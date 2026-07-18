// MyDAW — core/IInsertNode.h
// RT insert-chain node interface. A track's insert chain (TrackNode::Config::inserts) is a
// list of these; the graph resolves each PluginInstance to either a PluginProxyNode
// (out-of-process VST, plugins/PluginProxyNode.h) or a BuiltinEffectNode (in-engine stock
// effect, core/effects/BuiltinEffectNode.h). Both honor the SAME contract: bypass = dry
// pass-through, engine-side wet/dry mix, RT-safe param delivery. The surface mirrors exactly
// the polymorphic methods the graph calls (TrackNode.cpp insert loop + AudioGraph param drain
// / offline toggle), so the RT loop needs no per-type branching.
#pragma once

#include <cstdint>

#include "core/GraphNode.h" // ProcessContext
#include "midi/MidiEvent.h" // MidiBuffer

namespace mydaw {

class IInsertNode {
public:
    virtual ~IInsertNode() = default;

    // RT. Process ctx.frames samples in place: io[c][0..frames) for c in [0,numCh). Honors
    // bypass (dry pass-through) and engine-side wet/dry mix internally. midiIn carries this
    // block's events (instruments / MIDI FX; unused by plain audio effects).
    virtual void processRt(const ProcessContext& ctx, float* const* io, int numCh,
                           const MidiBuffer& midiIn) noexcept = 0;

    // RT-queryable processing latency in samples (0 for time-based effects).
    virtual int latencySamples() const noexcept = 0;

    // Queue a normalized (0..1) parameter change for the next processRt(). Single non-RT
    // producer (command path / graph param dispatch) → RT consumer.
    virtual void setParamRt(uint32_t paramId, float value) noexcept = 0;

    // Engine-side insert controls (SPEC §5.6 cmd/plugin.set).
    virtual void setBypass(bool bypass) = 0;
    virtual void setWetDry(float wetDry) = 0;

    // Offline (export/bounce) mode toggle. No-op for in-engine effects (no IPC wait).
    virtual void setOfflineMode(bool offline) = 0;

    // RT: hand this insert its sidechain source audio for the CURRENT block (l/r valid only
    // until processRt returns; nullptr = none). Default no-op — only the built-in compressor
    // uses it. Called by TrackNode's insert loop right before processRt when wired.
    virtual void setSidechainRt(const float* l, const float* r, int frames) noexcept {
        (void)l; (void)r; (void)frames;
    }
};

} // namespace mydaw
