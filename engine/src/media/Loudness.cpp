// MyDAW — media/Loudness.cpp — see Loudness.h. BS.1770-4 K-weighting via RBJ biquads computed
// at the session sample rate (so it is correct at any rate), 400 ms / 100 ms gated integration.

#include "media/Loudness.h"

#include <algorithm>
#include <cmath>

namespace mydaw {
namespace {

constexpr double kPi = 3.14159265358979323846;

// RBJ high-shelf biquad (gain in dB), normalized (a0 = 1).
void highShelf(double sr, double f0, double gainDb, double q, double& b0, double& b1, double& b2,
               double& a1, double& a2) {
    const double A = std::pow(10.0, gainDb / 40.0);
    const double w0 = 2.0 * kPi * f0 / sr;
    const double cw = std::cos(w0);
    const double alpha = std::sin(w0) / (2.0 * q);
    const double tsA = 2.0 * std::sqrt(A) * alpha;
    const double a0 = (A + 1) - (A - 1) * cw + tsA;
    b0 = (A * ((A + 1) + (A - 1) * cw + tsA)) / a0;
    b1 = (-2 * A * ((A - 1) + (A + 1) * cw)) / a0;
    b2 = (A * ((A + 1) + (A - 1) * cw - tsA)) / a0;
    a1 = (2 * ((A - 1) - (A + 1) * cw)) / a0;
    a2 = ((A + 1) - (A - 1) * cw - tsA) / a0;
}

// RBJ high-pass biquad (Q), normalized (a0 = 1).
void highPass(double sr, double f0, double q, double& b0, double& b1, double& b2, double& a1,
              double& a2) {
    const double w0 = 2.0 * kPi * f0 / sr;
    const double cw = std::cos(w0);
    const double alpha = std::sin(w0) / (2.0 * q);
    const double a0 = 1 + alpha;
    b0 = ((1 + cw) / 2.0) / a0;
    b1 = (-(1 + cw)) / a0;
    b2 = ((1 + cw) / 2.0) / a0;
    a1 = (-2 * cw) / a0;
    a2 = (1 - alpha) / a0;
}

} // namespace

LoudnessMeter::LoudnessMeter(int sampleRate)
    : sr_(sampleRate > 0 ? sampleRate : 48000) {
    // BS.1770 pre-filter (high shelf) + RLB high-pass, ITU reference design frequencies.
    double b0, b1, b2, a1, a2;
    highShelf(sr_, 1681.9744509555319, 3.99984385397, 0.7071752369554196, b0, b1, b2, a1, a2);
    for (int c = 0; c < 2; ++c) { shelf_[c].b0 = b0; shelf_[c].b1 = b1; shelf_[c].b2 = b2; shelf_[c].a1 = a1; shelf_[c].a2 = a2; }
    highPass(sr_, 38.135470876, 0.5003270373238773, b0, b1, b2, a1, a2);
    for (int c = 0; c < 2; ++c) { hp_[c].b0 = b0; hp_[c].b1 = b1; hp_[c].b2 = b2; hp_[c].a1 = a1; hp_[c].a2 = a2; }
    subLen_ = std::max(1, sr_ / 10); // 100 ms
}

void LoudnessMeter::process(const float* const* ch, int numCh, int frames) {
    const int nc = std::min(numCh, 2);
    for (int i = 0; i < frames; ++i) {
        double weighted = 0.0;
        for (int c = 0; c < nc; ++c) {
            const double x = static_cast<double>(ch[c][i]);
            peak_ = std::max(peak_, std::fabs(x));
            const double y = hp_[c].tick(shelf_[c].tick(x)); // K-weighting
            weighted += y * y; // channel weight 1.0 for L/R
        }
        subSum_ += weighted;
        if (++subPos_ >= subLen_) {
            subSums_.push_back(subSum_);
            subSum_ = 0.0;
            subPos_ = 0;
        }
    }
}

double LoudnessMeter::integratedLufs() const {
    // 400 ms blocks = 4 consecutive 100 ms sub-blocks (75% overlap → hop = 1 sub-block).
    const size_t n = subSums_.size();
    if (n < 4) return -70.0;
    std::vector<double> blockPow; // mean square per 400 ms block
    blockPow.reserve(n - 3);
    const double denom = static_cast<double>(4 * subLen_); // per-channel-sum already summed
    for (size_t i = 3; i < n; ++i) {
        const double s = subSums_[i - 3] + subSums_[i - 2] + subSums_[i - 1] + subSums_[i];
        blockPow.push_back(s / denom);
    }
    // Absolute gate at -70 LUFS: L = -0.691 + 10 log10(power) >= -70.
    auto lufsOf = [](double p) { return p > 0 ? -0.691 + 10.0 * std::log10(p) : -1000.0; };
    double sumAbs = 0.0;
    int cntAbs = 0;
    for (double p : blockPow)
        if (lufsOf(p) >= -70.0) { sumAbs += p; ++cntAbs; }
    if (cntAbs == 0) return -70.0;
    const double meanAbs = sumAbs / cntAbs;
    // Relative gate = integrated(over abs-gated) - 10 LU.
    const double relThresh = lufsOf(meanAbs) - 10.0;
    double sumRel = 0.0;
    int cntRel = 0;
    for (double p : blockPow)
        if (lufsOf(p) >= -70.0 && lufsOf(p) >= relThresh) { sumRel += p; ++cntRel; }
    if (cntRel == 0) return -70.0;
    return lufsOf(sumRel / cntRel);
}

double LoudnessMeter::peakDb() const {
    return peak_ > 1e-9 ? 20.0 * std::log10(peak_) : -120.0;
}

} // namespace mydaw
