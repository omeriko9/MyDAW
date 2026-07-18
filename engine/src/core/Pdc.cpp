// MyDAW — core/Pdc.cpp (E2)

#include "core/Pdc.h"

#include <algorithm>
#include <cstring>

namespace mydaw {

// ---------------------------------------------------------------------------
// DelayLine
// ---------------------------------------------------------------------------

void DelayLine::prepare(int maxDelaySamples, int channels) {
    capacity_ = std::max(0, maxDelaySamples);
    delay_ = 0;
    writePos_ = 0;
    buf_.clear();
    if (capacity_ > 0) {
        buf_.resize(static_cast<size_t>(std::max(1, channels)));
        for (auto& b : buf_)
            b.assign(static_cast<size_t>(capacity_), 0.0f);
    }
}

void DelayLine::setDelay(int samples) {
    delay_ = std::clamp(samples, 0, capacity_);
}

void DelayLine::processRt(float* const* ch, int numCh, int frames) noexcept {
    if (delay_ <= 0 || capacity_ <= 0 || frames <= 0)
        return;
    const int chans = std::min<int>(numCh, static_cast<int>(buf_.size()));
    // Per-channel ring: read the sample written `delay_` samples ago, then overwrite.
    for (int c = 0; c < chans; ++c) {
        float* x = ch[c];
        if (!x)
            continue;
        float* ring = buf_[static_cast<size_t>(c)].data();
        int w = writePos_;
        for (int i = 0; i < frames; ++i) {
            int r = w - delay_;
            if (r < 0)
                r += capacity_;
            const float delayed = ring[r];
            ring[w] = x[i];
            x[i] = delayed;
            if (++w >= capacity_)
                w = 0;
        }
    }
    writePos_ = (writePos_ + frames) % capacity_;
}

void DelayLine::reset() noexcept {
    for (auto& b : buf_)
        std::memset(b.data(), 0, b.size() * sizeof(float));
    writePos_ = 0;
}

// ---------------------------------------------------------------------------
// computePdc
// ---------------------------------------------------------------------------

PdcResult computePdc(const std::vector<PdcNode>& nodes, int masterIndex) {
    PdcResult res;
    const int n = static_cast<int>(nodes.size());
    res.delays.assign(static_cast<size_t>(n), 0);
    if (n == 0)
        return res;

    // Forward pass (topological order): inLat[i] = max output latency of i's feeders.
    std::vector<int> inLat(static_cast<size_t>(n), 0);
    std::vector<int> outLat(static_cast<size_t>(n), 0);
    for (int i = 0; i < n; ++i) {
        outLat[static_cast<size_t>(i)] =
            inLat[static_cast<size_t>(i)] + std::max(0, nodes[static_cast<size_t>(i)].chainLatency);
        const int o = nodes[static_cast<size_t>(i)].outputIndex;
        if (o >= 0 && o < n)
            inLat[static_cast<size_t>(o)] =
                std::max(inLat[static_cast<size_t>(o)], outLat[static_cast<size_t>(i)]);
    }
    // Second pass: delay each entry so its branch matches the slowest branch into its target.
    for (int i = 0; i < n; ++i) {
        const int o = nodes[static_cast<size_t>(i)].outputIndex;
        if (o >= 0 && o < n)
            res.delays[static_cast<size_t>(i)] =
                std::max(0, inLat[static_cast<size_t>(o)] - outLat[static_cast<size_t>(i)]);
    }
    if (masterIndex >= 0 && masterIndex < n)
        res.totalLatency = outLat[static_cast<size_t>(masterIndex)];
    return res;
}

} // namespace mydaw
