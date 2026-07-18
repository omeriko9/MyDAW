/**
 * glyphs.ts — the notation "font": which outline to draw, how wide it is, where it hangs.
 *
 * The shapes themselves come from Bravura (see bravura.ts — real SMuFL outlines, vendored
 * as path data, no runtime font). Hand-drawn approximations were good enough to prove the
 * engine but never going to look like engraving; a G clef in particular is ~40 bezier
 * segments of accumulated tradition and is not worth re-deriving.
 *
 * This module owns the RULES around those outlines — registration, widths, and the few
 * marks that are geometry rather than glyphs (ties, beams, stems, ledger lines).
 */

import { BBOX, BRAVURA, STEM_ANCHOR } from "./bravura";

export { glyphAt, unitScale, BRAVURA, BBOX } from "./bravura";

const n = (v: number): string => (Math.round(v * 1000) / 1000).toString();

/* ============================================================================
 * Noteheads — registered at the LEFT edge, vertically centred (SMuFL)
 * ========================================================================= */

export function noteheadGlyph(value: number): string {
  if (value <= 0.5) return "noteheadDoubleWhole";
  if (value === 1) return "noteheadWhole";
  if (value === 2) return "noteheadHalf";
  return "noteheadBlack";
}

export const noteheadWidth = (value: number): number => BBOX[noteheadGlyph(value)]?.w ?? 1.18;
export const noteheadHalfWidth = (value: number): number => noteheadWidth(value) / 2;

/** Black-notehead half width — the unit stems, dots and spacing key off. */
export const HEAD_HALF = (BBOX.noteheadBlack?.w ?? 1.18) / 2;

/**
 * Stem attachment offset from the notehead CENTRE, in staff spaces.
 * x: which side the stem runs down; y: the small vertical offset SMuFL specifies.
 */
export function stemAttach(value: number, up: boolean): { dx: number; dy: number } {
  const a = STEM_ANCHOR[noteheadGlyph(value)];
  const half = noteheadHalfWidth(value);
  if (!a) return { dx: up ? half : -half, dy: 0 };
  const [ux, uy] = a.upSE;
  const [dx, dy] = a.downNW;
  // Anchors are measured from the glyph's left edge; re-base them on the centre.
  return up ? { dx: ux - half, dy: -uy } : { dx: dx - half, dy: -dy };
}

/* ============================================================================
 * Rests, accidentals, flags, clefs, digits
 * ========================================================================= */

/** Rests are registered on the middle staff line, except whole/half which hang off a line. */
export function restGlyph(value: number): string {
  switch (value) {
    case 1:
      return "restWhole";
    case 2:
      return "restHalf";
    case 4:
      return "restQuarter";
    case 8:
      return "rest8th";
    case 16:
      return "rest16th";
    case 32:
      return "rest32nd";
    default:
      return "rest64th";
  }
}

export const restWidth = (value: number): number => BBOX[restGlyph(value)]?.w ?? 1;

export function accidentalGlyph(alter: number): string | null {
  switch (alter) {
    case 2:
      return "accidentalDoubleSharp";
    case 1:
      return "accidentalSharp";
    case 0:
      return "accidentalNatural";
    case -1:
      return "accidentalFlat";
    case -2:
      return "accidentalDoubleFlat";
    default:
      return null;
  }
}

/** Room an accidental needs before its notehead, including breathing space. */
export function accidentalWidth(alter: number): number {
  const g = accidentalGlyph(alter);
  return (g ? (BBOX[g]?.w ?? 1) : 0) + 0.22;
}

/** Flags are whole glyphs per duration (a 16th flag is one outline, not two 8ths). */
export function flagGlyph(value: number, up: boolean): string | null {
  const side = up ? "Up" : "Down";
  switch (value) {
    case 8:
      return `flag8th${side}`;
    case 16:
      return `flag16th${side}`;
    case 32:
      return `flag32nd${side}`;
    case 64:
      return `flag64th${side}`;
    default:
      return null;
  }
}

export type ClefName = "treble" | "bass" | "alto";

export const clefGlyph = (clef: ClefName): string =>
  clef === "treble" ? "gClef" : clef === "bass" ? "fClef" : "cClef";

/** Width a clef occupies, plus the space engravers leave after it. */
export const clefWidth = (clef: ClefName): number => (BBOX[clefGlyph(clef)]?.w ?? 2.7) + 0.7;

export const digitGlyph = (ch: string): string => `timeSig${ch}`;
export const digitWidth = (ch: string): number => BBOX[digitGlyph(ch)]?.w ?? 1.7;
export const digitsWidth = (s: string): number =>
  s.split("").reduce((w, c) => w + digitWidth(c), 0);

export const DOT_W = BBOX.augmentationDot?.w ?? 0.3;

/** Brace outline height in staff spaces at scale 1 — the renderer stretches it to fit. */
export const BRACE_H = BBOX.brace?.h ?? 3.988;
export const BRACE_W = BBOX.brace?.w ?? 0.33;

/* ============================================================================
 * Marks that are geometry, not glyphs
 * ========================================================================= */

/**
 * A tie or slur: a crescent between two points, bulging `dir` (-1 up, +1 down), drawn in
 * STAFF-SPACE units. Thickness tapers to the tips — a constant-width arc reads as a
 * drawing mistake rather than a tie.
 */
export function tiePath(x1: number, y1: number, x2: number, y2: number, dir: -1 | 1): string {
  const dx = x2 - x1;
  const span = Math.max(0.6, Math.abs(dx));
  const h = Math.min(1.15, 0.3 + span * 0.16) * dir;
  const t = Math.min(0.17, 0.07 + span * 0.02); // waist thickness
  const mx1 = x1 + dx * 0.28;
  const mx2 = x1 + dx * 0.72;
  const my1 = y1 + (y2 - y1) * 0.28 + h;
  const my2 = y1 + (y2 - y1) * 0.72 + h;
  return (
    `M${n(x1)} ${n(y1)}C${n(mx1)} ${n(my1)} ${n(mx2)} ${n(my2)} ${n(x2)} ${n(y2)}` +
    `C${n(mx2)} ${n(my2 + t)} ${n(mx1)} ${n(my1 + t)} ${n(x1)} ${n(y1)}Z`
  );
}
