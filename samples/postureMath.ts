// Excerpt from Aswell (private repo), shown for portfolio review.
// (c) 2026 Alperen Sirli. All rights reserved.

import type {
  PoseLandmarks,
  Landmark,
  JointName,
  PoseEngineName,
} from "@/types/pose";
import { ENGINE_THRESHOLDS } from "@/features/posture/lib/engineThresholds";

// Every check below takes the engine that produced the landmarks, because the
// engines need different thresholds (engineThresholds.ts). It defaults to
// MoveNet, which is what these numbers were first calibrated on.

// MoveNet's minimum keypoint score to treat a landmark as genuinely detected.
// MoveNet SINGLEPOSE_THUNDER always emits all 17 keypoints — including guessed
// positions for body parts that aren't in frame — so existence alone is not
// evidence the joint was seen. Empirically (probe over a face selfie vs a real
// full-body photo): a face selfie's hips/knees/ankles score ~0.04–0.10 and its
// shoulders ~0.27, while a real full body scores 0.60–0.82 across the same
// joints. 0.30 sits cleanly in that gap and matches the cutoff runPoseDetection
// already uses for "real keypoint" in refineOnBodyCrop.
export const KEYPOINT_CONFIDENCE_FLOOR = ENGINE_THRESHOLDS.movenet.confidenceFloor;

function confident(
  p: Landmark | undefined,
  engine: PoseEngineName,
): p is Landmark {
  return !!p && p.confidence >= ENGINE_THRESHOLDS[engine].confidenceFloor;
}

function tiltBetween(a: Landmark, b: Landmark): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  return -deg;
}

export interface PostureAngles {
  earTilt: number | null;
  shoulderTilt: number | null;
  hipTilt: number | null;
  kneeTilt: number | null;
  ankleTilt: number | null;
}

export interface SideAngles {
  forwardHead: number | null;
  shoulderRounding: number | null;
}

function pairTilt(
  left: Landmark | undefined,
  right: Landmark | undefined,
  engine: PoseEngineName,
): number | null {
  // Gate on confidence, not mere existence — a sub-floor keypoint is a guess and
  // must not produce an angle (this is what fed "Ankles +49.6°" on a face photo).
  return confident(left, engine) && confident(right, engine)
    ? round(tiltBetween(left, right))
    : null;
}

// --- Lower-body sanity check (suppress, don't correct) ----------------------
// A joint can clear the confidence floor and still be in the wrong place. Before
// measuring hips, knees and ankles, check the legs make physical sense: hip above
// knee above ankle, and each leg segment a believable length compared with the
// torso. If not, we measure nothing down there rather than show a wrong angle.
//
// The limits are "physically impossible", not tuned: on real photos thigh and
// shin measured 0.60–1.01× torso. Honest limit: this catches wildly wrong
// joints, not a hip placed a few centimetres off (that looks normal to any
// geometry check — the fix for that is a better engine).
export const LEG_TO_TORSO_MIN = 0.35;
export const LEG_TO_TORSO_MAX = 2.0;

function distance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lowerBodyPlausible(
  pose: PoseLandmarks,
  engine: PoseEngineName = "movenet",
): boolean {
  for (const side of ["left", "right"] as const) {
    const shoulder = pose[`${side}Shoulder`];
    const hip = pose[`${side}Hip`];
    const knee = pose[`${side}Knee`];
    const ankle = pose[`${side}Ankle`];
    // Only judge a leg we can actually see. A leg with a guessed joint already
    // can't produce an angle.
    if (
      !confident(shoulder, engine) ||
      !confident(hip, engine) ||
      !confident(knee, engine) ||
      !confident(ankle, engine)
    ) {
      continue;
    }

    // Image y grows downwards, so a standing leg goes hip → knee → ankle.
    if (!(hip.y < knee.y && knee.y < ankle.y)) return false;

    const torso = distance(shoulder, hip);
    if (torso <= 1e-6) return false;
    const thigh = distance(hip, knee) / torso;
    const shin = distance(knee, ankle) / torso;
    const believable = (n: number) => n >= LEG_TO_TORSO_MIN && n <= LEG_TO_TORSO_MAX;
    if (!believable(thigh) || !believable(shin)) return false;
  }
  return true;
}

export function computeAngles(
  pose: PoseLandmarks,
  engine: PoseEngineName = "movenet",
): PostureAngles {
  // Knee alignment (valgus/varus) is intentionally not measured: it's
  // unreliable from a static 2D photo even after recalibration. Dropped.
  const legsOk = lowerBodyPlausible(pose, engine);
  return {
    earTilt: pairTilt(pose.leftEar, pose.rightEar, engine),
    shoulderTilt: pairTilt(pose.leftShoulder, pose.rightShoulder, engine),
    hipTilt: legsOk ? pairTilt(pose.leftHip, pose.rightHip, engine) : null,
    kneeTilt: legsOk ? pairTilt(pose.leftKnee, pose.rightKnee, engine) : null,
    ankleTilt: legsOk ? pairTilt(pose.leftAnkle, pose.rightAnkle, engine) : null,
  };
}

function pickSide(pose: PoseLandmarks) {
  const leftConf =
    (pose.leftEar?.confidence ?? 0) + (pose.leftShoulder?.confidence ?? 0);
  const rightConf =
    (pose.rightEar?.confidence ?? 0) + (pose.rightShoulder?.confidence ?? 0);
  return rightConf >= leftConf
    ? {
        ear: pose.rightEar,
        shoulder: pose.rightShoulder,
        hip: pose.rightHip,
        knee: pose.rightKnee,
      }
    : {
        ear: pose.leftEar,
        shoulder: pose.leftShoulder,
        hip: pose.leftHip,
        knee: pose.leftKnee,
      };
}

export function computeSideAngles(
  pose: PoseLandmarks,
  engine: PoseEngineName = "movenet",
): SideAngles {
  const { ear, shoulder, hip } = pickSide(pose);

  // Same confidence gate as the front angles — never compute on guessed joints.
  let forwardHead: number | null = null;
  if (confident(ear, engine) && confident(shoulder, engine)) {
    const dx = ear.x - shoulder.x;
    const dy = shoulder.y - ear.y;
    forwardHead = round(Math.abs((Math.atan2(dx, dy) * 180) / Math.PI));
  }

  let shoulderRounding: number | null = null;
  if (confident(shoulder, engine) && confident(hip, engine)) {
    const dx = shoulder.x - hip.x;
    const dy = hip.y - shoulder.y;
    shoulderRounding = round(Math.abs((Math.atan2(dx, dy) * 180) / Math.PI));
  }

  // Pelvic tilt is intentionally not measured: a single photo can't assess true
  // pelvic tilt (no ASIS/PSIS), so showing a number would contradict the
  // honesty principle. Dropped — see PR fix/knee-calibration-and-honesty.
  return { forwardHead, shoulderRounding };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ... the rest of the file (side-profile checks and helpers) is left out.
