// Excerpt from Aswell (private repo), shown for portfolio review.
// (c) 2026 Alperen Sirli. All rights reserved.

// Face vision proxy — the ONLY path the app uses to reach Claude for a face read.
//
// Why this exists: the Anthropic key must never ship in the client bundle
// (EXPO_PUBLIC_* vars are inlined and extractable). The key lives here as a
// Supabase secret (ANTHROPIC_API_KEY) and never leaves the server.
//
// Why it's PURPOSE-BUILT, not a passthrough relay: the model, params, and system
// prompt are fixed in this function. A caller can only send one image and get a
// face classification back — they cannot supply their own prompt and turn the
// endpoint into a free general-purpose Claude relay on our bill.
//
// SOURCE OF TRUTH for the face-classification prompt — it runs here, server-side.

// ... imports, limit constants, CORS headers, the model prompt and small helpers
// (json, isRealRead, reportOps) are left out of this excerpt.

// Hand a claimed gift back — used when a claimed read never actually happened
// (the model call failed, or came back with no face). service_role may flip the
// flag back to false; the integrity trigger only pins it one-way for app clients.
// Best-effort: a failed refund costs the user one gift, never a crash.
async function refundGift(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  try {
    await admin
      .from("entitlements")
      .update({ free_face_scan_used: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  } catch {
    // swallow — never let a refund failure take down the response
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const configured = Boolean(key && supabaseUrl && serviceKey);

  // Health check for the uptime monitor. A GET never reads a face and never
  // calls Claude, so it costs nothing. It fails if a secret went missing.
  if (req.method === "GET") {
    return configured ? json({ ok: true }, 200) : json({ ok: false }, 500);
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!key || !supabaseUrl || !serviceKey) {
    return json({ error: "server_misconfigured" }, 500);
  }

  // Identity comes from the caller's own token, never the body. No token → no
  // read: this closes the open relay that let anyone spend our model budget.
  const token = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) return json({ error: "unauthorized" }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  // Body is exactly one field: the base64 JPEG. Nothing else is honoured — the
  // caller cannot influence the model, prompt, or params.
  let image: unknown;
  try {
    ({ image } = await req.json());
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (typeof image !== "string" || image.length === 0) {
    return json({ error: "missing_image" }, 400);
  }

  // Rate limit — count this user's recent calls; refuse past the ceiling before
  // we touch entitlements or the model.
  const windowStart = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count } = await admin
    .from("vision_calls")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", windowStart);
  if ((count ?? 0) >= RATE_LIMIT) return json({ error: "rate_limited" }, 429);

  // Weekly limit — count this user's REAL reads in the last 7 days. Refused
  // before the gift or the model, so a refused request costs nothing.
  if (FACE_WEEKLY_LIMIT > 0) {
    const weekStart = new Date(Date.now() - WEEK_MS).toISOString();
    const { count: weekCount } = await admin
      .from("face_reads")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", weekStart);
    if ((weekCount ?? 0) >= FACE_WEEKLY_LIMIT) {
      return json({ error: "weekly_limit" }, 429);
    }
  }

  // Global cost cap — count EVERY user's recent calls and refuse past the daily
  // ceiling. Checked before we claim a gift or hit the model, so a capped request
  // costs the user nothing and costs us nothing. This is the last line that keeps
  // a bad day from becoming a bad bill.
  const globalWindowStart = new Date(Date.now() - GLOBAL_WINDOW_MS).toISOString();
  const { count: globalCount } = await admin
    .from("vision_calls")
    .select("*", { count: "exact", head: true })
    .gte("created_at", globalWindowStart);
  const usedToday = globalCount ?? 0;
  if (usedToday >= GLOBAL_DAILY_CAP) {
    reportOps("face_cost_blocked", { used: usedToday, cap: GLOBAL_DAILY_CAP });
    return json({ error: "capacity_reached" }, 503);
  }
  if (usedToday >= GLOBAL_DAILY_CAP * NEAR_CAP_RATIO) {
    reportOps("face_cost_near_cap", { used: usedToday, cap: GLOBAL_DAILY_CAP });
  }

  // Entitlement — a face read costs a real vision call, gated to a subscriber OR
  // a user whose one free gift is still unused. subscription_status is
  // server-owned, never client-claimed.
  const { data: ent } = await admin
    .from("entitlements")
    .select("subscription_status")
    .eq("user_id", userId)
    .maybeSingle();
  const subscribed = ent?.subscription_status === "active";

  // Non-subscribers must CLAIM the one free gift ATOMICALLY. Reading "is the gift
  // unused?" and then burning it in two steps lets two requests fired at once
  // both pass the read and both spend a call (one gift → N reads). Instead, a
  // single conditional update flips free_face_scan_used false→true and returns
  // the row ONLY to the racer that won; every other concurrent request matches no
  // row and is refused. If this read turns out not to have happened, the gift is
  // handed back below.
  let claimedGift = false;
  if (!subscribed) {
    // Ensure a row exists so the conditional update has something to flip — a
    // brand-new user may not have synced an entitlements row yet.
    await admin
      .from("entitlements")
      .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });

    const { data: claimed } = await admin
      .from("entitlements")
      .update({ free_face_scan_used: true, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("free_face_scan_used", false)
      .select("user_id")
      .maybeSingle();

    if (!claimed) return json({ error: "not_entitled" }, 402);
    claimedGift = true;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: 0,
        thinking: { type: "disabled" },
        system: FACE_VISION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: image,
                },
              },
              {
                type: "text",
                text: "Classify this selfie. Return only the JSON object.",
              },
            ],
          },
        ],
      }),
    });
  } catch {
    // The read never happened — give the claimed gift back before bailing.
    if (claimedGift) await refundGift(admin, userId);
    return json({ error: "upstream_unreachable" }, 502);
  } finally {
    clearTimeout(timer);
  }

  // Forward Claude's status + body verbatim so the client's existing handling
  // (401/403 → "auth", non-OK → "network", parse content[].text) still works.
  // Only the model's own response is forwarded — the key is never echoed.
  const body = await upstream.text();

  // Log the call for both rate windows, then prune ALL old rows so the table
  // stays bounded — a global prune (not just this user's) is what keeps the
  // global-cap count cheap and stops an abandoned account's rows lingering
  // forever. Awaited so the write actually lands (an edge isolate can freeze once
  // the response returns); wrapped so a logging hiccup never fails the read the
  // user already paid for.
  try {
    await admin.from("vision_calls").insert({ user_id: userId });
    await admin
      .from("vision_calls")
      .delete()
      .lt("created_at", new Date(Date.now() - PRUNE_AGE_MS).toISOString());
  } catch {
    // best-effort — never block the response on the rate-limit log
  }

  // The gift was already claimed up front (atomically). Hand it back if this read
  // never really happened — the model errored, or it came back with no face — so
  // the "unclear / no-face doesn't cost your gift" behaviour survives the claim.
  // A genuine read keeps the burn.
  const realRead = isRealRead(body);
  if (claimedGift && (!upstream.ok || !realRead)) {
    await refundGift(admin, userId);
  }

  // A real read counts toward the weekly limit. Then drop reads older than a
  // week — nothing looks further back. Best-effort, like the log above.
  if (upstream.ok && realRead) {
    try {
      await admin.from("face_reads").insert({ user_id: userId });
      await admin
        .from("face_reads")
        .delete()
        .lt("created_at", new Date(Date.now() - WEEK_MS).toISOString());
    } catch {
      // best-effort — never block the response on the weekly log
    }
  }

  // One-line, no-PII audit of what this request decided — visible in the function
  // Logs tab, so an entitlement issue is diagnosable without guessing. No user id,
  // no image, just the outcome.
  console.log(
    `[face-vision] status=${upstream.status} subscribed=${subscribed} claimedGift=${claimedGift} realRead=${realRead} globalToday=${globalCount ?? 0}/${GLOBAL_DAILY_CAP}`,
  );

  return new Response(body, {
    status: upstream.status,
    headers: { ...CORS, "content-type": "application/json" },
  });
});
