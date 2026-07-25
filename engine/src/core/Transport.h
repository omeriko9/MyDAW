// MyDAW — core/Transport.h
// Transport state machine (SPEC §5.4/§7): atomic playhead in samples, Stopped/Playing/
// Recording state, loop region (samples, derived from beats via TempoMap), count-in, and
// per-block advancement with loop-wrap split points.
//
// Threading: control methods (play/stop/pause/record/locate/setLoop*/setCountInBars/...)
// are called from the main thread; nextSpans() is called ONLY by the RT audio thread.
// All shared state is in atomics — no locks anywhere. Races between a control write and a
// concurrent RT block (e.g. locate during playback) resolve to last-writer-wins and are
// musically benign; the loop region is three independent atomics (documented v1 tradeoff —
// a block straddling a loop edit may wrap on mixed values once).

#pragma once

#include <atomic>
#include <cstdint>

#include "core/TempoMap.h"

namespace mydaw {

enum class TransportState : int { Stopped = 0, Playing = 1, Recording = 2 };

inline const char* transportStateToString(TransportState s) {
    switch (s) {
        case TransportState::Playing:   return "playing";
        case TransportState::Recording: return "recording";
        default:                        return "stopped";
    }
}

// One contiguous run of samples produced by nextSpans(). `wrapped` is true for a span
// that (re)starts at the loop start because a loop wrap happened inside this block.
struct BlockSpan {
    int64_t startSample = 0;
    int frames = 0;
    bool wrapped = false;
};

class Transport {
public:
    // `tempoMap` must outlive the Transport. Used for beat<->sample conversion (locate,
    // loop region, snapshots, count-in length).
    explicit Transport(const TempoMap& tempoMap);

    // ----- control (main thread) -------------------------------------------
    void play();
    // SPEC §5.4: "stop at pos; second stop returns to start".
    // NOTE(spec): interpreted as — stop while moving: halt at the current position;
    // stop while already stopped: jump to the position playback last started from;
    // stop again when already there: jump to project start (0).
    void stop();
    void pause();   // halt at position; does NOT alter the return-to-start logic
    void record();  // enters Recording; arms count-in when countInBars > 0
    void locate(double beat);
    void locateSamples(int64_t samples);

    void setLoopBeats(double startBeat, double endBeat, bool enabled); // converts via TempoMap
    void setLoopSamples(int64_t startSample, int64_t endSample, bool enabled);
    // Re-derives the loop sample region from the given beats (call after tempo changes).
    void rederiveLoop(double startBeat, double endBeat);

    void setCountInBars(int bars);         // 0 | 1 | 2 (transport/setMetronome)
    void setMetronomeEnabled(bool enabled);

    // ----- arranger chain (TRACK_TYPES_PLAN §3.6) ---------------------------
    // One entry per chain position: play [start, end), then jump to `to` (the next
    // step's start; `to` < 0 on the LAST step = no jump, playback continues linearly).
    // While the chain is active it OVERRIDES the loop region (documented v1 tradeoff —
    // a repeated section in the chain IS a loop). Steps are double-buffered so the RT
    // thread never reads a half-written table; the step counter re-derives on locate.
    struct ArrangerStep {
        int64_t start = 0;
        int64_t end = 0;
        int64_t to = -1;
    };
    static constexpr int kMaxArrangerSteps = 512;
    // Main thread. count is clamped to kMaxArrangerSteps; active with count==0 = inactive.
    void setArrangerSteps(const ArrangerStep* steps, int count, bool active);
    bool arrangerActive() const { return arrActive_.load(std::memory_order_acquire); }
    int arrangerStep() const { return arrStep_.load(std::memory_order_acquire); }

    // ----- queries (any thread) --------------------------------------------
    TransportState state() const { return static_cast<TransportState>(state_.load(std::memory_order_acquire)); }
    bool isPlaying() const { return state() != TransportState::Stopped; } // playing or recording
    bool isRecording() const { return state() == TransportState::Recording; }

    int64_t playheadSamples() const { return playhead_.load(std::memory_order_acquire); }
    double playheadBeats() const;
    double playheadSeconds() const;

    bool loopEnabled() const { return loopEnabled_.load(std::memory_order_acquire); }
    int64_t loopStartSamples() const { return loopStart_.load(std::memory_order_acquire); }
    int64_t loopEndSamples() const { return loopEnd_.load(std::memory_order_acquire); }

    int countInBars() const { return countInBars_.load(std::memory_order_acquire); }
    bool metronomeEnabled() const { return metronome_.load(std::memory_order_acquire); }

    // Automation write arm (SPEC §5.4): while on AND playing, param drags (volume/pan/send/
    // plugin) capture points into that param's automation lane at the playhead.
    void setAutomationWrite(bool on) { automationWrite_.store(on, std::memory_order_release); }
    bool automationWrite() const { return automationWrite_.load(std::memory_order_acquire); }
    // Remaining count-in samples (> 0 while the pre-roll click is sounding and the
    // playhead is held). The metronome (E2) reads this before/after nextSpans() to place
    // count-in clicks within the block.
    int64_t countInRemainingSamples() const { return countInRemaining_.load(std::memory_order_acquire); }
    int64_t countInTotalSamples() const { return countInTotal_.load(std::memory_order_acquire); }

    // Coherent snapshot for event/transport (E8). Non-RT.
    struct Snapshot {
        TransportState state = TransportState::Stopped;
        int64_t samples = 0;
        double beat = 0.0;
        double seconds = 0.0;
        bool loopEnabled = false;
        double loopStartBeat = 0.0;
        double loopEndBeat = 0.0;
    };
    Snapshot snapshot() const;

    // ----- RT thread ---------------------------------------------------------
    // Describes how the next `frames` samples map onto the timeline and advances the
    // playhead. Returns the number of spans written to out[2]:
    //   0 — stopped, or the entire block is consumed by count-in (playhead held);
    //   1 — one contiguous span;
    //   2 — block split at the loop end: out[0] runs to loopEnd, out[1] restarts at
    //       loopStart with wrapped=true.
    // Count-in consumes leading frames without advancing the playhead; a partial
    // count-in block yields spans for the remaining frames only. If the remainder after
    // a wrap exceeds the loop length, the overflow plays on linearly past loopEnd and
    // wraps again on the NEXT block (v1 simplification; loop length is normally >> block).
    int nextSpans(int frames, BlockSpan out[2]);

private:
    const TempoMap& tempoMap_;

    std::atomic<int64_t> playhead_{0};
    std::atomic<int> state_{static_cast<int>(TransportState::Stopped)};
    std::atomic<int64_t> loopStart_{0};
    std::atomic<int64_t> loopEnd_{0};
    std::atomic<bool> loopEnabled_{false};
    std::atomic<int> countInBars_{0};
    // Default OFF (matching every imported/new project unless it says otherwise); state is
    // mirrored to the UI via the "metronome" object in transportJson()/session/hello.
    std::atomic<bool> metronome_{false};
    std::atomic<bool> automationWrite_{false};
    std::atomic<int64_t> countInRemaining_{0};
    std::atomic<int64_t> countInTotal_{0};
    std::atomic<int64_t> lastPlayStart_{0}; // position where playback/recording last began

    // Arranger chain: double-buffered step table (control writes the inactive buffer,
    // then flips arrBuf_). arrStep_ = the chain position the playhead is inside/awaiting.
    ArrangerStep arrSteps_[2][kMaxArrangerSteps];
    std::atomic<int> arrCount_[2]{0, 0};
    std::atomic<int> arrBuf_{0};
    std::atomic<bool> arrActive_{false};
    std::atomic<int> arrStep_{0};
    // Recompute arrStep_ for a playhead position: first step whose [start,end) contains
    // pos; else past-the-end (no jumps fire until re-derived).
    void rederiveArrangerStep(int64_t pos);
};

} // namespace mydaw
