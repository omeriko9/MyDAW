// MyDAW — core/effects/BuiltinEffectNode.h
// IInsertNode adapter around an in-engine IEffect: adds the insert contract (bypass = dry
// pass-through, engine-side wet/dry mix) that PluginProxyNode implements for out-of-process
// plugins. Param changes arrive on the RT param-drain thread and go straight to the effect
// (its param store is atomic). Time-based effects report 0 latency.
#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

#include "core/IInsertNode.h"
#include "core/effects/IEffect.h"

namespace mydaw {

class BuiltinEffectNode : public IInsertNode {
public:
    BuiltinEffectNode(uint64_t instanceId, std::unique_ptr<IEffect> fx)
        : instanceId_(instanceId), fx_(std::move(fx)) {}

    // Non-RT: size dry-mix scratch + prepare the effect. Main thread, before publish.
    void prepare(double sampleRate, int maxBlock) {
        maxBlock_ = maxBlock > 0 ? maxBlock : 512;
        dryL_.assign(static_cast<size_t>(maxBlock_), 0.f);
        dryR_.assign(static_cast<size_t>(maxBlock_), 0.f);
        if (fx_) fx_->prepare(sampleRate, maxBlock_);
    }

    void processRt(const ProcessContext& ctx, float* const* io, int numCh,
                   const MidiBuffer& midiIn) noexcept override {
        const int n = ctx.frames;
        if (!fx_ || n <= 0 || numCh <= 0) return;
        const bool bypass = bypass_.load(std::memory_order_relaxed);
        if (fx_->isInstrument()) {
            // Source node: bypass = silence (no meaningful dry); no wet/dry blend. Writes io.
            if (bypass) {
                for (int c = 0; c < numCh; ++c)
                    if (io[c]) std::fill(io[c], io[c] + n, 0.f);
                return;
            }
            fx_->process(io, numCh, n, midiIn);
            return;
        }
        if (bypass) return; // effect: dry pass-through
        const float wet = wetDry_.load(std::memory_order_relaxed);
        const bool needDry = wet < 0.999f && n <= maxBlock_;
        if (needDry) {
            std::copy(io[0], io[0] + n, dryL_.begin());
            if (numCh >= 2) std::copy(io[1], io[1] + n, dryR_.begin());
        }
        fx_->process(io, numCh, n, midiIn);
        if (needDry) {
            const float dry = 1.f - wet;
            for (int i = 0; i < n; ++i) io[0][i] = dryL_[static_cast<size_t>(i)] * dry + io[0][i] * wet;
            if (numCh >= 2)
                for (int i = 0; i < n; ++i)
                    io[1][i] = dryR_[static_cast<size_t>(i)] * dry + io[1][i] * wet;
        }
    }

    int latencySamples() const noexcept override { return 0; }
    void setParamRt(uint32_t paramId, float value) noexcept override {
        if (fx_) fx_->setParamNorm(paramId, value);
    }
    void setBypass(bool bypass) override { bypass_.store(bypass, std::memory_order_relaxed); }
    void setWetDry(float wetDry) override {
        wetDry_.store(wetDry < 0.f ? 0.f : (wetDry > 1.f ? 1.f : wetDry), std::memory_order_relaxed);
    }
    void setOfflineMode(bool /*offline*/) override {} // no IPC wait to stretch
    void setSidechainRt(const float* l, const float* r, int frames) noexcept override {
        if (fx_) fx_->setSidechain(l, r, frames);
    }

    uint64_t instanceId() const noexcept { return instanceId_; }
    IEffect* effect() noexcept { return fx_.get(); }
    // Sampler bookkeeping (main thread): the asset currently bound, so rebuilds don't re-copy.
    uint64_t boundSampleAsset() const noexcept { return boundSampleAsset_; }
    void setBoundSampleAsset(uint64_t id) noexcept { boundSampleAsset_ = id; }

private:
    uint64_t instanceId_;
    std::unique_ptr<IEffect> fx_;
    uint64_t boundSampleAsset_ = 0;
    std::atomic<bool> bypass_{false};
    std::atomic<float> wetDry_{1.0f};
    int maxBlock_ = 512;
    std::vector<float> dryL_, dryR_;
};

} // namespace mydaw
