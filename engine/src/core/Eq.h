// MyDAW — core/Eq.h
// Per-track parametric channel EQ: RBJ-cookbook biquads (peak/shelf/cut/notch), computed
// on the CONTROL thread and applied RT-safely in the track signal chain (post-inserts,
// pre-fader). See SPEC §5.3 (cmd/track.setEq) and §6 (track.eq schema).
//
// Threading model (mirrors the ParamMsg fast path of GraphNode.h):
//   - EqCoeffs (one biquad's coefficients) and EqBandSet (the whole cascade) are
//     plain trivially-copyable value types computed by the command thread.
//   - EqProcessor holds per-channel Direct-Form-I biquad state; process() is hard-RT
//     (no allocation, no locks, denormal-flushed). setActiveRt() swaps the live
//     coefficient set in place (called from the graph's param-ring drain at block start).
//
// type enum (pinned cross-module contract):
//   0=peak(bell) 1=lowShelf 2=highShelf 3=highCut(LPF) 4=lowCut(HPF) 5=notch.

#pragma once

#include <cmath>
#include <cstdint>
#include <type_traits>

namespace mydaw {

// Hard cap on bands per track EQ (RT state is fixed-size; the UI exposes far fewer).
constexpr int kMaxEqBands = 12;

// EQ band types (pinned enum).
enum class EqType : int {
    Peak = 0,
    LowShelf = 1,
    HighShelf = 2,
    HighCut = 3, // low-pass
    LowCut = 4,  // high-pass
    Notch = 5,
};

// One biquad's normalized coefficients (a0 divided out). active=false => identity passthrough.
struct EqCoeffs {
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
    float a1 = 0.0f, a2 = 0.0f; // a0 == 1 (normalized)
    uint8_t active = 0;         // 0 => skip this biquad entirely
};
static_assert(std::is_trivially_copyable_v<EqCoeffs>);

// The whole cascade for one track (control-thread output, RT input). A count of 0 (or
// every band inactive) means the EQ is a true no-op.
struct EqBandSet {
    EqCoeffs coeffs[kMaxEqBands];
    int count = 0; // number of valid entries in `coeffs`
};
static_assert(std::is_trivially_copyable_v<EqBandSet>);

// Compute RBJ-cookbook coefficients for one band. freqHz/gainDb/q already validated to the
// contract ranges by the caller; sampleRate > 0. enabled=false (or out-of-range) yields an
// inactive (passthrough) biquad. Pure function — call from the control thread only.
inline EqCoeffs computeEqCoeffs(bool enabled, int type, double freqHz, double gainDb,
                                double q, int sampleRate) {
    EqCoeffs c;
    if (!enabled || sampleRate <= 0) {
        c.active = 0;
        return c;
    }
    const double sr = static_cast<double>(sampleRate);
    // Clamp the corner below Nyquist so coefficients stay finite/stable.
    const double f = freqHz < 1.0 ? 1.0 : (freqHz > sr * 0.49 ? sr * 0.49 : freqHz);
    const double qq = q < 0.05 ? 0.05 : q;
    constexpr double kPi = 3.14159265358979323846;
    const double w0 = 2.0 * kPi * f / sr;
    const double cw = std::cos(w0);
    const double sw = std::sin(w0);
    const double alpha = sw / (2.0 * qq);
    const double A = std::pow(10.0, gainDb / 40.0); // shelf/peak amplitude

    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a0 = 1.0, a1 = 0.0, a2 = 0.0;

    switch (static_cast<EqType>(type)) {
        case EqType::Peak: {
            b0 = 1.0 + alpha * A;
            b1 = -2.0 * cw;
            b2 = 1.0 - alpha * A;
            a0 = 1.0 + alpha / A;
            a1 = -2.0 * cw;
            a2 = 1.0 - alpha / A;
            break;
        }
        case EqType::LowShelf: {
            const double sqA = 2.0 * std::sqrt(A) * alpha;
            b0 = A * ((A + 1.0) - (A - 1.0) * cw + sqA);
            b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cw);
            b2 = A * ((A + 1.0) - (A - 1.0) * cw - sqA);
            a0 = (A + 1.0) + (A - 1.0) * cw + sqA;
            a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cw);
            a2 = (A + 1.0) + (A - 1.0) * cw - sqA;
            break;
        }
        case EqType::HighShelf: {
            const double sqA = 2.0 * std::sqrt(A) * alpha;
            b0 = A * ((A + 1.0) + (A - 1.0) * cw + sqA);
            b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cw);
            b2 = A * ((A + 1.0) + (A - 1.0) * cw - sqA);
            a0 = (A + 1.0) - (A - 1.0) * cw + sqA;
            a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cw);
            a2 = (A + 1.0) - (A - 1.0) * cw - sqA;
            break;
        }
        case EqType::HighCut: { // low-pass (gain ignored)
            b0 = (1.0 - cw) / 2.0;
            b1 = 1.0 - cw;
            b2 = (1.0 - cw) / 2.0;
            a0 = 1.0 + alpha;
            a1 = -2.0 * cw;
            a2 = 1.0 - alpha;
            break;
        }
        case EqType::LowCut: { // high-pass (gain ignored)
            b0 = (1.0 + cw) / 2.0;
            b1 = -(1.0 + cw);
            b2 = (1.0 + cw) / 2.0;
            a0 = 1.0 + alpha;
            a1 = -2.0 * cw;
            a2 = 1.0 - alpha;
            break;
        }
        case EqType::Notch: { // band-reject (gain ignored)
            b0 = 1.0;
            b1 = -2.0 * cw;
            b2 = 1.0;
            a0 = 1.0 + alpha;
            a1 = -2.0 * cw;
            a2 = 1.0 - alpha;
            break;
        }
        default: { // unknown type -> passthrough
            c.active = 0;
            return c;
        }
    }

    // Every coefficient must be finite (and a0 nonzero) or the biquad would blow up —
    // fall back to identity passthrough so a bad band is a no-op, never a divergence.
    if (a0 == 0.0 || !std::isfinite(a0) || !std::isfinite(b0) || !std::isfinite(b1) ||
        !std::isfinite(b2) || !std::isfinite(a1) || !std::isfinite(a2)) {
        c.active = 0;
        return c;
    }
    const double inv = 1.0 / a0;
    c.b0 = static_cast<float>(b0 * inv);
    c.b1 = static_cast<float>(b1 * inv);
    c.b2 = static_cast<float>(b2 * inv);
    c.a1 = static_cast<float>(a1 * inv);
    c.a2 = static_cast<float>(a2 * inv);
    c.active = 1;
    return c;
}

// ---------------------------------------------------------------------------
// EqProcessor — a stereo cascade of Direct-Form-I biquads with per-channel state.
// Coefficients are set on the control thread (snap at prepare, swap via setActiveRt at
// block start); process() is hard-RT. A count of 0 / all-inactive is a true no-op.
// ---------------------------------------------------------------------------
class EqProcessor {
public:
    // Control thread (rebuild). Snap the live coefficients and clear filter state.
    void snap(const EqBandSet& set) noexcept {
        active_ = set;
        reset();
    }

    // RT (param-ring drain at block start): swap the coefficient set. State is preserved
    // so an in-place knob tweak does not click; biquads remain stable (TDF coefficients
    // never blow up for valid params). No allocation.
    void setActiveRt(const EqBandSet& set) noexcept { active_ = set; }

    // Control thread (graph rebuild): copy the per-channel/per-band filter HISTORY
    // (x1/x2/y1/y2) from a predecessor processor WITHOUT touching coefficients — those
    // come from the new config via snap(). Carrying state forward across a rebuild keeps
    // EQ glitch-free (snap() would otherwise zero st_ and click mid-playback). Since a
    // commit changes coefficients only slightly, reusing the old recursive state is
    // benign. RT-safety: buildPlan runs on the control thread while the OLD plan is still
    // the live RT plan; the RT thread may be writing prev's st_ concurrently, so this is a
    // benign race on plain floats — at worst a 1-sample glitch, far better than a
    // guaranteed click. No allocation, no locks.
    void adoptState(const EqProcessor& prev) noexcept {
        for (int ch = 0; ch < 2; ++ch)
            for (int b = 0; b < kMaxEqBands; ++b)
                st_[ch][b] = prev.st_[ch][b];
    }

    // RT: clear all biquad state (plan reuse, panic, locate-while-stopped).
    void reset() noexcept {
        for (auto& s : st_)
            for (auto& b : s)
                b = State{};
    }

    bool isNoOp() const noexcept {
        if (active_.count <= 0)
            return true;
        for (int i = 0; i < active_.count && i < kMaxEqBands; ++i)
            if (active_.coeffs[i].active)
                return false;
        return true;
    }

    // RT: process `n` frames of L/R in place. Direct-Form-I; tiny states flushed to zero
    // (the graph also sets FTZ/DAZ). Skips inactive biquads entirely.
    void processRt(float* l, float* r, int n) noexcept {
        const int nb = active_.count < kMaxEqBands ? active_.count : kMaxEqBands;
        for (int bi = 0; bi < nb; ++bi) {
            const EqCoeffs& c = active_.coeffs[bi];
            if (!c.active)
                continue;
            processBiquad(c, st_[0][bi], l, n);
            if (r)
                processBiquad(c, st_[1][bi], r, n);
        }
    }

private:
    struct State {
        float x1 = 0.0f, x2 = 0.0f, y1 = 0.0f, y2 = 0.0f;
    };

    static inline float flush(float v) noexcept {
        // Self-heal: a non-finite (Inf/NaN) sample would lodge in the recursive y1/y2
        // state forever — zero it. Then flush sub-denormals (belt-and-braces with FTZ/DAZ).
        if (!std::isfinite(v))
            return 0.0f;
        return (v < 1.0e-20f && v > -1.0e-20f) ? 0.0f : v;
    }

    static void processBiquad(const EqCoeffs& c, State& s, float* buf, int n) noexcept {
        const float b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
        float x1 = s.x1, x2 = s.x2, y1 = s.y1, y2 = s.y2;
        for (int i = 0; i < n; ++i) {
            const float x0 = buf[i];
            float y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            y0 = flush(y0);
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
            buf[i] = y0;
        }
        s.x1 = x1;
        s.x2 = x2;
        s.y1 = y1;
        s.y2 = y2;
    }

    EqBandSet active_{};
    State st_[2][kMaxEqBands]{}; // [channel][band]
};

} // namespace mydaw
