// MyDAW — midi/MidiRecorder.h
// MIDI recording (SPEC §5.5/§7): pairs note-on/off events arriving from MidiInput's
// QPC-timestamped mirror ring into Note values, and captures CC / pitch-bend / channel-
// aftertouch as MidiCc points (controller 128 = pitch bend, 129 = channel aftertouch;
// values normalized 0..1). Quantize-on-record is intentionally NOT here
// (cmd/notes.quantize, E3, covers it).
//
// Flow: E9 calls begin(startBeat) when transport recording actually starts (after any
// count-in), then pump(tempoMap, currentBeat) at ~50 Hz while recording (currentBeat =
// transport playhead in beats), then finalize(tempoMap) at stop. finalize's result feeds
// the internal "internal/recording.commit" command (E3) as {trackId, notes, startBeat,
// endBeat}; note ids are left 0 — E3 allocates ids when it creates the clip.
//
// Timestamping: pump drains the mirror ring; each event carries the QPC tick of its
// arrival, so its timeline position is reconstructed as currentBeat minus the event's
// age (converted through the TempoMap) — recording accuracy is therefore independent of
// the pump rate and of the audio block size. Events that arrived before the record start
// (count-in key presses) are clamped to the clip start.
//
// Threading: main thread only (begin/feed/pump/finalize). feed() may also be called
// directly with an externally derived beat — pump() is just the mirror-draining wrapper.

#pragma once

#include <vector>

#include "core/TempoMap.h"
#include "midi/MidiEvent.h"
#include "project/Model.h" // Note

namespace mydaw {

class MidiInput;

class MidiRecorder {
public:
    // Result of one recording pass. `notes[i].startBeat` and `cc[i].beat` are RELATIVE
    // to `startBeat` (clip-local, matching MidiClip semantics, SPEC §6); startBeat/
    // endBeat are absolute timeline beats. endBeat == startBeat when nothing was
    // recorded. `cc` is sorted by (controller, beat), ids 0 (E3 allocates on commit).
    struct RecordedNotes {
        std::vector<Note> notes;
        std::vector<MidiCc> cc;
        double startBeat = 0.0;
        double endBeat = 0.0;
    };

    MidiRecorder();

    // Wires the mirror source (E9, once at startup). Without it pump() is a no-op and
    // only direct feed() calls record.
    void setInput(MidiInput* input);

    // Starts a recording pass at the given absolute timeline beat. Discards anything
    // stale in the mirror ring.
    void begin(double startBeat);

    bool active() const { return active_; }

    // Live in-progress snapshot for UI feedback (E9). `liveNotes()` are the notes captured
    // so far, clip-relative to `startBeat()`; a still-open note has lengthBeats 0 (the UI
    // extends it to the current playhead). Main thread only; the caller copies while
    // serializing. Not for committing — finalize() is the source of truth.
    const std::vector<Note>& liveNotes() const { return notes_; }
    double startBeat() const { return startBeat_; }

    // Feeds one event whose absolute timeline position is `beatAtEvent`. Note-on starts
    // a pending note (a retrigger of an already-sounding pitch/channel closes the old
    // note first); note-off (incl. on-with-velocity-0) closes it. CC / pitch bend /
    // channel aftertouch become MidiCc points; program change / poly-AT are ignored.
    void feed(const MidiEvent& e, double beatAtEvent);

    // Drains the MidiInput mirror ring, converting QPC age -> beats (see header note),
    // and feeds every event. E9 calls this at ~50 Hz while recording with the current
    // transport beat. When not recording it discards pending mirror events.
    void pump(const TempoMap& tempoMap, double currentBeat);

    // Ends the pass: closes still-held notes at the last pumped beat, sorts, and returns
    // the result. NOTE(spec): endBeat is rounded UP to the next bar boundary (via the
    // TempoMap's time signature) so the created clip covers whole bars — the simplest
    // musical interpretation; notes themselves are never moved.
    RecordedNotes finalize(const TempoMap& tempoMap);

private:
    void closePending(int ch, int pitch, double relBeat);
    void resetPending();

    static constexpr double kMinNoteLenBeats = 1.0 / 128.0;

    MidiInput* input_ = nullptr;
    bool active_ = false;
    double startBeat_ = 0.0;    // absolute beat where the pass began
    double lastPumpBeat_ = 0.0; // absolute beat of the most recent pump
    std::vector<Note> notes_;   // startBeat relative to startBeat_; lengthBeats 0 = open
    std::vector<MidiCc> cc_;    // beat relative to startBeat_; values normalized
    int pending_[16][128];      // [channel][pitch] -> index into notes_, -1 = none
};

} // namespace mydaw
