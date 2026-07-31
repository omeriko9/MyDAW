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
    laps_.clear();
    laps_.push_back(Lap{startBeat, startBeat});
    noteLap_.clear();
    ccLap_.clear();
    curLap_ = 0;
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
        noteLap_.push_back(curLap_);
    } else if (e.isNoteOff()) {
        closePending(ch, e.note(), rel);
    } else if (e.isController()) {
        cc_.push_back(MidiCc{0, static_cast<int>(e.controller()), rel,
                             static_cast<double>(e.ccValue()) / 127.0});
        ccLap_.push_back(curLap_);
    } else if (e.isPitchBend()) { // controller 128, 0.5 = center
        cc_.push_back(MidiCc{0, 128, rel,
                             static_cast<double>(e.pitchBendValue() + 8192) / 16383.0});
        ccLap_.push_back(curLap_);
    } else if (e.isChannelAftertouch()) { // controller 129
        cc_.push_back(MidiCc{0, 129, rel, static_cast<double>(e.data[1]) / 127.0});
        ccLap_.push_back(curLap_);
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

void MidiRecorder::wrapTake(double boundaryBeat, double resumeBeat) {
    if (!active_)
        return;
    double relEnd = boundaryBeat - startBeat_;
    if (relEnd < 0.0)
        relEnd = 0.0;
    double relResume = resumeBeat - startBeat_;
    if (relResume < 0.0)
        relResume = 0.0;

    for (int ch = 0; ch < 16; ++ch) {
        for (int p = 0; p < 128; ++p) {
            const int idx = pending_[ch][p];
            if (idx < 0)
                continue;
            // Read the velocity out before push_back invalidates the reference; closing
            // first also clears the pending slot, so the re-opened note owns it after.
            const int velocity = notes_[static_cast<size_t>(idx)].velocity;
            closePending(ch, p, relEnd);
            Note n;
            n.id = 0;
            n.pitch = p;
            n.velocity = velocity;
            n.startBeat = relResume;
            n.lengthBeats = 0.0; // still held — the next lap closes it
            n.channel = ch;
            pending_[ch][p] = static_cast<int>(notes_.size());
            notes_.push_back(n);
            noteLap_.push_back(curLap_);
        noteLap_.push_back(curLap_);
        }
    }
    // The seam IS the lap boundary — close this pass and open the next one. Held notes
    // were just split across it above, so each lap owns a complete copy of what sounded
    // during it.
    if (!laps_.empty())
        laps_.back().endBeat = boundaryBeat;
    laps_.push_back(Lap{resumeBeat, resumeBeat});
    curLap_ = static_cast<int>(laps_.size()) - 1;

    // A finalize before the next pump must close held notes here, not back at the seam.
    lastPumpBeat_ = resumeBeat;
}

std::vector<MidiRecorder::RecordedNotes> MidiRecorder::finalize(const TempoMap& tempoMap) {
    double relStop = lastPumpBeat_ - startBeat_;
    if (relStop < 0.0)
        relStop = 0.0;

    // Close notes still held at stop time.
    for (int ch = 0; ch < 16; ++ch)
        for (int p = 0; p < 128; ++p)
            if (pending_[ch][p] >= 0)
                closePending(ch, p, relStop);

    // NOTE: sorting happens per-lap AFTER bucketing. Sorting notes_/cc_ here would
    // desync noteLap_/ccLap_, which are parallel by index.
    std::vector<RecordedNotes> out;
    if (notes_.empty() && cc_.empty()) {
        // Nothing recorded — one empty pass, so the caller's "skip when endBeat ==
        // startBeat" test behaves exactly as it did before laps existed.
        RecordedNotes empty;
        empty.startBeat = startBeat_;
        empty.endBeat = startBeat_;
        out.push_back(std::move(empty));
        notes_.clear();
        cc_.clear();
        laps_.clear();
        resetPending();
        active_ = false;
        return out;
    }

    // Close the final lap at the last sounding position, rounded up to the next bar as
    // clip ends always have been (see the header note).
    double relEnd = relStop;
    for (const Note& n : notes_)
        relEnd = std::max(relEnd, n.startBeat + n.lengthBeats);
    for (const MidiCc& c : cc_)
        relEnd = std::max(relEnd, c.beat);
    double endAbs = startBeat_ + relEnd;
    const TempoMap::BarBeat bb = tempoMap.barBeatAtBeat(endAbs);
    if (bb.beat > 1e-6)
        endAbs = tempoMap.beatAtBar(bb.bar + 1);
    if (laps_.empty())
        laps_.push_back(Lap{startBeat_, endAbs});
    else
        laps_.back().endBeat = std::max(laps_.back().startBeat, endAbs);

    // Bucket by ABSOLUTE position. wrapTake already split held notes at each seam, so a
    // note belongs wholly to the lap its start falls in and nothing straddles a boundary.
    out.resize(laps_.size());
    for (size_t k = 0; k < laps_.size(); ++k) {
        out[k].startBeat = laps_[k].startBeat;
        out[k].endBeat = laps_[k].endBeat;
    }
    for (size_t i = 0; i < notes_.size(); ++i) {
        const size_t k = static_cast<size_t>(
            std::clamp(i < noteLap_.size() ? noteLap_[i] : 0, 0,
                       static_cast<int>(laps_.size()) - 1));
        Note c = notes_[i];
        // Re-base onto this lap's own start. notes_ is relative to startBeat_, and a cycle
        // re-enters the same span, so lap 3's note sits at the same musical position as
        // lap 1's — the difference is which lane it belongs to, not where it plays.
        c.startBeat = (startBeat_ + notes_[i].startBeat) - laps_[k].startBeat;
        if (c.startBeat < 0.0)
            c.startBeat = 0.0;
        out[k].notes.push_back(c);
    }
    for (size_t i = 0; i < cc_.size(); ++i) {
        const size_t k = static_cast<size_t>(
            std::clamp(i < ccLap_.size() ? ccLap_[i] : 0, 0,
                       static_cast<int>(laps_.size()) - 1));
        MidiCc c = cc_[i];
        c.beat = (startBeat_ + cc_[i].beat) - laps_[k].startBeat;
        if (c.beat < 0.0)
            c.beat = 0.0;
        out[k].cc.push_back(c);
    }
    for (RecordedNotes& rn : out) {
        std::stable_sort(rn.notes.begin(), rn.notes.end(), [](const Note& a, const Note& b) {
            if (a.startBeat != b.startBeat)
                return a.startBeat < b.startBeat;
            return a.pitch < b.pitch;
        });
        std::stable_sort(rn.cc.begin(), rn.cc.end(), [](const MidiCc& a, const MidiCc& b) {
            if (a.controller != b.controller)
                return a.controller < b.controller;
            return a.beat < b.beat;
        });
    }

    // Drop laps that captured nothing — a wrap with no notes must not leave an empty take
    // lane sitting in the folder.
    out.erase(std::remove_if(out.begin(), out.end(),
                             [](const RecordedNotes& r) {
                                 return r.notes.empty() && r.cc.empty();
                             }),
              out.end());
    if (out.empty()) {
        RecordedNotes empty;
        empty.startBeat = startBeat_;
        empty.endBeat = startBeat_;
        out.push_back(std::move(empty));
    }

    notes_.clear();
    cc_.clear();
    laps_.clear();
    noteLap_.clear();
    ccLap_.clear();
    resetPending();
    active_ = false;

    Log::info("MidiRecorder: finalized %zu lap(s), first [%.3f, %.3f]", out.size(),
              out.front().startBeat, out.front().endBeat);
    return out;
}

} // namespace mydaw
