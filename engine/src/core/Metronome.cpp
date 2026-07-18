// MyDAW — core/Metronome.cpp (E2)

#include "core/Metronome.h"

#include <algorithm>
#include <cmath>

namespace mydaw {

namespace {
constexpr double kTwoPi = 6.283185307179586476925286766559;
constexpr double kAccentFreq = 880.0;
constexpr double kBeatFreq = 440.0;
constexpr float kAccentAmp = 0.5f;
constexpr float kBeatAmp = 0.35f;
constexpr double kDecaySeconds = 0.025; // ~25 ms tau
} // namespace

void Metronome::prepare(int sampleRate) {
    sampleRate_ = std::max(1, sampleRate);
    envCoef_ = std::exp(-1.0 / (kDecaySeconds * sampleRate_));
    numPending_ = 0;
    voiceActive_ = false;
    env_ = 0.0;
}

void Metronome::scheduleClickRt(int offsetInBlock, bool accent) noexcept {
    if (offsetInBlock < 0 || numPending_ >= kMaxPendingClicks)
        return;
    pending_[numPending_++] = Pending{offsetInBlock, accent};
}

void Metronome::scheduleBeatClicksRt(const TempoMap& map, int64_t spanStart, int frames,
                                     int blockOffset) noexcept {
    if (frames <= 0)
        return;
    const double startBeat = map.samplesToBeats(spanStart);
    const TimeSigEntry sig = map.timeSigAtBeat(startBeat);
    const double unit = 4.0 / static_cast<double>(sig.den > 0 ? sig.den : 4); // quarter beats
    const int64_t spanEnd = spanStart + frames;

    double k = std::ceil(startBeat / unit - 1e-9);
    for (int guard = 0; guard < kMaxPendingClicks; ++guard, k += 1.0) {
        const double clickBeat = k * unit;
        const int64_t s = map.beatsToSamples(clickBeat);
        if (s < spanStart)
            continue; // rounding pushed it before the span
        if (s >= spanEnd)
            break;
        const double beatsPerBar = map.beatsPerBarAt(clickBeat);
        const TempoMap::BarBeat bb = map.barBeatAtBeat(clickBeat);
        const bool accent =
            bb.beat < unit * 0.5 || (beatsPerBar - bb.beat) < unit * 0.5;
        scheduleClickRt(blockOffset + static_cast<int>(s - spanStart), accent);
    }
}

void Metronome::scheduleCountInClicksRt(double samplesPerClick, int clicksPerBar,
                                        int64_t elapsedStart, int64_t count,
                                        int blockOffset) noexcept {
    if (samplesPerClick <= 1.0 || count <= 0)
        return;
    int64_t k = static_cast<int64_t>(
        std::ceil(static_cast<double>(elapsedStart) / samplesPerClick - 1e-9));
    if (k < 0)
        k = 0;
    for (int guard = 0; guard < kMaxPendingClicks; ++guard, ++k) {
        const double pos = static_cast<double>(k) * samplesPerClick;
        if (pos >= static_cast<double>(elapsedStart + count))
            break;
        if (pos < static_cast<double>(elapsedStart))
            continue;
        const bool accent = clicksPerBar > 0 && (k % clicksPerBar) == 0;
        scheduleClickRt(blockOffset + static_cast<int>(pos - static_cast<double>(elapsedStart)),
                        accent);
    }
}

void Metronome::renderRt(float* outL, float* outR, int frames) noexcept {
    if (frames <= 0) {
        numPending_ = 0;
        return;
    }
    if (numPending_ == 0 && !voiceActive_)
        return;

    // Insertion-sort pending clicks by offset (tiny list, RT-safe).
    for (int i = 1; i < numPending_; ++i) {
        const Pending key = pending_[i];
        int j = i - 1;
        while (j >= 0 && pending_[j].offset > key.offset) {
            pending_[j + 1] = pending_[j];
            --j;
        }
        pending_[j + 1] = key;
    }

    int p = 0;
    for (int i = 0; i < frames; ++i) {
        while (p < numPending_ && pending_[p].offset <= i) {
            const bool accent = pending_[p].accent;
            ++p;
            voiceActive_ = true;
            phase_ = 0.0;
            phaseInc_ = kTwoPi * (accent ? kAccentFreq : kBeatFreq) / sampleRate_;
            env_ = accent ? kAccentAmp : kBeatAmp;
        }
        if (!voiceActive_)
            continue;
        const float v = static_cast<float>(std::sin(phase_) * env_);
        phase_ += phaseInc_;
        if (phase_ >= kTwoPi)
            phase_ -= kTwoPi;
        env_ *= envCoef_;
        if (env_ < 1e-4) {
            voiceActive_ = false;
            env_ = 0.0;
        }
        if (outL)
            outL[i] += v;
        if (outR)
            outR[i] += v;
    }
    numPending_ = 0;
}

void Metronome::resetRt() noexcept {
    numPending_ = 0;
    voiceActive_ = false;
    env_ = 0.0;
    phase_ = 0.0;
}

} // namespace mydaw
