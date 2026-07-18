/**
 * notation.ts — the engraving MODEL: MIDI notes → measures of spelled, rhythmically
 * notatable elements. Pure (no React, no DOM, no engine), so every rule here is unit
 * testable; layout.ts turns this into coordinates and SheetMusic.tsx draws it.
 *
 * Three problems are solved here, in order:
 *   1. SPELLING   which letter+accidental a MIDI pitch gets in a given key (line of fifths)
 *   2. RHYTHM     an arbitrary duration → the tied chain of real note values a reader
 *                 expects, split at the metric boundaries notation requires
 *   3. GROUPING   which notes share a beam, and which way stems point
 *
 * Everything is measured in TICKS (TPQ per quarter note) to keep the arithmetic exact —
 * beats are floating point and 1/3 (triplets) would drift.
 */

/* ============================================================================
 * Units
 * ========================================================================= */

/** Ticks per quarter note. 960 divides by 2,3,4,5,6,8 — triplets and quintuplets stay exact. */
export const TPQ = 960;
export const TICKS_PER_WHOLE = TPQ * 4;

/** Note value = the denominator: 1 = whole, 4 = quarter, 16 = sixteenth. */
export type NoteValue = 1 | 2 | 4 | 8 | 16 | 32 | 64;
export const NOTE_VALUES: NoteValue[] = [1, 2, 4, 8, 16, 32, 64];

export interface Meter {
  num: number;
  den: number;
}

export const meterTicks = (m: Meter): number => (TICKS_PER_WHOLE * m.num) / m.den;

/** A compound meter (6/8, 9/8, 12/8) beams in dotted-quarter groups. */
export const isCompound = (m: Meter): boolean => m.den === 8 && m.num % 3 === 0 && m.num > 3;

/** Ticks of one metric beat — the pulse a listener taps. */
export function beatTicks(m: Meter): number {
  const unit = TICKS_PER_WHOLE / m.den;
  return isCompound(m) ? unit * 3 : unit;
}

/** Duration: a note value plus augmentation dots. */
export interface Dur {
  value: NoteValue;
  dots: 0 | 1 | 2;
  ticks: number;
}

export function durTicks(value: NoteValue, dots: 0 | 1 | 2): number {
  const base = TICKS_PER_WHOLE / value;
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
}

/** Every notatable duration, longest first — the vocabulary the decomposer draws from. */
const DUR_TABLE: Dur[] = (() => {
  const out: Dur[] = [];
  for (const value of NOTE_VALUES) {
    for (const dots of [0, 1, 2] as const) {
      const ticks = durTicks(value, dots);
      if (Number.isInteger(ticks) && ticks > 0) out.push({ value, dots, ticks });
    }
  }
  return out.sort((a, b) => b.ticks - a.ticks);
})();

/** Number of flags/beams a value carries (8th = 1, 16th = 2 …). 0 = unbeamable. */
export function flagCount(value: NoteValue): number {
  switch (value) {
    case 8:
      return 1;
    case 16:
      return 2;
    case 32:
      return 3;
    case 64:
      return 4;
    default:
      return 0;
  }
}

/* ============================================================================
 * 1. Pitch spelling — the line of fifths
 * =========================================================================
 * Every spelling of every pitch sits at an integer position on the line of fifths
 * (… F=-1, C=0, G=1, D=2 …); positions 12 apart are enharmonic (C#=7, Db=-5).
 * A key signature occupies a 7-position window, so the RIGHT spelling of a pitch is
 * simply the candidate nearest that window. This is why F# major spells a black key
 * as E# and Db major spells the same key as F — with no special cases.
 */

const FIFTH_LETTERS = ["C", "G", "D", "A", "E", "B", "F"] as const;
/** Semitone of each natural letter above C. */
const LETTER_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Diatonic index of each letter (C=0 … B=6) — this is what staff position counts. */
const LETTER_STEP: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

export interface Spelled {
  /** "C".."B" */
  letter: string;
  /** −2 … +2 semitones (flat/sharp) */
  alter: number;
  /** Scientific octave: middle C (MIDI 60) is C4. */
  octave: number;
  /** Absolute diatonic step: octave*7 + letterStep. Staff position derives from this. */
  step: number;
  /** MIDI pitch this spelling renders. */
  pitch: number;
}

/**
 * Spell `pitch` for a key signature of `fifths` accidentals (−7 flats … +7 sharps).
 * The window centre sits two fifths above the tonic, the middle of the diatonic set.
 */
export function spellPitch(pitch: number, fifths: number): Spelled {
  const pc = ((pitch % 12) + 12) % 12;
  // Candidates for this pitch class are n ≡ 7·pc (mod 12); pick the one nearest the key.
  const base = (7 * pc) % 12;
  const centre = fifths + 1;
  const n = base + 12 * Math.round((centre - base) / 12);

  const letter = FIFTH_LETTERS[((n % 7) + 7) % 7];
  const alter = Math.floor((n + 1) / 7);
  // Octave from the pitch the spelling must render (handles B#3 = MIDI 60 correctly).
  const octave = Math.floor((pitch - alter - LETTER_SEMITONE[letter]) / 12) - 1;
  return { letter, alter, octave, step: octave * 7 + LETTER_STEP[letter], pitch };
}

/** Accidentals a key signature draws, in the order they are written. */
export function keySignatureAccidentals(fifths: number): { letter: string; alter: number }[] {
  const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
  const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];
  const out: { letter: string; alter: number }[] = [];
  const n = Math.min(7, Math.abs(fifths));
  for (let i = 0; i < n; i++) {
    out.push(fifths > 0 ? { letter: SHARP_ORDER[i], alter: 1 } : { letter: FLAT_ORDER[i], alter: -1 });
  }
  return out;
}

/** Human name of a key signature, e.g. 2 → "D major" / "B minor". */
export function keyName(fifths: number, minor = false): string {
  const MAJ = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
  const MIN = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"];
  const i = Math.max(0, Math.min(14, fifths + 7));
  return minor ? `${MIN[i]} minor` : `${MAJ[i]} major`;
}

/**
 * Guess the key from the notes actually played — weighted pitch-class profile scored
 * against every major and minor key (a light Krumhansl–Schmuckler). Notes are weighted
 * by duration, because a long tonic says more than a passing sixteenth.
 */
export function detectKey(
  notes: { pitch: number; ticks: number }[],
): { fifths: number; minor: boolean } {
  if (notes.length === 0) return { fifths: 0, minor: false };
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.pitch % 12) + 12) % 12] += Math.max(1, n.ticks);

  // Krumhansl profiles, normalised at use.
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (profile: number[], tonic: number): number => {
    let s = 0;
    for (let i = 0; i < 12; i++) s += hist[(tonic + i) % 12] * profile[i];
    return s;
  };

  let best = { score: -Infinity, tonic: 0, minor: false };
  for (let tonic = 0; tonic < 12; tonic++) {
    const maj = corr(MAJOR, tonic);
    if (maj > best.score) best = { score: maj, tonic, minor: false };
    const min = corr(MINOR, tonic);
    if (min > best.score) best = { score: min, tonic, minor: true };
  }
  // Tonic pitch class → fifths, choosing the signature humans actually write.
  const MAJOR_FIFTHS: Record<number, number> = {
    0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1,
  };
  const MINOR_FIFTHS: Record<number, number> = {
    9: 0, 4: 1, 11: 2, 6: 3, 1: 4, 8: 5, 3: -3, 10: -2, 5: -1, 0: -3, 7: -2, 2: -1,
  };
  const fifths = best.minor ? (MINOR_FIFTHS[best.tonic] ?? 0) : (MAJOR_FIFTHS[best.tonic] ?? 0);
  return { fifths, minor: best.minor };
}

/* ============================================================================
 * 2. Rhythm — durations a reader expects
 * ========================================================================= */

/**
 * Metric boundary strengths inside a measure, strongest first: the whole measure, then
 * halves (simple) or dotted-beat groups (compound), then beats, then each binary
 * subdivision. A note may not straddle a boundary STRONGER than the note itself — that
 * is exactly why a quarter starting off-beat is written as two tied eighths.
 */
function boundaryLadder(meter: Meter): number[] {
  const total = meterTicks(meter);
  const beat = beatTicks(meter);
  const out: number[] = [total];
  if (!isCompound(meter) && meter.num % 2 === 0 && total / 2 > beat) out.push(total / 2);
  out.push(beat);
  for (let d = beat / 2; d >= 15; d /= 2) out.push(d);
  return out.filter((b, i, a) => Number.isInteger(b) && a.indexOf(b) === i).sort((a, b) => b - a);
}

/**
 * True when [pos, pos+len) crosses a boundary at least as coarse as the note itself.
 *
 * The bound is `b >= len`, not `b > len`: a quarter note starting off the beat spans a
 * boundary exactly its own size, and that is precisely the case notation must split
 * (it becomes two tied eighths). Finer boundaries are always spannable — a half note on
 * beat 1 crosses the beat-2 line and is still just a half note.
 */
function crossesStrongerBoundary(pos: number, len: number, ladder: number[]): boolean {
  for (const b of ladder) {
    if (b < len) break; // ladder is descending — everything below here is finer
    if (Math.floor(pos / b) !== Math.floor((pos + len - 1) / b)) return true;
  }
  return false;
}

/**
 * Split a duration starting at `pos` (ticks from the START OF ITS MEASURE) into the chain
 * of note values a reader expects, longest-first. Callers tie the results together.
 * `allowDots = false` produces plain values only (some engravers prefer this for rests).
 */
export function decomposeDuration(
  pos: number,
  len: number,
  meter: Meter,
  allowDots = true,
): Dur[] {
  const ladder = boundaryLadder(meter);
  const out: Dur[] = [];
  let p = pos;
  let remaining = len;
  let guard = 0;
  while (remaining > 0 && guard++ < 64) {
    let picked: Dur | null = null;
    for (const d of DUR_TABLE) {
      if (d.ticks > remaining) continue;
      if (!allowDots && d.dots !== 0) continue;
      if (crossesStrongerBoundary(p, d.ticks, ladder)) continue;
      picked = d;
      break;
    }
    if (!picked) {
      // Duration below a 64th (or an unnotatable remainder) — round it away.
      break;
    }
    out.push(picked);
    p += picked.ticks;
    remaining -= picked.ticks;
  }
  return out;
}

/* ============================================================================
 * Model
 * ========================================================================= */

export interface NotatedHead {
  spelled: Spelled;
  /** Draw an accidental before this head (decided per measure, not per note). */
  accidental: number | null;
  /** Tie continues INTO / OUT OF this head. */
  tieFrom: boolean;
  tieTo: boolean;
  /** Source note id, for selection + playback highlighting. */
  noteId: number;
  velocity: number;
  /** Head is on the far side of the stem (a second against its neighbour). */
  displaced?: boolean;
}

export interface NotatedElement {
  kind: "note" | "rest";
  /** Absolute ticks from the start of the piece. */
  start: number;
  dur: Dur;
  heads: NotatedHead[];
  staff: number;
  /** Beam group id; elements sharing one are beamed together. */
  beam: number | null;
  /** true = stem up. */
  stemUp: boolean;
  /** Index within its beam group (0 = first). */
  beamIndex?: number;
  beamCount?: number;
}

export interface NotatedMeasure {
  index: number;
  start: number;
  ticks: number;
  meter: Meter;
  /** One element list per staff. */
  staves: NotatedElement[][];
  /** Meter/key printed at this measure (changes only). */
  showMeter: boolean;
  showKey: boolean;
  /** Loudest velocity in the measure, for optional dynamics. */
  velocity: number;
}

export interface SourceNote {
  id: number;
  /** Absolute position in ticks. */
  start: number;
  ticks: number;
  pitch: number;
  velocity: number;
}

export interface BuildOptions {
  meter: Meter;
  fifths: number;
  /** Quantise onsets/lengths to this grid in ticks (0 = leave untouched). */
  quantize: number;
  /** Two staves split at this pitch (60 = middle C); null = single staff. */
  splitPitch: number | null;
  /** Semitones to transpose the written pitch (concert → written). */
  transpose: number;
  /** Pad the score out to at least this many measures. */
  minMeasures?: number;
}

const q = (v: number, grid: number): number => (grid > 0 ? Math.round(v / grid) * grid : v);

/**
 * MIDI notes → measures. The heavy lifting: quantise, split staves, collapse simultaneous
 * notes into chords, fill the gaps with rests, decompose everything into notatable values
 * (tying across the splits), then decide accidentals, stems and beams.
 */
export function buildScore(notes: SourceNote[], opt: BuildOptions): NotatedMeasure[] {
  const mTicks = meterTicks(opt.meter);
  const staffCount = opt.splitPitch === null ? 1 : 2;

  // ---- quantise + transpose, drop anything that quantises to nothing ----
  const src = notes
    .map((n) => ({
      ...n,
      pitch: n.pitch + opt.transpose,
      start: Math.max(0, q(n.start, opt.quantize)),
      ticks: Math.max(opt.quantize || 1, q(n.ticks, opt.quantize)),
    }))
    .filter((n) => n.pitch >= 0 && n.pitch <= 127)
    .sort((a, b) => a.start - b.start || b.pitch - a.pitch);

  const lastEnd = src.reduce((m, n) => Math.max(m, n.start + n.ticks), 0);
  const measureCount = Math.max(opt.minMeasures ?? 1, Math.ceil(lastEnd / mTicks) || 1);

  const measures: NotatedMeasure[] = [];
  for (let i = 0; i < measureCount; i++) {
    measures.push({
      index: i,
      start: i * mTicks,
      ticks: mTicks,
      meter: opt.meter,
      staves: Array.from({ length: staffCount }, () => []),
      showMeter: i === 0,
      showKey: i === 0,
      velocity: 0,
    });
  }

  for (let staff = 0; staff < staffCount; staff++) {
    const mine = src.filter((n) =>
      opt.splitPitch === null ? true : staff === 0 ? n.pitch >= opt.splitPitch : n.pitch < opt.splitPitch,
    );
    layoutVoice(mine, measures, staff, opt);
  }

  for (const m of measures) {
    for (const st of m.staves) {
      for (const el of st) for (const h of el.heads) m.velocity = Math.max(m.velocity, h.velocity);
    }
  }
  return measures;
}

/**
 * One staff = one voice: chords at each onset, rests between them, every duration cut to
 * the next onset (an overlapping legato line becomes a readable monophonic part rather
 * than an unreadable pile of voices).
 */
function layoutVoice(
  notes: SourceNote[],
  measures: NotatedMeasure[],
  staff: number,
  opt: BuildOptions,
): void {
  const mTicks = meterTicks(opt.meter);
  const total = measures.length * mTicks;

  // Group into chords by onset.
  const onsets = new Map<number, SourceNote[]>();
  for (const n of notes) {
    const list = onsets.get(n.start);
    if (list) list.push(n);
    else onsets.set(n.start, [n]);
  }
  const starts = [...onsets.keys()].sort((a, b) => a - b);

  type Span = { start: number; end: number; notes: SourceNote[] | null };
  const spans: Span[] = [];
  let cursor = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (s > cursor) spans.push({ start: cursor, end: s, notes: null }); // rest
    const chord = onsets.get(s)!;
    const nextOnset = i + 1 < starts.length ? starts[i + 1] : Infinity;
    const natural = Math.max(...chord.map((n) => n.start + n.ticks));
    const end = Math.min(natural, nextOnset, total);
    if (end > s) spans.push({ start: s, end, notes: chord });
    cursor = Math.max(cursor, end);
  }
  if (cursor < total) spans.push({ start: cursor, end: total, notes: null });

  // Cut spans at barlines, decompose each piece, tie note-pieces together.
  for (const span of spans) {
    let p = span.start;
    let firstPiece = true;
    while (p < span.end) {
      const mIdx = Math.floor(p / mTicks);
      if (mIdx >= measures.length) break;
      const measure = measures[mIdx];
      const barEnd = measure.start + mTicks;
      const chunkEnd = Math.min(span.end, barEnd);
      const pieces = decomposeDuration(p - measure.start, chunkEnd - p, opt.meter, true);
      let pp = p;
      for (const dur of pieces) {
        const isLast = pp + dur.ticks >= span.end;
        measure.staves[staff].push({
          kind: span.notes ? "note" : "rest",
          start: pp,
          dur,
          staff,
          beam: null,
          stemUp: true,
          heads: (span.notes ?? []).map((n) => ({
            spelled: spellPitch(n.pitch, opt.fifths),
            accidental: null,
            tieFrom: !firstPiece,
            tieTo: !isLast,
            noteId: n.id,
            velocity: n.velocity,
          })),
        });
        pp += dur.ticks;
        firstPiece = false;
      }
      p = chunkEnd;
    }
  }

  for (const m of measures) {
    m.staves[staff].sort((a, b) => a.start - b.start);
    assignAccidentals(m.staves[staff], opt.fifths);
    assignStems(m.staves[staff], staff, opt.splitPitch !== null);
    assignBeams(m.staves[staff], m, opt.meter);
    resolveSeconds(m.staves[staff]);
  }
}

/**
 * Accidentals are a per-measure conversation: print one only when the pitch differs from
 * what the key signature (or an earlier accidental in the same measure, same staff line)
 * already established. Tied continuations never re-print one.
 */
function assignAccidentals(elements: NotatedElement[], fifths: number): void {
  const keyAlter = new Map<string, number>();
  for (const a of keySignatureAccidentals(fifths)) keyAlter.set(a.letter, a.alter);
  const measureState = new Map<number, number>(); // staff step → sounding alter

  for (const el of elements) {
    if (el.kind !== "note") continue;
    for (const h of el.heads) {
      const expected = measureState.has(h.spelled.step)
        ? measureState.get(h.spelled.step)!
        : (keyAlter.get(h.spelled.letter) ?? 0);
      if (h.spelled.alter !== expected && !h.tieFrom) {
        h.accidental = h.spelled.alter;
        measureState.set(h.spelled.step, h.spelled.alter);
      } else if (h.spelled.alter !== expected) {
        measureState.set(h.spelled.step, h.spelled.alter);
      }
    }
  }
}

/** Middle staff line as an absolute diatonic step, per clef context. */
export const MIDDLE_STEP_TREBLE = 4 * 7 + LETTER_STEP.B; // B4
export const MIDDLE_STEP_BASS = 3 * 7 + LETTER_STEP.D; // D3

/**
 * Stems point away from the middle line; a chord follows its note furthest from the
 * middle. On a grand staff the upper staff is treble and the lower is bass.
 */
function assignStems(elements: NotatedElement[], staff: number, grand: boolean): void {
  const middle = !grand || staff === 0 ? MIDDLE_STEP_TREBLE : MIDDLE_STEP_BASS;
  for (const el of elements) {
    if (el.kind !== "note" || el.heads.length === 0) continue;
    let far = 0;
    for (const h of el.heads) {
      const d = h.spelled.step - middle;
      if (Math.abs(d) > Math.abs(far)) far = d;
    }
    el.stemUp = far <= 0;
  }
}

let beamSeq = 1;

/**
 * Beam runs of flagged notes that sit inside one beat group (dotted-beat groups in
 * compound time). A rest, a long note, or a group boundary breaks the run; a lone note
 * keeps its flag. The whole group then shares one stem direction — the majority wins,
 * which is what makes beamed passages look deliberate rather than jagged.
 */
function assignBeams(elements: NotatedElement[], measure: NotatedMeasure, meter: Meter): void {
  const group = beatTicks(meter);
  let run: NotatedElement[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const id = beamSeq++;
      let up = 0;
      for (const e of run) up += e.stemUp ? 1 : -1;
      const dir = up >= 0;
      run.forEach((e, i) => {
        e.beam = id;
        e.stemUp = dir;
        e.beamIndex = i;
        e.beamCount = run.length;
      });
    }
    run = [];
  };

  for (const el of elements) {
    const beamable = el.kind === "note" && flagCount(el.dur.value) > 0;
    if (!beamable) {
      flush();
      continue;
    }
    const rel = el.start - measure.start;
    const g = Math.floor(rel / group);
    const prev = run[run.length - 1];
    if (prev && Math.floor((prev.start - measure.start) / group) !== g) flush();
    run.push(el);
  }
  flush();
}

/**
 * Notes a second apart cannot share a side of the stem — displace the upper one (stem up)
 * or lower one (stem down) so the heads sit either side of the stem, as engravers do.
 */
function resolveSeconds(elements: NotatedElement[]): void {
  for (const el of elements) {
    if (el.kind !== "note" || el.heads.length < 2) continue;
    const heads = [...el.heads].sort((a, b) => a.spelled.step - b.spelled.step);
    for (let i = 1; i < heads.length; i++) {
      const gap = heads[i].spelled.step - heads[i - 1].spelled.step;
      if (gap === 1 && !heads[i - 1].displaced) heads[i].displaced = true;
    }
  }
}

/* ============================================================================
 * Conversions used by the pane
 * ========================================================================= */

export const beatsToTicks = (beats: number): number => Math.round(beats * TPQ);
export const ticksToBeats = (ticks: number): number => ticks / TPQ;

/** Grid presets offered in the toolbar, in ticks. */
export const QUANTIZE_PRESETS: { label: string; ticks: number }[] = [
  { label: "None", ticks: 0 },
  { label: "1/4", ticks: TPQ },
  { label: "1/8", ticks: TPQ / 2 },
  { label: "1/8 triplet", ticks: TPQ / 3 },
  { label: "1/16", ticks: TPQ / 4 },
  { label: "1/16 triplet", ticks: TPQ / 6 },
  { label: "1/32", ticks: TPQ / 8 },
];

/** Velocity → the dynamic mark a copyist would write. */
export function dynamicFor(velocity: number): string | null {
  if (velocity <= 0) return null;
  if (velocity < 24) return "pp";
  if (velocity < 44) return "p";
  if (velocity < 60) return "mp";
  if (velocity < 78) return "mf";
  if (velocity < 98) return "f";
  if (velocity < 116) return "ff";
  return "fff";
}
