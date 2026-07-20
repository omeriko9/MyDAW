/**
 * X-ray lenses (owned by U1) — analytical recoloring of the arrangement.
 * Instead of track colors, clips take a heat color derived from their CONTENT,
 * normalized project-relative so contrasts pop:
 *
 *   density   note onsets per beat  ("where is it busy / empty")
 *   register  mean pitch           (low = warm, high = cool)
 *   energy    mean velocity        ("where is it loud / soft")
 *
 * Pure math, no store access. MIDI clips only — audio clips have no note
 * content; callers render them neutral (an honest "no data here", not a fake
 * reading). Values are memoized per project reference by the caller.
 */

import type { Project } from "../protocol/types";
import { isMidiClip } from "../protocol/types";

export type LensId = "off" | "density" | "register" | "energy";

export const LENSES: Array<{ id: Exclude<LensId, "off">; label: string; hint: string }> = [
  {
    id: "density",
    label: "Density",
    hint: "Note onsets per beat — busy passages run hot, sparse ones cool",
  },
  {
    id: "register",
    label: "Register",
    hint: "Mean pitch — bass runs warm, treble runs cool",
  },
  {
    id: "energy",
    label: "Energy",
    hint: "Mean velocity — loud passages run hot, soft ones cool",
  },
];

/** Raw (un-normalized) lens metric for one MIDI clip, or null when it has no notes. */
function rawMetric(
  lens: Exclude<LensId, "off">,
  notes: ReadonlyArray<{ pitch: number; velocity: number }>,
  lengthBeats: number,
): number | null {
  if (notes.length === 0) return lens === "density" ? 0 : null;
  switch (lens) {
    case "density":
      return notes.length / Math.max(lengthBeats, 1e-6);
    case "register":
      return notes.reduce((s, n) => s + n.pitch, 0) / notes.length;
    case "energy":
      return notes.reduce((s, n) => s + n.velocity, 0) / notes.length;
  }
}

/**
 * Normalized 0..1 heat per MIDI clip id (project-relative min..max; a flat
 * project maps to 0.5 everywhere). Clips absent from the map have no data.
 */
export function computeLensValues(
  project: Project,
  lens: Exclude<LensId, "off">,
): Map<number, number> {
  const raw = new Map<number, number>();
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (!isMidiClip(c)) continue;
      const m = rawMetric(lens, c.notes, c.lengthBeats);
      if (m !== null) raw.set(c.id, m);
    }
  }
  const values = [...raw.values()];
  if (values.length === 0) return raw;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const out = new Map<number, number>();
  for (const [id, m] of raw) {
    let t = span < 1e-9 ? 0.5 : (m - lo) / span;
    // register reads low→warm: flip so bass lands on the hot end of the ramp
    if (lens === "register") t = 1 - t;
    out.set(id, t);
  }
  return out;
}

/* Heat ramp: cool blue → yellow → hot red (the prDraw velocity-heat stops —
   saturated mid-tones that read on every theme). */
const STOPS: Array<[number, number, number]> = [
  [74, 163, 232], // #4aa3e8
  [216, 201, 69], // #d8c945
  [224, 80, 76], // #e0504c
];

export function heatHex(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const [a, b, f] = x < 0.5 ? [STOPS[0], STOPS[1], x * 2] : [STOPS[1], STOPS[2], (x - 0.5) * 2];
  const p = (i: number) =>
    Math.round(a[i] + (b[i] - a[i]) * f)
      .toString(16)
      .padStart(2, "0");
  return `#${p(0)}${p(1)}${p(2)}`;
}
