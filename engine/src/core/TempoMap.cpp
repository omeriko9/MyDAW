// MyDAW — core/TempoMap.cpp

#include "core/TempoMap.h"

#include <algorithm>
#include <cmath>

namespace mydaw {

namespace {
constexpr double kMinBpm = 5.0;
constexpr double kMaxBpm = 999.0;

double clampBpm(double bpm) {
    if (!(bpm > 0.0)) // also catches NaN
        return 120.0;
    return std::min(std::max(bpm, kMinBpm), kMaxBpm);
}

double beatsPerBar(const TimeSigEntry& sig) {
    return static_cast<double>(sig.num) * 4.0 / static_cast<double>(sig.den);
}
} // namespace

TempoMap::TempoMap() {
    tempo_.push_back(TempoEntry{0.0, 120.0});
    timeSig_.push_back(TimeSigEntry{0, 4, 4});
    rebuild();
}

void TempoMap::setSampleRate(double sr) {
    if (sr > 0.0)
        sampleRate_ = sr;
}

void TempoMap::setMap(std::vector<TempoEntry> tempo, std::vector<TimeSigEntry> timeSig) {
    // --- tempo: sort by beat, clamp bpm, dedupe equal beats (last wins) ---
    std::stable_sort(tempo.begin(), tempo.end(),
                     [](const TempoEntry& a, const TempoEntry& b) { return a.beat < b.beat; });
    std::vector<TempoEntry> t;
    t.reserve(tempo.size() + 1);
    for (TempoEntry e : tempo) {
        e.bpm = clampBpm(e.bpm);
        if (e.beat < 0.0)
            e.beat = 0.0;
        if (!t.empty() && t.back().beat == e.beat)
            t.back() = e;
        else
            t.push_back(e);
    }
    if (t.empty())
        t.push_back(TempoEntry{0.0, 120.0});
    if (t.front().beat > 0.0)
        t.insert(t.begin(), TempoEntry{0.0, t.front().bpm});
    tempo_ = std::move(t);

    // --- time signatures: sort by bar, sanitize, dedupe (last wins) -------
    std::stable_sort(timeSig.begin(), timeSig.end(),
                     [](const TimeSigEntry& a, const TimeSigEntry& b) { return a.bar < b.bar; });
    std::vector<TimeSigEntry> s;
    s.reserve(timeSig.size() + 1);
    for (TimeSigEntry e : timeSig) {
        if (e.num < 1) e.num = 4;
        if (e.num > 64) e.num = 64;
        // valid denominators: powers of two 1..64
        if (e.den != 1 && e.den != 2 && e.den != 4 && e.den != 8 && e.den != 16 &&
            e.den != 32 && e.den != 64)
            e.den = 4;
        if (e.bar < 0)
            e.bar = 0;
        if (!s.empty() && s.back().bar == e.bar)
            s.back() = e;
        else
            s.push_back(e);
    }
    if (s.empty())
        s.push_back(TimeSigEntry{0, 4, 4});
    if (s.front().bar > 0)
        s.insert(s.begin(), TimeSigEntry{0, s.front().num, s.front().den});
    timeSig_ = std::move(s);

    rebuild();
}

void TempoMap::setTempo(double bpm) {
    // NOTE(spec): v1 cmd/tempo.set replaces the whole map with one entry at beat 0.
    tempo_.assign(1, TempoEntry{0.0, clampBpm(bpm)});
    rebuild();
}

void TempoMap::setTimeSig(int num, int den) {
    // NOTE(spec): v1 cmd/timesig.set replaces the whole map with one entry at bar 0.
    std::vector<TimeSigEntry> s{TimeSigEntry{0, num, den}};
    setMap(tempo_, std::move(s));
}

void TempoMap::rebuild() {
    // Cumulative seconds at each tempo entry boundary.
    tempoStartSec_.resize(tempo_.size());
    double sec = 0.0;
    for (size_t i = 0; i < tempo_.size(); ++i) {
        if (i > 0)
            sec += (tempo_[i].beat - tempo_[i - 1].beat) * 60.0 / tempo_[i - 1].bpm;
        tempoStartSec_[i] = sec;
    }
    // Cumulative beat position of each time-signature entry's bar.
    sigStartBeat_.resize(timeSig_.size());
    double beat = 0.0;
    for (size_t i = 0; i < timeSig_.size(); ++i) {
        if (i > 0)
            beat += static_cast<double>(timeSig_[i].bar - timeSig_[i - 1].bar) *
                    beatsPerBar(timeSig_[i - 1]);
        sigStartBeat_[i] = beat;
    }
}

double TempoMap::bpmAtBeat(double beat) const {
    // Last entry with entry.beat <= beat; beats before the first entry use the first bpm.
    size_t i = tempo_.size();
    while (i > 1 && tempo_[i - 1].beat > beat)
        --i;
    return tempo_[i - 1].bpm;
}

double TempoMap::beatsToSeconds(double beats) const {
    size_t i = tempo_.size();
    while (i > 1 && tempo_[i - 1].beat > beats)
        --i;
    const size_t k = i - 1;
    return tempoStartSec_[k] + (beats - tempo_[k].beat) * 60.0 / tempo_[k].bpm;
}

double TempoMap::secondsToBeats(double seconds) const {
    size_t i = tempo_.size();
    while (i > 1 && tempoStartSec_[i - 1] > seconds)
        --i;
    const size_t k = i - 1;
    return tempo_[k].beat + (seconds - tempoStartSec_[k]) * tempo_[k].bpm / 60.0;
}

int64_t TempoMap::beatsToSamples(double beats) const {
    return static_cast<int64_t>(std::llround(beatsToSeconds(beats) * sampleRate_));
}

double TempoMap::beatsToSamplesF(double beats) const {
    return beatsToSeconds(beats) * sampleRate_;
}

double TempoMap::samplesToBeats(int64_t samples) const {
    return secondsToBeats(static_cast<double>(samples) / sampleRate_);
}

double TempoMap::samplesToBeats(double samples) const {
    return secondsToBeats(samples / sampleRate_);
}

TimeSigEntry TempoMap::timeSigAtBeat(double beat) const {
    size_t i = timeSig_.size();
    while (i > 1 && sigStartBeat_[i - 1] > beat)
        --i;
    return timeSig_[i - 1];
}

double TempoMap::beatsPerBarAt(double beat) const {
    return beatsPerBar(timeSigAtBeat(beat));
}

TempoMap::BarBeat TempoMap::barBeatAtBeat(double beat) const {
    size_t i = timeSig_.size();
    while (i > 1 && sigStartBeat_[i - 1] > beat)
        --i;
    const size_t k = i - 1;
    const TimeSigEntry& sig = timeSig_[k];
    const double q = beatsPerBar(sig);
    const double rel = beat - sigStartBeat_[k];
    const double barF = std::floor(rel / q); // negative beats land in negative bars
    BarBeat out;
    out.bar = sig.bar + static_cast<int>(barF);
    out.beat = rel - barF * q;
    out.num = sig.num;
    out.den = sig.den;
    return out;
}

double TempoMap::beatAtBar(int bar) const {
    size_t i = timeSig_.size();
    while (i > 1 && timeSig_[i - 1].bar > bar)
        --i;
    const size_t k = i - 1;
    return sigStartBeat_[k] +
           static_cast<double>(bar - timeSig_[k].bar) * beatsPerBar(timeSig_[k]);
}

} // namespace mydaw
