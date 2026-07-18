// MyDAW — core/GraphNode.h
// Render contract between the audio graph (E2) and node implementations (E2 TrackNode,
// E7 PluginProxyNode), plus the RenderPlan snapshot (SPEC §7) and the lock-free ParamMsg
// path shared engine-wide.
//
// Buffer model: the graph owns `RenderPlan::numBuffers` stereo accumulation buffers
// (2 channel pointers each, maxBlock frames). process() receives raw channel-pointer
// arrays — non-interleaved float32 — and ACCUMULATES into outputs (the graph zeroes
// buffers at block start). All process() work is RT: no locks, no allocation (the
// documented plugin-IPC wait of SPEC §8 is the single exception, inside PluginProxyNode).

#pragma once

#include <cstdint>
#include <memory>
#include <vector>

#include "core/RtRing.h"
#include "midi/MidiEvent.h"

namespace mydaw {

// Per-block, per-span render context. Built by the graph from Transport::nextSpans() +
// TempoMap; one process pass per BlockSpan (so loop wraps render as two passes).
struct ProcessContext {
    int frames = 0;               // frames in this span (<= maxBlock)
    int64_t playheadSamples = 0;  // timeline position of the first frame of the span
    double ppqPos = 0.0;          // playheadSamples in beats (quarter notes)
    double tempo = 120.0;         // bpm at ppqPos
    bool playing = false;
    bool recording = false;
    bool looping = false;
    int sampleRate = 48000;
};

class GraphNode {
public:
    virtual ~GraphNode() = default;

    // Non-RT: allocate internal buffers/delay lines for the session format.
    virtual void prepare(int sampleRate, int maxBlock) { (void)sampleRate; (void)maxBlock; }

    // RT. inputs:  numInputs channel pointers the node reads (may be nullptr/0 for
    //              source nodes — e.g. a TrackNode pulling clip audio).
    //     outputs: numOutputs channel pointers the node ACCUMULATES its result into.
    // Channel pointers come from the graph's buffer pool per the RenderPlan indices.
    virtual void process(ProcessContext& ctx,
                         const float* const* inputs, int numInputs,
                         float* const* outputs, int numOutputs) = 0;

    // RT-queryable. Current processing latency in samples (plugins report via host
    // process, SPEC §8.1); the graph builds PDC delay lines from these (SPEC §7).
    virtual int latencySamples() const { return 0; }

    // Nodes that consume MIDI (instrument/effect proxies, TrackNode of midi tracks)
    // expose their per-block input event list; the graph/TrackNode fills it before
    // process() and the node consumes it during process(). nullptr = node takes no MIDI.
    virtual MidiBuffer* midiInput() { return nullptr; }

    // RT-safe state clear: silence tails, all-notes-off, reset delay lines
    // (engine/panic, locate while stopped, plan swap reuse).
    virtual void reset() {}
};

// ---------------------------------------------------------------------------
// RenderPlan — immutable flattened render order, built from the Model on every
// structural change (main thread) and atomically swapped as
// std::shared_ptr<const RenderPlan>; the RT thread copies the shared_ptr at block start
// (SPEC §7, acceptable v1). Param-only changes do NOT rebuild — they flow through
// RtRing<ParamMsg> below.
// ---------------------------------------------------------------------------

struct SendTap {
    int sendIndex = -1;        // index into Track::sends
    int destBufferIndex = -1;  // accumulation buffer of the destination bus
};

struct RenderEntry {
    uint64_t trackId = 0;
    std::shared_ptr<GraphNode> node;  // typically TrackNode (E2); kept alive across swaps
    int inputBufferIndex = -1;   // bus/master: accumulation buffer consumed; -1 for
                                 // clip-source tracks (audio/midi/instrument)
    int outputBufferIndex = -1;  // buffer of this track's outputTarget; -1 = "none"
    std::vector<SendTap> sends;  // enabled sends, tap pre/post per Track::sends[i].pre
};

struct RenderPlan {
    // Topological order: plain tracks first (MIDI feeders ahead of their midiTarget
    // instrument track), then buses (buses may feed buses), master last (SPEC §7).
    // Frozen tracks appear with their frozen-audio node; folders absent.
    std::vector<RenderEntry> entries;
    int numBuffers = 0;          // stereo accumulation buffers, indices 0..numBuffers-1
    int masterBufferIndex = -1;  // buffer the master node consumes / device output source
    int maxBlock = 0;
    int sampleRate = 0;
    int totalLatencySamples = 0; // pdcSamples reported by engine/getStatus
};

using RenderPlanPtr = std::shared_ptr<const RenderPlan>;

// ---------------------------------------------------------------------------
// ParamMsg — lock-free parameter delivery, main thread -> RT (SPEC §7). One SPSC ring
// owned by the engine; TrackNodes drain it (or the graph dispatches) at block start.
// ---------------------------------------------------------------------------

struct ParamMsg {
    enum class Target : uint8_t {
        Volume,       // value = linear gain;             trackId
        Pan,          // value = -1..1;                   trackId
        SendLevel,    // value = linear; index = sendIdx; trackId
        Mute,         // value = 0|1 (incl. solo-in-place implicit mutes); trackId
        PluginParam,  // value = normalized 0..1; index = paramId; instanceId
        PluginBypass, // value = 0|1;                     instanceId
        WetDry,       // value = 0..1;                    instanceId
        VcaGain       // value = linear VCA-group gain;   trackId (pushed per member track)
    };

    Target target = Target::Volume;
    uint64_t trackId = 0;
    uint64_t instanceId = 0; // plugin targets; 0 otherwise
    int index = 0;           // send index or plugin paramId; 0 otherwise
    float value = 0.0f;
};

static_assert(std::is_trivially_copyable_v<ParamMsg>);

// Engine-wide alias: single producer (main thread command processing) -> single RT consumer.
using ParamRing = RtRing<ParamMsg>;

} // namespace mydaw
