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

    // Punch region (SPEC §5.3). Unlike the loop it never moves the playhead — it only
    // decides whether the recorder is CAPTURING at a given sample position, so it is
    // evaluated per render span rather than in nextSpans().
    void setPunchBeats(double startBeat, double endBeat, bool enabled);
    void setPunchSamples(int64_t startSample, int64_t endSample, bool enabled);
    void rederivePunch(double startBeat, double endBeat); // tempo-map change
    // Re-derives the loop sample region from the given beats (call after tempo changes).
    void rederiveLoop(double startBeat, double endBeat);

    void setCountInBars(int bars);         // 0 | 1 | 2 (transport/setMetronome)
    void setMetronomeEnabled(bool enabled);

    // Record take mode (SPEC §8.7): what recording over existing material does. A
    // performer preference like the metronome — session state, never project data, and
    // fully independent of any lanes VIEW state (that separation is the design lesson
    // §8.7 records). The transport only STORES it; App forwards it inside the
    // internal/recording.commit payload so the command layer stays transport-agnostic.
    enum class RecordTakeMode { KeepHistory, Replace };
    void setRecordTakeMode(RecordTakeMode m) {
        recordTakeMode_.store(static_cast<int>(m), std::memory_order_release);
    }
    RecordTakeMode recordTakeMode() const {
        return static_cast<RecordTakeMode>(recordTakeMode_.load(std::memory_order_acquire));
    }

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

    bool punchEnabled() const { return punchEnabled_.load(std::memory_order_acquire); }
    int64_t punchStartSamples() const { return punchStart_.load(std::memory_order_acquire); }
    int64_t punchEndSamples() const { return punchEnd_.load(std::memory_order_acquire); }

    /**
     * RT: how many frames of [pos, pos+frames) fall inside the punch window, and where
     * they start. Returns false when the span contributes nothing.
     *
     * This is an INTERVAL INTERSECTION, deliberately, not an edge detector. The loop-wrap
     * bug (fixed in f9a5309) was an edge test — `pos < end && pos+frames > end` — which
     * silently failed whenever a boundary landed exactly on a block edge, and at 120 bpm
     * / 48 kHz the default cycle does that on every single block. Punch has the same
     * hazard at BOTH its boundaries, so it is expressed as an overlap and never as an
     * edge crossing.
     */
    bool punchSpan(int64_t pos, int frames, int& offsetOut, int& countOut) const noexcept {
        if (!punchEnabled_.load(std::memory_order_acquire)) {
            offsetOut = 0;
            countOut = frames;
            return frames > 0;
        }
        const int64_t s = punchStart_.load(std::memory_order_acquire);
        const int64_t e = punchEnd_.load(std::memory_order_acquire);
        const int64_t from = pos > s ? pos : s;
        const int64_t to = (pos + frames) < e ? (pos + frames) : e;
        if (to <= from)
            return false;
        offsetOut = static_cast<int>(from - pos);
        countOut = static_cast<int>(to - from);
        return countOut > 0;
    }

    // Timeline discontinuities published by the RT thread (loop wrap / arranger jump).
    // `wrapSeq` counts them and `wrapFromSamples` is the position the playhead LEFT.
    // Pollers that reconstruct time from the playhead — MIDI recording (E9) above all —
    // must notice the backwards step: a note held across the seam would otherwise be
    // closed by a note-off timestamped before its own note-on. Two independent atomics,
    // same v1 tradeoff as the loop region: `from` is published before the counter, so a
    // reader that sees a new count sees the matching boundary.
    uint32_t wrapSeq() const { return wrapSeq_.load(std::memory_order_acquire); }
    int64_t wrapFromSamples() const { return wrapFrom_.load(std::memory_order_acquire); }

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
    // a wrap exceeds the loop length (a cycle shorter than one block), the extra laps are
    // not rendered but the stored playhead is folded back into [loopStart, loopEnd) so the
    // cycle keeps wrapping (v1 simplification; loop length is normally >> block).
    int nextSpans(int frames, BlockSpan out[2]);

private:
    const TempoMap& tempoMap_;

    std::atomic<int64_t> playhead_{0};
    std::atomic<int> state_{static_cast<int>(TransportState::Stopped)};
    std::atomic<int64_t> loopStart_{0};
    std::atomic<int64_t> loopEnd_{0};
    std::atomic<bool> loopEnabled_{false};

    // Punch. Three independent atomics, so a drag that edits the region mid-take can gate
    // one block on mixed values — the same accepted tradeoff the loop region documents
    // above, and harmless because a mixed read still yields a valid sub-range.
    std::atomic<int64_t> punchStart_{0};
    std::atomic<int64_t> punchEnd_{0};
    std::atomic<bool> punchEnabled_{false};
    std::atomic<int> countInBars_{0};
    // Default OFF (matching every imported/new project unless it says otherwise); state is
    // mirrored to the UI via the "metronome" object in transportJson()/session/hello.
    std::atomic<bool> metronome_{false};
    // Default Keep History (Cubase default): recording over material stacks takes.
    std::atomic<int> recordTakeMode_{static_cast<int>(RecordTakeMode::KeepHistory)};
    std::atomic<bool> automationWrite_{false};
    std::atomic<int64_t> countInRemaining_{0};
    std::atomic<int64_t> countInTotal_{0};
    std::atomic<int64_t> lastPlayStart_{0}; // position where playback/recording last began
    std::atomic<uint32_t> wrapSeq_{0};      // see wrapSeq() — bumped once per discontinuity
    std::atomic<int64_t> wrapFrom_{0};

    // RT: publish a timeline discontinuity. Wait-free (two atomic ops, no allocation), so
    // it is safe to call from nextSpans() on the audio thread.
    void noteWrap(int64_t fromSamples) {
        wrapFrom_.store(fromSamples, std::memory_order_release);
        wrapSeq_.fetch_add(1, std::memory_order_release);
    }

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
