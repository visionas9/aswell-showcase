// Excerpt from Aswell (private repo), shown for portfolio review.
// (c) 2026 Alperen Sirli. All rights reserved.

import type { AnalyticsProps } from "./events";

// The privacy floor for event props, as a pure function so "no PII leaves the
// device" is a tested guarantee, not a hope. Funnel analytics needs counts and
// low-cardinality context (a plan tier, a boolean, a pillar name) — never free
// text, ids, emails, or anything that fingerprints a person. This strips the
// catalog down to that: primitives only, short, and with obvious PII shapes
// dropped outright.
//
// The contract is deliberately conservative — when in doubt, DROP. A missing
// prop costs a little analytical context; a leaked one is a privacy incident.

// Values longer than this are almost certainly free text or an id, not the
// low-cardinality label a funnel event should carry. Dropped rather than
// truncated (a truncated email is still PII).
const MAX_VALUE_LEN = 64;

// Obvious PII shapes. Not exhaustive by design — the real protection is the
// closed prop vocabulary at each call site; this is the backstop for a mistake.
const EMAIL_RE = /@/;
const LONG_DIGITS_RE = /\d{7,}/; // phone numbers, long ids

function isSafeStringValue(v: string): boolean {
  if (v.length === 0 || v.length > MAX_VALUE_LEN) return false;
  if (EMAIL_RE.test(v)) return false;
  if (LONG_DIGITS_RE.test(v)) return false;
  return true;
}

// Key names that should never carry a value into analytics, whatever the shape.
const BLOCKED_KEY_RE = /email|name|phone|address|token|password|uri|url|photo/i;

export function sanitizeProps(
  props: AnalyticsProps | undefined,
): AnalyticsProps | undefined {
  if (!props) return undefined;
  const out: AnalyticsProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (BLOCKED_KEY_RE.test(key)) continue;
    if (typeof value === "boolean" || typeof value === "number") {
      // Numbers are kept as-is EXCEPT non-finite ones, which aren't valid JSON.
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === "string") {
      if (isSafeStringValue(value)) out[key] = value;
    }
    // Anything else (object, array, null, undefined, function) is dropped.
  }
  // Collapse an emptied-out bag back to undefined so the row carries no `{}`.
  return Object.keys(out).length > 0 ? out : undefined;
}
