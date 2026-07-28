/**
 * Fade curve shapes — the UI mirror of the engine's FadeCurve enum (SPEC §6,
 * TrackNode.cpp fadeShapeRt). gain = shape(t) for progress t 0..1 into the fade;
 * fade-outs evaluate the shape on the REMAINING fraction so one shape mirrors.
 * eqPower fades sum to unity power with their mirror — the crossfade default.
 */

import type { FadeCurve } from "../protocol/types";

export const FADE_CURVES: FadeCurve[] = ["linear", "expo", "log", "sCurve", "eqPower"];

export const FADE_CURVE_LABELS: Record<FadeCurve, string> = {
  linear: "Linear",
  expo: "Exponential (slow start)",
  log: "Logarithmic (fast start)",
  sCurve: "S-Curve",
  eqPower: "Equal Power",
};

/** Gain multiplier for progress t (clamped to 0..1) under the given shape. */
export function fadeGain(curve: FadeCurve | undefined, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (curve) {
    case "expo":
      return x * x;
    case "log":
      return 1 - (1 - x) * (1 - x);
    case "sCurve":
      return x * x * (3 - 2 * x);
    case "eqPower":
      return Math.sin((x * Math.PI) / 2);
    default:
      return x;
  }
}

/**
 * Fade gain at clip position p (0..1) for a fade occupying `fadeFrac` of the span
 * from the faded end (in: [0, fadeFrac]; out: [1-fadeFrac, 1]); 1 outside the fade.
 * fadeFrac 1 = the full-span render fades; 0 = no fade.
 */
export function fadeGainAt(
  which: "in" | "out",
  curve: FadeCurve | undefined,
  fadeFrac: number,
  p: number,
): number {
  if (fadeFrac <= 0) return 1;
  if (which === "in") return p < fadeFrac ? fadeGain(curve, p / fadeFrac) : 1;
  return p > 1 - fadeFrac ? fadeGain(curve, (1 - p) / fadeFrac) : 1;
}

/** Evaluate a clip gain envelope (sorted points, pos 0..1) at pos; 1 when empty. */
export function envGainAt(
  env: ReadonlyArray<{ pos: number; value: number }> | undefined,
  pos: number,
): number {
  if (!env || env.length === 0) return 1;
  if (pos <= env[0].pos) return env[0].value;
  const last = env[env.length - 1];
  if (pos >= last.pos) return last.value;
  for (let i = 0; i + 1 < env.length; i++) {
    if (pos <= env[i + 1].pos) {
      const span = env[i + 1].pos - env[i].pos;
      const t = span > 0 ? (pos - env[i].pos) / span : 1;
      return env[i].value + (env[i + 1].value - env[i].value) * t;
    }
  }
  return last.value;
}
