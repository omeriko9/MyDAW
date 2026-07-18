// MyDAW — core/Mixer.h
// Mixing primitives shared by the audio graph (SPEC §7):
//   - pan laws: equal-power placement for mono sources with the -4.5 dB center-law
//     compromise; attenuate-only balance (same taper, center = unity) for stereo sources.
//   - GainSmoother: 5 ms linear ramp used for volume / mute / send-level changes arriving
//     through the ParamMsg fast path (click-free).
//   - solo-in-place audible-set computation (main thread, operates on the Model).
//
// All RT-usable pieces (pan gains, GainSmoother::next) are allocation- and lock-free.

#pragma once

#include <cstdint>
#include <vector>

namespace mydaw {

struct Project; // project/Model.h (included by Mixer.cpp only)

// ---------------------------------------------------------------------------
// Pan laws
// ---------------------------------------------------------------------------

struct PanGains {
    float l = 1.0f;
    float r = 1.0f;
};

// Mono-source placement, pan in [-1, 1]. Compromise law between linear (-6 dB center)
// and constant-power (-3 dB center): g = sqrt(linear * constantPower), giving the
// SPEC §7 -4.5 dB center. Hard pan = unity on the active side, 0 on the other.
PanGains monoPanGains(float pan);

// Stereo-source balance, pan in [-1, 1]. Attenuate-only: center = unity on both
// channels; panning right tapers the LEFT channel along the same -4.5 dB-compromise
// curve (normalized so it starts at 1), and vice versa. No channel is ever boosted.
PanGains stereoBalanceGains(float pan);

// ---------------------------------------------------------------------------
// GainSmoother — linear ramp toward a target over rampSeconds (default 5 ms).
// setTarget()/snap() are called from the RT thread (param-ring drain at block start);
// next() is called per sample. No allocation, no locks.
// ---------------------------------------------------------------------------

class GainSmoother {
public:
    void prepare(int sampleRate, float rampSeconds = 0.005f) {
        rampSamples_ = static_cast<int>(rampSeconds * static_cast<float>(sampleRate) + 0.5f);
        if (rampSamples_ < 1)
            rampSamples_ = 1;
    }

    // Jump immediately (rebuild-time init, reset()).
    void snap(float v) {
        value_ = target_ = v;
        remaining_ = 0;
        step_ = 0.0f;
    }

    void setTarget(float v) {
        if (v == target_ && remaining_ == 0)
            return;
        target_ = v;
        step_ = (target_ - value_) / static_cast<float>(rampSamples_);
        remaining_ = rampSamples_;
    }

    float next() {
        if (remaining_ > 0) {
            value_ += step_;
            if (--remaining_ == 0)
                value_ = target_;
        }
        return value_;
    }

    float current() const { return value_; }
    float target() const { return target_; }
    bool ramping() const { return remaining_ > 0; }

private:
    float value_ = 1.0f;
    float target_ = 1.0f;
    float step_ = 0.0f;
    int remaining_ = 0;
    int rampSamples_ = 240;
};

// ---------------------------------------------------------------------------
// Solo-in-place (SPEC §7) — main thread only.
// Audible set = soloed tracks (folders expand to their descendants), everything
// DOWNSTREAM of them (outputTarget chain + Track::midiTarget feeder->instrument edges +
// enabled send destinations, transitively), and — for soloed buses — everything
// UPSTREAM that feeds them via outputTarget (transitively), so soloing a bus is
// audible; soloed Instrument tracks likewise pull in their MIDI feeders (midiTarget).
// Master is always audible.
// NOTE(spec): tracks feeding a soloed bus only via a *send* are not auto-included
// (v1 simplification; their main path would be muted anyway).
// ---------------------------------------------------------------------------

struct SoloState {
    bool anySolo = false;          // false => everything audible, `audible` unused
    std::vector<uint64_t> audible; // sorted track ids (valid when anySolo)
};

// Closure from explicit solo roots (used by AudioGraph::renderOffline's soloTrackId).
SoloState computeSoloClosure(const Project& p, const std::vector<uint64_t>& soloRoots);

// Roots = all tracks with solo == true (cmd/track.set solo path).
SoloState computeSoloAudibleSet(const Project& p);

// Binary search into SoloState::audible. True when !anySolo.
bool soloAudible(const SoloState& s, uint64_t trackId);

} // namespace mydaw
