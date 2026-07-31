/**
 * Comping math (SPEC §8.7) — shared by the Inspector Takes section and the
 * arrangement's inline take lanes. Pure and canvas/DOM-agnostic.
 *
 * compSegments/laneAt mirror the engine's resolution in AudioGraph::buildPlan
 * EXACTLY (first segment anchored to the folder start regardless of its stored
 * startBeat; lane -1 or out of range = silence) — the UI must predict what plays,
 * never re-derive it from raw comp[i].startBeat for segment 0.
 */

import type { TakeFolder } from "../protocol/types";

export interface CompSeg {
  s: number;
  e: number;
  lane: number;
}

/** Comp boundaries → concrete [s,e) segments (mirrors AudioGraph::buildPlan). */
export function compSegments(f: TakeFolder): CompSeg[] {
  const segs: CompSeg[] = [];
  const fs = f.startBeat;
  const fe = f.endBeat;
  if (!f.comp || f.comp.length === 0) {
    if (f.lanes.length) segs.push({ s: fs, e: fe, lane: 0 });
    return segs;
  }
  for (let i = 0; i < f.comp.length; i++) {
    const s = i === 0 ? fs : Math.max(f.comp[i].startBeat, fs);
    let e = i + 1 < f.comp.length ? Math.max(f.comp[i + 1].startBeat, s) : fe;
    e = Math.min(e, fe);
    if (e > s) segs.push({ s, e, lane: f.comp[i].lane });
  }
  return segs;
}

/** Which lane plays at `beat` (0 when the comp is empty; -1 = silence). */
export function laneAt(f: TakeFolder, beat: number): number {
  if (!f.comp || f.comp.length === 0) return 0;
  let lane = f.comp[0].lane;
  for (const s of f.comp) {
    if (beat >= s.startBeat) lane = s.lane;
    else break;
  }
  return lane;
}

/** Paint [b0,b1) with `lane`, preserving what played before b0 and restoring at b1. */
export function paintComp(
  f: TakeFolder,
  b0: number,
  b1: number,
  lane: number,
): { startBeat: number; lane: number }[] {
  const fs = f.startBeat;
  const fe = f.endBeat;
  let lo = Math.max(fs, Math.min(b0, fe));
  let hi = Math.max(fs, Math.min(b1, fe));
  if (hi < lo) [lo, hi] = [hi, lo];
  const src = f.comp && f.comp.length ? f.comp : [{ startBeat: fs, lane: 0 }];
  const laneAfter = laneAt(f, hi);
  const pts: { startBeat: number; lane: number }[] = [];
  for (const s of src) if (s.startBeat < lo - 1e-6) pts.push({ startBeat: s.startBeat, lane: s.lane });
  if (pts.length === 0) pts.push({ startBeat: fs, lane: laneAt(f, fs) });
  pts.push({ startBeat: lo, lane });
  if (fe - hi > 1e-6) pts.push({ startBeat: hi, lane: laneAfter });
  for (const s of src) if (s.startBeat > hi + 1e-6) pts.push({ startBeat: s.startBeat, lane: s.lane });
  pts.sort((a, b) => a.startBeat - b.startBeat);
  // Drop redundant consecutive same-lane boundaries; anchor the first to the folder start.
  const out: { startBeat: number; lane: number }[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1].lane === p.lane) continue;
    out.push(p);
  }
  if (out.length) out[0] = { startBeat: fs, lane: out[0].lane };
  return out;
}

/** Per-take accent colors, indexed lane % length (shared Inspector/arrangement). */
export const LANE_COLORS = ["#4f8cff", "#28c07a", "#e0a533", "#c96be0", "#e0605f", "#33bcd6"];
