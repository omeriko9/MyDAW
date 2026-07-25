/**
 * View-row lanes (TRACK_TYPES_PLAN §3.5-3.8): canvas rendering + hit-testing for the
 * marker / arranger / chord / transpose tracks. These rows show PROJECT-LEVEL data
 * (markers[], arranger, chordEvents[], transposeEvents[]) — the track itself is only
 * the lane. ClipCanvas calls drawViewRow per visible row and viewRowHit from its
 * pointer handlers; commands are fired by ClipCanvas, never from here.
 */

import type { HViewport } from "../../lib/time";
import { beatToPx } from "../../lib/time";
import { withAlpha } from "./layout";
import type { Project, Marker, ArrangerSection, ChordEvent, TransposeEvent } from "../../protocol/types";
import type { TlColors } from "./clipRender";
import { SMALL_FONT } from "./clipRender";

export const TRANSPOSE_RANGE = 24; // ± semitones drawn across the lane height

/* ============================================================================
 * Chord naming
 * ========================================================================= */

export const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Display qualities — value is the SUFFIX appended to the root name. */
export const CHORD_QUALITIES: Array<{ id: string; suffix: string; label: string }> = [
  { id: "maj", suffix: "", label: "Major" },
  { id: "min", suffix: "m", label: "Minor" },
  { id: "7", suffix: "7", label: "Dominant 7" },
  { id: "maj7", suffix: "maj7", label: "Major 7" },
  { id: "min7", suffix: "m7", label: "Minor 7" },
  { id: "dim", suffix: "dim", label: "Diminished" },
  { id: "aug", suffix: "aug", label: "Augmented" },
  { id: "sus2", suffix: "sus2", label: "Sus 2" },
  { id: "sus4", suffix: "sus4", label: "Sus 4" },
  { id: "min6", suffix: "m6", label: "Minor 6" },
  { id: "6", suffix: "6", label: "Major 6" },
];

export function chordLabel(c: ChordEvent): string {
  const q = CHORD_QUALITIES.find((x) => x.id === c.quality);
  const suffix = q ? q.suffix : c.quality === "maj" ? "" : c.quality;
  let s = PITCH_NAMES[((c.root % 12) + 12) % 12] + suffix;
  if (c.tensions) s += c.tensions;
  if (c.bass !== undefined && c.bass >= 0) s += "/" + PITCH_NAMES[c.bass % 12];
  return s;
}

/** Pitch classes sounded by a chord (for the piano-roll chord-tone highlight). */
export function chordPitchClasses(c: ChordEvent): Set<number> {
  const iv: Record<string, number[]> = {
    maj: [0, 4, 7],
    min: [0, 3, 7],
    "7": [0, 4, 7, 10],
    maj7: [0, 4, 7, 11],
    min7: [0, 3, 7, 10],
    dim: [0, 3, 6],
    aug: [0, 4, 8],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
    min6: [0, 3, 7, 9],
    "6": [0, 4, 7, 9],
  };
  const base = iv[c.quality] ?? [0, 4, 7];
  const out = new Set(base.map((i) => (c.root + i) % 12));
  if (c.bass !== undefined && c.bass >= 0) out.add(c.bass % 12);
  return out;
}

/** The chord in effect at `beat` (last event at/before it), or null before the first. */
export function chordAtBeat(chords: readonly ChordEvent[] | undefined, beat: number): ChordEvent | null {
  if (!chords || chords.length === 0) return null;
  let cur: ChordEvent | null = null;
  for (const c of chords) {
    if (c.beat <= beat) cur = c;
    else break;
  }
  return cur;
}

/** The transpose in effect at `beat` (mirrors the engine's bake-time lookup). */
export function transposeAtBeat(events: readonly TransposeEvent[] | undefined, beat: number): number {
  if (!events) return 0;
  let semis = 0;
  for (const t of events) {
    if (t.beat <= beat) semis = t.semitones;
    else break;
  }
  return semis;
}

/* ============================================================================
 * Hit testing
 * ========================================================================= */

export type ViewRowHit =
  | { type: "marker"; marker: Marker; part: "flag" | "body" | "end" }
  | { type: "section"; section: ArrangerSection; part: "body" | "start" | "end" }
  | { type: "chord"; chord: ChordEvent }
  | { type: "transpose"; event: TransposeEvent };

const EDGE_PX = 5;

export function viewRowHit(
  kind: "marker" | "arranger" | "chord" | "transpose",
  project: Project,
  vx: number,
  vp: HViewport,
): ViewRowHit | null {
  if (kind === "marker") {
    // scan back-to-front so later (drawn-on-top) markers win
    for (let i = project.markers.length - 1; i >= 0; i--) {
      const m = project.markers[i];
      const x = beatToPx(m.beat, vp);
      const cycle = (m.endBeat ?? 0) > m.beat;
      if (cycle) {
        const xe = beatToPx(m.endBeat!, vp);
        if (Math.abs(vx - xe) <= EDGE_PX) return { type: "marker", marker: m, part: "end" };
        if (Math.abs(vx - x) <= EDGE_PX) return { type: "marker", marker: m, part: "flag" };
        if (vx > x && vx < xe) return { type: "marker", marker: m, part: "body" };
      } else if (vx >= x - EDGE_PX && vx <= x + 42) {
        return { type: "marker", marker: m, part: "flag" };
      }
    }
    return null;
  }
  if (kind === "arranger") {
    const sections = project.arranger?.sections ?? [];
    for (let i = sections.length - 1; i >= 0; i--) {
      const s = sections[i];
      const x0 = beatToPx(s.startBeat, vp);
      const x1 = beatToPx(s.endBeat, vp);
      if (vx < x0 - EDGE_PX || vx > x1 + EDGE_PX) continue;
      if (Math.abs(vx - x0) <= EDGE_PX) return { type: "section", section: s, part: "start" };
      if (Math.abs(vx - x1) <= EDGE_PX) return { type: "section", section: s, part: "end" };
      return { type: "section", section: s, part: "body" };
    }
    return null;
  }
  if (kind === "chord") {
    const chords = project.chordEvents ?? [];
    for (let i = chords.length - 1; i >= 0; i--) {
      const c = chords[i];
      const x = beatToPx(c.beat, vp);
      if (vx >= x - EDGE_PX && vx <= x + 40) return { type: "chord", chord: c };
    }
    return null;
  }
  const events = project.transposeEvents ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i];
    const x = beatToPx(t.beat, vp);
    if (Math.abs(vx - x) <= EDGE_PX + 3) return { type: "transpose", event: t };
  }
  return null;
}

/* ============================================================================
 * Rendering
 * ========================================================================= */

export interface ViewRowDrawOpts {
  y: number;
  h: number;
  w: number;
  vp: HViewport;
  colors: TlColors;
  trackColor?: string;
  /** live drag preview: replaces the named item's position while dragging */
  preview?: { type: "marker" | "section" | "chord" | "transpose"; id: number; beat: number; endBeat?: number; semitones?: number } | null;
}

function previewBeat(o: ViewRowDrawOpts, type: string, id: number, beat: number): number {
  return o.preview && o.preview.type === type && o.preview.id === id ? o.preview.beat : beat;
}

export function drawMarkerRow(ctx: CanvasRenderingContext2D, project: Project, o: ViewRowDrawOpts): void {
  ctx.font = SMALL_FONT;
  for (const m of project.markers) {
    const beat = previewBeat(o, "marker", m.id, m.beat);
    const rawEnd = m.endBeat ?? 0;
    const endBeat =
      o.preview && o.preview.type === "marker" && o.preview.id === m.id && o.preview.endBeat !== undefined
        ? o.preview.endBeat
        : rawEnd > m.beat
          ? rawEnd + (beat - m.beat) // body drag carries the range
          : 0;
    const x = beatToPx(beat, o.vp);
    const color = m.color || o.colors.accent;
    if (endBeat > beat) {
      // cycle marker: translucent range block + name
      const xe = beatToPx(endBeat, o.vp);
      if (xe < -2 || x > o.w + 2) continue;
      ctx.fillStyle = withAlpha(color, 0.22);
      ctx.fillRect(x, o.y + 2, xe - x, o.h - 4);
      ctx.strokeStyle = withAlpha(color, 0.85);
      ctx.strokeRect(x + 0.5, o.y + 2.5, xe - x - 1, o.h - 5);
      ctx.fillStyle = o.colors.text;
      ctx.fillText(m.name, x + 4, o.y + o.h / 2 + 3.5, Math.max(10, xe - x - 8));
    } else {
      if (x < -50 || x > o.w + 10) continue;
      // point marker: flag
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, o.y + 2);
      ctx.lineTo(x + 9, o.y + 5.5);
      ctx.lineTo(x, o.y + 9);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - 0.5, o.y + 2, 1, o.h - 4);
      ctx.fillStyle = o.colors.textDim;
      ctx.fillText(m.name, x + 11, o.y + o.h / 2 + 3.5);
    }
  }
}

export function drawArrangerRow(ctx: CanvasRenderingContext2D, project: Project, o: ViewRowDrawOpts): void {
  const a = project.arranger;
  if (!a) return;
  ctx.font = SMALL_FONT;
  // chain-repeat counts per section (badge)
  const chainCount = new Map<number, number>();
  for (const id of a.chain) chainCount.set(id, (chainCount.get(id) ?? 0) + 1);
  for (const s of a.sections) {
    const beat = previewBeat(o, "section", s.id, s.startBeat);
    const endBeat =
      o.preview && o.preview.type === "section" && o.preview.id === s.id && o.preview.endBeat !== undefined
        ? o.preview.endBeat
        : s.endBeat + (beat - s.startBeat);
    const x0 = beatToPx(beat, o.vp);
    const x1 = beatToPx(endBeat, o.vp);
    if (x1 < -2 || x0 > o.w + 2) continue;
    const color = s.color || o.colors.accent;
    const inChain = chainCount.has(s.id);
    ctx.fillStyle = withAlpha(color, inChain && a.activeChain ? 0.5 : 0.28);
    ctx.fillRect(x0, o.y + 2, x1 - x0, o.h - 4);
    ctx.strokeStyle = withAlpha(color, 0.9);
    ctx.strokeRect(x0 + 0.5, o.y + 2.5, x1 - x0 - 1, o.h - 5);
    ctx.fillStyle = o.colors.text;
    ctx.fillText(s.name, x0 + 5, o.y + o.h / 2 + 3.5, Math.max(10, x1 - x0 - 10));
    const n = chainCount.get(s.id);
    if (n) {
      // chain badge: xN at the block's right edge
      const label = `×${n}`;
      const tw = ctx.measureText(label).width;
      if (x1 - x0 > tw + 26) {
        ctx.fillStyle = a.activeChain ? o.colors.accent : o.colors.textFaint;
        ctx.fillText(label, x1 - tw - 5, o.y + o.h / 2 + 3.5);
      }
    }
  }
}

export function drawChordRow(ctx: CanvasRenderingContext2D, project: Project, o: ViewRowDrawOpts): void {
  const chords = project.chordEvents ?? [];
  ctx.font = SMALL_FONT;
  for (let i = 0; i < chords.length; i++) {
    const c = chords[i];
    const beat = previewBeat(o, "chord", c.id, c.beat);
    const x = beatToPx(beat, o.vp);
    if (x < -60 || x > o.w + 10) continue;
    ctx.fillStyle = withAlpha(o.trackColor || o.colors.accent, 0.9);
    ctx.fillRect(x - 0.5, o.y + 3, 1, o.h - 6);
    ctx.fillStyle = o.colors.text;
    ctx.fillText(chordLabel(c), x + 4, o.y + o.h / 2 + 3.5);
  }
}

export function transposeToY(semitones: number, y: number, h: number): number {
  const t = (TRANSPOSE_RANGE - semitones) / (2 * TRANSPOSE_RANGE); // +24 at top
  return y + 3 + t * (h - 6);
}

export function yToTranspose(py: number, y: number, h: number): number {
  const t = (py - y - 3) / Math.max(1, h - 6);
  return Math.max(-TRANSPOSE_RANGE, Math.min(TRANSPOSE_RANGE, Math.round(TRANSPOSE_RANGE - t * 2 * TRANSPOSE_RANGE)));
}

export function drawTransposeRow(ctx: CanvasRenderingContext2D, project: Project, o: ViewRowDrawOpts): void {
  const events = project.transposeEvents ?? [];
  ctx.font = SMALL_FONT;
  // zero line
  const zeroY = transposeToY(0, o.y, o.h);
  ctx.strokeStyle = withAlpha(o.colors.border, 0.7);
  ctx.beginPath();
  ctx.moveTo(0, zeroY + 0.5);
  ctx.lineTo(o.w, zeroY + 0.5);
  ctx.stroke();
  const color = o.trackColor || o.colors.accent;
  // step line: value holds until the next event
  ctx.strokeStyle = withAlpha(color, 0.9);
  ctx.beginPath();
  let prevX = 0;
  let prevY = zeroY;
  for (const t of events) {
    const semis =
      o.preview && o.preview.type === "transpose" && o.preview.id === t.id && o.preview.semitones !== undefined
        ? o.preview.semitones
        : t.semitones;
    const beat = previewBeat(o, "transpose", t.id, t.beat);
    const x = beatToPx(beat, o.vp);
    const py = transposeToY(semis, o.y, o.h);
    if (x > prevX) {
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(x, prevY);
    }
    ctx.moveTo(x, prevY);
    ctx.lineTo(x, py);
    prevX = x;
    prevY = py;
  }
  ctx.moveTo(prevX, prevY);
  ctx.lineTo(o.w, prevY);
  ctx.stroke();
  // points + value labels
  for (const t of events) {
    const semis =
      o.preview && o.preview.type === "transpose" && o.preview.id === t.id && o.preview.semitones !== undefined
        ? o.preview.semitones
        : t.semitones;
    const beat = previewBeat(o, "transpose", t.id, t.beat);
    const x = beatToPx(beat, o.vp);
    if (x < -30 || x > o.w + 10) continue;
    const py = transposeToY(semis, o.y, o.h);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, py, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = o.colors.textDim;
    ctx.fillText(semis > 0 ? `+${semis}` : String(semis), x + 6, py + 3.5);
  }
}

export function drawViewRow(
  ctx: CanvasRenderingContext2D,
  kind: "marker" | "arranger" | "chord" | "transpose",
  project: Project,
  o: ViewRowDrawOpts,
): void {
  // lane wash so the special rows read as chrome, not clip space
  ctx.fillStyle = withAlpha(o.colors.border, 0.12);
  ctx.fillRect(0, o.y, o.w, o.h);
  if (kind === "marker") drawMarkerRow(ctx, project, o);
  else if (kind === "arranger") drawArrangerRow(ctx, project, o);
  else if (kind === "chord") drawChordRow(ctx, project, o);
  else drawTransposeRow(ctx, project, o);
}
