/**
 * Mirror of the built-in effects' param normalization (engine
 * core/effects/Effects.cpp linNorm/logNorm tables) — the SAME pinned param
 * contract InstrumentEditors.tsx relies on. Techniques set params by NAME in real
 * units ("Release 120 ms"); this maps them to the normalized 0..1 the wire wants.
 *
 * When Effects.cpp adds/changes a param a technique uses, update the table here —
 * catalog.test.ts walks every technique's settings through normFor(), so an unknown
 * name fails the suite instead of silently setting the wrong knob.
 */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const linNorm = (v: number, min: number, max: number) => clamp01((v - min) / (max - min));
export const logNorm = (v: number, min: number, max: number) =>
  clamp01(Math.log(Math.max(v, min) / min) / Math.log(max / min));

type Spec =
  | { lin: [number, number] }
  | { log: [number, number] }
  /** stepped param: pass the step INDEX (normalized = index / (steps − 1)) */
  | { steps: number }
  /** already 0..1 on the engine side — pass through */
  | { raw: true };

export const BUILTIN_PARAM_SPECS: Record<string, Record<string, Spec>> = {
  "builtin:utility": {
    Gain: { lin: [-60, 24] },
    Pan: { lin: [-1, 1] },
    "Invert Phase": { steps: 2 },
    Mono: { steps: 2 },
  },
  "builtin:gate": {
    Threshold: { lin: [-80, 0] },
    Attack: { log: [0.1, 100] },
    Hold: { lin: [0, 500] },
    Release: { log: [5, 2000] },
    Range: { lin: [-80, 0] },
  },
  "builtin:compressor": {
    Threshold: { lin: [-60, 0] },
    Ratio: { log: [1, 20] },
    Attack: { log: [0.1, 100] },
    Release: { log: [5, 2000] },
    Knee: { lin: [0, 24] },
    Makeup: { lin: [0, 24] },
  },
  "builtin:limiter": {
    Ceiling: { lin: [-24, 0] },
    Release: { log: [1, 1000] },
  },
  "builtin:saturator": {
    Drive: { lin: [0, 36] },
    Tone: { log: [1000, 20000] },
    Mix: { lin: [0, 100] },
    Output: { lin: [-24, 6] },
  },
  "builtin:delay": {
    Time: { lin: [1, 2000] },
    Feedback: { lin: [0, 95] },
    Mix: { lin: [0, 100] },
    Tone: { log: [200, 20000] },
    "Ping-Pong": { steps: 2 },
  },
  "builtin:reverb": {
    Size: { raw: true },
    Damp: { raw: true },
    Width: { raw: true },
    Mix: { lin: [0, 100] },
  },
  "builtin:sampler": {
    "Root Note": { steps: 128 },
    Tune: { lin: [-12, 12] },
    Gain: { lin: [-24, 6] },
    Attack: { log: [1, 2000] },
    Release: { log: [1, 4000] },
    Loop: { steps: 2 },
  },
  "builtin:polysynth": {
    "Osc 1 Wave": { steps: 4 },
    "Osc 2 Wave": { steps: 4 },
    "Osc 2 Semi": { steps: 49 },
    "Osc 2 Fine": { lin: [-50, 50] },
    "Osc Mix": { raw: true },
    Sub: { raw: true },
    Noise: { raw: true },
    Cutoff: { log: [30, 18000] },
    Resonance: { raw: true },
    "Filter Type": { steps: 3 },
    "Filter Env": { raw: true },
    "Amp Attack": { log: [1, 4000] },
    "Amp Decay": { log: [1, 4000] },
    "Amp Sustain": { raw: true },
    "Amp Release": { log: [1, 8000] },
    "LFO Depth": { raw: true },
    Width: { raw: true },
    Gain: { lin: [-24, 6] },
  },
};

/** Real-unit (or step-index / raw) value → normalized 0..1 for uid's named param. */
export function normFor(uid: string, name: string, value: number): number {
  const spec = BUILTIN_PARAM_SPECS[uid]?.[name];
  if (!spec) throw new Error(`normFor: unknown builtin param ${uid} / ${name}`);
  if ("lin" in spec) return linNorm(value, spec.lin[0], spec.lin[1]);
  if ("log" in spec) return logNorm(value, spec.log[0], spec.log[1]);
  if ("steps" in spec) return clamp01(value / (spec.steps - 1));
  return clamp01(value);
}
