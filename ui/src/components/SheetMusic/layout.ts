/**
 * layout.ts — turns the notation model into COORDINATES (pixels), which is where the
 * difference between "notes on lines" and engraving actually lives:
 *
 *  · columns are shared across staves, so a grand staff lines up vertically
 *  · horizontal space grows with duration but sub-linearly (a whole note is wider than
 *    a quarter, not four times wider) — the classic Gould/Ross spacing curve
 *  · beams are fitted lines with clamped slope and a minimum stem length, so a run of
 *    sixteenths reads as one gesture instead of a picket fence
 *  · systems are packed greedily and then justified to the full measure
 *
 * Everything is in pixels derived from `sp` (one staff space), so zoom and print DPI are
 * the same knob.
 */

import {
  dynamicFor,
  flagCount,
  keySignatureAccidentals,
  meterTicks,
  TPQ,
  type NotatedElement,
  type NotatedMeasure,
} from "./notation";
import { accidentalWidth, digitsWidth, HEAD_RX, noteheadWidth, WHOLE_RX } from "./glyphs";

export type Clef = "treble" | "bass" | "alto";

/** Diatonic step sitting on each clef's TOP staff line. */
export const CLEF_TOP_STEP: Record<Clef, number> = { treble: 38, bass: 26, alto: 32 };
/** Staff line the clef glyph anchors to, counted in spaces below the top line. */
export const CLEF_ANCHOR: Record<Clef, number> = { treble: 3, bass: 1, alto: 2 };
/** Key signatures keep their shape between clefs, shifted by whole octaves. */
const KEY_SHIFT: Record<Clef, number> = { treble: 0, bass: -14, alto: -7 };
const SHARP_STEPS = [38, 35, 39, 36, 33, 37, 34];
const FLAT_STEPS = [34, 37, 33, 36, 32, 35, 31];

export interface LaidHead {
  y: number;
  /** Head offset from the element x (seconds are displaced across the stem). */
  dx: number;
  filled: boolean;
  value: number;
  accidental: number | null;
  accX: number;
  tieFrom: boolean;
  tieTo: boolean;
  noteId: number;
  step: number;
}

export interface LaidLedger {
  y: number;
  x1: number;
  x2: number;
}

export interface LaidElement {
  source: NotatedElement;
  /** Notehead centre x (px, absolute in the layout). */
  x: number;
  staff: number;
  heads: LaidHead[];
  ledgers: LaidLedger[];
  stem: { x: number; y1: number; y2: number } | null;
  /** Unbeamed flags to draw at the stem tip. */
  flags: number;
  stemUp: boolean;
  dots: number;
  dotY: number;
  restY: number;
  start: number;
  ticks: number;
}

export interface LaidBeam {
  staff: number;
  /** Level 0 = primary beam; 1 = the sixteenth beam, and so on. */
  level: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LaidTie {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dir: -1 | 1;
  staff: number;
}

export interface LaidMeasure {
  index: number;
  x: number;
  width: number;
  /** Where musical content starts (after clef/key/meter) and how wide it is. */
  contentX: number;
  contentW: number;
  startTick: number;
  ticks: number;
  elements: LaidElement[];
  beams: LaidBeam[];
  ties: LaidTie[];
  showClef: boolean;
  showKey: boolean;
  showMeter: boolean;
  meter: { num: number; den: number };
  dynamic: string | null;
}

export interface LaidSystem {
  /** Top of the system's FIRST staff top-line, relative to the page content box. */
  y: number;
  height: number;
  x: number;
  width: number;
  measures: LaidMeasure[];
  /** Y of each staff's top line, relative to `y`. */
  staffY: number[];
}

export interface LaidPage {
  systems: LaidSystem[];
  height: number;
}

export interface ScoreLayout {
  pages: LaidPage[];
  sp: number;
  width: number;
  staffCount: number;
  clefs: Clef[];
  fifths: number;
  /** Total pixel height of a single continuous flow (page mode uses page heights). */
  height: number;
}

export interface LayoutOptions {
  sp: number;
  /** Width available for music (already excludes page margins). */
  width: number;
  clefs: Clef[];
  fifths: number;
  /** Vertical space between the two staves of a system, in staff spaces. */
  staffGap?: number;
  /** Space between systems, in staff spaces. */
  systemGap?: number;
  /** Page mode: break systems into pages of this content height (px). Null = continuous. */
  pageHeight?: number | null;
  /** Extra top space on the first page for the title block (px). */
  firstPageOffset?: number;
  dynamics?: boolean;
}

const STAFF_H = 4; // staff spaces from top line to bottom line
const IDEAL_STEM = 3.5;
const MIN_STEM = 2.4;
const MAX_BEAM_SLOPE = 0.28; // px per px

/** Y of a diatonic step relative to the staff's top line. */
export const stepY = (step: number, clef: Clef, sp: number): number =>
  ((CLEF_TOP_STEP[clef] - step) * sp) / 2;

/** Staff positions for a key signature's accidentals, in draw order. */
export function keySignatureSteps(fifths: number, clef: Clef): { step: number; alter: number }[] {
  const accs = keySignatureAccidentals(fifths);
  const table = fifths > 0 ? SHARP_STEPS : FLAT_STEPS;
  return accs.map((a, i) => ({ step: table[i] + KEY_SHIFT[clef], alter: a.alter }));
}

/** Width of the clef/key/meter prefix a measure needs, in px. */
function prefixWidth(
  sp: number,
  showClef: boolean,
  showKey: boolean,
  showMeter: boolean,
  fifths: number,
  meter: { num: number; den: number },
): number {
  let w = 0.6 * sp;
  if (showClef) w += 3.1 * sp;
  if (showKey && fifths !== 0) w += (Math.abs(fifths) * 1.05 + 0.5) * sp;
  if (showMeter) w += (Math.max(digitsWidth(String(meter.num)), digitsWidth(String(meter.den))) + 0.9) * sp;
  return w;
}

/**
 * Horizontal room a column of a given duration deserves. Sub-linear on purpose: doubling
 * a note's length must widen it noticeably but not proportionally, or a whole-note bar
 * would dwarf everything around it.
 */
function columnSpace(ticks: number, sp: number): number {
  const q = Math.max(ticks, 1) / TPQ;
  return sp * (1.55 + 2.45 * Math.pow(q, 0.62));
}

interface Column {
  tick: number;
  /** Elements at this tick, per staff. */
  byStaff: Map<number, NotatedElement>;
  x: number;
  width: number;
  accWidth: number;
}

function buildColumns(measure: NotatedMeasure, sp: number): Column[] {
  const ticks = new Set<number>();
  for (const staff of measure.staves) for (const el of staff) ticks.add(el.start);
  const sorted = [...ticks].sort((a, b) => a - b);
  const end = measure.start + measure.ticks;

  return sorted.map((tick, i) => {
    const byStaff = new Map<number, NotatedElement>();
    measure.staves.forEach((staff, si) => {
      const el = staff.find((e) => e.start === tick);
      if (el) byStaff.set(si, el);
    });
    const next = i + 1 < sorted.length ? sorted[i + 1] : end;
    // Accidentals and wide (whole-note) heads need room before/at the column.
    let accWidth = 0;
    let headWidth = HEAD_RX * 2;
    for (const el of byStaff.values()) {
      let acc = 0;
      for (const h of el.heads) if (h.accidental !== null) acc += accidentalWidth(h.accidental);
      accWidth = Math.max(accWidth, acc * sp);
      headWidth = Math.max(headWidth, noteheadWidth(el.dur.value) * sp);
    }
    return {
      tick,
      byStaff,
      x: 0,
      accWidth,
      width: Math.max(columnSpace(next - tick, sp), headWidth + 0.5 * sp) + accWidth,
    };
  });
}

/** Natural (unjustified) width of a measure. */
function measureWidth(cols: Column[], prefix: number, sp: number): number {
  const content = cols.reduce((s, c) => s + c.width, 0);
  return prefix + Math.max(content, 3 * sp) + 0.7 * sp;
}

/* ============================================================================
 * Element geometry
 * ========================================================================= */

function layElement(
  el: NotatedElement,
  x: number,
  clef: Clef,
  sp: number,
  staff: number,
): LaidElement {
  const out: LaidElement = {
    source: el,
    x,
    staff,
    heads: [],
    ledgers: [],
    stem: null,
    flags: 0,
    stemUp: el.stemUp,
    dots: el.dur.dots,
    dotY: 0,
    restY: 2 * sp,
    start: el.start,
    ticks: el.dur.ticks,
  };

  if (el.kind === "rest") {
    // Whole rest hangs from the second line; half rest sits on the middle line.
    out.restY = el.dur.value === 1 ? sp : 2 * sp;
    out.dotY = out.restY - sp * 0.5;
    return out;
  }

  const filled = el.dur.value >= 4;
  const headHalf = (el.dur.value === 1 ? WHOLE_RX : HEAD_RX) * sp;
  let accCursor = -headHalf - 0.35 * sp;

  // Accidentals stack leftward, furthest-out first, so they never overlap.
  const withAcc = el.heads.filter((h) => h.accidental !== null);
  const accX = new Map<number, number>();
  withAcc
    .slice()
    .sort((a, b) => a.spelled.step - b.spelled.step)
    .forEach((h) => {
      const w = accidentalWidth(h.accidental!) * sp;
      accCursor -= w;
      accX.set(h.noteId, accCursor + w * 0.5);
    });

  for (const h of el.heads) {
    const y = stepY(h.spelled.step, clef, sp);
    // A displaced second sits on the far side of the stem.
    const dx = h.displaced ? (el.stemUp ? headHalf * 2 : -headHalf * 2) : 0;
    out.heads.push({
      y,
      dx,
      filled,
      value: el.dur.value,
      accidental: h.accidental,
      accX: accX.get(h.noteId) ?? 0,
      tieFrom: h.tieFrom,
      tieTo: h.tieTo,
      noteId: h.noteId,
      step: h.spelled.step,
    });
  }

  // Ledger lines, once per occupied line position outside the staff.
  const top = CLEF_TOP_STEP[clef];
  const bottom = top - 8;
  const lx = 1.05 * sp;
  const seen = new Set<number>();
  for (const h of el.heads) {
    const s = h.spelled.step;
    if (s > top) {
      for (let k = top + 2; k <= s; k += 2) {
        if (seen.has(k)) continue;
        seen.add(k);
        out.ledgers.push({ y: stepY(k, clef, sp), x1: -lx, x2: lx });
      }
    } else if (s < bottom) {
      for (let k = bottom - 2; k >= s; k -= 2) {
        if (seen.has(k)) continue;
        seen.add(k);
        out.ledgers.push({ y: stepY(k, clef, sp), x1: -lx, x2: lx });
      }
    }
  }

  // Stem: from the head at the near end to IDEAL_STEM beyond the far one.
  if (el.dur.value >= 2) {
    const ys = out.heads.map((h) => h.y);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const sx = el.stemUp ? headHalf - 0.06 * sp : -headHalf + 0.06 * sp;
    out.stem = el.stemUp
      ? { x: sx, y1: hi, y2: lo - IDEAL_STEM * sp }
      : { x: sx, y1: lo, y2: hi + IDEAL_STEM * sp };
    if (el.beam === null) out.flags = flagCount(el.dur.value);
  }

  // Augmentation dots sit in a space, never on a line.
  const ref = el.stemUp ? Math.min(...out.heads.map((h) => h.y)) : Math.max(...out.heads.map((h) => h.y));
  const onLine = Math.round((ref / sp) * 2) % 2 === 0;
  out.dotY = onLine ? ref - sp * 0.5 : ref;
  return out;
}

/**
 * Fit the beam(s) for one group: a clamped straight line through the outer stems, pushed
 * far enough out that the shortest stem still reads, then secondary beams for the
 * sixteenths and shorter — including single-note stubs.
 */
function layBeams(group: LaidElement[], sp: number, staff: number): LaidBeam[] {
  if (group.length < 2) return [];
  const up = group[0].stemUp;
  const dir = up ? -1 : 1;
  const extreme = (e: LaidElement): number =>
    up ? Math.min(...e.heads.map((h) => h.y)) : Math.max(...e.heads.map((h) => h.y));

  const xs = group.map((e) => e.x + (e.stem?.x ?? 0));
  const ideal = group.map((e) => extreme(e) + dir * IDEAL_STEM * sp);

  let slope = (ideal[ideal.length - 1] - ideal[0]) / Math.max(1, xs[xs.length - 1] - xs[0]);
  slope = Math.max(-MAX_BEAM_SLOPE, Math.min(MAX_BEAM_SLOPE, slope));
  const at = (x: number): number => ideal[0] + slope * (x - xs[0]);

  // Push the beam out until every stem clears MIN_STEM.
  let shift = 0;
  group.forEach((e, i) => {
    const need = extreme(e) + dir * MIN_STEM * sp;
    const have = at(xs[i]);
    if (up ? have > need : have < need) shift = up ? Math.min(shift, need - have) : Math.max(shift, need - have);
  });
  const beamY = (x: number): number => at(x) + shift;

  // Stems now end on the beam (all y values are staff-relative, like head y).
  group.forEach((e, i) => {
    if (e.stem) e.stem.y2 = beamY(xs[i]);
  });

  const out: LaidBeam[] = [];
  const thickness = 0.5 * sp;
  const maxLevel = Math.max(...group.map((e) => flagCount(e.source.dur.value)));
  for (let level = 0; level < maxLevel; level++) {
    const off = dir * level * (thickness + 0.28 * sp);
    let runStart = -1;
    for (let i = 0; i <= group.length; i++) {
      const inRun = i < group.length && flagCount(group[i].source.dur.value) > level;
      if (inRun && runStart < 0) runStart = i;
      if (!inRun && runStart >= 0) {
        const a = runStart;
        const b = i - 1;
        if (b > a) {
          out.push({ staff, level, x1: xs[a], y1: beamY(xs[a]) + off, x2: xs[b], y2: beamY(xs[b]) + off });
        } else {
          // Lone short note inside a longer beam — a stub pointing at its neighbour.
          const back = a > 0;
          const len = 0.85 * sp * (back ? -1 : 1);
          const x1 = xs[a];
          const x2 = xs[a] + len;
          out.push({ staff, level, x1, y1: beamY(x1) + off, x2, y2: beamY(x2) + off });
        }
        runStart = -1;
      }
    }
  }
  return out;
}

/* ============================================================================
 * Score layout
 * ========================================================================= */

export function layoutScore(measures: NotatedMeasure[], opt: LayoutOptions): ScoreLayout {
  const sp = opt.sp;
  const staffCount = opt.clefs.length;
  const staffGap = (opt.staffGap ?? 7) * sp;
  const systemGap = (opt.systemGap ?? 8) * sp;
  const systemH = staffCount === 1 ? STAFF_H * sp : STAFF_H * sp * 2 + staffGap;

  // ---- natural widths ----
  const prepared = measures.map((m, i) => {
    const cols = buildColumns(m, sp);
    return { m, cols, i };
  });

  // Dynamics are marked only where the level CHANGES — a mark under every bar is noise.
  const dynByIndex = new Map<number, string>();
  if (opt.dynamics) {
    let prev: string | null = null;
    for (const m of measures) {
      const d = m.velocity > 0 ? dynamicFor(m.velocity) : null;
      if (d && d !== prev) {
        dynByIndex.set(m.index, d);
        prev = d;
      }
    }
  }

  // ---- pack into systems ----
  interface Pack {
    items: typeof prepared;
    width: number;
  }
  const packs: Pack[] = [];
  let cur: Pack = { items: [], width: 0 };
  for (const p of prepared) {
    const first = cur.items.length === 0;
    const pre = prefixWidth(sp, first, first || p.m.showKey, p.m.showMeter, opt.fifths, p.m.meter);
    const w = measureWidth(p.cols, pre, sp);
    if (!first && cur.width + w > opt.width) {
      packs.push(cur);
      cur = { items: [], width: 0 };
      const pre2 = prefixWidth(sp, true, true, p.m.showMeter, opt.fifths, p.m.meter);
      cur.items.push(p);
      cur.width = measureWidth(p.cols, pre2, sp);
    } else {
      cur.items.push(p);
      cur.width += w;
    }
  }
  if (cur.items.length) packs.push(cur);

  // ---- lay each system out, justified ----
  const systems: LaidSystem[] = [];
  packs.forEach((pack, si) => {
    const isLast = si === packs.length - 1;
    const measuresOut: LaidMeasure[] = [];
    let x = 0;

    // Re-measure with this system's own prefix rules, then justify the slack.
    const infos = pack.items.map((p, idx) => {
      const first = idx === 0;
      const pre = prefixWidth(sp, first, first || p.m.showKey, p.m.showMeter, opt.fifths, p.m.meter);
      return { ...p, pre, natural: measureWidth(p.cols, pre, sp) };
    });
    const natural = infos.reduce((s, i) => s + i.natural, 0);
    const slack = opt.width - natural;
    // The last system keeps natural spacing unless it is nearly full — a half-empty
    // final line stretched to the margin looks broken.
    const stretch = isLast && slack > opt.width * 0.35 ? 0 : slack;
    const contentTotal = infos.reduce((s, i) => s + (i.natural - i.pre), 0);

    for (const info of infos) {
      const contentNat = info.natural - info.pre;
      const extra = contentTotal > 0 ? (stretch * contentNat) / contentTotal : 0;
      const width = info.natural + extra;
      const scale = contentNat > 0 ? (contentNat + extra) / contentNat : 1;

      const contentX = x + info.pre;
      let cx = contentX;
      const elements: LaidElement[] = [];
      const beams: LaidBeam[] = [];
      const ties: LaidTie[] = [];

      for (const col of info.cols) {
        col.x = cx + col.accWidth;
        for (const [staffIdx, el] of col.byStaff) {
          elements.push(layElement(el, col.x, opt.clefs[staffIdx] ?? "treble", sp, staffIdx));
        }
        cx += col.width * scale;
      }

      // Beams, per staff, per group id.
      for (let s = 0; s < staffCount; s++) {
        const groups = new Map<number, LaidElement[]>();
        for (const e of elements) {
          if (e.staff !== s || e.source.beam === null) continue;
          const g = groups.get(e.source.beam) ?? [];
          g.push(e);
          groups.set(e.source.beam, g);
        }
        for (const g of groups.values()) {
          g.sort((a, b) => a.x - b.x);
          beams.push(...layBeams(g, sp, s));
        }
      }

      measuresOut.push({
        index: info.m.index,
        x,
        width,
        contentX,
        contentW: width - info.pre,
        startTick: info.m.start,
        ticks: info.m.ticks,
        elements,
        beams,
        ties,
        showClef: info === infos[0],
        showKey: info === infos[0] || info.m.showKey,
        showMeter: info.m.showMeter,
        meter: info.m.meter,
        dynamic: dynByIndex.get(info.m.index) ?? null,
      });
      x += width;
    }

    systems.push({
      y: 0,
      height: systemH,
      x: 0,
      width: x,
      measures: measuresOut,
      staffY: staffCount === 1 ? [0] : [0, STAFF_H * sp + staffGap],
    });
  });

  // ---- ties (within a system; a tie across a system break is dropped) ----
  for (const sys of systems) {
    const pending = new Map<number, { x: number; y: number; staff: number; up: boolean }>();
    for (const m of sys.measures) {
      for (const el of m.elements.slice().sort((a, b) => a.x - b.x)) {
        for (const h of el.heads) {
          const key = h.noteId;
          const prev = pending.get(key);
          if (h.tieFrom && prev && prev.staff === el.staff) {
            m.ties.push({
              x1: prev.x,
              y1: prev.y,
              x2: el.x + h.dx - HEAD_RX * opt.sp * 0.4,
              y2: h.y,
              dir: prev.up ? 1 : -1,
              staff: el.staff,
            });
          }
          if (h.tieTo) {
            pending.set(key, {
              x: el.x + h.dx + HEAD_RX * opt.sp * 0.4,
              y: h.y,
              staff: el.staff,
              up: el.stemUp,
            });
          } else {
            pending.delete(key);
          }
        }
      }
    }
  }

  // ---- stack systems into pages ----
  const pages: LaidPage[] = [];
  let page: LaidPage = { systems: [], height: 0 };
  let y = opt.firstPageOffset ?? 0;
  const limit = opt.pageHeight ?? Infinity;

  for (const sys of systems) {
    if (page.systems.length > 0 && y + sys.height > limit) {
      page.height = y;
      pages.push(page);
      page = { systems: [], height: 0 };
      y = 0;
    }
    sys.y = y;
    page.systems.push(sys);
    y += sys.height + systemGap;
  }
  page.height = y;
  pages.push(page);

  return {
    pages,
    sp,
    width: opt.width,
    staffCount,
    clefs: opt.clefs,
    fifths: opt.fifths,
    height: pages.reduce((s, p) => s + p.height, 0),
  };
}

/**
 * Where a musical position sits on the page — used by the playhead and by
 * click-to-locate. Returns null when the tick is outside the engraved music.
 */
export function tickToPoint(
  layout: ScoreLayout,
  tick: number,
): { page: number; system: LaidSystem; x: number } | null {
  for (let p = 0; p < layout.pages.length; p++) {
    for (const sys of layout.pages[p].systems) {
      for (const m of sys.measures) {
        if (tick >= m.startTick && tick < m.startTick + m.ticks) {
          const frac = (tick - m.startTick) / m.ticks;
          return { page: p, system: sys, x: m.contentX + frac * m.contentW };
        }
      }
    }
  }
  return null;
}

/** Inverse of tickToPoint for a click inside a system. */
export function pointToTick(system: LaidSystem, x: number): number | null {
  for (const m of system.measures) {
    if (x >= m.x && x < m.x + m.width) {
      const frac = Math.max(0, Math.min(1, (x - m.contentX) / Math.max(1, m.contentW)));
      return m.startTick + frac * m.ticks;
    }
  }
  return null;
}

/** Convenience for the renderer: absolute y of a staff's top line inside a page. */
export const staffTop = (sys: LaidSystem, staff: number): number => sys.y + (sys.staffY[staff] ?? 0);

export const measureTicksOf = meterTicks;
