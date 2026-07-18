// MyDAW — core/Metronome.h (E2)
// Synthesized click track (SPEC §7): sine bursts with exponential decay — 880 Hz on the
// downbeat (bar start / count-in beat 0), 440 Hz otherwise. Follows the time signature:
// one click per timesig beat unit (4/den quarter notes), accent at the bar start.
//
// Usage (AudioGraph, RT thread):
//   - per playing span:    scheduleBeatClicksRt(tempoMap, spanStart, frames, blockOffset)
//   - per count-in chunk:  scheduleCountInClicksRt(...) (clicks while the playhead is held)
//   - once per device block, LAST: renderRt(outL, outR, frames) ADDS pending clicks +
//     any ringing tail directly into the device output (post-master, unaffected by the
//     master chain).
// All Rt methods are allocation- and lock-free; scheduling and rendering happen on the
// same RT thread within one block. prepare() is main-thread (before the stream starts).

#pragma once

#include <cstdint>

#include "core/TempoMap.h"

namespace mydaw {

class Metronome {
public:
    static constexpr int kMaxPendingClicks = 64;

    // Main thread (graph configure / sample-rate change).
    void prepare(int sampleRate);

    // ---- RT thread -----------------------------------------------------------
    // Queue a click starting at `offsetInBlock` (relative to the current device block).
    // Drops when the pending list is full or the offset is negative.
    void scheduleClickRt(int offsetInBlock, bool accent) noexcept;

    // Queue clicks for every timesig beat boundary inside [spanStart, spanStart+frames)
    // of the timeline; offsets are emitted relative to the block via `blockOffset`.
    void scheduleBeatClicksRt(const TempoMap& map, int64_t spanStart, int frames,
                              int blockOffset) noexcept;

    // Count-in clicks (SPEC §7): the pre-roll covers `clicksPerBar * bars` clicks spaced
    // `samplesPerClick` apart from the moment recording was requested. This call covers
    // the [elapsedStart, elapsedStart + count) sample window of that pre-roll, mapped to
    // the block at `blockOffset`. Accent every `clicksPerBar` clicks.
    void scheduleCountInClicksRt(double samplesPerClick, int clicksPerBar,
                                 int64_t elapsedStart, int64_t count,
                                 int blockOffset) noexcept;

    // Render pending clicks + the ringing tail of the previous click, ADDING into
    // outL/outR (either may be nullptr). Call exactly once per device block, after all
    // schedule*Rt calls. Clears the pending list.
    void renderRt(float* outL, float* outR, int frames) noexcept;

    // Silence immediately (engine/panic, plan swaps).
    void resetRt() noexcept;

private:
    struct Pending {
        int offset = 0;
        bool accent = false;
    };

    int sampleRate_ = 48000;
    double envCoef_ = 0.999;

    Pending pending_[kMaxPendingClicks];
    int numPending_ = 0;

    // Single click voice (a new click steals the previous one).
    bool voiceActive_ = false;
    double phase_ = 0.0;
    double phaseInc_ = 0.0;
    double env_ = 0.0;
};

} // namespace mydaw
