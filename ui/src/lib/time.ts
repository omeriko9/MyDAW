/**
 * Musical time math — mirrors engine semantics (SPEC §4, §7):
 *   - musical positions are in `double beats` (quarter notes)
 *   - tempoMap is piecewise-CONSTANT bpm (each entry holds until the next)
 *   - timeSigMap entries start at 1-based bar numbers
 *
 * Also: beat↔px via the viewport, grid snapping (snapping uses division & triplet;
 * swing is for quantize only — SPEC §6 grid object), and bars.beats / time formatting.
 */

import type { Grid, TempoPoint, TimeSigEntry } from "../protocol/types";

/* ============================================================================
 * beat ↔ px (viewport: zoomX = px per beat, scrollX = px)
 * ========================================================================= */

export interface HViewport {
  zoomX: number;
  scrollX: number;
}

export function beatToPx(beat: number, vp: HViewport): number {
  return beat * vp.zoomX - vp.scrollX;
}

export function pxToBeat(px: number, vp: HViewport): number {
  return vp.zoomX > 0 ? (px + vp.scrollX) / vp.zoomX : 0;
}

/* ============================================================================
 * Grid snapping
 * ========================================================================= */

export type SnapMode = "round" | "floor" | "ceil";

/**
 * Snap a beat position to the grid. Uses grid.division (beats) and grid.triplet
 * (step × 2/3). grid.swing is NOT applied here — swing affects quantize only
 * (cmd/notes.quantize). If grid is absent or snap is off, returns beat unchanged.
 */
export function snapBeat(beat: number, grid?: Grid | null, mode: SnapMode = "round"): number {
  if (!grid || !grid.snap || !(grid.division > 0)) return beat;
  const step = gridStepBeats(grid);
  const q = beat / step;
  const snapped = mode === "floor" ? Math.floor(q) : mode === "ceil" ? Math.ceil(q) : Math.round(q);
  return snapped * step;
}

/** Effective grid step in beats (division, with triplet = ×2/3). */
export function gridStepBeats(grid: Grid): number {
  return grid.division * (grid.triplet ? 2 / 3 : 1);
}

/* ============================================================================
 * Tempo map: beats ↔ seconds (piecewise-constant bpm; v1 has a single entry at beat 0)
 * ========================================================================= */

const DEFAULT_BPM = 120;

export function beatsToSeconds(beat: number, tempoMap: TempoPoint[]): number {
  if (!tempoMap || tempoMap.length === 0) return (beat * 60) / DEFAULT_BPM;
  let sec = 0;
  let prevBeat = tempoMap[0].beat;
  let prevBpm = tempoMap[0].bpm;
  if (beat <= prevBeat) {
    // before the first entry (first entry is at beat 0 in practice): extrapolate its bpm
    return ((beat - prevBeat) * 60) / prevBpm;
  }
  for (let i = 1; i < tempoMap.length; i++) {
    const e = tempoMap[i];
    if (beat <= e.beat) {
      return sec + ((beat - prevBeat) * 60) / prevBpm;
    }
    sec += ((e.beat - prevBeat) * 60) / prevBpm;
    prevBeat = e.beat;
    prevBpm = e.bpm;
  }
  return sec + ((beat - prevBeat) * 60) / prevBpm;
}

export function secondsToBeats(sec: number, tempoMap: TempoPoint[]): number {
  if (!tempoMap || tempoMap.length === 0) return (sec * DEFAULT_BPM) / 60;
  let accSec = 0;
  let prevBeat = tempoMap[0].beat;
  let prevBpm = tempoMap[0].bpm;
  if (sec <= 0) {
    return prevBeat + (sec * prevBpm) / 60;
  }
  for (let i = 1; i < tempoMap.length; i++) {
    const e = tempoMap[i];
    const segSec = ((e.beat - prevBeat) * 60) / prevBpm;
    if (sec <= accSec + segSec) {
      return prevBeat + ((sec - accSec) * prevBpm) / 60;
    }
    accSec += segSec;
    prevBeat = e.beat;
    prevBpm = e.bpm;
  }
  return prevBeat + ((sec - accSec) * prevBpm) / 60;
}

/** bpm in effect at a beat position. */
export function bpmAtBeat(beat: number, tempoMap: TempoPoint[]): number {
  if (!tempoMap || tempoMap.length === 0) return DEFAULT_BPM;
  let bpm = tempoMap[0].bpm;
  for (const e of tempoMap) {
    if (e.beat > beat) break;
    bpm = e.bpm;
  }
  return bpm;
}

/* ============================================================================
 * Time signature map: bars ↔ beats (bars are 1-based; map entries keyed by bar)
 * ========================================================================= */

const DEFAULT_SIG: TimeSigEntry = { bar: 1, num: 4, den: 4 };

interface SigSegment {
  bar: number; // first bar of this segment (1-based)
  startBeat: number; // beat position of that bar
  num: number;
  den: number;
  beatsPerBar: number; // in quarter-note beats
}

function sigSegments(timeSigMap: TimeSigEntry[]): SigSegment[] {
  const map = timeSigMap && timeSigMap.length > 0 ? timeSigMap : [DEFAULT_SIG];
  const segs: SigSegment[] = [];
  let startBeat = 0;
  let prev: SigSegment | null = null;
  for (const e of map) {
    if (prev) startBeat += (e.bar - prev.bar) * prev.beatsPerBar;
    // Sanitize: a den<=0 or num<1 entry would make beatsPerBar=Infinity/NaN and
    // hang grid-line loops that step by it. Fall back to 4/4 components.
    const den = e.den > 0 ? e.den : 4;
    const num = e.num >= 1 ? e.num : 4;
    const seg: SigSegment = {
      bar: e.bar,
      startBeat,
      num,
      den,
      beatsPerBar: (num * 4) / den,
    };
    segs.push(seg);
    prev = seg;
  }
  return segs;
}

function segmentForBeat(segs: SigSegment[], beat: number): SigSegment {
  let seg = segs[0];
  for (const s of segs) {
    if (s.startBeat > beat) break;
    seg = s;
  }
  return seg;
}

function segmentForBar(segs: SigSegment[], bar: number): SigSegment {
  let seg = segs[0];
  for (const s of segs) {
    if (s.bar > bar) break;
    seg = s;
  }
  return seg;
}

export interface TimeSigAt {
  num: number;
  den: number;
  /** quarter-note beats per bar */
  beatsPerBar: number;
}

export function timeSigAtBeat(beat: number, timeSigMap: TimeSigEntry[]): TimeSigAt {
  const s = segmentForBeat(sigSegments(timeSigMap), beat);
  return { num: s.num, den: s.den, beatsPerBar: s.beatsPerBar };
}

/** Beat position (quarter notes) of the start of a 1-based bar number. */
export function barToBeat(bar: number, timeSigMap: TimeSigEntry[]): number {
  const segs = sigSegments(timeSigMap);
  const s = segmentForBar(segs, bar);
  return s.startBeat + (bar - s.bar) * s.beatsPerBar;
}

/** 1-based bar number containing a beat position. */
export function beatToBar(beat: number, timeSigMap: TimeSigEntry[]): number {
  const segs = sigSegments(timeSigMap);
  const s = segmentForBeat(segs, beat);
  return s.bar + Math.floor((beat - s.startBeat) / s.beatsPerBar);
}

/* ============================================================================
 * bars.beats.ticks display (ticks = 1/960 of the displayed beat unit, 0..959)
 * The displayed beat unit is the timesig denominator note (e.g. eighths in 6/8).
 * ========================================================================= */

export interface BarsBeats {
  /** 1-based */
  bar: number;
  /** 1-based, in denominator-note units */
  beat: number;
  /** 0..959 */
  tick: number;
}

export const TICKS_PER_BEAT_UNIT = 960;

export function beatToBarsBeats(beat: number, timeSigMap: TimeSigEntry[]): BarsBeats {
  const segs = sigSegments(timeSigMap);
  const s = segmentForBeat(segs, beat);
  const unit = 4 / s.den; // quarter-note beats per displayed beat
  const rel = beat - s.startBeat;
  let barOff = Math.floor(rel / s.beatsPerBar);
  let inBar = rel - barOff * s.beatsPerBar;
  if (inBar < 0) {
    // negative positions (before bar of segment start)
    barOff -= 1;
    inBar += s.beatsPerBar;
  }
  let beatIdx = Math.floor(inBar / unit + 1e-9);
  let tick = Math.round(((inBar - beatIdx * unit) / unit) * TICKS_PER_BEAT_UNIT);
  if (tick >= TICKS_PER_BEAT_UNIT) {
    tick = 0;
    beatIdx += 1;
  }
  if (beatIdx >= s.num) {
    beatIdx -= s.num;
    barOff += 1;
  }
  return { bar: s.bar + barOff, beat: beatIdx + 1, tick };
}

/** "BAR.BEAT.TTT" e.g. "5.3.480" — the transport position readout format. */
export function formatBarsBeats(beat: number, timeSigMap: TimeSigEntry[]): string {
  const b = beatToBarsBeats(beat, timeSigMap);
  return `${b.bar}.${b.beat}.${String(b.tick).padStart(3, "0")}`;
}

/** "5.2" (ticks appended only when off-grid) — compact drag-HUD position label. */
export function formatBarsBeatsShort(beat: number, timeSigMap: TimeSigEntry[]): string {
  const b = beatToBarsBeats(beat, timeSigMap);
  return `${b.bar}.${b.beat}${b.tick > 0 ? `.${String(b.tick).padStart(3, "0")}` : ""}`;
}

/** Parse "bar", "bar.beat", or "bar.beat.tick" (separators . : or whitespace) → beats. */
export function parseBarsBeats(text: string, timeSigMap: TimeSigEntry[]): number | null {
  const parts = text.trim().split(/[.:\s]+/).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [bar, beatPart = 1, tick = 0] = nums;
  const segs = sigSegments(timeSigMap);
  const s = segmentForBar(segs, bar);
  const unit = 4 / s.den;
  return (
    s.startBeat +
    (bar - s.bar) * s.beatsPerBar +
    (beatPart - 1) * unit +
    (tick / TICKS_PER_BEAT_UNIT) * unit
  );
}

/* ============================================================================
 * Wall-clock formatting
 * ========================================================================= */

/** "M:SS.mmm" (or "H:MM:SS.mmm" when ≥ 1 hour); negative values get a leading "-". */
export function formatTimeSec(sec: number): string {
  const neg = sec < 0;
  let t = Math.abs(sec);
  const h = Math.floor(t / 3600);
  t -= h * 3600;
  const m = Math.floor(t / 60);
  t -= m * 60;
  const s = Math.floor(t);
  const ms = Math.round((t - s) * 1000);
  const msStr = String(ms === 1000 ? 999 : ms).padStart(3, "0");
  const sStr = String(s).padStart(2, "0");
  const body =
    h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${sStr}.${msStr}`
      : `${m}:${sStr}.${msStr}`;
  return neg ? `-${body}` : body;
}

/** Parse "SS", "M:SS", "H:MM:SS" (fractional seconds allowed) → seconds. */
export function parseTimeSec(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const neg = trimmed.startsWith("-");
  const parts = (neg ? trimmed.slice(1) : trimmed).split(":");
  if (parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let sec = 0;
  for (const n of nums) sec = sec * 60 + n;
  return neg ? -sec : sec;
}

/* ============================================================================
 * Combined helpers
 * ========================================================================= */

/** beats → samples at the session sample rate (mirrors TempoMap::beatsToSamples). */
export function beatsToSamples(beat: number, tempoMap: TempoPoint[], sampleRate: number): number {
  return Math.round(beatsToSeconds(beat, tempoMap) * sampleRate);
}

export function samplesToBeats(samples: number, tempoMap: TempoPoint[], sampleRate: number): number {
  return sampleRate > 0 ? secondsToBeats(samples / sampleRate, tempoMap) : 0;
}
