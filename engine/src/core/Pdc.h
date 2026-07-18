// MyDAW — core/Pdc.h (E2)
// Plugin-delay compensation building blocks (SPEC §7):
//   - DelayLine: fixed integer-sample delay applied in place to channel buffers. Allocated
//     at prepare() time on the main thread; processRt() is lock- and allocation-free.
//   - computePdc(): given the flattened render order (feeders before the bus/master they
//     output into) and each entry's insert-chain latency, computes the per-entry alignment
//     delay so every summing point receives time-aligned branches, plus the total latency
//     at master (engine/getStatus pdcSamples).
//
// Alignment model (SPEC §7 "all-path alignment"): walking the topological order, the input
// latency of a bus is the maximum output latency of its feeders; each feeder is delayed by
// (busInputLatency - feederOutputLatency) at its own output so all branches arrive equal.
// Applied recursively this makes every route to master carry the same total latency.
// Sends reuse the same per-track delayed signal (v1 approximation — exact send-path
// compensation would need a second delay line per send; documented tradeoff).

#pragma once

#include <vector>

namespace mydaw {

// Fixed-delay line, stereo-or-fewer channels, processed in place.
class DelayLine {
public:
    // Main thread. Allocates for up to maxDelaySamples (0 = pass-through, no allocation).
    void prepare(int maxDelaySamples, int channels = 2);

    // Main thread (before the plan is published). Clamped to [0, maxDelaySamples].
    void setDelay(int samples);
    int delay() const { return delay_; }

    // RT: delays ch[c][0..frames) in place. No-op when delay() == 0.
    void processRt(float* const* ch, int numCh, int frames) noexcept;

    // RT-safe: zero the delay memory (reset()/plan reuse).
    void reset() noexcept;

private:
    std::vector<std::vector<float>> buf_; // per channel, capacity_ samples
    int capacity_ = 0;
    int delay_ = 0;
    int writePos_ = 0;
};

// One render entry for computePdc(). `outputIndex` is the index (into the same array) of
// the bus/master entry this entry accumulates into, or -1 for "none"-routed entries and
// the master itself. The array MUST be in render (topological) order: every feeder appears
// before its outputIndex target.
struct PdcNode {
    int outputIndex = -1;
    int chainLatency = 0; // sum of insert latencies (samples)
};

struct PdcResult {
    std::vector<int> delays;  // per-entry alignment delay (samples), parallel to input
    int totalLatency = 0;     // latency at the master output (pdcSamples)
};

// `masterIndex` selects the entry whose output latency is reported as totalLatency.
PdcResult computePdc(const std::vector<PdcNode>& nodes, int masterIndex);

} // namespace mydaw
