// MyDAW — media/Loudness.h (E4)
// ITU-R BS.1770-4 loudness meter: K-weighting (two biquads) + 400 ms blocks (100 ms hop) with
// absolute (-70 LUFS) then relative (-10 LU) gating → integrated loudness in LUFS. Also tracks
// sample peak in dBFS. Streaming: feed planar float blocks with process(); read results after.
// Non-RT (used on the export worker thread). Mono or stereo (channel weights 1.0).
#pragma once

#include <cstdint>
#include <vector>

namespace mydaw {

class LoudnessMeter {
public:
    explicit LoudnessMeter(int sampleRate);

    // Feed `frames` samples: ch[c][0..frames) for c in [0,numCh). Uses up to 2 channels.
    void process(const float* const* ch, int numCh, int frames);

    // Integrated (gated) loudness in LUFS, or -infinity (returns -70.0 sentinel) if silent.
    double integratedLufs() const;
    // Peak sample magnitude in dBFS (<= 0; -inf-ish for silence returns a large negative).
    double peakDb() const;

private:
    struct Biquad {
        double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
        double z1 = 0, z2 = 0;
        double tick(double x) {
            const double y = b0 * x + z1;
            z1 = b1 * x - a1 * y + z2;
            z2 = b2 * x - a2 * y;
            return y;
        }
    };

    int sr_;
    Biquad shelf_[2]; // pre-filter (high shelf), per channel
    Biquad hp_[2];    // RLB high-pass, per channel
    int subLen_ = 0;      // samples per 100 ms sub-block
    int subPos_ = 0;      // samples accumulated in the current sub-block
    double subSum_ = 0.0; // sum of weighted K-filtered squared samples in the current sub-block
    std::vector<double> subSums_;    // completed sub-block sums (each over subLen_*nch weighted)
    double peak_ = 0.0;
};

} // namespace mydaw
