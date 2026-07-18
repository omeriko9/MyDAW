// MyDAW — core/TempoMap.h
// Piecewise-constant tempo map + time-signature map (SPEC §6/§7).
// Beats are quarter notes (double); audio offsets are int64 samples (SPEC §4).
// v1 projects carry a single tempo/timesig entry, but the math here is fully general.
//
// Thread-safety: NOT internally synchronized. Mutations (setTempo/setTimeSig/setMap/
// setSampleRate) happen on the main thread; the RT thread reads. v1 treats tempo edits as
// structural changes coordinated by the engine (graph swap / brief transport-consistent
// update). A torn read during the rare single-entry bpm write is the documented v1 tradeoff.

#pragma once

#include <cstdint>
#include <vector>

namespace mydaw {

// Mirrors project.json `tempoMap` entries: [{beat, bpm}] (SPEC §6).
struct TempoEntry {
    double beat = 0.0;
    double bpm = 120.0;
};

// Mirrors project.json `timeSigMap` entries: [{bar, num, den}] (SPEC §6). bar is 0-based.
struct TimeSigEntry {
    int bar = 0;
    int num = 4;
    int den = 4;
};

class TempoMap {
public:
    TempoMap(); // defaults: 120 bpm at beat 0, 4/4 at bar 0, 48000 Hz

    // --- configuration (main thread) --------------------------------------
    void setSampleRate(double sr);
    double sampleRate() const { return sampleRate_; }

    // Replaces both maps. Entries are sorted/sanitized; an entry at beat 0 / bar 0 is
    // guaranteed afterwards (synthesized from the first entry if missing).
    void setMap(std::vector<TempoEntry> tempo, std::vector<TimeSigEntry> timeSig);

    void setTempo(double bpm);          // v1: single entry at beat 0 (cmd/tempo.set)
    void setTimeSig(int num, int den);  // v1: single entry at bar 0 (cmd/timesig.set)

    const std::vector<TempoEntry>& tempoEntries() const { return tempo_; }
    const std::vector<TimeSigEntry>& timeSigEntries() const { return timeSig_; }

    // --- conversions (RT-safe reads: no locks, no allocation) -------------
    double bpmAtBeat(double beat) const;
    double beatsToSeconds(double beats) const;
    double secondsToBeats(double seconds) const;
    int64_t beatsToSamples(double beats) const;    // rounded to nearest sample
    double beatsToSamplesF(double beats) const;    // unrounded
    double samplesToBeats(int64_t samples) const;
    double samplesToBeats(double samples) const;

    // --- bars / time signature --------------------------------------------
    TimeSigEntry timeSigAtBeat(double beat) const;
    double beatsPerBarAt(double beat) const; // num * 4/den (beat = quarter note)

    struct BarBeat {
        int bar = 0;        // 0-based (UI renders bar+1)
        double beat = 0.0;  // 0-based beat within the bar, fractional
        int num = 4;
        int den = 4;
    };
    BarBeat barBeatAtBeat(double beat) const;
    double beatAtBar(int bar) const; // beat position of the start of `bar` (0-based)

private:
    void rebuild(); // recompute cached segment start times/beats

    double sampleRate_ = 48000.0;
    std::vector<TempoEntry> tempo_;        // sorted by beat, first at beat 0
    std::vector<double> tempoStartSec_;    // seconds at tempo_[i].beat
    std::vector<TimeSigEntry> timeSig_;    // sorted by bar, first at bar 0
    std::vector<double> sigStartBeat_;     // beat position of timeSig_[i].bar
};

} // namespace mydaw
