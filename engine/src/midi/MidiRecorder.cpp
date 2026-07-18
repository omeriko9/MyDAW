// MyDAW — midi/MidiRecorder.cpp
// See MidiRecorder.h for the recording flow and timing contract.

#include "midi/MidiRecorder.h"

#include <algorithm>

#include "midi/MidiInput.h"
#include "util/Log.h"

namespace mydaw {

MidiRecorder::MidiRecorder() {
    resetPending();
}

void MidiRecorder::setInput(MidiInput* input) {
    input_ = input;
}

void MidiRecorder::resetPending() {
    for (int ch = 0; ch < 16; ++ch)
        for (int p = 0; p < 128; ++p)
            pending_[ch][p] = -1;
}

void MidiRecorder::begin(double startBeat) {
    active_ = true;
    startBeat_ = startBeat;
    lastPumpBeat_ = startBeat;
    notes_.clear();
    cc_.clear();
    resetPending();
    if (input_)
        input_->clearMirror(); // drop events that arrived before the pass started
    Log::info("MidiRecorder: recording from beat %.3f", startBeat);
}

void MidiRecorder::closePending(int ch, int pitch, double relBeat) {
    if (ch < 0 || ch > 15 || pitch < 0 || pitch > 127)
        return;
    const int idx = pending_[ch][pitch];
    if (idx < 0)
        return;
    Note& n = notes_[static_cast<size_t>(idx)];
    double len = relBeat - n.startBeat;
    if (len < kMinNoteLenBeats)
        len = kMinNoteLenBeats;
    n.lengthBeats = len;
    pending_[ch][pitch] = -1;
}

void MidiRecorder::feed(const MidiEvent& e, double beatAtEvent) {
    if (!active_)
        return;
    double rel = beatAtEvent - startBeat_;
    if (rel < 0.0)
        rel = 0.0; // count-in / pre-roll presses land at the clip start

    const int ch = e.channel();
    if (e.isNoteOn()) {
        const int pitch = e.note();
        closePending(ch, pitch, rel); // retrigger: end the still-sounding note first
        Note n;
        n.id = 0; // E3 allocates ids on internal/recording.commit
        n.pitch = pitch;
        n.velocity = e.velocity() < 1 ? 1 : e.velocity();
        n.startBeat = rel;
        n.lengthBeats = 0.0; // open until the matching note-off
        n.channel = ch;
        pending_[ch][pitch] = static_cast<int>(notes_.size());
        notes_.push_back(n);
    } else if (e.isNoteOff()) {
        closePending(ch, e.note(), rel);
    } else if (e.isController()) {
        cc_.push_back(MidiCc{0, static_cast<int>(e.controller()), rel,
                             static_cast<double>(e.ccValue()) / 127.0});
    } else if (e.isPitchBend()) { // controller 128, 0.5 = center
        cc_.push_back(MidiCc{0, 128, rel,
                             static_cast<double>(e.pitchBendValue() + 8192) / 16383.0});
    } else if (e.isChannelAftertouch()) { // controller 129
        cc_.push_back(MidiCc{0, 129, rel, static_cast<double>(e.data[1]) / 127.0});
    }
    // Program change / poly aftertouch: not recorded.
}

void MidiRecorder::pump(const TempoMap& tempoMap, double currentBeat) {
    if (!input_)
        return;
    if (!active_) {
        input_->clearMirror(); // not recording: keep the ring from backing up
        return;
    }
    lastPumpBeat_ = currentBeat;

    const double nowSec = tempoMap.beatsToSeconds(currentBeat);
    const int64_t nowQpc = MidiInput::qpcNow();
    const double freq = static_cast<double>(MidiInput::qpcFrequency());

    TimedMidiEvent te;
    while (input_->popMirror(te)) {
        double ageSec = static_cast<double>(nowQpc - te.qpc) / freq;
        if (ageSec < 0.0)
            ageSec = 0.0; // event raced in after we sampled nowQpc
        if (ageSec > 2.0)
            ageSec = 2.0; // stale-event guard (clock hiccup / stalled pump)
        const double evtSec = nowSec - ageSec;
        const double beat = evtSec <= 0.0 ? 0.0 : tempoMap.secondsToBeats(evtSec);
        feed(te.ev, beat);
    }
}

MidiRecorder::RecordedNotes MidiRecorder::finalize(const TempoMap& tempoMap) {
    RecordedNotes out;
    out.startBeat = startBeat_;

    double relStop = lastPumpBeat_ - startBeat_;
    if (relStop < 0.0)
        relStop = 0.0;

    // Close notes still held at stop time.
    for (int ch = 0; ch < 16; ++ch)
        for (int p = 0; p < 128; ++p)
            if (pending_[ch][p] >= 0)
                closePending(ch, p, relStop);

    if (notes_.empty() && cc_.empty()) {
        out.endBeat = startBeat_; // nothing recorded — caller skips clip creation
    } else {
        double relEnd = relStop;
        for (const Note& n : notes_)
            relEnd = std::max(relEnd, n.startBeat + n.lengthBeats);
        for (const MidiCc& c : cc_)
            relEnd = std::max(relEnd, c.beat);
        double endAbs = startBeat_ + relEnd;
        // NOTE(spec): round the clip end up to the next bar boundary (see MidiRecorder.h).
        const TempoMap::BarBeat bb = tempoMap.barBeatAtBeat(endAbs);
        if (bb.beat > 1e-6)
            endAbs = tempoMap.beatAtBar(bb.bar + 1);
        out.endBeat = endAbs;
    }

    std::stable_sort(notes_.begin(), notes_.end(), [](const Note& a, const Note& b) {
        if (a.startBeat != b.startBeat)
            return a.startBeat < b.startBeat;
        return a.pitch < b.pitch;
    });
    std::stable_sort(cc_.begin(), cc_.end(), [](const MidiCc& a, const MidiCc& b) {
        if (a.controller != b.controller)
            return a.controller < b.controller;
        return a.beat < b.beat;
    });
    out.notes = std::move(notes_);
    out.cc = std::move(cc_);
    notes_.clear();
    cc_.clear();
    resetPending();
    active_ = false;

    Log::info("MidiRecorder: finalized %zu note%s + %zu cc point%s, beats [%.3f, %.3f]",
              out.notes.size(), out.notes.size() == 1 ? "" : "s", out.cc.size(),
              out.cc.size() == 1 ? "" : "s", out.startBeat, out.endBeat);
    return out;
}

} // namespace mydaw
