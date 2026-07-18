// MyDAW — core/effects/Effects.cpp — stock effect DSP + catalog/factory. See Effects.h.
//
// Conventions: params are normalized 0..1 (atomic-backed in EffectBase for cross-thread reads).
// process() reads the current norms at block start and maps them to real units locally, so no
// coefficient caching / cross-thread coefficient races exist. All algorithms are textbook and
// RT-safe (no allocation/locks in process(); buffers sized in prepare()).

#include "core/effects/Effects.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

#include "midi/MidiEvent.h" // MidiBuffer / MidiEvent (instruments)

namespace mydaw {
namespace {

constexpr float kPi = 3.14159265358979323846f;

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline float linMap(float norm, float lo, float hi) { return lo + clampf(norm, 0.f, 1.f) * (hi - lo); }
inline float linNorm(float v, float lo, float hi) { return (v - lo) / (hi - lo); }
// Log map for strictly-positive ranges (times, frequencies): perceptually even.
inline float logMap(float norm, float lo, float hi) {
    return lo * std::pow(hi / lo, clampf(norm, 0.f, 1.f));
}
inline float logNorm(float v, float lo, float hi) {
    return std::log(v / lo) / std::log(hi / lo);
}
inline float dbToLin(float db) { return std::pow(10.0f, db * 0.05f); }
// One-pole smoothing coefficient for a given time constant (seconds).
inline float onePole(double ms, double sr) {
    const double t = std::max(1e-4, ms) * 0.001;
    return static_cast<float>(std::exp(-1.0 / (t * sr)));
}
inline std::string fmt(const char* f, float v) {
    char b[48];
    std::snprintf(b, sizeof(b), f, v);
    return std::string(b);
}

// ---------------------------------------------------------------------------
// EffectBase — param storage (atomic norms) + boilerplate. Subclasses declare params in their
// ctor via addParam(realDefault) and implement process()/valueText()/prepareImpl().
// ---------------------------------------------------------------------------
class EffectBase : public IEffect {
public:
    const std::vector<BuiltinParam>& params() const noexcept override { return params_; }

    void prepare(double sr, int maxBlock) override {
        sr_ = sr > 0 ? sr : 48000.0;
        maxBlock_ = maxBlock > 0 ? maxBlock : 512;
        prepareImpl();
        reset();
    }
    void reset() noexcept override {}

    float getParamNorm(uint32_t id) const noexcept override {
        const int i = indexOf(id);
        return i < 0 ? 0.0f : norms_[static_cast<size_t>(i)].load(std::memory_order_relaxed);
    }
    void setParamNorm(uint32_t id, float norm) noexcept override {
        const int i = indexOf(id);
        if (i >= 0)
            norms_[static_cast<size_t>(i)].store(clampf(norm, 0.f, 1.f), std::memory_order_relaxed);
    }

protected:
    void addParam(uint32_t id, const char* name, const char* unit, float defaultNorm, int steps) {
        params_.push_back(BuiltinParam{id, name, unit, clampf(defaultNorm, 0.f, 1.f), steps});
    }
    // Call after all addParam() calls in the ctor to build the atomic store at defaults.
    void finalizeParams() {
        norms_ = std::vector<std::atomic<float>>(params_.size());
        for (size_t i = 0; i < params_.size(); ++i)
            norms_[i].store(params_[i].defaultNorm, std::memory_order_relaxed);
    }
    float nrm(uint32_t id) const { return getParamNorm(id); }

    int indexOf(uint32_t id) const {
        for (size_t i = 0; i < params_.size(); ++i)
            if (params_[i].id == id) return static_cast<int>(i);
        return -1;
    }

    virtual void prepareImpl() {}

    std::vector<BuiltinParam> params_;
    std::vector<std::atomic<float>> norms_;
    double sr_ = 48000.0;
    int maxBlock_ = 512;
};

// ===========================================================================
// Utility — gain / pan / phase invert / mono
// ===========================================================================
class UtilityEffect : public EffectBase {
public:
    enum { kGain, kPan, kInvert, kMono };
    UtilityEffect() {
        addParam(kGain, "Gain", "dB", linNorm(0.f, -60.f, 24.f), 0);
        addParam(kPan, "Pan", "", linNorm(0.f, -1.f, 1.f), 0);
        addParam(kInvert, "Invert Phase", "", 0.f, 2);
        addParam(kMono, "Mono", "", 0.f, 2);
        finalizeParams();
    }
    void process(float* const* io, int numCh, int n, const MidiBuffer& /*midi*/) noexcept override {
        const float g = dbToLin(linMap(nrm(kGain), -60.f, 24.f));
        const float pan = linMap(nrm(kPan), -1.f, 1.f);
        const float sign = nrm(kInvert) >= 0.5f ? -1.f : 1.f;
        const bool mono = nrm(kMono) >= 0.5f;
        const float theta = (pan + 1.f) * 0.25f * kPi; // 0..pi/2
        const float gl = g * sign * std::cos(theta) * 1.41421356f; // keep center unity
        const float gr = g * sign * std::sin(theta) * 1.41421356f;
        if (numCh >= 2) {
            float* l = io[0];
            float* r = io[1];
            for (int i = 0; i < n; ++i) {
                float a = l[i], b = r[i];
                if (mono) { const float m = 0.5f * (a + b); a = m; b = m; }
                l[i] = a * gl;
                r[i] = b * gr;
            }
        } else {
            float* l = io[0];
            const float gm = g * sign;
            for (int i = 0; i < n; ++i) l[i] *= gm;
        }
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kGain: return fmt("%.1f dB", linMap(nrm(kGain), -60.f, 24.f));
            case kPan: {
                const float p = linMap(nrm(kPan), -1.f, 1.f);
                if (std::fabs(p) < 0.005f) return "C";
                return fmt(p < 0 ? "L %.0f" : "R %.0f", std::fabs(p) * 100.f);
            }
            case kInvert: return nrm(kInvert) >= 0.5f ? "On" : "Off";
            case kMono: return nrm(kMono) >= 0.5f ? "On" : "Off";
        }
        return "";
    }
};

// ===========================================================================
// Noise Gate
// ===========================================================================
class GateEffect : public EffectBase {
public:
    enum { kThresh, kAttack, kHold, kRelease, kRange };
    GateEffect() {
        addParam(kThresh, "Threshold", "dB", linNorm(-40.f, -80.f, 0.f), 0);
        addParam(kAttack, "Attack", "ms", logNorm(1.f, 0.1f, 100.f), 0);
        addParam(kHold, "Hold", "ms", linNorm(50.f, 0.f, 500.f), 0);
        addParam(kRelease, "Release", "ms", logNorm(100.f, 5.f, 2000.f), 0);
        addParam(kRange, "Range", "dB", linNorm(-60.f, -80.f, 0.f), 0);
        finalizeParams();
    }
    void reset() noexcept override { gain_ = 1.f; hold_ = 0; }
    void process(float* const* io, int numCh, int n, const MidiBuffer& /*midi*/) noexcept override {
        const float thr = dbToLin(linMap(nrm(kThresh), -80.f, 0.f));
        const float aCoef = onePole(logMap(nrm(kAttack), 0.1f, 100.f), sr_);
        const float rCoef = onePole(logMap(nrm(kRelease), 5.f, 2000.f), sr_);
        const int holdN = static_cast<int>(linMap(nrm(kHold), 0.f, 500.f) * 0.001f * sr_);
        const float floor = dbToLin(linMap(nrm(kRange), -80.f, 0.f));
        float* l = io[0];
        float* r = numCh >= 2 ? io[1] : nullptr;
        for (int i = 0; i < n; ++i) {
            const float det = r ? std::max(std::fabs(l[i]), std::fabs(r[i])) : std::fabs(l[i]);
            float target;
            if (det >= thr) { target = 1.f; hold_ = holdN; }
            else if (hold_ > 0) { target = 1.f; --hold_; }
            else target = floor;
            const float c = target < gain_ ? rCoef : aCoef; // closing = release, opening = attack
            gain_ = target + (gain_ - target) * c;
            l[i] *= gain_;
            if (r) r[i] *= gain_;
        }
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kThresh: return fmt("%.1f dB", linMap(nrm(kThresh), -80.f, 0.f));
            case kAttack: return fmt("%.1f ms", logMap(nrm(kAttack), 0.1f, 100.f));
            case kHold: return fmt("%.0f ms", linMap(nrm(kHold), 0.f, 500.f));
            case kRelease: return fmt("%.0f ms", logMap(nrm(kRelease), 5.f, 2000.f));
            case kRange: return fmt("%.1f dB", linMap(nrm(kRange), -80.f, 0.f));
        }
        return "";
    }
private:
    float gain_ = 1.f;
    int hold_ = 0;
};

// ===========================================================================
// Compressor — feed-forward, soft-knee, smoothed gain reduction
// ===========================================================================
class CompressorEffect : public EffectBase {
public:
    enum { kThresh, kRatio, kAttack, kRelease, kKnee, kMakeup };
    CompressorEffect() {
        addParam(kThresh, "Threshold", "dB", linNorm(-18.f, -60.f, 0.f), 0);
        addParam(kRatio, "Ratio", ":1", logNorm(4.f, 1.f, 20.f), 0);
        addParam(kAttack, "Attack", "ms", logNorm(10.f, 0.1f, 100.f), 0);
        addParam(kRelease, "Release", "ms", logNorm(100.f, 5.f, 2000.f), 0);
        addParam(kKnee, "Knee", "dB", linNorm(6.f, 0.f, 24.f), 0);
        addParam(kMakeup, "Makeup", "dB", linNorm(0.f, 0.f, 24.f), 0);
        finalizeParams();
    }
    void reset() noexcept override { grDb_ = 0.f; }
    void setSidechain(const float* l, const float* r, int frames) noexcept override {
        scL_ = l; scR_ = r; scN_ = frames; // valid only for the next process() call
    }
    void process(float* const* io, int numCh, int n, const MidiBuffer& /*midi*/) noexcept override {
        // External sidechain: drive the detector from the source when wired, else self-detect.
        const float* dl = (scL_ && scN_ > 0) ? scL_ : io[0];
        const float* dr = (scL_ && scN_ > 0) ? (scR_ ? scR_ : scL_) : (numCh >= 2 ? io[1] : io[0]);
        const int dn = (scL_ && scN_ > 0) ? scN_ : n;
        scL_ = scR_ = nullptr; scN_ = 0; // consume (one-shot per block)
        const float thr = linMap(nrm(kThresh), -60.f, 0.f);
        const float ratio = logMap(nrm(kRatio), 1.f, 20.f);
        const float aCoef = onePole(logMap(nrm(kAttack), 0.1f, 100.f), sr_);
        const float rCoef = onePole(logMap(nrm(kRelease), 5.f, 2000.f), sr_);
        const float knee = linMap(nrm(kKnee), 0.f, 24.f);
        const float makeup = linMap(nrm(kMakeup), 0.f, 24.f);
        float* l = io[0];
        float* r = numCh >= 2 ? io[1] : nullptr;
        for (int i = 0; i < n; ++i) {
            const int di = i < dn ? i : dn - 1; // clamp: sidechain block may be shorter
            const float det = std::max(std::fabs(dl[di]), std::fabs(dr[di]));
            const float xDb = 20.f * std::log10(det + 1e-9f);
            // Soft-knee static gain (target reduction, <= 0 dB).
            float yDb;
            const float over = xDb - thr;
            if (knee > 0.f && over > -knee * 0.5f && over < knee * 0.5f) {
                const float t = over + knee * 0.5f;
                yDb = xDb + (1.f / ratio - 1.f) * t * t / (2.f * knee);
            } else if (over >= knee * 0.5f) {
                yDb = thr + over / ratio;
            } else {
                yDb = xDb;
            }
            const float targetGr = yDb - xDb; // <= 0
            const float c = targetGr < grDb_ ? aCoef : rCoef; // more reduction = attack
            grDb_ = targetGr + (grDb_ - targetGr) * c;
            const float g = dbToLin(grDb_ + makeup);
            l[i] *= g;
            if (r) r[i] *= g;
        }
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kThresh: return fmt("%.1f dB", linMap(nrm(kThresh), -60.f, 0.f));
            case kRatio: return fmt("%.1f:1", logMap(nrm(kRatio), 1.f, 20.f));
            case kAttack: return fmt("%.1f ms", logMap(nrm(kAttack), 0.1f, 100.f));
            case kRelease: return fmt("%.0f ms", logMap(nrm(kRelease), 5.f, 2000.f));
            case kKnee: return fmt("%.1f dB", linMap(nrm(kKnee), 0.f, 24.f));
            case kMakeup: return fmt("%.1f dB", linMap(nrm(kMakeup), 0.f, 24.f));
        }
        return "";
    }
private:
    float grDb_ = 0.f;
    // External sidechain pointers, set for one block by setSidechain() then consumed by process().
    const float* scL_ = nullptr;
    const float* scR_ = nullptr;
    int scN_ = 0;
};

// ===========================================================================
// Limiter — per-sample brickwall (instant attack, smoothed release)
// ===========================================================================
class LimiterEffect : public EffectBase {
public:
    enum { kCeiling, kRelease };
    LimiterEffect() {
        addParam(kCeiling, "Ceiling", "dB", linNorm(-0.3f, -24.f, 0.f), 0);
        addParam(kRelease, "Release", "ms", logNorm(50.f, 1.f, 1000.f), 0);
        finalizeParams();
    }
    void reset() noexcept override { gain_ = 1.f; }
    void process(float* const* io, int numCh, int n, const MidiBuffer& /*midi*/) noexcept override {
        const float ceil = dbToLin(linMap(nrm(kCeiling), -24.f, 0.f));
        const float rCoef = onePole(logMap(nrm(kRelease), 1.f, 1000.f), sr_);
        float* l = io[0];
        float* r = numCh >= 2 ? io[1] : nullptr;
        for (int i = 0; i < n; ++i) {
            const float peak = r ? std::max(std::fabs(l[i]), std::fabs(r[i])) : std::fabs(l[i]);
            const float target = peak > ceil ? ceil / peak : 1.f;
            if (target < gain_) gain_ = target;            // instant attack — no overshoot
            else gain_ = target + (gain_ - target) * rCoef; // smoothed release
            l[i] *= gain_;
            if (r) r[i] *= gain_;
        }
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kCeiling: return fmt("%.1f dB", linMap(nrm(kCeiling), -24.f, 0.f));
            case kRelease: return fmt("%.0f ms", logMap(nrm(kRelease), 1.f, 1000.f));
        }
        return "";
    }
private:
    float gain_ = 1.f;
};

// ===========================================================================
// Delay — stereo, feedback with a tone (one-pole LP), optional ping-pong
// ===========================================================================
class DelayEffect : public EffectBase {
public:
    enum { kTime, kFeedback, kMix, kTone, kPingPong };
    DelayEffect() {
        addParam(kTime, "Time", "ms", linNorm(300.f, 1.f, 2000.f), 0);
        addParam(kFeedback, "Feedback", "%", linNorm(30.f, 0.f, 95.f), 0);
        addParam(kMix, "Mix", "%", linNorm(30.f, 0.f, 100.f), 0);
        addParam(kTone, "Tone", "Hz", logNorm(8000.f, 200.f, 20000.f), 0);
        addParam(kPingPong, "Ping-Pong", "", 0.f, 2);
        finalizeParams();
    }
    void prepareImpl() override {
        size_ = static_cast<int>(2.05 * sr_) + 4;
        bufL_.assign(static_cast<size_t>(size_), 0.f);
        bufR_.assign(static_cast<size_t>(size_), 0.f);
        w_ = 0;
        lpL_ = lpR_ = 0.f;
    }
    void reset() noexcept override {
        std::fill(bufL_.begin(), bufL_.end(), 0.f);
        std::fill(bufR_.begin(), bufR_.end(), 0.f);
        w_ = 0;
        lpL_ = lpR_ = 0.f;
    }
    void process(float* const* io, int numCh, int n, const MidiBuffer& /*midi*/) noexcept override {
        if (bufL_.empty()) return;
        const float ds = clampf(linMap(nrm(kTime), 1.f, 2000.f) * 0.001f * static_cast<float>(sr_),
                                1.f, static_cast<float>(size_ - 2));
        const float fb = linMap(nrm(kFeedback), 0.f, 95.f) * 0.01f;
        const float mix = linMap(nrm(kMix), 0.f, 100.f) * 0.01f;
        // one-pole LP coefficient for the tone control
        const float fc = logMap(nrm(kTone), 200.f, 20000.f);
        const float lpC = std::exp(-2.f * kPi * fc / static_cast<float>(sr_));
        const bool ping = nrm(kPingPong) >= 0.5f;
        const bool stereo = numCh >= 2;
        float* l = io[0];
        float* r = stereo ? io[1] : nullptr;
        for (int i = 0; i < n; ++i) {
            const float dl = readInterp(bufL_, ds);
            const float dr = stereo ? readInterp(bufR_, ds) : dl;
            lpL_ = dl + (lpL_ - dl) * lpC;
            lpR_ = dr + (lpR_ - dr) * lpC;
            const float inL = l[i];
            const float inR = stereo ? r[i] : l[i];
            float newL, newR;
            if (ping && stereo) { newL = inL + lpR_ * fb; newR = inR + lpL_ * fb; }
            else { newL = inL + lpL_ * fb; newR = inR + lpR_ * fb; }
            bufL_[static_cast<size_t>(w_)] = newL;
            bufR_[static_cast<size_t>(w_)] = newR;
            l[i] = inL * (1.f - mix) + lpL_ * mix;
            if (r) r[i] = inR * (1.f - mix) + lpR_ * mix;
            if (++w_ >= size_) w_ = 0;
        }
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kTime: return fmt("%.0f ms", linMap(nrm(kTime), 1.f, 2000.f));
            case kFeedback: return fmt("%.0f %%", linMap(nrm(kFeedback), 0.f, 95.f));
            case kMix: return fmt("%.0f %%", linMap(nrm(kMix), 0.f, 100.f));
            case kTone: return fmt("%.0f Hz", logMap(nrm(kTone), 200.f, 20000.f));
            case kPingPong: return nrm(kPingPong) >= 0.5f ? "On" : "Off";
        }
        return "";
    }
private:
    float readInterp(const std::vector<float>& b, float delay) const noexcept {
        float rp = static_cast<float>(w_) - delay;
        while (rp < 0.f) rp += static_cast<float>(size_);
        const int i0 = static_cast<int>(rp);
        const int i1 = (i0 + 1) % size_;
        const float f = rp - static_cast<float>(i0);
        return b[static_cast<size_t>(i0)] * (1.f - f) + b[static_cast<size_t>(i1)] * f;
    }
    std::vector<float> bufL_, bufR_;
    int size_ = 0;
    int w_ = 0;
    float lpL_ = 0.f, lpR_ = 0.f;
};

// ===========================================================================
// Reverb — Freeverb (8 combs + 4 allpass per channel)
// ===========================================================================
class ReverbEffect : public EffectBase {
public:
    enum { kSize, kDamp, kWidth, kMix };
    ReverbEffect() {
        addParam(kSize, "Size", "", 0.5f, 0);
        addParam(kDamp, "Damp", "", 0.5f, 0);
        addParam(kWidth, "Width", "", 1.0f, 0);
        addParam(kMix, "Mix", "%", linNorm(25.f, 0.f, 100.f), 0);
        finalizeParams();
    }
    void prepareImpl() override {
        static const int combTune[kCombs] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
        static const int apTune[kAllpass] = {556, 441, 341, 225};
        const double scale = sr_ / 44100.0;
        for (int ch = 0; ch < 2; ++ch) {
            const int spread = ch == 0 ? 0 : kStereoSpread;
            for (int c = 0; c < kCombs; ++c) {
                comb_[ch][c].buf.assign(static_cast<size_t>(std::max(1, (int)((combTune[c] + spread) * scale))), 0.f);
                comb_[ch][c].idx = 0;
                comb_[ch][c].store = 0.f;
            }
            for (int a = 0; a < kAllpass; ++a) {
                ap_[ch][a].buf.assign(static_cast<size_t>(std::max(1, (int)((apTune[a] + spread) * scale))), 0.f);
                ap_[ch][a].idx = 0;
            }
        }
    }
    void reset() noexcept override {
        for (int ch = 0; ch < 2; ++ch) {
            for (int c = 0; c < kCombs; ++c) {
                std::fill(comb_[ch][c].buf.begin(), comb_[ch][c].buf.end(), 0.f);
                comb_[ch][c].store = 0.f;
            }
            for (int a = 0; a < kAllpass; ++a)
                std::fill(ap_[ch][a].buf.begin(), ap_[ch][a].buf.end(), 0.f);
        }
    }
    void process(float* const* io, int numCh, int n, const MidiBuffer& /*midi*/) noexcept override {
        if (comb_[0][0].buf.empty()) return;
        const float roomsize = linMap(nrm(kSize), 0.f, 1.f) * 0.28f + 0.7f;
        const float damp1 = linMap(nrm(kDamp), 0.f, 1.f) * 0.4f;
        const float damp2 = 1.f - damp1;
        const float width = linMap(nrm(kWidth), 0.f, 1.f);
        const float mix = linMap(nrm(kMix), 0.f, 100.f) * 0.01f;
        const float wet1 = width * 0.5f + 0.5f;
        const float wet2 = (1.f - width) * 0.5f;
        const float gain = 0.015f;
        const bool stereo = numCh >= 2;
        float* l = io[0];
        float* r = stereo ? io[1] : nullptr;
        for (int i = 0; i < n; ++i) {
            const float dryL = l[i];
            const float dryR = stereo ? r[i] : l[i];
            const float input = (dryL + dryR) * gain;
            float outL = 0.f, outR = 0.f;
            for (int c = 0; c < kCombs; ++c) {
                outL += comb_[0][c].tick(input, roomsize, damp1, damp2);
                outR += comb_[1][c].tick(input, roomsize, damp1, damp2);
            }
            for (int a = 0; a < kAllpass; ++a) {
                outL = ap_[0][a].tick(outL);
                outR = ap_[1][a].tick(outR);
            }
            const float wetL = outL * wet1 + outR * wet2;
            const float wetR = outR * wet1 + outL * wet2;
            l[i] = dryL * (1.f - mix) + wetL * mix;
            if (r) r[i] = dryR * (1.f - mix) + wetR * mix;
        }
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kSize: return fmt("%.0f %%", linMap(nrm(kSize), 0.f, 1.f) * 100.f);
            case kDamp: return fmt("%.0f %%", linMap(nrm(kDamp), 0.f, 1.f) * 100.f);
            case kWidth: return fmt("%.0f %%", linMap(nrm(kWidth), 0.f, 1.f) * 100.f);
            case kMix: return fmt("%.0f %%", linMap(nrm(kMix), 0.f, 100.f));
        }
        return "";
    }
private:
    static constexpr int kCombs = 8;
    static constexpr int kAllpass = 4;
    static constexpr int kStereoSpread = 23;
    struct Comb {
        std::vector<float> buf;
        int idx = 0;
        float store = 0.f;
        float tick(float in, float feedback, float d1, float d2) noexcept {
            const float out = buf[static_cast<size_t>(idx)];
            store = out * d2 + store * d1;
            buf[static_cast<size_t>(idx)] = in + store * feedback;
            if (++idx >= static_cast<int>(buf.size())) idx = 0;
            return out;
        }
    };
    struct Allpass {
        std::vector<float> buf;
        int idx = 0;
        float tick(float in) noexcept {
            const float bufout = buf[static_cast<size_t>(idx)];
            buf[static_cast<size_t>(idx)] = in + bufout * 0.5f;
            if (++idx >= static_cast<int>(buf.size())) idx = 0;
            return bufout - in;
        }
    };
    Comb comb_[2][kCombs];
    Allpass ap_[2][kAllpass];
};

// ===========================================================================
// Synth — polyphonic subtractive instrument (MIDI-driven source)
// ===========================================================================
class SynthInstrument : public EffectBase {
public:
    enum { kWave, kCutoff, kReso, kAttack, kDecay, kSustain, kRelease, kGain };
    SynthInstrument() {
        addParam(kWave, "Waveform", "", 0.f, 4); // 0 Saw 1 Square 2 Triangle 3 Sine
        addParam(kCutoff, "Cutoff", "Hz", logNorm(6000.f, 50.f, 18000.f), 0);
        addParam(kReso, "Resonance", "", 0.2f, 0);
        addParam(kAttack, "Attack", "ms", logNorm(5.f, 1.f, 2000.f), 0);
        addParam(kDecay, "Decay", "ms", logNorm(200.f, 1.f, 2000.f), 0);
        addParam(kSustain, "Sustain", "", 0.7f, 0);
        addParam(kRelease, "Release", "ms", logNorm(150.f, 1.f, 4000.f), 0);
        addParam(kGain, "Gain", "dB", linNorm(-6.f, -24.f, 6.f), 0);
        finalizeParams();
    }
    bool isInstrument() const noexcept override { return true; }
    void reset() noexcept override {
        for (Voice& v : voices_) v = Voice{};
    }
    void process(float* const* io, int numCh, int n, const MidiBuffer& midi) noexcept override {
        float* l = io[0];
        float* r = numCh >= 2 ? io[1] : nullptr;
        int pos = 0;
        for (const MidiEvent& e : midi) {
            const int at = e.sampleOffset < 0 ? 0 : (e.sampleOffset > n ? n : e.sampleOffset);
            if (at > pos) { renderSeg(l, r, pos, at); pos = at; }
            if (e.isNoteOn() && e.velocity() > 0) noteOn(e.note(), e.velocity());
            else if (e.isNoteOff() || (e.isNoteOn() && e.velocity() == 0)) noteOff(e.note());
            else if (e.isAllNotesOff() || e.isAllSoundOff()) for (Voice& v : voices_) v.release();
        }
        if (pos < n) renderSeg(l, r, pos, n);
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kWave: {
                const int w = static_cast<int>(std::lround(nrm(kWave) * 3.f));
                static const char* names[4] = {"Saw", "Square", "Triangle", "Sine"};
                return names[w < 0 ? 0 : (w > 3 ? 3 : w)];
            }
            case kCutoff: return fmt("%.0f Hz", logMap(nrm(kCutoff), 50.f, 18000.f));
            case kReso: return fmt("%.0f %%", nrm(kReso) * 100.f);
            case kAttack: return fmt("%.0f ms", logMap(nrm(kAttack), 1.f, 2000.f));
            case kDecay: return fmt("%.0f ms", logMap(nrm(kDecay), 1.f, 2000.f));
            case kSustain: return fmt("%.0f %%", nrm(kSustain) * 100.f);
            case kRelease: return fmt("%.0f ms", logMap(nrm(kRelease), 1.f, 4000.f));
            case kGain: return fmt("%.1f dB", linMap(nrm(kGain), -24.f, 6.f));
        }
        return "";
    }
private:
    enum class Stage { Idle, Attack, Decay, Sustain, Release };
    struct Voice {
        bool active = false;
        int note = -1;
        float phase = 0.f, inc = 0.f, vel = 0.f;
        Stage stage = Stage::Idle;
        float env = 0.f;
        float lp = 0.f, bp = 0.f; // state-variable filter integrators
        void release() {
            if (active && stage != Stage::Idle) stage = Stage::Release;
        }
    };
    static constexpr int kVoices = 16;

    void noteOn(int note, int vel) {
        Voice* v = nullptr;
        for (Voice& c : voices_) if (!c.active) { v = &c; break; }
        if (!v) { // steal the quietest voice
            float lo = 1e9f;
            for (Voice& c : voices_) if (c.env < lo) { lo = c.env; v = &c; }
        }
        if (!v) return;
        *v = Voice{};
        v->active = true;
        v->note = note;
        v->vel = static_cast<float>(vel) / 127.f;
        v->inc = 440.f * std::pow(2.f, (note - 69) / 12.f) / static_cast<float>(sr_);
        v->stage = Stage::Attack;
    }
    void noteOff(int note) {
        for (Voice& v : voices_) if (v.active && v.note == note) v.release();
    }
    float osc(int wave, float ph) const {
        switch (wave) {
            case 1: return ph < 0.5f ? 1.f : -1.f;                 // square
            case 2: return 4.f * std::fabs(ph - 0.5f) - 1.f;       // triangle
            case 3: return std::sin(2.f * kPi * ph);               // sine
            default: return 2.f * ph - 1.f;                        // saw
        }
    }
    void renderSeg(float* l, float* r, int start, int end) noexcept {
        const int wave = static_cast<int>(std::lround(nrm(kWave) * 3.f));
        const float fc = logMap(nrm(kCutoff), 50.f, 18000.f);
        const float f = std::min(0.45f, 2.f * std::sin(kPi * fc / static_cast<float>(sr_)));
        const float q = 1.f - 0.95f * nrm(kReso); // damping (lower = more resonance)
        const float aInc = 1.f / std::max(1.f, logMap(nrm(kAttack), 1.f, 2000.f) * 0.001f * static_cast<float>(sr_));
        const float dInc = 1.f / std::max(1.f, logMap(nrm(kDecay), 1.f, 2000.f) * 0.001f * static_cast<float>(sr_));
        const float sus = nrm(kSustain);
        const float rInc = 1.f / std::max(1.f, logMap(nrm(kRelease), 1.f, 4000.f) * 0.001f * static_cast<float>(sr_));
        const float gain = dbToLin(linMap(nrm(kGain), -24.f, 6.f));
        for (int i = start; i < end; ++i) {
            float mix = 0.f;
            for (Voice& v : voices_) {
                if (!v.active) continue;
                // ADSR
                switch (v.stage) {
                    case Stage::Attack: v.env += aInc; if (v.env >= 1.f) { v.env = 1.f; v.stage = Stage::Decay; } break;
                    case Stage::Decay: v.env -= dInc; if (v.env <= sus) { v.env = sus; v.stage = Stage::Sustain; } break;
                    case Stage::Sustain: v.env = sus; break;
                    case Stage::Release: v.env -= rInc; if (v.env <= 0.f) { v.env = 0.f; v.active = false; v.stage = Stage::Idle; } break;
                    default: break;
                }
                if (!v.active) continue;
                float s = osc(wave, v.phase) * v.vel * v.env;
                v.phase += v.inc;
                if (v.phase >= 1.f) v.phase -= 1.f;
                // state-variable low-pass
                v.lp += f * v.bp;
                const float hp = s - v.lp - q * v.bp;
                v.bp += f * hp;
                mix += v.lp;
            }
            mix *= gain * 0.4f; // headroom for polyphony
            l[i] += mix;
            if (r) r[i] += mix;
        }
    }
    Voice voices_[kVoices];
};

// ===========================================================================
// Sampler — polyphonic one-shot / looping sample playback (MIDI-driven source)
// ===========================================================================
class SamplerInstrument : public EffectBase {
public:
    enum { kRoot, kTune, kGain, kAttack, kRelease, kLoop };
    SamplerInstrument() {
        addParam(kRoot, "Root Note", "", 60.f / 127.f, 128); // MIDI note = original pitch
        addParam(kTune, "Tune", "st", linNorm(0.f, -12.f, 12.f), 0);
        addParam(kGain, "Gain", "dB", linNorm(0.f, -24.f, 6.f), 0);
        addParam(kAttack, "Attack", "ms", logNorm(1.f, 1.f, 2000.f), 0);
        addParam(kRelease, "Release", "ms", logNorm(60.f, 1.f, 4000.f), 0);
        addParam(kLoop, "Loop", "", 0.f, 2);
        finalizeParams();
    }
    bool isInstrument() const noexcept override { return true; }

    // Main thread: publish an immutable Sample via an atomic pointer; keep prior samples alive
    // (the RT thread never frees). planes==nullptr clears.
    void setSampleData(const float* const* planes, int numCh, int64_t frames) noexcept override {
        if (!planes || numCh <= 0 || frames <= 1) {
            active_.store(nullptr, std::memory_order_release);
            return;
        }
        auto s = std::make_unique<Sample>();
        s->ch = std::min(numCh, 2);
        s->frames = frames;
        for (int c = 0; c < s->ch; ++c)
            s->planes[c].assign(planes[c], planes[c] + frames);
        active_.store(s.get(), std::memory_order_release);
        owned_.push_back(std::move(s));
    }
    void reset() noexcept override { for (Voice& v : voices_) v = Voice{}; }

    void process(float* const* io, int numCh, int n, const MidiBuffer& midi) noexcept override {
        const Sample* s = active_.load(std::memory_order_acquire);
        if (!s) return; // no sample → leave the (zeroed) buffer silent
        float* l = io[0];
        float* r = numCh >= 2 ? io[1] : nullptr;
        int pos = 0;
        for (const MidiEvent& e : midi) {
            const int at = e.sampleOffset < 0 ? 0 : (e.sampleOffset > n ? n : e.sampleOffset);
            if (at > pos) { renderSeg(s, l, r, pos, at); pos = at; }
            if (e.isNoteOn() && e.velocity() > 0) noteOn(e.note(), e.velocity());
            else if (e.isNoteOff() || (e.isNoteOn() && e.velocity() == 0)) noteOff(e.note());
            else if (e.isAllNotesOff() || e.isAllSoundOff())
                for (Voice& v : voices_) if (v.active) v.stage = Stage::Release;
        }
        if (pos < n) renderSeg(s, l, r, pos, n);
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kRoot: {
                const int note = std::clamp(static_cast<int>(std::lround(nrm(kRoot) * 127.f)), 0, 127);
                static const char* nm[12] = {"C","C#","D","D#","E","F","F#","G","G#","A","A#","B"};
                char b[16];
                std::snprintf(b, sizeof(b), "%s%d", nm[note % 12], note / 12 - 1);
                return b;
            }
            case kTune: return fmt("%+.0f st", linMap(nrm(kTune), -12.f, 12.f));
            case kGain: return fmt("%.1f dB", linMap(nrm(kGain), -24.f, 6.f));
            case kAttack: return fmt("%.0f ms", logMap(nrm(kAttack), 1.f, 2000.f));
            case kRelease: return fmt("%.0f ms", logMap(nrm(kRelease), 1.f, 4000.f));
            case kLoop: return nrm(kLoop) >= 0.5f ? "On" : "Off";
        }
        return "";
    }
private:
    struct Sample { std::vector<float> planes[2]; int ch = 0; int64_t frames = 0; };
    enum class Stage { Idle, Attack, Hold, Release };
    struct Voice {
        bool active = false;
        int note = -1;
        double pos = 0.0, rate = 1.0;
        float vel = 0.f, env = 0.f;
        Stage stage = Stage::Idle;
    };
    static constexpr int kVoices = 16;

    void noteOn(int note, int vel) {
        Voice* v = nullptr;
        for (Voice& c : voices_) if (!c.active) { v = &c; break; }
        if (!v) { float lo = 1e9f; for (Voice& c : voices_) if (c.env < lo) { lo = c.env; v = &c; } }
        if (!v) return;
        const int root = std::clamp(static_cast<int>(std::lround(nrm(kRoot) * 127.f)), 0, 127);
        const float tune = linMap(nrm(kTune), -12.f, 12.f);
        *v = Voice{};
        v->active = true;
        v->note = note;
        v->vel = static_cast<float>(vel) / 127.f;
        v->rate = std::pow(2.0, (static_cast<double>(note - root) + tune) / 12.0);
        v->stage = Stage::Attack;
    }
    void noteOff(int note) {
        for (Voice& v : voices_) if (v.active && v.note == note) v.stage = Stage::Release;
    }
    void renderSeg(const Sample* s, float* l, float* r, int start, int end) noexcept {
        const float gain = dbToLin(linMap(nrm(kGain), -24.f, 6.f)) * 1.2f;
        const float aInc = 1.f / std::max(1.f, logMap(nrm(kAttack), 1.f, 2000.f) * 0.001f * static_cast<float>(sr_));
        const float rInc = 1.f / std::max(1.f, logMap(nrm(kRelease), 1.f, 4000.f) * 0.001f * static_cast<float>(sr_));
        const bool loop = nrm(kLoop) >= 0.5f;
        const int64_t last = s->frames - 1;
        for (int i = start; i < end; ++i) {
            float ml = 0.f, mr = 0.f;
            for (Voice& v : voices_) {
                if (!v.active) continue;
                if (v.stage == Stage::Attack) { v.env += aInc; if (v.env >= 1.f) { v.env = 1.f; v.stage = Stage::Hold; } }
                else if (v.stage == Stage::Release) { v.env -= rInc; if (v.env <= 0.f) { v.active = false; continue; } }
                if (v.pos >= static_cast<double>(last)) {
                    if (loop) { while (v.pos >= static_cast<double>(last)) v.pos -= static_cast<double>(last); }
                    else { v.active = false; continue; }
                }
                const int64_t i0 = static_cast<int64_t>(v.pos);
                const double f = v.pos - static_cast<double>(i0);
                const float sl = s->planes[0][i0] * (1.f - f) + s->planes[0][i0 + 1] * f;
                const float sr = s->ch >= 2 ? s->planes[1][i0] * (1.f - f) + s->planes[1][i0 + 1] * f : sl;
                const float g = v.vel * v.env * gain;
                ml += sl * g;
                mr += sr * g;
                v.pos += v.rate;
            }
            l[i] += ml;
            if (r) r[i] += mr;
        }
    }
    std::atomic<const Sample*> active_{nullptr};
    std::vector<std::unique_ptr<Sample>> owned_;
    Voice voices_[kVoices];
};

// ===========================================================================
// Piano — modal (inharmonic-partial) piano instrument (MIDI-driven source)
//
// Each voice models the struck string pair as 2 slightly-detuned "strings" of up to 16
// exponentially-decaying inharmonic partials (f_n = f0·n·sqrt(1+B·n²)), each partial a
// complex-rotator sine (4 mul/2 add per sample — no per-sample trig). Velocity drives both
// level (Dynamics = dB range) and spectral tilt (harder hit = brighter), a short filtered
// noise burst supplies the hammer strike, CC64 is the sustain pedal, and key position pans
// the voice across the stereo field (Width). All shaping constants are empirical.
// ===========================================================================
class PianoInstrument : public EffectBase {
public:
    enum { kDecay, kBright, kHard, kDetune, kRelease, kWidth, kDynamics, kGain };
    PianoInstrument() {
        addParam(kDecay, "Decay", "%", logNorm(1.f, 0.25f, 4.f), 0);
        addParam(kBright, "Brightness", "", 0.5f, 0); // bipolar, center = neutral
        addParam(kHard, "Hardness", "%", 0.5f, 0);
        addParam(kDetune, "Detune", "ct", linNorm(1.6f, 0.f, 8.f), 0);
        addParam(kRelease, "Release", "ms", logNorm(90.f, 20.f, 500.f), 0);
        addParam(kWidth, "Width", "%", 0.7f, 0);
        addParam(kDynamics, "Dynamics", "%", 0.6f, 0);
        addParam(kGain, "Gain", "dB", linNorm(0.f, -24.f, 6.f), 0);
        finalizeParams();
    }
    bool isInstrument() const noexcept override { return true; }
    void prepareImpl() override {
        lvlCoef_ = std::exp(-1.f / (0.4f * static_cast<float>(sr_))); // silent-voice reaper
    }
    void reset() noexcept override {
        for (Voice& v : voices_) v.active = false;
        pedal_ = false;
    }
    void process(float* const* io, int numCh, int n, const MidiBuffer& midi) noexcept override {
        float* l = io[0];
        float* r = numCh >= 2 ? io[1] : nullptr;
        int pos = 0;
        for (const MidiEvent& e : midi) {
            const int at = e.sampleOffset < 0 ? 0 : (e.sampleOffset > n ? n : e.sampleOffset);
            if (at > pos) { renderSeg(l, r, pos, at); pos = at; }
            if (e.isNoteOn() && e.velocity() > 0) noteOn(e.note(), e.velocity());
            else if (e.isNoteOff() || (e.isNoteOn() && e.velocity() == 0)) noteOff(e.note());
            else if (e.isAllSoundOff()) { for (Voice& v : voices_) v.active = false; pedal_ = false; }
            else if (e.isAllNotesOff()) { for (Voice& v : voices_) startRelease(v); pedal_ = false; }
            else if (e.isController() && e.controller() == 64) setPedal(e.ccValue() >= 64);
        }
        if (pos < n) renderSeg(l, r, pos, n);
    }
    std::string valueText(uint32_t id) const override {
        switch (id) {
            case kDecay: return fmt("%.0f %%", logMap(nrm(kDecay), 0.25f, 4.f) * 100.f);
            case kBright: return fmt("%+.0f", (nrm(kBright) * 2.f - 1.f) * 100.f);
            case kHard: return fmt("%.0f %%", nrm(kHard) * 100.f);
            case kDetune: return fmt("%.1f ct", linMap(nrm(kDetune), 0.f, 8.f));
            case kRelease: return fmt("%.0f ms", logMap(nrm(kRelease), 20.f, 500.f));
            case kWidth: return fmt("%.0f %%", nrm(kWidth) * 100.f);
            case kDynamics: return fmt("%.0f %%", nrm(kDynamics) * 100.f);
            case kGain: return fmt("%.1f dB", linMap(nrm(kGain), -24.f, 6.f));
        }
        return "";
    }
private:
    static constexpr int kVoices = 24;
    static constexpr int kParts = 16;
    struct Voice {
        bool active = false;
        bool keyDown = false;
        bool sustained = false; // key up, held only by the pedal
        bool releasing = false;
        int note = -1;
        int nParts = 0;
        float velGain = 0.f;
        float env = 0.f, aInc = 0.f; // attack ramp 0..1 (declick)
        float rel = 1.f, relCoef = 1.f;
        float lvl = 1.f; // slow peak follower; reaps fully-decayed voices
        float gl = 0.7071f, gr = 0.7071f;
        // 2 detuned strings × partials: rotator state (re,im), rotation (rc,rs), amp + decay
        float re[2][kParts], im[2][kParts], rc[2][kParts], rs[2][kParts];
        float amp[2][kParts], dk[2][kParts];
        // hammer-strike noise burst (one-pole LP colored, fast exponential decay)
        float nAmp = 0.f, nDk = 0.f, nLp = 0.f, nLpC = 0.f;
        uint32_t rng = 0x9e3779b9u;
    };

    static float frand(uint32_t& s) noexcept { // xorshift white noise in -1..1
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return static_cast<float>(static_cast<int32_t>(s)) * (1.f / 2147483648.f);
    }
    void startRelease(Voice& v) noexcept {
        if (!v.active || v.releasing) return;
        const float ms = logMap(nrm(kRelease), 20.f, 500.f);
        v.relCoef = std::exp(-1.f / (ms * 0.001f * static_cast<float>(sr_)));
        v.releasing = true;
        v.keyDown = false;
        v.sustained = false;
    }
    void setPedal(bool down) noexcept {
        pedal_ = down;
        if (!down)
            for (Voice& v : voices_)
                if (v.active && v.sustained) startRelease(v);
    }
    void noteOn(int note, int vel) noexcept {
        // The damper falls onto a re-struck string just before the new hammer hits.
        for (Voice& v : voices_)
            if (v.active && v.note == note && !v.releasing) {
                v.releasing = true;
                v.keyDown = false;
                v.sustained = false;
                v.relCoef = std::exp(-1.f / (0.004f * static_cast<float>(sr_)));
            }
        Voice* v = nullptr;
        for (Voice& c : voices_) if (!c.active) { v = &c; break; }
        if (!v) { // steal the quietest
            float lo = 1e9f;
            for (Voice& c : voices_) { const float s = c.lvl * c.velGain; if (s < lo) { lo = s; v = &c; } }
        }
        if (!v) return;
        const uint32_t rng = v->rng; // keep the noise stream rolling across reuse
        *v = Voice{};
        v->rng = rng ? rng : 0x9e3779b9u;
        v->active = true;
        v->keyDown = true;
        v->note = note;

        const float velN = static_cast<float>(vel) / 127.f;
        const float dyn = nrm(kDynamics);
        const float bright = nrm(kBright) * 2.f - 1.f;
        const float hard = nrm(kHard);
        const float sr = static_cast<float>(sr_);
        v->velGain = dbToLin(-36.f * dyn * (1.f - velN));
        v->aInc = 1.f / std::max(8.f, (0.0002f + 0.0025f * (1.f - hard)) * sr);

        // Key position → stereo placement (equal power), scaled by Width.
        const float pan = clampf((static_cast<float>(note) - 21.f) / 87.f * 2.f - 1.f, -1.f, 1.f) * nrm(kWidth);
        const float theta = (pan + 1.f) * 0.25f * kPi;
        v->gl = std::cos(theta);
        v->gr = std::sin(theta);

        const float f0 = 440.f * std::exp2((static_cast<float>(note) - 69.f) / 12.f);
        // String stiffness (inharmonicity), growing toward the treble.
        const float B = 0.00017f * std::exp2((static_cast<float>(note) - 33.f) / 24.f);
        const float tauBase = 9.f * std::exp2(-(static_cast<float>(note) - 21.f) / 20.f) *
                              logMap(nrm(kDecay), 0.25f, 4.f);
        // Spectral tilt: 1/n^p rolloff opened up by Brightness and by striking harder.
        const float tilt = 1.9f - 0.75f * bright - 0.85f * velN * (0.4f + 0.6f * hard);
        const float detRatio = std::exp2(linMap(nrm(kDetune), 0.f, 8.f) / 2400.f); // ± half the cents
        const float nyq = 0.45f * sr;

        int np = 0;
        float ampSum = 0.f;
        for (int p = 1; p <= kParts; ++p) {
            const float pf = static_cast<float>(p);
            const float fn = f0 * pf * std::sqrt(1.f + B * pf * pf);
            if (fn >= nyq) break;
            // Hammer strikes ~1/8 along the string — comb-attenuates partials near n=8.
            const float a = std::pow(pf, -std::max(0.7f, tilt)) *
                            (0.3f + 0.7f * std::fabs(std::sin(kPi * pf * 0.118f)));
            const float tau = tauBase / (1.f + 0.6f * (pf - 1.f));
            const float dk = std::exp(-1.f / (tau * sr));
            for (int s = 0; s < 2; ++s) {
                const float fs = s == 0 ? fn / detRatio : fn * detRatio;
                const float w = 2.f * kPi * fs / sr;
                v->rc[s][np] = std::cos(w);
                v->rs[s][np] = std::sin(w);
                const float phase = s == 0 ? 0.f : 0.6f + 0.35f * pf; // decorrelate string 2
                v->re[s][np] = std::cos(phase);
                v->im[s][np] = std::sin(phase);
                v->amp[s][np] = a * 0.5f;
                v->dk[s][np] = dk;
            }
            ampSum += a;
            ++np;
        }
        v->nParts = np;
        if (ampSum > 1e-6f) { // normalize: every key lands at comparable strike level
            const float scale = 1.f / ampSum;
            for (int s = 0; s < 2; ++s)
                for (int p = 0; p < np; ++p) v->amp[s][p] *= scale;
        }

        // Hammer noise burst: level from Hardness²·velocity, color tracks the key.
        v->nAmp = (0.03f + 0.45f * hard * hard) * velN;
        const float nFc = clampf(400.f + f0 * 5.f, 400.f, 9000.f);
        v->nLpC = std::exp(-2.f * kPi * nFc / sr);
        v->nDk = std::exp(-1.f / ((0.002f + 0.010f * (1.f - hard)) * sr));
    }
    void noteOff(int note) noexcept {
        for (Voice& v : voices_)
            if (v.active && v.note == note && v.keyDown) {
                v.keyDown = false;
                if (pedal_) v.sustained = true;
                else startRelease(v);
            }
    }
    void renderSeg(float* l, float* r, int start, int end) noexcept {
        const float master = dbToLin(linMap(nrm(kGain), -24.f, 6.f)) * 0.32f;
        for (int i = start; i < end; ++i) {
            float outL = 0.f, outR = 0.f;
            for (Voice& v : voices_) {
                if (!v.active) continue;
                float sum = 0.f;
                for (int s = 0; s < 2; ++s) {
                    float* re = v.re[s];
                    float* im = v.im[s];
                    const float* rc = v.rc[s];
                    const float* rs = v.rs[s];
                    float* amp = v.amp[s];
                    const float* dk = v.dk[s];
                    for (int p = 0; p < v.nParts; ++p) {
                        const float nre = re[p] * rc[p] - im[p] * rs[p];
                        im[p] = re[p] * rs[p] + im[p] * rc[p];
                        re[p] = nre;
                        amp[p] *= dk[p];
                        sum += im[p] * amp[p];
                    }
                }
                if (v.nAmp > 1e-6f) { // hammer strike
                    const float w = frand(v.rng);
                    v.nLp = w + (v.nLp - w) * v.nLpC;
                    sum += v.nLp * v.nAmp;
                    v.nAmp *= v.nDk;
                }
                if (v.env < 1.f) { v.env += v.aInc; if (v.env > 1.f) v.env = 1.f; }
                if (v.releasing) {
                    v.rel *= v.relCoef;
                    if (v.rel < 7e-4f) { v.active = false; continue; }
                }
                const float o = sum * v.velGain * v.env * v.rel;
                const float ao = std::fabs(o);
                v.lvl *= lvlCoef_;
                if (ao > v.lvl) v.lvl = ao;
                if (v.lvl < 1e-5f) { v.active = false; continue; } // fully decayed
                outL += o * v.gl;
                outR += o * v.gr;
            }
            l[i] += outL * master;
            if (r) r[i] += outR * master;
        }
    }

    Voice voices_[kVoices];
    bool pedal_ = false;
    float lvlCoef_ = 0.9999f;
};

// ===========================================================================
// PolySynth — 2-oscillator subtractive synth (MIDI-driven source)
//
// Per voice: 2 polyBLEP-antialiased oscillators (wave / semitone / fine detune / mix) +
// sub sine (-1 oct) + white noise, into a Chamberlin SVF (LP/BP/HP) with its own ADSR
// (bipolar amount, ±4 oct) and key tracking; a second ADSR shapes the amp. One global LFO
// routes to pitch, filter, or amp. Glide slews pitch from the last played note; Width
// spreads voices across a 5-position pan sequence; CC64 sustains. 16 voices, steals quietest.
// ===========================================================================
class PolySynthInstrument : public EffectBase {
public:
    enum { kOsc1Wave, kOsc2Wave, kOsc2Semi, kOsc2Fine, kOscMix, kSub, kNoise, kGlide,
           kCutoff, kReso, kFltMode, kFltEnv, kFltTrack,
           kAmpA, kAmpD, kAmpS, kAmpR, kFltA, kFltD, kFltS, kFltR,
           kLfoRate, kLfoDepth, kLfoDest, kWidth, kGain };
    PolySynthInstrument() {
        addParam(kOsc1Wave, "Osc 1 Wave", "", 0.f, 4); // Saw Square Triangle Sine
        addParam(kOsc2Wave, "Osc 2 Wave", "", 0.f, 4);
        addParam(kOsc2Semi, "Osc 2 Semi", "st", 0.5f, 49); // -24..+24
        addParam(kOsc2Fine, "Osc 2 Fine", "ct", linNorm(6.f, -50.f, 50.f), 0);
        addParam(kOscMix, "Osc Mix", "%", 0.35f, 0);
        addParam(kSub, "Sub", "%", 0.2f, 0);
        addParam(kNoise, "Noise", "%", 0.f, 0);
        addParam(kGlide, "Glide", "ms", 0.f, 0);
        addParam(kCutoff, "Cutoff", "Hz", logNorm(1100.f, 30.f, 18000.f), 0);
        addParam(kReso, "Resonance", "%", 0.25f, 0);
        addParam(kFltMode, "Filter Type", "", 0.f, 3); // LP BP HP
        addParam(kFltEnv, "Filter Env", "", 0.675f, 0); // bipolar, ±4 oct
        addParam(kFltTrack, "Key Track", "%", 0.5f, 0);
        addParam(kAmpA, "Amp Attack", "ms", logNorm(3.f, 1.f, 4000.f), 0);
        addParam(kAmpD, "Amp Decay", "ms", logNorm(500.f, 1.f, 4000.f), 0);
        addParam(kAmpS, "Amp Sustain", "%", 0.65f, 0);
        addParam(kAmpR, "Amp Release", "ms", logNorm(260.f, 1.f, 8000.f), 0);
        addParam(kFltA, "Filter Attack", "ms", logNorm(1.f, 1.f, 4000.f), 0);
        addParam(kFltD, "Filter Decay", "ms", logNorm(380.f, 1.f, 4000.f), 0);
        addParam(kFltS, "Filter Sustain", "%", 0.2f, 0);
        addParam(kFltR, "Filter Release", "ms", logNorm(380.f, 1.f, 8000.f), 0);
        addParam(kLfoRate, "LFO Rate", "Hz", logNorm(5.f, 0.05f, 25.f), 0);
        addParam(kLfoDepth, "LFO Depth", "%", 0.f, 0);
        addParam(kLfoDest, "LFO Target", "", 0.f, 4); // Off Pitch Filter Amp
        addParam(kWidth, "Width", "%", 0.6f, 0);
        addParam(kGain, "Gain", "dB", linNorm(-8.f, -24.f, 6.f), 0);
        finalizeParams();
    }
    bool isInstrument() const noexcept override { return true; }
    void reset() noexcept override {
        for (Voice& v : voices_) v = Voice{};
        pedal_ = false;
        lfoPh_ = 0.f;
    }
    void process(float* const* io, int numCh, int n, const MidiBuffer& midi) noexcept override {
        float* l = io[0];
        float* r = numCh >= 2 ? io[1] : nullptr;
        int pos = 0;
        for (const MidiEvent& e : midi) {
            const int at = e.sampleOffset < 0 ? 0 : (e.sampleOffset > n ? n : e.sampleOffset);
            if (at > pos) { renderSeg(l, r, pos, at); pos = at; }
            if (e.isNoteOn() && e.velocity() > 0) noteOn(e.note(), e.velocity());
            else if (e.isNoteOff() || (e.isNoteOn() && e.velocity() == 0)) noteOff(e.note());
            else if (e.isAllSoundOff()) { for (Voice& v : voices_) v = Voice{}; pedal_ = false; }
            else if (e.isAllNotesOff()) { for (Voice& v : voices_) release(v); pedal_ = false; }
            else if (e.isController() && e.controller() == 64) setPedal(e.ccValue() >= 64);
        }
        if (pos < n) renderSeg(l, r, pos, n);
    }
    std::string valueText(uint32_t id) const override {
        static const char* waves[4] = {"Saw", "Square", "Triangle", "Sine"};
        static const char* modes[3] = {"Low-pass", "Band-pass", "High-pass"};
        static const char* dests[4] = {"Off", "Pitch", "Filter", "Amp"};
        switch (id) {
            case kOsc1Wave: return waves[stepIdx(kOsc1Wave, 4)];
            case kOsc2Wave: return waves[stepIdx(kOsc2Wave, 4)];
            case kOsc2Semi: return fmt("%+.0f st", std::round(linMap(nrm(kOsc2Semi), -24.f, 24.f)));
            case kOsc2Fine: return fmt("%+.0f ct", linMap(nrm(kOsc2Fine), -50.f, 50.f));
            case kOscMix: return fmt("%.0f %%", nrm(kOscMix) * 100.f);
            case kSub: return fmt("%.0f %%", nrm(kSub) * 100.f);
            case kNoise: return fmt("%.0f %%", nrm(kNoise) * 100.f);
            case kGlide: {
                const float ms = glideMs();
                return ms <= 0.f ? "Off" : fmt("%.0f ms", ms);
            }
            case kCutoff: return fmt("%.0f Hz", logMap(nrm(kCutoff), 30.f, 18000.f));
            case kReso: return fmt("%.0f %%", nrm(kReso) * 100.f);
            case kFltMode: return modes[stepIdx(kFltMode, 3)];
            case kFltEnv: return fmt("%+.0f %%", (nrm(kFltEnv) * 2.f - 1.f) * 100.f);
            case kFltTrack: return fmt("%.0f %%", nrm(kFltTrack) * 100.f);
            case kAmpA: return fmt("%.0f ms", logMap(nrm(kAmpA), 1.f, 4000.f));
            case kAmpD: return fmt("%.0f ms", logMap(nrm(kAmpD), 1.f, 4000.f));
            case kAmpS: return fmt("%.0f %%", nrm(kAmpS) * 100.f);
            case kAmpR: return fmt("%.0f ms", logMap(nrm(kAmpR), 1.f, 8000.f));
            case kFltA: return fmt("%.0f ms", logMap(nrm(kFltA), 1.f, 4000.f));
            case kFltD: return fmt("%.0f ms", logMap(nrm(kFltD), 1.f, 4000.f));
            case kFltS: return fmt("%.0f %%", nrm(kFltS) * 100.f);
            case kFltR: return fmt("%.0f ms", logMap(nrm(kFltR), 1.f, 8000.f));
            case kLfoRate: return fmt("%.2f Hz", logMap(nrm(kLfoRate), 0.05f, 25.f));
            case kLfoDepth: return fmt("%.0f %%", nrm(kLfoDepth) * 100.f);
            case kLfoDest: return dests[stepIdx(kLfoDest, 4)];
            case kWidth: return fmt("%.0f %%", nrm(kWidth) * 100.f);
            case kGain: return fmt("%.1f dB", linMap(nrm(kGain), -24.f, 6.f));
        }
        return "";
    }
private:
    struct Adsr {
        enum class St : uint8_t { Idle, Att, Dec, Sus, Rel };
        St st = St::Idle;
        float v = 0.f;
        void on() noexcept { st = St::Att; } // retrigger from current v (click-free)
        void off() noexcept { if (st != St::Idle) st = St::Rel; }
        float tick(float aInc, float dInc, float sus, float rInc) noexcept {
            switch (st) {
                case St::Att: v += aInc; if (v >= 1.f) { v = 1.f; st = St::Dec; } break;
                case St::Dec: v -= dInc; if (v <= sus) { v = sus; st = St::Sus; } break;
                case St::Sus: v = sus; break;
                case St::Rel: v -= rInc; if (v <= 0.f) { v = 0.f; st = St::Idle; } break;
                case St::Idle: break;
            }
            return v;
        }
    };
    struct Voice {
        bool active = false;
        bool keyDown = false;
        bool sustained = false;
        int note = -1;
        float vel = 0.f;
        float ph1 = 0.f, ph2 = 0.f, phSub = 0.f;
        float pitch = 60.f, target = 60.f; // MIDI, fractional (glide slew)
        Adsr aEnv, fEnv;
        float lp = 0.f, bp = 0.f;
        float gl = 0.7071f, gr = 0.7071f;
        uint32_t rng = 0x2545f491u;
    };
    static constexpr int kVoices = 16;

    int stepIdx(uint32_t id, int steps) const noexcept {
        const int i = static_cast<int>(std::lround(nrm(id) * static_cast<float>(steps - 1)));
        return i < 0 ? 0 : (i >= steps ? steps - 1 : i);
    }
    float glideMs() const noexcept {
        const float n = nrm(kGlide);
        return n <= 0.005f ? 0.f : logMap(n, 5.f, 1000.f);
    }
    // PolyBLEP residual: subtracts the aliased edge of a saw/square discontinuity.
    static float blep(float t, float dt) noexcept {
        if (t < dt) { const float x = t / dt; return x + x - x * x - 1.f; }
        if (t > 1.f - dt) { const float x = (t - 1.f) / dt; return x * x + x + x + 1.f; }
        return 0.f;
    }
    static float oscSample(int wave, float ph, float dt) noexcept {
        switch (wave) {
            case 1: { // square
                float s = ph < 0.5f ? 1.f : -1.f;
                s += blep(ph, dt);
                float t2 = ph + 0.5f;
                if (t2 >= 1.f) t2 -= 1.f;
                return s - blep(t2, dt);
            }
            case 2: return 4.f * std::fabs(ph - 0.5f) - 1.f; // triangle (1/n² rolloff — naive ok)
            case 3: return std::sin(2.f * kPi * ph);
            default: return 2.f * ph - 1.f - blep(ph, dt); // saw
        }
    }
    void setPedal(bool down) noexcept {
        pedal_ = down;
        if (!down)
            for (Voice& v : voices_)
                if (v.active && v.sustained) release(v);
    }
    void release(Voice& v) noexcept {
        if (!v.active) return;
        v.keyDown = false;
        v.sustained = false;
        v.aEnv.off();
        v.fEnv.off();
    }
    void noteOn(int note, int vel) noexcept {
        Voice* v = nullptr;
        for (Voice& c : voices_) if (!c.active) { v = &c; break; }
        if (!v) { float lo = 1e9f; for (Voice& c : voices_) if (c.aEnv.v < lo) { lo = c.aEnv.v; v = &c; } }
        if (!v) return;
        const uint32_t rng = v->rng;
        *v = Voice{};
        v->rng = rng ? rng : 0x2545f491u;
        v->active = true;
        v->keyDown = true;
        v->note = note;
        v->vel = static_cast<float>(vel) / 127.f;
        v->target = static_cast<float>(note);
        v->pitch = (glideMs() > 0.f && lastPitch_ >= 0.f) ? lastPitch_ : v->target;
        lastPitch_ = v->target;
        // 5-position pan sequence scaled by Width — spreads a held chord across the field.
        static const float seq[5] = {0.f, -0.6f, 0.6f, -0.3f, 0.3f};
        const float pan = seq[panSeq_++ % 5] * nrm(kWidth);
        const float theta = (pan + 1.f) * 0.25f * kPi;
        v->gl = std::cos(theta);
        v->gr = std::sin(theta);
        v->aEnv.on();
        v->fEnv.on();
    }
    void noteOff(int note) noexcept {
        for (Voice& v : voices_)
            if (v.active && v.note == note && v.keyDown) {
                if (pedal_) { v.keyDown = false; v.sustained = true; }
                else release(v);
            }
    }
    void renderSeg(float* l, float* r, int start, int end) noexcept {
        const float sr = static_cast<float>(sr_);
        const int w1 = stepIdx(kOsc1Wave, 4);
        const int w2 = stepIdx(kOsc2Wave, 4);
        const float ratio2 = std::exp2((std::round(linMap(nrm(kOsc2Semi), -24.f, 24.f)) +
                                        linMap(nrm(kOsc2Fine), -50.f, 50.f) / 100.f) / 12.f);
        const float mix = nrm(kOscMix);
        const float g1 = 1.f - mix, g2 = mix;
        const float sub = nrm(kSub);
        const float noise = nrm(kNoise);
        const float gMs = glideMs();
        const float gCoef = gMs <= 0.f ? 0.f : std::exp(-1.f / (gMs * 0.001f * sr));
        const float cutBase = logMap(nrm(kCutoff), 30.f, 18000.f);
        const float q = 1.f - 0.93f * nrm(kReso);
        const int mode = stepIdx(kFltMode, 3);
        const float envOct = (nrm(kFltEnv) * 2.f - 1.f) * 4.f;
        const float track = nrm(kFltTrack);
        const float aA = 1.f / std::max(1.f, logMap(nrm(kAmpA), 1.f, 4000.f) * 0.001f * sr);
        const float aD = 1.f / std::max(1.f, logMap(nrm(kAmpD), 1.f, 4000.f) * 0.001f * sr);
        const float aS = nrm(kAmpS);
        const float aR = 1.f / std::max(1.f, logMap(nrm(kAmpR), 1.f, 8000.f) * 0.001f * sr);
        const float fA = 1.f / std::max(1.f, logMap(nrm(kFltA), 1.f, 4000.f) * 0.001f * sr);
        const float fD = 1.f / std::max(1.f, logMap(nrm(kFltD), 1.f, 4000.f) * 0.001f * sr);
        const float fS = nrm(kFltS);
        const float fR = 1.f / std::max(1.f, logMap(nrm(kFltR), 1.f, 8000.f) * 0.001f * sr);
        const float lfoInc = logMap(nrm(kLfoRate), 0.05f, 25.f) / sr;
        const float depth = nrm(kLfoDepth);
        const int dest = stepIdx(kLfoDest, 4);
        const float master = dbToLin(linMap(nrm(kGain), -24.f, 6.f)) * 0.5f;
        const float nyqF = 0.45f * sr;
        for (int i = start; i < end; ++i) {
            lfoPh_ += lfoInc;
            if (lfoPh_ >= 1.f) lfoPh_ -= 1.f;
            const float lfo = std::sin(2.f * kPi * lfoPh_);
            const float pitchMod = dest == 1 ? lfo * depth : 0.f;         // ±1 semitone
            const float fltMod = dest == 2 ? lfo * depth * 2.f : 0.f;     // ±2 octaves
            const float trem = dest == 3 ? 1.f - depth * 0.5f * (1.f + lfo) : 1.f;
            float outL = 0.f, outR = 0.f;
            for (Voice& v : voices_) {
                if (!v.active) continue;
                const float av = v.aEnv.tick(aA, aD, aS, aR);
                if (v.aEnv.st == Adsr::St::Idle) { v.active = false; continue; }
                const float fv = v.fEnv.tick(fA, fD, fS, fR);
                if (gCoef > 0.f) v.pitch = v.target + (v.pitch - v.target) * gCoef;
                else v.pitch = v.target;
                const float freq = 440.f * std::exp2((v.pitch + pitchMod - 69.f) / 12.f);
                const float dt1 = std::min(0.49f, freq / sr);
                const float dt2 = std::min(0.49f, dt1 * ratio2);
                float o = g1 * oscSample(w1, v.ph1, dt1) + g2 * oscSample(w2, v.ph2, dt2);
                v.ph1 += dt1; if (v.ph1 >= 1.f) v.ph1 -= 1.f;
                v.ph2 += dt2; if (v.ph2 >= 1.f) v.ph2 -= 1.f;
                if (sub > 0.001f) {
                    v.phSub += dt1 * 0.5f;
                    if (v.phSub >= 1.f) v.phSub -= 1.f;
                    o += sub * std::sin(2.f * kPi * v.phSub);
                }
                if (noise > 0.001f) o += noise * frand(v.rng) * 0.8f;
                const float fc = clampf(cutBase * std::exp2(envOct * fv + fltMod +
                                                            track * (v.pitch - 60.f) / 12.f),
                                        20.f, nyqF);
                const float f = std::min(0.45f, 2.f * std::sin(kPi * fc / sr));
                v.lp += f * v.bp;
                const float hp = o - v.lp - q * v.bp;
                v.bp += f * hp;
                const float y = mode == 0 ? v.lp : (mode == 1 ? v.bp : hp);
                const float out = y * av * (0.25f + 0.75f * v.vel) * trem;
                outL += out * v.gl;
                outR += out * v.gr;
            }
            l[i] += outL * master;
            if (r) r[i] += outR * master;
        }
    }
    static float frand(uint32_t& s) noexcept {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return static_cast<float>(static_cast<int32_t>(s)) * (1.f / 2147483648.f);
    }

    Voice voices_[kVoices];
    bool pedal_ = false;
    float lfoPh_ = 0.f;
    float lastPitch_ = -1.f;
    uint32_t panSeq_ = 0;
};

// ---------------------------------------------------------------------------
// Catalog / factory
// ---------------------------------------------------------------------------
using MakeFn = std::unique_ptr<IEffect> (*)();
struct Entry {
    const char* uid;
    const char* name;
    const char* category;
    bool isInstrument;
    MakeFn make;
};

template <class T>
std::unique_ptr<IEffect> makeT() { return std::make_unique<T>(); }

const std::array<Entry, 10>& entries() {
    static const std::array<Entry, 10> e{{
        {"builtin:utility", "Utility", "Utility", false, &makeT<UtilityEffect>},
        {"builtin:gate", "Noise Gate", "Dynamics", false, &makeT<GateEffect>},
        {"builtin:compressor", "Compressor", "Dynamics", false, &makeT<CompressorEffect>},
        {"builtin:limiter", "Limiter", "Dynamics", false, &makeT<LimiterEffect>},
        {"builtin:delay", "Delay", "Delay", false, &makeT<DelayEffect>},
        {"builtin:reverb", "Reverb", "Reverb", false, &makeT<ReverbEffect>},
        {"builtin:synth", "Synth", "Instrument", true, &makeT<SynthInstrument>},
        {"builtin:sampler", "Sampler", "Instrument", true, &makeT<SamplerInstrument>},
        {"builtin:piano", "Piano", "Instrument", true, &makeT<PianoInstrument>},
        {"builtin:polysynth", "PolySynth", "Instrument", true, &makeT<PolySynthInstrument>},
    }};
    return e;
}

// ---------------------------------------------------------------------------
// Factory presets — defined in real units, converted through the same norm maps
// the instruments use, so the tables read like patch sheets.
// ---------------------------------------------------------------------------

// Full real-unit patch for the PolySynth (fields default to the instrument defaults).
struct PsPatch {
    int w1 = 0, w2 = 0;                       // 0 Saw 1 Square 2 Triangle 3 Sine
    float semi = 0.f, fine = 6.f;             // osc2 offset
    float mix = 0.35f, sub = 0.2f, noise = 0.f, glideMs = 0.f;
    float cutoff = 1100.f, reso = 0.25f;      // filter
    int mode = 0;                             // 0 LP 1 BP 2 HP
    float fenv = 0.35f, track = 0.5f;         // env amount -1..1, key track 0..1
    float aA = 3.f, aD = 500.f, aS = 0.65f, aR = 260.f;   // amp ADSR ms/ms/%/ms
    float fA = 1.f, fD = 380.f, fS = 0.2f, fR = 380.f;    // filter ADSR
    float lfoHz = 5.f, lfoDepth = 0.f;
    int lfoDest = 0;                          // 0 Off 1 Pitch 2 Filter 3 Amp
    float width = 0.6f, gainDb = -8.f;
};

BuiltinPreset psPreset(const char* name, const PsPatch& v) {
    using P = PolySynthInstrument;
    const auto gl = [](float ms) { return ms <= 0.f ? 0.f : logNorm(ms, 5.f, 1000.f); };
    return BuiltinPreset{name, {
        {P::kOsc1Wave, v.w1 / 3.f},
        {P::kOsc2Wave, v.w2 / 3.f},
        {P::kOsc2Semi, linNorm(v.semi, -24.f, 24.f)},
        {P::kOsc2Fine, linNorm(v.fine, -50.f, 50.f)},
        {P::kOscMix, v.mix},
        {P::kSub, v.sub},
        {P::kNoise, v.noise},
        {P::kGlide, gl(v.glideMs)},
        {P::kCutoff, logNorm(v.cutoff, 30.f, 18000.f)},
        {P::kReso, v.reso},
        {P::kFltMode, v.mode / 2.f},
        {P::kFltEnv, (v.fenv + 1.f) * 0.5f},
        {P::kFltTrack, v.track},
        {P::kAmpA, logNorm(v.aA, 1.f, 4000.f)},
        {P::kAmpD, logNorm(v.aD, 1.f, 4000.f)},
        {P::kAmpS, v.aS},
        {P::kAmpR, logNorm(v.aR, 1.f, 8000.f)},
        {P::kFltA, logNorm(v.fA, 1.f, 4000.f)},
        {P::kFltD, logNorm(v.fD, 1.f, 4000.f)},
        {P::kFltS, v.fS},
        {P::kFltR, logNorm(v.fR, 1.f, 8000.f)},
        {P::kLfoRate, logNorm(v.lfoHz, 0.05f, 25.f)},
        {P::kLfoDepth, v.lfoDepth},
        {P::kLfoDest, v.lfoDest / 3.f},
        {P::kWidth, v.width},
        {P::kGain, linNorm(v.gainDb, -24.f, 6.f)},
    }};
}

// Piano patch (fields default to the instrument defaults).
struct PianoPatch {
    float decay = 1.f;      // 0.25..4 scale
    float bright = 0.f;     // -1..1
    float hard = 0.5f, detuneCt = 1.6f, relMs = 90.f;
    float width = 0.7f, dyn = 0.6f, gainDb = 0.f;
};

BuiltinPreset pianoPreset(const char* name, const PianoPatch& v) {
    using P = PianoInstrument;
    return BuiltinPreset{name, {
        {P::kDecay, logNorm(v.decay, 0.25f, 4.f)},
        {P::kBright, (v.bright + 1.f) * 0.5f},
        {P::kHard, v.hard},
        {P::kDetune, linNorm(v.detuneCt, 0.f, 8.f)},
        {P::kRelease, logNorm(v.relMs, 20.f, 500.f)},
        {P::kWidth, v.width},
        {P::kDynamics, v.dyn},
        {P::kGain, linNorm(v.gainDb, -24.f, 6.f)},
    }};
}

const std::vector<BuiltinPreset>& polySynthPresets() {
    static const std::vector<BuiltinPreset> v = [] {
        std::vector<BuiltinPreset> out;
        PsPatch init;
        out.push_back(psPreset("Init", init));

        PsPatch fatSaw;      // classic detuned-saw stack
        fatSaw.mix = 0.5f; fatSaw.fine = 12.f; fatSaw.cutoff = 4200.f; fatSaw.reso = 0.2f;
        fatSaw.fenv = 0.3f; fatSaw.aD = 800.f; fatSaw.aS = 0.8f; fatSaw.width = 0.75f;
        fatSaw.gainDb = -9.f;
        out.push_back(psPreset("Fat Saw Lead", fatSaw));

        PsPatch sqLead;
        sqLead.w1 = 1; sqLead.mix = 0.f; sqLead.sub = 0.3f; sqLead.glideMs = 55.f;
        sqLead.cutoff = 2600.f; sqLead.reso = 0.35f; sqLead.fenv = 0.25f;
        sqLead.lfoDest = 1; sqLead.lfoHz = 5.5f; sqLead.lfoDepth = 0.12f;
        sqLead.width = 0.2f;
        out.push_back(psPreset("Square Lead", sqLead));

        PsPatch vibra;      // triangle lead with delayed-feel vibrato
        vibra.w1 = 2; vibra.w2 = 3; vibra.mix = 0.25f; vibra.cutoff = 3400.f;
        vibra.fenv = 0.15f; vibra.lfoDest = 1; vibra.lfoHz = 5.2f; vibra.lfoDepth = 0.2f;
        vibra.glideMs = 30.f; vibra.aA = 8.f; vibra.aS = 0.85f;
        out.push_back(psPreset("Vibrato Lead", vibra));

        PsPatch warmPad;
        warmPad.mix = 0.5f; warmPad.fine = 9.f; warmPad.cutoff = 900.f; warmPad.reso = 0.15f;
        warmPad.fenv = 0.2f; warmPad.aA = 750.f; warmPad.aD = 2000.f; warmPad.aS = 0.8f;
        warmPad.aR = 1500.f; warmPad.fA = 1200.f; warmPad.fD = 2000.f; warmPad.fS = 0.6f;
        warmPad.fR = 1800.f; warmPad.width = 0.9f; warmPad.gainDb = -10.f;
        out.push_back(psPreset("Warm Pad", warmPad));

        PsPatch sweep;      // slow filter bloom
        sweep.mix = 0.5f; sweep.fine = 10.f; sweep.cutoff = 220.f; sweep.reso = 0.35f;
        sweep.fenv = 0.7f; sweep.fA = 2800.f; sweep.fD = 3000.f; sweep.fS = 0.7f;
        sweep.fR = 2500.f; sweep.aA = 900.f; sweep.aS = 0.9f; sweep.aR = 2200.f;
        sweep.width = 0.85f; sweep.gainDb = -11.f;
        out.push_back(psPreset("Sweep Pad", sweep));

        PsPatch strings;
        strings.mix = 0.5f; strings.fine = 14.f; strings.cutoff = 3000.f;
        strings.fenv = 0.1f; strings.aA = 380.f; strings.aS = 0.85f; strings.aR = 800.f;
        strings.lfoDest = 1; strings.lfoHz = 6.f; strings.lfoDepth = 0.06f;
        strings.width = 0.95f; strings.gainDb = -10.f;
        out.push_back(psPreset("String Machine", strings));

        PsPatch choir;
        choir.w1 = 2; choir.w2 = 2; choir.mix = 0.5f; choir.fine = 11.f;
        choir.cutoff = 1400.f; choir.mode = 1; choir.reso = 0.3f; choir.fenv = 0.05f;
        choir.aA = 600.f; choir.aS = 0.85f; choir.aR = 1200.f; choir.width = 0.9f;
        choir.gainDb = -7.f;
        out.push_back(psPreset("Choir Pad", choir));

        PsPatch deep;
        deep.w2 = 1; deep.semi = -12.f; deep.fine = 0.f; deep.mix = 0.4f; deep.sub = 0.6f;
        deep.cutoff = 380.f; deep.fenv = 0.45f; deep.fD = 260.f; deep.fS = 0.1f;
        deep.aA = 2.f; deep.aD = 420.f; deep.aS = 0.7f; deep.aR = 130.f;
        deep.width = 0.f; deep.track = 0.3f; deep.gainDb = -6.f;
        out.push_back(psPreset("Deep Bass", deep));

        PsPatch acid;
        acid.mix = 0.f; acid.fine = 0.f; acid.sub = 0.1f; acid.cutoff = 320.f;
        acid.reso = 0.78f; acid.fenv = 0.6f; acid.fD = 300.f; acid.fS = 0.f;
        acid.glideMs = 70.f; acid.aA = 1.f; acid.aD = 320.f; acid.aS = 0.6f;
        acid.aR = 90.f; acid.width = 0.f; acid.track = 0.7f;
        out.push_back(psPreset("Acid Bass", acid));

        PsPatch subBass;
        subBass.w1 = 3; subBass.mix = 0.f; subBass.sub = 0.5f; subBass.noise = 0.f;
        subBass.cutoff = 520.f; subBass.fenv = 0.1f; subBass.aA = 4.f; subBass.aD = 500.f;
        subBass.aS = 0.9f; subBass.aR = 100.f; subBass.width = 0.f; subBass.gainDb = -4.f;
        out.push_back(psPreset("Sub Bass", subBass));

        PsPatch pluck;
        pluck.mix = 0.5f; pluck.fine = 8.f; pluck.cutoff = 650.f; pluck.reso = 0.3f;
        pluck.fenv = 0.65f; pluck.fD = 180.f; pluck.fS = 0.f; pluck.aA = 1.f;
        pluck.aD = 360.f; pluck.aS = 0.f; pluck.aR = 240.f; pluck.track = 0.6f;
        out.push_back(psPreset("Pluck", pluck));

        PsPatch bell;
        bell.w1 = 3; bell.w2 = 3; bell.semi = 19.f; bell.fine = 4.f; bell.mix = 0.35f;
        bell.sub = 0.f; bell.cutoff = 5200.f; bell.fenv = 0.3f; bell.fD = 900.f;
        bell.fS = 0.f; bell.aA = 1.f; bell.aD = 1300.f; bell.aS = 0.15f; bell.aR = 900.f;
        bell.width = 0.8f;
        out.push_back(psPreset("Bell Keys", bell));

        PsPatch ep;
        ep.w1 = 2; ep.w2 = 3; ep.mix = 0.3f; ep.sub = 0.15f; ep.cutoff = 2100.f;
        ep.fenv = 0.25f; ep.fD = 700.f; ep.fS = 0.1f; ep.aA = 2.f; ep.aD = 950.f;
        ep.aS = 0.5f; ep.aR = 320.f; ep.lfoDest = 3; ep.lfoHz = 4.2f; ep.lfoDepth = 0.15f;
        ep.width = 0.5f;
        out.push_back(psPreset("EP Keys", ep));

        PsPatch brass;
        brass.mix = 0.45f; brass.fine = 9.f; brass.cutoff = 1500.f; brass.reso = 0.2f;
        brass.fenv = 0.4f; brass.fA = 55.f; brass.fD = 420.f; brass.fS = 0.55f;
        brass.aA = 35.f; brass.aS = 0.85f; brass.aR = 200.f; brass.width = 0.4f;
        brass.gainDb = -7.f;
        out.push_back(psPreset("Synth Brass", brass));

        PsPatch flute;
        flute.w1 = 3; flute.w2 = 2; flute.mix = 0.4f; flute.sub = 0.f; flute.noise = 0.07f;
        flute.cutoff = 1300.f; flute.fenv = 0.1f; flute.aA = 140.f; flute.aS = 0.9f;
        flute.aR = 260.f; flute.lfoDest = 1; flute.lfoHz = 5.f; flute.lfoDepth = 0.08f;
        flute.width = 0.25f;
        out.push_back(psPreset("Hollow Flute", flute));

        PsPatch wob;
        wob.w2 = 1; wob.semi = -12.f; wob.fine = 0.f; wob.mix = 0.3f; wob.sub = 0.4f;
        wob.cutoff = 850.f; wob.reso = 0.55f; wob.fenv = 0.f; wob.aS = 1.f; wob.aR = 180.f;
        wob.lfoDest = 2; wob.lfoHz = 1.8f; wob.lfoDepth = 0.8f; wob.width = 0.3f;
        wob.gainDb = -7.f;
        out.push_back(psPreset("Filter Wobble", wob));

        PsPatch riser;
        riser.mix = 0.f; riser.noise = 1.f; riser.cutoff = 300.f; riser.reso = 0.4f;
        riser.mode = 1; riser.fenv = 0.85f; riser.fA = 3800.f; riser.fS = 1.f;
        riser.aA = 2600.f; riser.aS = 1.f; riser.aR = 700.f; riser.width = 0.9f;
        riser.gainDb = -10.f;
        out.push_back(psPreset("Noise Riser", riser));

        return out;
    }();
    return v;
}

const std::vector<BuiltinPreset>& pianoPresets() {
    static const std::vector<BuiltinPreset> v = [] {
        std::vector<BuiltinPreset> out;
        out.push_back(pianoPreset("Concert Grand", PianoPatch{}));
        PianoPatch bright;
        bright.bright = 0.35f; bright.hard = 0.7f; bright.dyn = 0.5f;
        out.push_back(pianoPreset("Bright Pop", bright));
        PianoPatch felt;
        felt.bright = -0.45f; felt.hard = 0.15f; felt.dyn = 0.75f; felt.decay = 0.8f;
        felt.width = 0.5f;
        out.push_back(pianoPreset("Mellow Felt", felt));
        PianoPatch honky;
        honky.detuneCt = 6.f; honky.bright = 0.15f; honky.hard = 0.6f; honky.decay = 0.7f;
        out.push_back(pianoPreset("Honky-Tonk", honky));
        PianoPatch tack;
        tack.hard = 0.95f; tack.bright = 0.5f; tack.decay = 0.6f; tack.dyn = 0.4f;
        out.push_back(pianoPreset("Tack Piano", tack));
        return out;
    }();
    return v;
}

} // namespace

const std::vector<BuiltinPreset>& builtinFactoryPresets(const std::string& uid) {
    static const std::vector<BuiltinPreset> none;
    if (uid == "builtin:polysynth") return polySynthPresets();
    if (uid == "builtin:piano") return pianoPresets();
    return none;
}

const std::vector<BuiltinEffectDesc>& builtinEffectCatalog() {
    static const std::vector<BuiltinEffectDesc> cat = [] {
        std::vector<BuiltinEffectDesc> v;
        for (const Entry& e : entries()) {
            std::unique_ptr<IEffect> fx = e.make();
            v.push_back(BuiltinEffectDesc{e.uid, e.name, e.category, e.isInstrument, fx->params()});
        }
        return v;
    }();
    return cat;
}

bool isBuiltinUid(const std::string& uid) {
    for (const Entry& e : entries())
        if (uid == e.uid) return true;
    return false;
}

std::unique_ptr<IEffect> makeBuiltinEffect(const std::string& uid) {
    for (const Entry& e : entries())
        if (uid == e.uid) return e.make();
    return nullptr;
}

} // namespace mydaw
