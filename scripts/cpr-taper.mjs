// cpr-taper.mjs — the calibrated Cubase fader taper (Volume.Value -> linear gain / dB).
//
// SINGLE SOURCE OF TRUTH for decoding the Cubase "Volume Value" fader taper (25856 = 0 dB)
// shared by trackarchive-xml.mjs (oracle), cpr-mixer-test.mjs and cpr-taper-harvest.mjs.
// The C++ importer (engine/src/import/CprImportProvider.cpp, applyVolumeValue25856) embeds
// the identical closed form.
//
// CALIBRATION (2026-06-12, scripts/cpr-taper-harvest.mjs): modern Cubase saves store BOTH
// the taper `Volume.Value` AND `Volume.AnchorValue` (= the true fader gain in dB, f64).
// Harvesting every (Value, AnchorValue) pair with both populated across the 2004-2026
// project corpus (~1476 cpr/bak files) yielded 682 unique calibration points spanning
// Value 1717..32767. 680/682 match the closed form below to < 1e-6 dB (f64 round-trip
// precision); the 2 rejects are stale Value/Anchor desyncs inside .bak files. The previous
// (Value/25856)^2 square-law assumption is CONFIRMED WRONG (up to ~0.4 dB off near -7 dB
// and ~1.9 dB at the +6 dB top).
//
// The taper is piecewise in LINEAR GAIN with round hex knots:
//   Value 32767 (0x7fff) -> gain 2.0   (+6.0206 dB, the classic Cubase fader top)
//   Value 25856 (0x6500) -> gain 1.0   (0 dB)
//   Value 18688 (0x4900) -> gain 0.5   (-6.0206 dB)
//   Value     0          -> gain 0     (-inf)
// linear in gain between the upper knots (slopes 1/6911 and 1/14336 = 0.5/7168), and a
// parabola 0.5*(v/18688)^2 below 18688 (C0-continuous, anchored at gain 0).
// Above 32767 (never observed in the corpus) the top line extrapolates; importer clamps
// gain at 4.0 (+12 dB).

export const CUBASE_FADER_UNITY = 25856; // 0x6500 = 0 dB
export const CUBASE_FADER_MAX = 32767;   // 0x7fff = gain 2.0 (+6.0206 dB)

/** Cubase Volume.Value (25856-based taper) -> linear gain. Exact (calibrated). */
export function cubaseValueToGain(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 25856) return 1 + (v - 25856) / 6911;        // 1.0 .. 2.0 (.. extrapolated)
  if (v >= 18688) return 0.5 + (v - 18688) / 14336;     // 0.5 .. 1.0
  return 0.5 * (v / 18688) * (v / 18688);               // 0 .. 0.5 (parabola)
}

/** Cubase Volume.Value -> dB (-Infinity at/below 0). */
export function cubaseValueToDb(v) {
  const g = cubaseValueToGain(v);
  return g > 0 ? 20 * Math.log10(g) : -Infinity;
}
