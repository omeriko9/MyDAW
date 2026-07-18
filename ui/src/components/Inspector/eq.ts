/**
 * Channel-EQ helpers (U5) — shared by the Inspector EQ section and its response curve.
 *
 * The type enum is FIXED by the cross-module contract (engine and UI must match):
 *   0=peak(bell), 1=lowShelf, 2=highShelf, 3=highCut(lowpass), 4=lowCut(highpass), 5=notch.
 * gainDb is ignored for cut/notch types. Ranges: freqHz 20..20000, gainDb -24..+24, q 0.1..18.
 *
 * The magnitude response is the standard RBJ (Robert Bristow-Johnson "Audio EQ Cookbook")
 * biquad transfer function evaluated on the unit circle. All math is clamped/guarded so a
 * stray NaN/Inf never reaches the canvas or a knob caption.
 */

import type { EqBand } from "../../protocol/types";

/* ---- enum + ranges (contract) ---- */

export const EQ_TYPE = {
  peak: 0,
  lowShelf: 1,
  highShelf: 2,
  highCut: 3,
  lowCut: 4,
  notch: 5,
} as const;

export const EQ_TYPE_LABELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: EQ_TYPE.peak, label: "Peak" },
  { value: EQ_TYPE.lowShelf, label: "Low Shelf" },
  { value: EQ_TYPE.highShelf, label: "High Shelf" },
  { value: EQ_TYPE.highCut, label: "High Cut" },
  { value: EQ_TYPE.lowCut, label: "Low Cut" },
  { value: EQ_TYPE.notch, label: "Notch" },
];

export const FREQ_MIN = 20;
export const FREQ_MAX = 20000;
export const GAIN_MIN = -24;
export const GAIN_MAX = 24;
export const Q_MIN = 0.1;
export const Q_MAX = 18;

/** EQ types whose gainDb is ignored by the engine (cut / notch). */
export function bandUsesGain(type: number): boolean {
  return type === EQ_TYPE.peak || type === EQ_TYPE.lowShelf || type === EQ_TYPE.highShelf;
}

export function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalize a (possibly engine-supplied or hand-edited) band into the legal ranges. */
export function sanitizeBand(b: EqBand): EqBand {
  return {
    enabled: !!b.enabled,
    type: Number.isFinite(b.type) ? Math.trunc(b.type) : EQ_TYPE.peak,
    freqHz: clampNum(b.freqHz, FREQ_MIN, FREQ_MAX, 1000),
    gainDb: clampNum(b.gainDb, GAIN_MIN, GAIN_MAX, 0),
    q: clampNum(b.q, Q_MIN, Q_MAX, 1),
  };
}

/**
 * Default 4-band starter set. All bands DISABLED so adding EQ is audibly transparent
 * until the user enables a band (the engine only processes enabled bands).
 */
export function defaultBands(): EqBand[] {
  return [
    { enabled: false, type: EQ_TYPE.lowCut, freqHz: 40, gainDb: 0, q: 0.71 },
    { enabled: false, type: EQ_TYPE.peak, freqHz: 200, gainDb: 0, q: 1 },
    { enabled: false, type: EQ_TYPE.peak, freqHz: 2000, gainDb: 0, q: 1 },
    { enabled: false, type: EQ_TYPE.highShelf, freqHz: 8000, gainDb: 0, q: 0.71 },
  ];
}

/* ---- log-frequency mapping for drags + plotting ---- */

const LOG_MIN = Math.log10(FREQ_MIN);
const LOG_MAX = Math.log10(FREQ_MAX);

/** 0..1 (log) -> Hz. */
export function normToFreq(t: number): number {
  const tt = clampNum(t, 0, 1, 0);
  return Math.pow(10, LOG_MIN + tt * (LOG_MAX - LOG_MIN));
}

/** Hz -> 0..1 (log). */
export function freqToNorm(hz: number): number {
  const f = clampNum(hz, FREQ_MIN, FREQ_MAX, FREQ_MIN);
  return (Math.log10(f) - LOG_MIN) / (LOG_MAX - LOG_MIN);
}

export function freqText(hz: number): string {
  const f = clampNum(hz, FREQ_MIN, FREQ_MAX, FREQ_MIN);
  if (f >= 1000) {
    const k = f / 1000;
    return (k >= 10 ? k.toFixed(1) : k.toFixed(2)) + " kHz";
  }
  return Math.round(f) + " Hz";
}

export function gainText(db: number): string {
  const g = clampNum(db, GAIN_MIN, GAIN_MAX, 0);
  return (g > 0 ? "+" : "") + g.toFixed(1) + " dB";
}

/* ============================================================================
 * RBJ biquad coefficients + magnitude
 * ========================================================================= */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/** RBJ cookbook coefficients for one band at a given sample rate. Null if not applicable. */
function biquadFor(band: EqBand, sampleRate: number): Biquad | null {
  const f0 = clampNum(band.freqHz, FREQ_MIN, FREQ_MAX, 1000);
  const q = clampNum(band.q, Q_MIN, Q_MAX, 1);
  const dbGain = bandUsesGain(band.type) ? clampNum(band.gainDb, GAIN_MIN, GAIN_MAX, 0) : 0;

  // Keep w0 strictly inside (0, π) so the geometry never degenerates at Nyquist.
  const w0 = Math.min(Math.PI * 0.999, (2 * Math.PI * f0) / Math.max(1, sampleRate));
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  const A = Math.pow(10, dbGain / 40);

  switch (band.type) {
    case EQ_TYPE.peak: {
      return {
        b0: 1 + alpha * A,
        b1: -2 * cosw,
        b2: 1 - alpha * A,
        a0: 1 + alpha / A,
        a1: -2 * cosw,
        a2: 1 - alpha / A,
      };
    }
    case EQ_TYPE.lowShelf: {
      const tsa = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * (A + 1 - (A - 1) * cosw + tsa),
        b1: 2 * A * (A - 1 - (A + 1) * cosw),
        b2: A * (A + 1 - (A - 1) * cosw - tsa),
        a0: A + 1 + (A - 1) * cosw + tsa,
        a1: -2 * (A - 1 + (A + 1) * cosw),
        a2: A + 1 + (A - 1) * cosw - tsa,
      };
    }
    case EQ_TYPE.highShelf: {
      const tsa = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * (A + 1 + (A - 1) * cosw + tsa),
        b1: -2 * A * (A - 1 + (A + 1) * cosw),
        b2: A * (A + 1 + (A - 1) * cosw - tsa),
        a0: A + 1 - (A - 1) * cosw + tsa,
        a1: 2 * (A - 1 - (A + 1) * cosw),
        a2: A + 1 - (A - 1) * cosw - tsa,
      };
    }
    case EQ_TYPE.highCut: {
      // low-pass
      return {
        b0: (1 - cosw) / 2,
        b1: 1 - cosw,
        b2: (1 - cosw) / 2,
        a0: 1 + alpha,
        a1: -2 * cosw,
        a2: 1 - alpha,
      };
    }
    case EQ_TYPE.lowCut: {
      // high-pass
      return {
        b0: (1 + cosw) / 2,
        b1: -(1 + cosw),
        b2: (1 + cosw) / 2,
        a0: 1 + alpha,
        a1: -2 * cosw,
        a2: 1 - alpha,
      };
    }
    case EQ_TYPE.notch: {
      return {
        b0: 1,
        b1: -2 * cosw,
        b2: 1,
        a0: 1 + alpha,
        a1: -2 * cosw,
        a2: 1 - alpha,
      };
    }
    default:
      return null;
  }
}

/** |H(e^jw)| in dB for one biquad at angular frequency w (0..π). Guarded; 0 dB on failure. */
function biquadMagDb(bq: Biquad, w: number): number {
  const cosw = Math.cos(w);
  const cos2w = Math.cos(2 * w);
  const sinw = Math.sin(w);
  const sin2w = Math.sin(2 * w);

  // numerator/denominator as complex: c0 + c1 e^-jw + c2 e^-2jw
  const numRe = bq.b0 + bq.b1 * cosw + bq.b2 * cos2w;
  const numIm = -(bq.b1 * sinw + bq.b2 * sin2w);
  const denRe = bq.a0 + bq.a1 * cosw + bq.a2 * cos2w;
  const denIm = -(bq.a1 * sinw + bq.a2 * sin2w);

  const numMag2 = numRe * numRe + numIm * numIm;
  const denMag2 = denRe * denRe + denIm * denIm;
  if (!(denMag2 > 1e-30) || !Number.isFinite(numMag2)) return 0;
  const ratio = numMag2 / denMag2;
  if (!(ratio > 1e-30) || !Number.isFinite(ratio)) return -120;
  const db = 10 * Math.log10(ratio); // 10*log10 of |H|^2 == 20*log10|H|
  return Number.isFinite(db) ? db : 0;
}

/**
 * Summed magnitude response (dB) of the ENABLED bands at `n` log-spaced frequencies from
 * FREQ_MIN..FREQ_MAX. Disabled bands contribute nothing (the engine processes only enabled
 * bands). Returns { freqs, db } arrays of length n; never contains NaN/Inf.
 */
export function eqResponseCurve(
  bands: EqBand[],
  sampleRate: number,
  n: number,
): { freqs: number[]; db: number[] } {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const count = Math.max(2, Math.trunc(n));
  const freqs = new Array<number>(count);
  const db = new Array<number>(count).fill(0);

  const active: Biquad[] = [];
  for (const b of bands) {
    if (!b.enabled) continue;
    const bq = biquadFor(b, sr);
    if (bq) active.push(bq);
  }

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const f = normToFreq(t);
    freqs[i] = f;
    let sum = 0;
    const w = Math.min(Math.PI * 0.999, (2 * Math.PI * f) / sr);
    for (const bq of active) sum += biquadMagDb(bq, w);
    db[i] = Number.isFinite(sum) ? sum : 0;
  }
  return { freqs, db };
}
