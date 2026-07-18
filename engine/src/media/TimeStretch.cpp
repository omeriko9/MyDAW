// MyDAW — media/TimeStretch.cpp — see TimeStretch.h. Classic WSOLA (windowed overlap-add with
// waveform-similarity alignment) + linear resample. Textbook, non-RT.

#include "media/TimeStretch.h"

#include <algorithm>
#include <cmath>

namespace mydaw {
namespace {
constexpr double kPi = 3.14159265358979323846;
}

std::vector<std::vector<float>> wsolaStretch(const std::vector<std::vector<float>>& in,
                                             int64_t frames, double ratio, int /*sampleRate*/) {
    const int nch = static_cast<int>(in.size());
    ratio = std::clamp(ratio, 0.25, 4.0);
    const int64_t outLen = std::max<int64_t>(1, static_cast<int64_t>(std::llround(frames * ratio)));
    std::vector<std::vector<float>> out(std::max(1, nch), std::vector<float>(static_cast<size_t>(outLen), 0.f));
    if (nch <= 0 || frames < 8)
        return out;

    const int W = static_cast<int>(std::min<int64_t>(2048, frames));       // analysis/synthesis window
    const int Hs = std::max(1, W / 2);                                     // synthesis hop (50% overlap)
    const int Ha = std::max(1, static_cast<int>(std::llround(Hs / ratio))); // analysis hop
    const int search = std::min(Hs, W / 2);                                 // ± similarity search

    std::vector<float> win(static_cast<size_t>(W));
    for (int i = 0; i < W; ++i)
        win[static_cast<size_t>(i)] = 0.5f - 0.5f * std::cos(2.0 * kPi * i / (W - 1));

    std::vector<float> norm(static_cast<size_t>(outLen), 0.f);
    auto s = [&](int ch, int64_t idx) -> float {
        return (idx >= 0 && idx < frames) ? in[static_cast<size_t>(ch)][static_cast<size_t>(idx)] : 0.f;
    };

    std::vector<float> naturalNext(static_cast<size_t>(W), 0.f); // expected continuation (ch 0)
    int64_t ana = 0; // analysis read position in the input
    int64_t syn = 0; // synthesis write position in the output
    bool first = true;

    while (syn < outLen) {
        int delta = 0;
        if (!first) { // align the next analysis frame to the previous frame's natural continuation
            float best = -1e30f;
            for (int k = -search; k <= search; ++k) {
                float corr = 0.f, e = 1e-9f;
                for (int i = 0; i < W; i += 4) { // strided cross-correlation (speed)
                    const float a = s(0, ana + k + i);
                    corr += a * naturalNext[static_cast<size_t>(i)];
                    e += a * a;
                }
                const float score = corr / std::sqrt(e);
                if (score > best) { best = score; delta = k; }
            }
        }
        first = false;
        const int64_t rd = ana + delta;

        for (int i = 0; i < W; ++i) {
            const int64_t o = syn + i;
            if (o >= outLen)
                break;
            const float wv = win[static_cast<size_t>(i)];
            for (int ch = 0; ch < nch; ++ch)
                out[static_cast<size_t>(ch)][static_cast<size_t>(o)] += s(ch, rd + i) * wv;
            norm[static_cast<size_t>(o)] += wv;
        }
        for (int i = 0; i < W; ++i) // what naturally follows this frame in the input
            naturalNext[static_cast<size_t>(i)] = s(0, rd + Hs + i);

        ana += Ha;
        syn += Hs;
    }

    for (int ch = 0; ch < nch; ++ch)
        for (int64_t o = 0; o < outLen; ++o)
            if (norm[static_cast<size_t>(o)] > 1e-6f)
                out[static_cast<size_t>(ch)][static_cast<size_t>(o)] /= norm[static_cast<size_t>(o)];
    return out;
}

std::vector<std::vector<float>> resampleLinear(const std::vector<std::vector<float>>& in,
                                               int64_t frames, double ratio) {
    const int nch = static_cast<int>(in.size());
    ratio = std::clamp(ratio, 0.25, 4.0);
    const int64_t outLen = std::max<int64_t>(1, static_cast<int64_t>(std::llround(frames / ratio)));
    std::vector<std::vector<float>> out(std::max(1, nch), std::vector<float>(static_cast<size_t>(outLen), 0.f));
    if (nch <= 0 || frames < 2)
        return out;
    for (int ch = 0; ch < nch; ++ch) {
        const std::vector<float>& src = in[static_cast<size_t>(ch)];
        for (int64_t o = 0; o < outLen; ++o) {
            const double sp = static_cast<double>(o) * ratio;
            const int64_t i0 = static_cast<int64_t>(sp);
            const double f = sp - static_cast<double>(i0);
            const float a = i0 < frames ? src[static_cast<size_t>(i0)] : 0.f;
            const float b = (i0 + 1) < frames ? src[static_cast<size_t>(i0 + 1)] : a;
            out[static_cast<size_t>(ch)][static_cast<size_t>(o)] = a * (1.f - static_cast<float>(f)) + b * static_cast<float>(f);
        }
    }
    return out;
}

} // namespace mydaw
