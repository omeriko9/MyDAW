// MyDAW — core/Transport.cpp

#include "core/Transport.h"

#include <algorithm>

namespace mydaw {

Transport::Transport(const TempoMap& tempoMap) : tempoMap_(tempoMap) {}

// ----- control ---------------------------------------------------------------

void Transport::play() {
    if (state() == TransportState::Playing)
        return;
    lastPlayStart_.store(playhead_.load(std::memory_order_acquire),
                         std::memory_order_release);
    countInRemaining_.store(0, std::memory_order_release);
    countInTotal_.store(0, std::memory_order_release);
    state_.store(static_cast<int>(TransportState::Playing), std::memory_order_release);
}

void Transport::stop() {
    if (state() != TransportState::Stopped) {
        // First stop: halt at the current position.
        countInRemaining_.store(0, std::memory_order_release);
        countInTotal_.store(0, std::memory_order_release);
        state_.store(static_cast<int>(TransportState::Stopped), std::memory_order_release);
        return;
    }
    // Already stopped: second stop returns to where playback last started; a further
    // stop (already there) returns to project start.
    const int64_t start = lastPlayStart_.load(std::memory_order_acquire);
    const int64_t pos = playhead_.load(std::memory_order_acquire);
    playhead_.store(pos != start ? start : 0, std::memory_order_release);
}

void Transport::pause() {
    if (state() == TransportState::Stopped)
        return;
    countInRemaining_.store(0, std::memory_order_release);
    countInTotal_.store(0, std::memory_order_release);
    state_.store(static_cast<int>(TransportState::Stopped), std::memory_order_release);
}

void Transport::record() {
    if (state() == TransportState::Recording)
        return;
    const int64_t pos = playhead_.load(std::memory_order_acquire);
    lastPlayStart_.store(pos, std::memory_order_release);

    const int bars = countInBars_.load(std::memory_order_acquire);
    if (bars > 0) {
        // Count-in length: N bars at the time signature / tempo in effect at the
        // current position (SPEC §7: count-in delays transport start by N bars).
        const double beat = tempoMap_.samplesToBeats(pos);
        const double countBeats =
            static_cast<double>(bars) * tempoMap_.beatsPerBarAt(beat);
        const double bpm = tempoMap_.bpmAtBeat(beat);
        const double seconds = countBeats * 60.0 / bpm;
        const int64_t samples =
            static_cast<int64_t>(seconds * tempoMap_.sampleRate() + 0.5);
        countInTotal_.store(samples, std::memory_order_release);
        countInRemaining_.store(samples, std::memory_order_release);
    } else {
        countInTotal_.store(0, std::memory_order_release);
        countInRemaining_.store(0, std::memory_order_release);
    }
    state_.store(static_cast<int>(TransportState::Recording), std::memory_order_release);
}

void Transport::locate(double beat) {
    locateSamples(tempoMap_.beatsToSamples(beat));
}

void Transport::locateSamples(int64_t samples) {
    const int64_t pos = std::max<int64_t>(0, samples);
    playhead_.store(pos, std::memory_order_release);
    if (arrActive_.load(std::memory_order_acquire))
        rederiveArrangerStep(pos); // a locate re-enters the chain at the landed section
}

void Transport::setArrangerSteps(const ArrangerStep* steps, int count, bool active) {
    count = std::clamp(count, 0, kMaxArrangerSteps);
    const int cur = arrBuf_.load(std::memory_order_acquire);
    const int next = 1 - cur;
    for (int i = 0; i < count; ++i)
        arrSteps_[next][i] = steps[i];
    arrCount_[next].store(count, std::memory_order_release);
    arrBuf_.store(next, std::memory_order_release);
    arrActive_.store(active && count > 0, std::memory_order_release);
    rederiveArrangerStep(playhead_.load(std::memory_order_acquire));
}

void Transport::rederiveArrangerStep(int64_t pos) {
    const int b = arrBuf_.load(std::memory_order_acquire);
    const int n = arrCount_[b].load(std::memory_order_acquire);
    int step = n; // past-the-end: no jump fires
    for (int i = 0; i < n; ++i) {
        if (pos >= arrSteps_[b][i].start && pos < arrSteps_[b][i].end) {
            step = i;
            break;
        }
    }
    arrStep_.store(step, std::memory_order_release);
}

void Transport::setLoopBeats(double startBeat, double endBeat, bool enabled) {
    setLoopSamples(tempoMap_.beatsToSamples(startBeat), tempoMap_.beatsToSamples(endBeat),
                   enabled);
}

void Transport::setLoopSamples(int64_t startSample, int64_t endSample, bool enabled) {
    if (endSample < startSample)
        std::swap(startSample, endSample);
    loopStart_.store(std::max<int64_t>(0, startSample), std::memory_order_release);
    loopEnd_.store(std::max<int64_t>(0, endSample), std::memory_order_release);
    loopEnabled_.store(enabled && endSample > startSample, std::memory_order_release);
}

void Transport::rederiveLoop(double startBeat, double endBeat) {
    setLoopSamples(tempoMap_.beatsToSamples(startBeat), tempoMap_.beatsToSamples(endBeat),
                   loopEnabled_.load(std::memory_order_acquire));
}

void Transport::setCountInBars(int bars) {
    countInBars_.store(std::clamp(bars, 0, 2), std::memory_order_release);
}

void Transport::setMetronomeEnabled(bool enabled) {
    metronome_.store(enabled, std::memory_order_release);
}

// ----- queries ----------------------------------------------------------------

double Transport::playheadBeats() const {
    return tempoMap_.samplesToBeats(playhead_.load(std::memory_order_acquire));
}

double Transport::playheadSeconds() const {
    return static_cast<double>(playhead_.load(std::memory_order_acquire)) /
           tempoMap_.sampleRate();
}

Transport::Snapshot Transport::snapshot() const {
    Snapshot s;
    s.state = state();
    s.samples = playhead_.load(std::memory_order_acquire);
    s.beat = tempoMap_.samplesToBeats(s.samples);
    s.seconds = static_cast<double>(s.samples) / tempoMap_.sampleRate();
    s.loopEnabled = loopEnabled_.load(std::memory_order_acquire);
    s.loopStartBeat = tempoMap_.samplesToBeats(loopStart_.load(std::memory_order_acquire));
    s.loopEndBeat = tempoMap_.samplesToBeats(loopEnd_.load(std::memory_order_acquire));
    return s;
}

// ----- RT ----------------------------------------------------------------------

int Transport::nextSpans(int frames, BlockSpan out[2]) {
    if (frames <= 0 || state() == TransportState::Stopped)
        return 0;

    // Count-in: consume leading frames while holding the playhead.
    const int64_t ci = countInRemaining_.load(std::memory_order_acquire);
    if (ci > 0) {
        const int64_t consumed = std::min<int64_t>(ci, frames);
        countInRemaining_.store(ci - consumed, std::memory_order_release);
        frames -= static_cast<int>(consumed);
        if (frames <= 0)
            return 0;
    }

    const int64_t pos = playhead_.load(std::memory_order_acquire);

    // Arranger chain (TRACK_TYPES_PLAN §3.6): jump section-to-section at step
    // boundaries — same split-span shape as the loop wrap (nodes re-chase on the
    // discontinuity). While active it OVERRIDES the loop region; a step with to < 0
    // (the last chain entry) plays on linearly and the chain is done.
    if (arrActive_.load(std::memory_order_acquire)) {
        const int b = arrBuf_.load(std::memory_order_acquire);
        const int n = arrCount_[b].load(std::memory_order_acquire);
        const int s = arrStep_.load(std::memory_order_acquire);
        if (s < n) {
            const ArrangerStep& st = arrSteps_[b][s];
            if (st.to >= 0 && st.to != st.end) {
                if (pos < st.end && pos + frames > st.end) {
                    const int first = static_cast<int>(st.end - pos);
                    const int rest = frames - first;
                    out[0] = BlockSpan{pos, first, false};
                    out[1] = BlockSpan{st.to, rest, true};
                    playhead_.store(st.to + rest, std::memory_order_release);
                    arrStep_.store(s + 1, std::memory_order_release);
                    noteWrap(st.end);
                    return 2;
                }
                if (pos >= st.end) {
                    // Boundary landed EXACTLY on a block edge (bar-aligned sections at
                    // integer tempos hit this every time) — jump at block start instead
                    // of splitting; wrapped=true still triggers the nodes' re-chase.
                    const int64_t to = st.to + (pos - st.end);
                    out[0] = BlockSpan{to, frames, true};
                    playhead_.store(to + frames, std::memory_order_release);
                    arrStep_.store(s + 1, std::memory_order_release);
                    noteWrap(st.end);
                    return 1;
                }
            } else if (pos >= st.end) {
                // Adjacent next section (to == end) or the final linear step: the step
                // counter advances without a jump.
                arrStep_.store(s + 1, std::memory_order_release);
            }
        }
        out[0] = BlockSpan{pos, frames, false};
        playhead_.store(pos + frames, std::memory_order_release);
        return 1;
    }

    const bool loop = loopEnabled_.load(std::memory_order_acquire);
    const int64_t ls = loopStart_.load(std::memory_order_acquire);
    const int64_t le = loopEnd_.load(std::memory_order_acquire);

    if (loop && le > ls) {
        // Fold every re-entry back into [ls, le): a cycle SHORTER than one block would
        // otherwise store a playhead PAST le, where neither branch below can fire again
        // and the transport escapes the loop for the rest of the take. Normally the loop
        // is many blocks long and the modulo is a no-op. (The arranger above needs none —
        // its step counter advances, so the next block re-tests against the NEXT section.)
        const int64_t loopLen = le - ls;
        if (pos < le && pos + frames > le) {
            const int first = static_cast<int>(le - pos);
            const int rest = frames - first;
            out[0] = BlockSpan{pos, first, false};
            out[1] = BlockSpan{ls, rest, true};
            playhead_.store(ls + (rest % loopLen), std::memory_order_release);
            noteWrap(le);
            return 2;
        }
        if (pos == le) {
            // Boundary landed EXACTLY on a block edge, so the split above never fired:
            // the previous block ended ON le (pos + frames > le was false) and this one
            // starts there (pos < le is false), which used to skip the wrap forever. A
            // whole-bar cycle at an integer tempo hits this every time — 8 beats at
            // 120 bpm / 48 kHz is 192000 frames, exactly 3000 64-frame blocks. Same
            // shape as the arranger's block-edge jump above.
            // Only pos == le wraps: a playhead located BEYOND the right locator keeps
            // playing linearly, as it does in Cubase.
            out[0] = BlockSpan{ls, frames, true};
            playhead_.store(ls + (frames % loopLen), std::memory_order_release);
            noteWrap(le);
            return 1;
        }
    }

    out[0] = BlockSpan{pos, frames, false};
    playhead_.store(pos + frames, std::memory_order_release);
    return 1;
}

} // namespace mydaw
