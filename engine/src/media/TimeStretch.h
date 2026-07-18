// MyDAW — media/TimeStretch.h (E4/Phase 6)
// Offline WSOLA time-stretch: change duration by `ratio` (out ≈ in*ratio) while preserving
// pitch. Planar float32 in/out at the session sample rate. Non-RT (worker thread). Also a
// resample() for pitch transposition (changes pitch + length; combine with stretch to transpose
// at constant length). Mono or stereo; the WSOLA alignment offset is shared across channels.
#pragma once

#include <cstdint>
#include <vector>

namespace mydaw {

// WSOLA stretch. `in` is planar [channel][0..frames). ratio clamped to [0.25, 4.0].
// Returns planar output ~ round(frames*ratio) frames long.
std::vector<std::vector<float>> wsolaStretch(const std::vector<std::vector<float>>& in,
                                             int64_t frames, double ratio, int sampleRate);

// Linear-interpolating resample by `ratio` (out ≈ frames/ratio; ratio>1 = shorter+higher).
std::vector<std::vector<float>> resampleLinear(const std::vector<std::vector<float>>& in,
                                               int64_t frames, double ratio);

} // namespace mydaw
