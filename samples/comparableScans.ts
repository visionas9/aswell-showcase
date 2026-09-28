// Excerpt from Aswell (private repo), shown for portfolio review.
// (c) 2026 Alperen Sirli. All rights reserved.

import type {
  ArchivedScan,
  ArchivedPostureScan,
  ArchivedFaceScan,
} from "@/features/progress/useScanArchive";
import type { PoseEngineName } from "@/types/pose";

// Which scans can honestly be compared with each other. Every before/after,
// "What improved", points total and share card asks this file, so the rule
// lives in ONE place.
//
// The rule: a posture scan can only be compared with scans read by the same
// body-pose engine. Two engines place joints a little differently, so a switch
// from one to the other would otherwise look like the body changed.
//
// Face scans have no engine, so they're always comparable with each other.

// Which engine read a scan. Posture scans from before we tracked it were all
// MoveNet. Face scans don't have one.
export function engineOf(scan: ArchivedScan): PoseEngineName | null {
  return scan.pillar === "posture" ? (scan.engine ?? "movenet") : null;
}

// Can these two scans be compared?
export function sameEngine(a: ArchivedScan, b: ArchivedScan): boolean {
  return engineOf(a) === engineOf(b);
}

// A pillar's scans that can be compared with its newest one, newest first
// (the archive's order).
//
// Pass `upToIso` to ask "as of that moment": an old session only looks at
// scans up to itself, and "newest" means newest up to then.
export function comparableScans(
  entries: ArchivedScan[],
  pillar: "posture",
  upToIso?: string,
): ArchivedPostureScan[];
export function comparableScans(
  entries: ArchivedScan[],
  pillar: "face",
  upToIso?: string,
): ArchivedFaceScan[];
export function comparableScans(
  entries: ArchivedScan[],
  pillar: "posture" | "face",
  upToIso?: string,
): (ArchivedPostureScan | ArchivedFaceScan)[];
export function comparableScans(
  entries: ArchivedScan[],
  pillar: "posture" | "face",
  upToIso?: string,
): ArchivedScan[] {
  const scans = entries.filter(
    (e) => e.pillar === pillar && (!upToIso || e.createdAt <= upToIso),
  );
  if (scans.length === 0) return [];

  const newest = scans.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return scans.filter((s) => sameEngine(s, newest));
}
