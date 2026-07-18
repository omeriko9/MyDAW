/**
 * glyphs.ts — the music font, drawn rather than downloaded.
 *
 * Every glyph is an SVG path expressed in STAFF SPACES (1 unit = the gap between two
 * staff lines) with the origin at the glyph's musical anchor — the notehead centre, the
 * clef's reference line, the accidental's notehead. The caller scales by `sp` and
 * translates; nothing here knows about pixels, so the score is resolution independent
 * and prints at whatever DPI the printer offers.
 *
 * Shipping paths instead of a SMuFL font (Bravura et al.) keeps the app dependency-free
 * and self-contained — an embedded font would be a licence and a megabyte.
 */

/* ============================================================================
 * Primitives
 * ========================================================================= */

/**
 * An ellipse as a path, rotated by `rot` degrees. Written as two arcs so noteheads can
 * carry a counter-rotated hole (fill-rule="evenodd"), which is what gives an open
 * notehead its thick/thin waist instead of a flat uniform ring.
 */
export function ellipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rot = 0,
  sweep: 0 | 1 = 1,
): string {
  const rad = (rot * Math.PI) / 180;
  const dx = rx * Math.cos(rad);
  const dy = rx * Math.sin(rad);
  const x1 = cx - dx;
  const y1 = cy - dy;
  const x2 = cx + dx;
  const y2 = cy + dy;
  const r = `${rx} ${ry} ${rot}`;
  return `M${x1} ${y1}A${r} 0 ${sweep} ${x2} ${y2}A${r} 0 ${sweep} ${x1} ${y1}Z`;
}

const n = (v: number): string => (Math.round(v * 1000) / 1000).toString();

/* ============================================================================
 * Noteheads — anchor at the centre of the head, on its staff position
 * ========================================================================= */

/** Notehead half-width in staff spaces; stems and spacing key off this. */
export const HEAD_RX = 0.62;
export const HEAD_RY = 0.45;
export const WHOLE_RX = 0.9;
const HEAD_TILT = -21;

export const NOTEHEAD_FILLED = ellipsePath(0, 0, HEAD_RX, HEAD_RY, HEAD_TILT);

/** Half note: outer ellipse plus a counter-rotated hole. */
export const NOTEHEAD_HALF =
  ellipsePath(0, 0, HEAD_RX, HEAD_RY, HEAD_TILT) +
  ellipsePath(0, 0, HEAD_RX * 0.56, HEAD_RY * 0.42, HEAD_TILT + 42, 0);

/** Whole note: wider, and the hole leans the other way — the classic breve look. */
export const NOTEHEAD_WHOLE =
  ellipsePath(0, 0, WHOLE_RX, HEAD_RY, 0) +
  ellipsePath(0, 0, WHOLE_RX * 0.5, HEAD_RY * 0.5, 68, 0);

export function noteheadPath(value: number): string {
  if (value === 1) return NOTEHEAD_WHOLE;
  if (value === 2) return NOTEHEAD_HALF;
  return NOTEHEAD_FILLED;
}

export const noteheadWidth = (value: number): number => (value === 1 ? WHOLE_RX : HEAD_RX) * 2;

/* ============================================================================
 * Clefs — anchored on their reference staff line (y = 0)
 * ========================================================================= */

/**
 * G clef, anchored with its spiral centre ON the G line (y = 0).
 *
 * Topology matters more than any single control point: the glyph is a near-straight STEM
 * running the full height, with a loop that crosses it twice and winds into the spiral.
 * (Generating the whole thing as one logarithmic spiral — the obvious first idea — draws
 * a convincing numeral 6, because the stem disappears into the curl.) Two strokes:
 * the outer loop+spiral, and the stem with its tail hook.
 */
export const CLEF_TREBLE =
  // outer: top terminal → down the left → across → bottom of the loop → into the spiral
  "M0.3 -4.05" +
  "C-0.3 -3.95 -0.85 -3.2 -0.85 -2.35" +
  "C-0.85 -1.5 -0.28 -0.8 0.22 -0.28" +
  "C0.64 0.18 0.82 0.58 0.72 1.02" +
  "C0.6 1.58 0.02 1.86 -0.38 1.58" +
  "C-0.8 1.28 -0.84 0.7 -0.54 0.34" +
  "C-0.26 0.0 0.16 0.06 0.24 0.36" +
  // stem: straight down through the loop, tail hooking left below the staff
  "M0.3 -4.05" +
  "C0.36 -2.6 0.26 -0.6 0.16 1.1" +
  "C0.1 1.88 0.02 2.36 -0.3 2.62" +
  "C-0.6 2.86 -0.86 2.64 -0.8 2.34";

/**
 * F clef: the comma sits with its eye on the F line (y = 0), the two dots straddle it.
 * Dots are separate filled circles the renderer draws — see CLEF_BASS_DOTS.
 */
export const CLEF_BASS =
  "M-1.02 -1.02C-0.35 -1.38 0.62 -1.15 0.82 -0.42" +
  "C1.02 0.32 0.55 1.05 -0.08 1.55C-0.62 1.98 -1.25 2.22 -1.85 2.3" +
  "C-1.35 2.02 -0.72 1.62 -0.28 1.15C0.18 0.65 0.42 0.05 0.28 -0.42" +
  "C0.12 -0.95 -0.45 -1.05 -1.02 -0.72Z";
export const CLEF_BASS_DOTS: [number, number][] = [
  [1.25, -0.5],
  [1.25, 0.5],
];

/** C clef: two mirrored bows meeting the middle line (y = 0), behind a double bar. */
export const CLEF_ALTO =
  "M-1.25 -2H-0.95V2H-1.25Z" + // thin bar
  "M-0.8 -2H-0.42V2H-0.8Z" + // thick bar
  "M-0.28 -2C0.35 -2 0.72 -1.5 0.72 -1.02C0.72 -0.5 0.42 -0.15 -0.02 0" +
  "C0.42 0.15 0.72 0.5 0.72 1.02C0.72 1.5 0.35 2 -0.28 2" +
  "C0.05 1.72 0.28 1.35 0.28 0.95C0.28 0.42 -0.02 0.12 -0.35 0" +
  "C-0.02 -0.12 0.28 -0.42 0.28 -0.95C0.28 -1.35 0.05 -1.72 -0.28 -2Z";

/* ============================================================================
 * Accidentals — anchored at the notehead they qualify
 * ========================================================================= */

export const ACC_SHARP =
  "M-0.34 -0.95H-0.2V1.05H-0.34Z" + // left vertical
  "M0.2 -1.15H0.34V0.85H0.2Z" + // right vertical
  "M-0.52 0.16L0.52 -0.1V0.2L-0.52 0.46Z" + // lower bar
  "M-0.52 -0.44L0.52 -0.7V-0.4L-0.52 -0.14Z"; // upper bar

export const ACC_FLAT =
  "M-0.3 -1.45H-0.16V0.72C0.1 0.34 0.52 0.28 0.52 0.72" +
  "C0.52 1.12 0.05 1.4 -0.3 1.62Z" +
  "M-0.16 0.98C0.08 0.8 0.3 0.62 0.3 0.82C0.3 1.02 0.06 1.2 -0.16 1.34Z";

export const ACC_NATURAL =
  "M-0.28 -1.15H-0.16V0.72L-0.28 0.68Z" +
  "M0.16 -0.68L0.28 -0.72V1.15H0.16Z" +
  "M-0.28 -0.42L0.28 -0.56V-0.26L-0.28 -0.12Z" +
  "M-0.28 0.28L0.28 0.14V0.44L-0.28 0.58Z";

export const ACC_DOUBLE_SHARP =
  "M-0.4 -0.4L-0.12 -0.12L-0.4 0.16L-0.16 0.4L0.12 0.12L0.4 0.4L0.4 0.1L0.16 -0.12L0.4 -0.36L0.4 -0.4L0.1 -0.4L-0.12 -0.16L-0.36 -0.4Z";

export function accidentalPath(alter: number): string | null {
  if (alter === 0) return ACC_NATURAL;
  if (alter === 1) return ACC_SHARP;
  if (alter === -1) return ACC_FLAT;
  if (alter === 2) return ACC_DOUBLE_SHARP;
  if (alter === -2) return ACC_FLAT; // rendered twice by the caller
  return null;
}

/** Horizontal room an accidental needs, in staff spaces. */
export function accidentalWidth(alter: number): number {
  if (alter === 2) return 0.9;
  if (alter === -2) return 1.55;
  return alter === -1 ? 0.95 : 1.1;
}

/* ============================================================================
 * Rests — anchored on the middle staff line
 * ========================================================================= */

/** Whole rest hangs UNDER the second line from the top; half rest sits ON the middle. */
export const REST_WHOLE = "M-0.62 0H0.62V0.52H-0.62Z";
export const REST_HALF = "M-0.62 -0.52H0.62V0H-0.62Z";

/** Quarter rest — the copyist's zigzag. */
export const REST_QUARTER =
  "M-0.18 -1.22C0.12 -0.88 0.42 -0.62 0.24 -0.28" +
  "C0.06 0.06 -0.28 0.28 -0.06 0.72C-0.34 0.5 -0.52 0.18 -0.3 -0.2" +
  "C-0.12 -0.5 0.06 -0.68 -0.24 -1.02Z" +
  "M-0.06 0.72C0.18 1.02 0.32 1.26 0.2 1.48C0.06 1.24 -0.14 1.0 -0.36 0.86Z";

/** Eighth rest: a slanted stroke with one teardrop; each further beam adds another. */
export function restFlagged(count: number): string {
  let d = "";
  const top = -0.85;
  for (let i = 0; i < count; i++) {
    const y = top + i * 0.62;
    d += `M-0.34 ${n(y)}A0.24 0.24 0 1 1 -0.33 ${n(y + 0.02)}Z`;
    d += `M-0.12 ${n(y)}L0.3 ${n(y - 0.12)}L0.3 ${n(y + 0.06)}L-0.12 ${n(y + 0.16)}Z`;
  }
  // the tail
  d += `M0.28 ${n(top - 0.14)}L0.44 ${n(top - 0.1)}L0.02 ${n(top + count * 0.62 + 0.82)}L-0.14 ${n(
    top + count * 0.62 + 0.78,
  )}Z`;
  return d;
}

export function restPath(value: number): string {
  switch (value) {
    case 1:
      return REST_WHOLE;
    case 2:
      return REST_HALF;
    case 4:
      return REST_QUARTER;
    case 8:
      return restFlagged(1);
    case 16:
      return restFlagged(2);
    case 32:
      return restFlagged(3);
    default:
      return restFlagged(4);
  }
}

/* ============================================================================
 * Flags — anchored at the stem TIP, drawn downward for stem-up notes
 * ========================================================================= */

/**
 * One flag. `up` = the note's stem points up (flag hangs to the right and down).
 * Extra flags repeat at `i * 0.78` staff spaces back along the stem.
 */
export function flagPath(up: boolean, i: number): string {
  const s = up ? 1 : -1;
  const y = i * 0.78 * s;
  return (
    `M0 ${n(y)}` +
    `C${n(0.72)} ${n(y + 0.5 * s)} ${n(0.86)} ${n(y + 1.15 * s)} ${n(0.52)} ${n(y + 1.9 * s)}` +
    `C${n(0.78)} ${n(y + 1.1 * s)} ${n(0.5)} ${n(y + 0.72 * s)} 0 ${n(y + 0.95 * s)}Z`
  );
}

/* ============================================================================
 * Ornaments and marks
 * ========================================================================= */

/**
 * Grand-staff brace spanning `h` staff spaces from y=0 down. A filled outline, not a
 * stroke: a brace is thick at the middle of each half and tapers to points at the tips
 * AND at the waist, which a constant-width stroke cannot express.
 */
export function bracePath(h: number): string {
  const m = h / 2;
  return (
    // right edge, top tip → waist → bottom tip
    `M0.42 0` +
    `C-0.12 ${n(h * 0.12)} 0.34 ${n(m - h * 0.13)} -0.16 ${n(m)}` +
    `C0.34 ${n(m + h * 0.13)} -0.12 ${n(h * 0.88)} 0.42 ${n(h)}` +
    // back up the left edge, bulging further out to give the strokes their weight
    `C-0.5 ${n(h * 0.86)} 0.02 ${n(m + h * 0.15)} -0.52 ${n(m)}` +
    `C0.02 ${n(m - h * 0.15)} -0.5 ${n(h * 0.14)} 0.42 0Z`
  );
}

/**
 * A tie or slur: a crescent between two points, bulging `dir` (-1 up, +1 down).
 * Thickness tapers to the tips, which is what stops it looking like a drawn arc.
 */
export function tiePath(x1: number, y1: number, x2: number, y2: number, dir: -1 | 1): string {
  const dx = x2 - x1;
  const span = Math.max(0.6, Math.abs(dx));
  const h = Math.min(1.15, 0.28 + span * 0.16) * dir;
  const t = Math.min(0.16, 0.06 + span * 0.02); // waist thickness
  const mx1 = x1 + dx * 0.28;
  const mx2 = x1 + dx * 0.72;
  const my1 = y1 + (y2 - y1) * 0.28 + h;
  const my2 = y1 + (y2 - y1) * 0.72 + h;
  return (
    `M${n(x1)} ${n(y1)}C${n(mx1)} ${n(my1)} ${n(mx2)} ${n(my2)} ${n(x2)} ${n(y2)}` +
    `C${n(mx2)} ${n(my2 + t)} ${n(mx1)} ${n(my1 + t)} ${n(x1)} ${n(y1)}Z`
  );
}

/** Augmentation dot. */
export const DOT_R = 0.17;

/* ============================================================================
 * Time signature digits — drawn, so they scale and print with the staff
 * ========================================================================= */

const DIGITS: Record<string, string> = {
  0: "M0.5 0C0.5 -0.85 0.28 -1.25 -0.02 -1.25C-0.32 -1.25 -0.54 -0.85 -0.54 0C-0.54 0.85 -0.32 1.25 -0.02 1.25C0.28 1.25 0.5 0.85 0.5 0ZM0.16 0C0.16 0.78 0.1 1.02 -0.02 1.02C-0.14 1.02 -0.2 0.78 -0.2 0C-0.2 -0.78 -0.14 -1.02 -0.02 -1.02C0.1 -1.02 0.16 -0.78 0.16 0Z",
  1: "M-0.42 -0.82C-0.1 -0.92 0.12 -1.08 0.24 -1.25H0.36V1.02H0.6V1.25H-0.42V1.02H-0.05V-0.72C-0.16 -0.65 -0.3 -0.6 -0.42 -0.58Z",
  2: "M-0.5 1.25C-0.42 0.55 -0.05 0.2 0.12 -0.05C0.28 -0.3 0.32 -0.5 0.32 -0.7C0.32 -0.95 0.2 -1.05 0.04 -1.05C-0.14 -1.05 -0.26 -0.92 -0.26 -0.72C-0.26 -0.62 -0.22 -0.55 -0.22 -0.5C-0.22 -0.4 -0.3 -0.34 -0.4 -0.34C-0.52 -0.34 -0.58 -0.45 -0.58 -0.62C-0.58 -0.98 -0.3 -1.25 0.08 -1.25C0.46 -1.25 0.66 -1.0 0.66 -0.68C0.66 -0.4 0.5 -0.2 0.16 0.08C-0.06 0.26 -0.22 0.45 -0.3 0.62H0.3C0.5 0.62 0.56 0.55 0.62 0.32H0.72L0.62 1.25Z",
  3: "M-0.5 -0.75C-0.44 -1.08 -0.2 -1.25 0.1 -1.25C0.45 -1.25 0.62 -1.05 0.62 -0.82C0.62 -0.6 0.48 -0.42 0.2 -0.32V-0.3C0.52 -0.24 0.7 -0.05 0.7 0.28C0.7 0.7 0.4 1.25 -0.05 1.25C-0.38 1.25 -0.6 1.05 -0.6 0.82C-0.6 0.7 -0.52 0.62 -0.42 0.62C-0.32 0.62 -0.26 0.68 -0.24 0.8C-0.2 0.95 -0.14 1.02 -0.02 1.02C0.18 1.02 0.34 0.78 0.34 0.35C0.34 -0.02 0.22 -0.18 -0.02 -0.18H-0.16V-0.38H-0.04C0.16 -0.38 0.28 -0.52 0.28 -0.78C0.28 -0.98 0.2 -1.06 0.06 -1.06C-0.1 -1.06 -0.2 -0.95 -0.26 -0.72Z",
  4: "M0.28 0.42V-0.75L-0.35 0.42ZM0.28 1.25V0.65H-0.62V0.45L0.32 -1.25H0.6V0.42H0.78V0.65H0.6V1.25Z",
  5: "M-0.42 -1.25H0.55L0.45 -0.9H-0.2L-0.28 -0.42C-0.2 -0.45 -0.12 -0.46 -0.02 -0.46C0.35 -0.46 0.66 -0.22 0.66 0.28C0.66 0.82 0.3 1.25 -0.08 1.25C-0.4 1.25 -0.6 1.05 -0.6 0.82C-0.6 0.7 -0.52 0.62 -0.42 0.62C-0.32 0.62 -0.26 0.68 -0.24 0.8C-0.2 0.95 -0.14 1.02 -0.02 1.02C0.18 1.02 0.3 0.78 0.3 0.32C0.3 -0.08 0.18 -0.26 -0.05 -0.26C-0.18 -0.26 -0.28 -0.2 -0.35 -0.1H-0.5Z",
  6: "M0.05 -1.25C0.38 -1.25 0.58 -1.08 0.58 -0.88C0.58 -0.76 0.5 -0.68 0.4 -0.68C0.3 -0.68 0.24 -0.74 0.22 -0.85C0.2 -0.98 0.14 -1.05 0.02 -1.05C-0.18 -1.05 -0.28 -0.82 -0.3 -0.15C-0.2 -0.35 -0.06 -0.45 0.12 -0.45C0.42 -0.45 0.65 -0.2 0.65 0.32C0.65 0.85 0.38 1.25 0.02 1.25C-0.4 1.25 -0.64 0.82 -0.64 0.05C-0.64 -0.78 -0.35 -1.25 0.05 -1.25ZM0.3 0.35C0.3 -0.08 0.22 -0.25 0.04 -0.25C-0.14 -0.25 -0.28 -0.05 -0.28 0.3C-0.28 0.82 -0.16 1.05 0.02 1.05C0.2 1.05 0.3 0.82 0.3 0.35Z",
  7: "M-0.55 -1.25H0.66V-1.05C0.24 -0.55 0.02 0.25 -0.02 1.25H-0.38C-0.3 0.32 -0.02 -0.42 0.32 -0.9H-0.28C-0.45 -0.9 -0.5 -0.82 -0.55 -0.62H-0.66Z",
  8: "M0.02 -1.25C0.38 -1.25 0.6 -1.05 0.6 -0.78C0.6 -0.55 0.45 -0.38 0.2 -0.25C0.5 -0.1 0.68 0.08 0.68 0.4C0.68 0.9 0.4 1.25 0.0 1.25C-0.4 1.25 -0.66 0.95 -0.66 0.52C-0.66 0.18 -0.48 0.0 -0.2 -0.14C-0.45 -0.3 -0.55 -0.48 -0.55 -0.72C-0.55 -1.02 -0.32 -1.25 0.02 -1.25ZM0.34 0.55C0.34 0.25 0.2 0.08 -0.08 -0.06C-0.25 0.06 -0.32 0.24 -0.32 0.48C-0.32 0.85 -0.18 1.05 0.02 1.05C0.22 1.05 0.34 0.86 0.34 0.55ZM0.28 -0.75C0.28 -0.95 0.18 -1.06 0.02 -1.06C-0.16 -1.06 -0.25 -0.95 -0.25 -0.78C-0.25 -0.55 -0.12 -0.42 0.12 -0.3C0.24 -0.4 0.28 -0.55 0.28 -0.75Z",
  9: "M-0.02 1.25C-0.35 1.25 -0.55 1.08 -0.55 0.88C-0.55 0.76 -0.48 0.68 -0.38 0.68C-0.28 0.68 -0.22 0.74 -0.2 0.85C-0.18 0.98 -0.12 1.05 0.0 1.05C0.2 1.05 0.3 0.82 0.32 0.15C0.22 0.35 0.08 0.45 -0.1 0.45C-0.4 0.45 -0.62 0.2 -0.62 -0.32C-0.62 -0.85 -0.35 -1.25 0.0 -1.25C0.42 -1.25 0.66 -0.82 0.66 -0.05C0.66 0.78 0.38 1.25 -0.02 1.25ZM-0.28 -0.35C-0.28 0.08 -0.2 0.25 -0.02 0.25C0.16 0.25 0.3 0.05 0.3 -0.3C0.3 -0.82 0.18 -1.05 0.0 -1.05C-0.18 -1.05 -0.28 -0.82 -0.28 -0.35Z",
};

/** Digit path anchored at its own centre; scale ≈ 1 staff space per unit. */
export const digitPath = (d: string): string => DIGITS[d] ?? "";

/** Width a digit string occupies, in staff spaces. */
export const digitsWidth = (s: string): number => s.length * 1.28;
