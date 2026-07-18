/**
 * roomMath — one-point-perspective ("2.5D") projection for the mixer Room View.
 *
 * World space: pan x ∈ [-1,1] (hard left .. hard right), depth z ∈ [0,1]
 * (0 = front edge of the room — the listener / entrance POV, 1 = back wall).
 * Screen space: room-local CSS pixels, origin at the top-left of the room box.
 *
 * Projection: perspective scale s(z) = F/(F+z), tuned so s(0) = 1 and
 * s(1) = BACK_SCALE. Equally spaced world depths then converge harmonically
 * toward the vanishing point, exactly like the grid lines of a real floor.
 *
 * Depth ↔ level rides the SPEC §9 fader taper (Fader gainToPos/posToGain):
 * front edge = +12 dB, back wall = -60 dB, pressed against the wall = -inf,
 * so 0 dB lands on its own grid line and nothing the fader can do is
 * unreachable in the room (and vice versa).
 */

import {
  FADER_DB_MAX,
  FADER_DB_MIN,
  gainToPos,
  posToGain,
} from "../common/Fader";

/** Back-wall width as a fraction of the front-edge width. */
export const BACK_SCALE = 0.45;
/** Perspective focal constant: s(z) = F/(F+z) with s(1) = BACK_SCALE. */
const F = BACK_SCALE / (1 - BACK_SCALE);

/** Token visual scale at the front edge / back wall (depth exaggerated a touch). */
export const TOKEN_SCALE_NEAR = 1.15;
export const TOKEN_SCALE_FAR = 0.55;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Room box + insets the floor trapezoid is drawn inside. */
export interface RoomGeom {
  width: number;
  height: number;
  /** Horizontal inset of the FRONT edge corners. */
  padX: number;
  /** Distance of the back wall from the top of the box. */
  padTop: number;
  /** Distance of the front edge from the bottom of the box. */
  padBottom: number;
}

/** Perspective scale at world depth z (1 at the front edge, BACK_SCALE at the wall). */
export function depthScale(z: number): number {
  return F / (F + clamp(z, 0, 1));
}

export interface RoomPoint {
  x: number;
  y: number;
  /** Perspective scale at this depth (drives token size). */
  s: number;
}

/** World (pan, depth) → room-local px. */
export function project(pan: number, z: number, g: RoomGeom): RoomPoint {
  const s = depthScale(z);
  const frontY = g.height - g.padBottom;
  const backY = g.padTop;
  const halfW = g.width / 2 - g.padX;
  return {
    x: g.width / 2 + clamp(pan, -1, 1) * halfW * s,
    y: frontY - (frontY - backY) * ((1 - s) / (1 - BACK_SCALE)),
    s,
  };
}

/** Room-local px → world (pan, depth), clamped to the floor. */
export function unproject(x: number, y: number, g: RoomGeom): { pan: number; z: number } {
  const frontY = g.height - g.padBottom;
  const backY = g.padTop;
  const halfW = g.width / 2 - g.padX;
  const u = clamp((frontY - y) / (frontY - backY), 0, 1);
  const s = 1 - u * (1 - BACK_SCALE);
  const z = clamp((F * (1 - s)) / s, 0, 1);
  return { pan: clamp((x - g.width / 2) / (halfW * s), -1, 1), z };
}

/** Depth → linear gain: front = +12 dB, back wall = -60 dB → gain 0 (-inf). */
export function depthToGain(z: number): number {
  return posToGain(1 - clamp(z, 0, 1));
}

/** Linear gain → depth (gain ≥ +12 dB clamps to the front edge, 0/-inf to the wall). */
export function gainToDepth(gain: number): number {
  return 1 - gainToPos(gain);
}

/** Depth of a given dB level's grid line (0 dB, -12 dB, ... — mirrors the fader ticks). */
export function dbToDepth(db: number): number {
  return 1 - clamp((db - FADER_DB_MIN) / (FADER_DB_MAX - FADER_DB_MIN), 0, 1);
}

/** Perspective scale → token visual scale (near tokens grow, far tokens shrink). */
export function tokenScale(s: number): number {
  const t = (s - BACK_SCALE) / (1 - BACK_SCALE);
  return TOKEN_SCALE_FAR + t * (TOKEN_SCALE_NEAR - TOKEN_SCALE_FAR);
}
