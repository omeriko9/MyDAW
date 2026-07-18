/**
 * PianoRoll math helpers (U4) — pure functions, no React.
 *
 * Coordinate system: the note grid shows all 128 MIDI pitches as rows, highest pitch at
 * the top, lowest at the bottom. Horizontal positions are CLIP-LOCAL beats (note.startBeat
 * is relative to the clip per SPEC §6); the ruler adds clip.startBeat to show ABSOLUTE bars.
 *
 * NOTE(spec): the brief says "top G9 bottom C-2" which is internally inconsistent (128
 * pitches spanning C-2..G8 or C-1..G9). We use the Cubase/Yamaha octave convention pinned
 * by "bottom C-2": pitch 0 = C-2, pitch 60 = C3 (middle C), pitch 127 = G8.
 */

import type { MidiCc, MidiClip, Note } from "../../protocol/types";

/* ============================================================================
 * Constants
 * ========================================================================= */

export const NUM_PITCHES = 128;
export const MAX_PITCH = 127;

/** Left keys column width (px) — pinned by the brief. */
export const KEYS_W = 56;
/** Ruler height (px). */
export const RULER_H = 22;
/** Velocity lane height (px). */
export const VEL_LANE_H = 88;

export const MIN_ROW_H = 8;
export const MAX_ROW_H = 24;
export const MIN_ZOOM_X = 4; // px per beat
export const MAX_ZOOM_X = 480;

/** Minimum note length in beats (a 64th note) — resize/draw clamp. */
export const MIN_NOTE_LEN = 0.0625;
/** Right-edge resize hot zone width (px). */
export const EDGE_PX = 6;
/** Extra scrollable beats past the end of content. */
export const SCROLL_MARGIN_BEATS = 8;

/* ============================================================================
 * Local viewport (independent of the timeline viewport — brief requirement)
 * ========================================================================= */

export interface PrView {
  /** px per clip-local beat */
  zoomX: number;
  /** row height px (8..24) */
  rowH: number;
  /** px */
  scrollX: number;
  /** px */
  scrollY: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Top y (px) of a pitch row. */
export function pitchTop(pitch: number, v: PrView): number {
  return (MAX_PITCH - pitch) * v.rowH - v.scrollY;
}

export function yToPitch(y: number, v: PrView): number {
  return clamp(MAX_PITCH - Math.floor((y + v.scrollY) / v.rowH), 0, MAX_PITCH);
}

export function beatToX(localBeat: number, v: PrView): number {
  return localBeat * v.zoomX - v.scrollX;
}

export function xToBeat(x: number, v: PrView): number {
  return v.zoomX > 0 ? (x + v.scrollX) / v.zoomX : 0;
}

/* ============================================================================
 * Pitch names / keyboard layout
 * ========================================================================= */

const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function isBlackKey(pitch: number): boolean {
  return BLACK[((pitch % 12) + 12) % 12];
}

/** "C3" for 60 (Cubase/Yamaha convention: pitch 0 = C-2). */
export function pitchName(pitch: number): string {
  const pc = ((pitch % 12) + 12) % 12;
  return `${NOTE_NAMES[pc]}${Math.floor(pitch / 12) - 2}`;
}

/* ============================================================================
 * Scales (highlight + snap) — semitone offsets from the root
 * ========================================================================= */

export const SCALE_ROOTS = NOTE_NAMES;

export interface ScaleDef {
  id: string;
  label: string;
  steps: number[];
}

export const SCALES: ScaleDef[] = [
  { id: "major", label: "Major", steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: "minor", label: "Minor", steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: "harmMinor", label: "Harmonic Minor", steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: "melMinor", label: "Melodic Minor", steps: [0, 2, 3, 5, 7, 9, 11] },
  { id: "dorian", label: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: "phrygian", label: "Phrygian", steps: [0, 1, 3, 5, 7, 8, 10] },
  { id: "lydian", label: "Lydian", steps: [0, 2, 4, 6, 7, 9, 11] },
  { id: "mixolydian", label: "Mixolydian", steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: "majPent", label: "Major Pentatonic", steps: [0, 2, 4, 7, 9] },
  { id: "minPent", label: "Minor Pentatonic", steps: [0, 3, 5, 7, 10] },
  { id: "blues", label: "Blues", steps: [0, 3, 5, 6, 7, 10] },
];

/** Pitch classes (0-11) of `scaleId` on `root` (0 = C), or null for unknown/"off". */
export function scalePitchClasses(root: number, scaleId: string): Set<number> | null {
  const def = SCALES.find((s) => s.id === scaleId);
  if (!def) return null;
  const r = ((root % 12) + 12) % 12;
  return new Set(def.steps.map((s) => (r + s) % 12));
}

/**
 * Snap `pitch` into the scale. dir 0 = nearest (ties go up), +1/−1 = strictly the
 * next in-scale pitch above/below (scale-degree transpose). Clamped to 0..127.
 */
export function snapPitchToScale(pitch: number, pcs: ReadonlySet<number>, dir: 0 | 1 | -1): number {
  if (pcs.size === 0) return pitch;
  const inScale = (p: number) => pcs.has(((p % 12) + 12) % 12);
  if (dir === 0 && inScale(pitch)) return pitch;
  if (dir !== 0) {
    for (let p = pitch + dir; p >= 0 && p <= 127; p += dir) {
      if (inScale(p)) return p;
    }
    return pitch;
  }
  for (let d = 1; d <= 11; d++) {
    if (pitch + d <= 127 && inScale(pitch + d)) return pitch + d;
    if (pitch - d >= 0 && inScale(pitch - d)) return pitch - d;
  }
  return pitch;
}

/* ============================================================================
 * Grid divisions (1/1 .. 1/32 + triplet) — beats are quarter notes (SPEC §4)
 * ========================================================================= */

export interface DivisionOpt {
  label: string;
  beats: number;
}

export const DIVISIONS: DivisionOpt[] = [
  { label: "1/1", beats: 4 },
  { label: "1/2", beats: 2 },
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 },
  { label: "1/32", beats: 0.125 },
];

export function divisionBeats(label: string): number {
  const d = DIVISIONS.find((x) => x.label === label);
  return d ? d.beats : 0.25;
}

/** Effective step in beats (triplet = ×2/3). */
export function gridStep(divBeats: number, triplet: boolean): number {
  return divBeats * (triplet ? 2 / 3 : 1);
}

export function snapFloor(beat: number, step: number): number {
  return step > 0 ? Math.floor(beat / step + 1e-9) * step : beat;
}

export function snapRound(beat: number, step: number): number {
  return step > 0 ? Math.round(beat / step) * step : beat;
}

export function snapCeil(beat: number, step: number): number {
  return step > 0 ? Math.ceil(beat / step - 1e-9) * step : beat;
}

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Pretty length: "1/8", "1/8T" (triplet), "1/8." (dotted), else "1.75b". */
export function lengthLabel(beats: number): string {
  if (approx(beats, 8)) return "2/1";
  for (const d of DIVISIONS) {
    if (approx(beats, d.beats)) return d.label;
    if (approx(beats, (d.beats * 2) / 3)) return `${d.label}T`;
    if (approx(beats, d.beats * 1.5)) return `${d.label}.`;
  }
  const s = beats.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${s}b`;
}

/* ============================================================================
 * Content extents
 * ========================================================================= */

/** Beats of horizontal content: clip length or last note end, whichever is larger. */
export function contentBeats(clip: MidiClip): number {
  let end = clip.lengthBeats;
  for (const n of clip.notes) {
    const e = n.startBeat + n.lengthBeats;
    if (e > end) end = e;
  }
  return end;
}

/** Velocity-lane bar width for the current zoom. */
export function velBarW(zoomX: number): number {
  return clamp(Math.round(zoomX * 0.25), 3, 9);
}

/**
 * Velocity-lane geometry — the single source of truth for both drawing and hit-testing.
 * The bar for a velocity (1..127) is drawn with its TOP at velToY(velocity, h); velYToVel
 * is its exact inverse so a click maps to the velocity whose bar top sits under the cursor.
 * Mirrors drawVelLane: velT = clamp(v,1,127)/127, y = h - 4 - velT*(h-8).
 */
export function velToY(velocity: number, h: number): number {
  const velT = clamp(velocity, 1, 127) / 127;
  return h - 4 - velT * (h - 8);
}

export function velYToVel(y: number, h: number): number {
  const velT = (h - 4 - y) / Math.max(1, h - 8);
  return clamp(Math.round(velT * 127), 1, 127);
}

/* ============================================================================
 * Render-note merging (gesture preview overlays — preview is LOCAL ONLY, the
 * store is updated exclusively by the engine echo, SPEC §5.8)
 * ========================================================================= */

export interface RenderNote {
  id: number;
  pitch: number;
  velocity: number;
  startBeat: number;
  lengthBeats: number;
  selected: boolean;
  /** alt-drag duplicate preview copy */
  ghost?: boolean;
}

export interface NotePreview {
  moveIds?: Set<number>;
  dBeat?: number;
  dPitch?: number;
  /** alt-drag duplicate: originals stay, ghosts render at the offset */
  copy?: boolean;
  resizeIds?: Set<number>;
  dLen?: number;
  eraseIds?: Set<number>;
  velocity?: Map<number, number>;
  createNote?: { id: number; pitch: number; velocity: number; startBeat: number; lengthBeats: number };
}

export function buildRenderNotes(
  notes: Note[],
  selected: Set<number>,
  p: NotePreview | null,
): RenderNote[] {
  const out: RenderNote[] = [];
  for (const n of notes) {
    if (p?.eraseIds?.has(n.id)) continue;
    let pitch = n.pitch;
    let startBeat = n.startBeat;
    let lengthBeats = n.lengthBeats;
    let velocity = n.velocity;
    if (p?.moveIds?.has(n.id) && !p.copy) {
      pitch = clamp(pitch + (p.dPitch ?? 0), 0, MAX_PITCH);
      startBeat = Math.max(0, startBeat + (p.dBeat ?? 0));
    }
    if (p?.resizeIds?.has(n.id)) {
      lengthBeats = Math.max(MIN_NOTE_LEN, lengthBeats + (p.dLen ?? 0));
    }
    const vOverride = p?.velocity?.get(n.id);
    if (vOverride !== undefined) velocity = vOverride;
    out.push({ id: n.id, pitch, velocity, startBeat, lengthBeats, selected: selected.has(n.id) });
  }
  if (p?.moveIds && p.copy) {
    for (const n of notes) {
      if (!p.moveIds.has(n.id)) continue;
      out.push({
        id: n.id,
        pitch: clamp(n.pitch + (p.dPitch ?? 0), 0, MAX_PITCH),
        velocity: n.velocity,
        startBeat: Math.max(0, n.startBeat + (p.dBeat ?? 0)),
        lengthBeats: n.lengthBeats,
        selected: true,
        ghost: true,
      });
    }
  }
  if (p?.createNote) {
    out.push({ ...p.createNote, selected: true });
  }
  return out;
}

/* ============================================================================
 * CC lane (controller 0..127 = MIDI CC, 128 = pitch bend, 129 = aftertouch)
 * ========================================================================= */

/** Pitch-bend pseudo-controller number (value 0.5 = center). */
export const CC_PITCH_BEND = 128;

/** CC-lane y for a normalized value (same 4px top/bottom padding as the velocity lane). */
export function ccValueToY(value: number, h: number): number {
  return h - 4 - clamp(value, 0, 1) * (h - 8);
}

export function ccYToValue(y: number, h: number): number {
  return clamp((h - 4 - y) / Math.max(1, h - 8), 0, 1);
}

/** Points of one controller, sorted by beat (clip.cc is optional, [] default). */
export function ccLanePoints(cc: MidiCc[] | undefined, controller: number): MidiCc[] {
  const out = (cc ?? []).filter((p) => p.controller === controller);
  out.sort((a, b) => a.beat - b.beat);
  return out;
}

export interface RenderCcPoint {
  id: number;
  beat: number;
  value: number;
  selected: boolean;
  /** pencil-stream preview point (no engine id yet) */
  ghost?: boolean;
}

export interface CcPreview {
  moveIds?: Set<number>;
  dBeat?: number;
  dValue?: number;
  eraseIds?: Set<number>;
  /** pencil stream — replaces existing points inside [lo, hi] */
  draw?: { lo: number; hi: number; points: Array<{ beat: number; value: number }> };
}

/** Merge gesture preview into the lane's points (LOCAL ONLY — engine echo is authoritative). */
export function buildRenderCc(
  points: MidiCc[],
  selected: Set<number>,
  p: CcPreview | null,
): RenderCcPoint[] {
  const out: RenderCcPoint[] = [];
  for (const pt of points) {
    if (p?.eraseIds?.has(pt.id)) continue;
    if (p?.draw && pt.beat >= p.draw.lo - 1e-9 && pt.beat <= p.draw.hi + 1e-9) continue;
    let beat = pt.beat;
    let value = pt.value;
    if (p?.moveIds?.has(pt.id)) {
      beat = Math.max(0, beat + (p.dBeat ?? 0));
      value = clamp(value + (p.dValue ?? 0), 0, 1);
    }
    out.push({ id: pt.id, beat, value, selected: selected.has(pt.id) });
  }
  if (p?.draw) {
    for (const s of p.draw.points) {
      out.push({ id: -1, beat: s.beat, value: s.value, selected: true, ghost: true });
    }
  }
  out.sort((a, b) => a.beat - b.beat);
  return out;
}

/** Nearest CC point under the pointer (±5px x, ±6px y); null when none. */
export function hitTestCcPoint(
  points: MidiCc[],
  x: number,
  y: number,
  v: PrView,
  laneH: number,
): MidiCc | null {
  let best: MidiCc | null = null;
  let bd = 6;
  for (const pt of points) {
    const dx = Math.abs(beatToX(pt.beat, v) - x);
    if (dx > 5) continue;
    if (Math.abs(ccValueToY(pt.value, laneH) - y) > 6) continue;
    if (dx < bd) {
      bd = dx;
      best = pt;
    }
  }
  return best;
}

/* ============================================================================
 * Hit testing
 * ========================================================================= */

export interface NoteHit {
  note: Note;
  /** pointer is in the right-edge resize zone */
  edge: boolean;
}

/** Topmost (= last in array) note under the pointer; edge = right-resize zone. */
export function hitTestNote(notes: Note[], x: number, y: number, v: PrView): NoteHit | null {
  const pitch = yToPitch(y, v);
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.pitch !== pitch) continue;
    const x0 = beatToX(n.startBeat, v);
    const x1 = beatToX(n.startBeat + n.lengthBeats, v);
    const w = x1 - x0;
    if (x < x0 || x > x1 + 2) continue;
    const edgeZone = Math.min(EDGE_PX, Math.max(3, w * 0.3));
    return { note: n, edge: x >= x1 - edgeZone };
  }
  return null;
}

/** Note rect intersects a marquee rect (px). */
export function noteInRect(
  n: { pitch: number; startBeat: number; lengthBeats: number },
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  v: PrView,
): boolean {
  const x0 = beatToX(n.startBeat, v);
  const x1 = beatToX(n.startBeat + n.lengthBeats, v);
  const y0 = pitchTop(n.pitch, v);
  const y1 = y0 + v.rowH;
  const lx = Math.min(rx0, rx1);
  const hx = Math.max(rx0, rx1);
  const ly = Math.min(ry0, ry1);
  const hy = Math.max(ry0, ry1);
  return x1 >= lx && x0 <= hx && y1 >= ly && y0 <= hy;
}
