// MyDAW — core/effects/IEffect.h
// Pure-DSP interface for a built-in ("stock") effect. An IEffect knows nothing about inserts,
// wet/dry, bypass, IPC, or the model — BuiltinEffectNode (core/effects/BuiltinEffectNode.h)
// wraps one and adds the insert contract. Params are addressed by a small integer id and are
// always NORMALIZED 0..1 on the wire (matching PluginInstance::paramValues and the generic
// editor's PluginParam.value); each effect maps norm↔real internally and formats human units.
//
// Threading: setParamNorm() and process() run on the RT audio thread (or, at create time,
// the main thread before the node is published into a render plan). Param norms are stored in
// std::atomic so getParamNorm()/valueText() can be read from the main thread (Api getParams)
// without a data race. Derived coefficients/state are touched only where the value is applied.
#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include "midi/MidiEvent.h" // MidiBuffer (instruments read it; effects ignore it)

namespace mydaw {

// Static description of one param (name/units/default/step count). The mapping from the
// normalized value to real units lives in the effect's setParamNorm/valueText.
struct BuiltinParam {
    uint32_t id = 0;
    std::string name;
    std::string unit;      // "dB", "ms", "%", "Hz", "" — display only
    float defaultNorm = 0.0f;
    int steps = 0;         // 0 = continuous; >=2 = discrete step count (e.g. 2 = on/off)
};

class IEffect {
public:
    virtual ~IEffect() = default;

    // False for audio effects; true for MIDI-driven instruments (source nodes). Governs the
    // insert node's contract: an instrument outputs silence on bypass and reads `midi`; an
    // effect passes the dry signal through on bypass and ignores `midi`.
    virtual bool isInstrument() const noexcept { return false; }

    // Non-RT: allocate delay lines / size buffers for the session format. Called once on create.
    virtual void prepare(double sampleRate, int maxBlock) = 0;

    // RT-safe: clear tails / reset internal state (delay lines, envelopes, filters, voices).
    virtual void reset() noexcept = 0;

    // RT-safe: io[c][0..nframes) for c in [0,numCh), numCh 1 or 2. Effects process io in place
    // and ignore `midi`; instruments read `midi` (note on/off, CC — honoring sampleOffset) and
    // WRITE their synth output into io (io is zeroed on entry for a track's first insert).
    virtual void process(float* const* io, int numCh, int nframes,
                         const MidiBuffer& midi) noexcept = 0;

    // The static param table (order defines display order). Same object for the effect's life.
    virtual const std::vector<BuiltinParam>& params() const noexcept = 0;

    // Set/get one param by id, normalized 0..1. setParamNorm applies derived coefficients.
    virtual void setParamNorm(uint32_t id, float norm) noexcept = 0;
    virtual float getParamNorm(uint32_t id) const noexcept = 0;

    // Human-readable current value for id (e.g. "-6.0 dB", "4.0:1", "250 ms"). Main thread.
    virtual std::string valueText(uint32_t id) const = 0;

    // RT: sidechain source audio for the current block (compressor detector). l/r valid only
    // for the following process() call; nullptr = none. No-op except the compressor.
    virtual void setSidechain(const float* l, const float* r, int frames) noexcept {
        (void)l; (void)r; (void)frames;
    }

    // Built-in sampler hook: bind PCM (planar, session sample rate, planes[c][0..frames)).
    // Called on the main thread; the effect copies what it needs (RT-safe publish). No-op for
    // everything except the sampler. planes==nullptr clears the sample.
    virtual void setSampleData(const float* const* planes, int numCh, int64_t frames) noexcept {
        (void)planes; (void)numCh; (void)frames;
    }
};

} // namespace mydaw
