// MyDAW — core/AudioGraph.h (E2)
// The audio engine core (SPEC §7): builds an immutable RenderPlan snapshot from the Model
// on the main thread, publishes it atomically (std::atomic<std::shared_ptr> — the RT
// thread copies the shared_ptr at block start, documented v1 tradeoff), and renders it in
// the driver callback. Retired plans are kept on a main-thread grace list and freed only
// after the RT thread has observed a newer plan (or after a 2 s wall-clock grace), so no
// deallocation ever happens on the RT thread.
//
// processBlock() is hard-RT: no allocation, no locks, no logging; FTZ/DAZ enabled; the
// final device output is hard-clipped to ±4. Loop wraps render as multiple passes via
// Transport::nextSpans(); count-in holds the playhead while the metronome clicks.
//
// Param-only changes flow through the internal SPSC ParamRing: applyParam() is the
// producer side (call it from ONE thread — E9 drains its MPSC command ring into
// applyParam on the main loop); the RT thread drains at block start.
//
// renderOffline() builds a separate plan (fresh TrackNodes; PluginProxyNodes are shared
// with the realtime plan) and pulls blocks on the CALLER's thread. The caller must
// suppress the driver for the duration (SPEC §7) and should set plugin offline mode
// expectations accordingly — the graph toggles PluginProxyNode::setOfflineMode around
// the render.

#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "core/Eq.h"        // EqBandSet (transient EQ coefficient fast path)
#include "core/GraphNode.h" // ParamMsg, ParamRing, RenderPlan

namespace mydaw {

class Model;
class Meters;
class AssetStore;
class HostProcessManager;
class BuiltinEffectManager;
class MidiInput;
class Metronome;
class Transport;
class AudioRecorder;
struct MidiEvent;

class AudioGraph {
public:
    AudioGraph();
    ~AudioGraph();
    AudioGraph(const AudioGraph&) = delete;
    AudioGraph& operator=(const AudioGraph&) = delete;

    // Main thread, before the stream starts (and again on sample-rate/block changes —
    // invalidates the current plan; call rebuild() afterwards). Any pointer may be null
    // (the corresponding feature is simply disabled — headless/test use).
    void configure(int sampleRate, int maxBlock, Meters* meters, AssetStore* assets,
                   HostProcessManager* host, BuiltinEffectManager* builtin,
                   MidiInput* midiInput, Metronome* metronome);

    // Main thread: rebuild the RenderPlan from the model and atomically swap it in
    // (SPEC §7: structural changes rebuild; cycles route to master + log).
    void rebuild(const Model& model);

    // RT driver callback. `in` = capture channels (may be null/0), `out` = device output.
    void processBlock(const float* const* in, int numIn, float* const* out, int numOut,
                      int frames, Transport& transport);

    // Param fast path (volume/pan/send/mute/plugin params) — pushed into the internal
    // SPSC ring, drained by the RT thread at block start. Single producer thread (E9
    // main loop). Silently drops when the ring is full (value also lives in the Model).
    void applyParam(const ParamMsg& msg);

    // EQ coefficient fast path (transient knob/slider drags): publish a freshly computed
    // coefficient cascade to `trackId`'s live node without a graph rebuild. Pushed into an
    // internal SPSC ring, drained by the RT thread at block start (same single producer as
    // applyParam — the E9 main loop). Silently drops when the ring is full (the band list
    // also lives in the Model, so the next rebuild restores the exact state).
    void applyEqCoeffs(uint64_t trackId, const EqBandSet& set);

    // Offline render of [startSample, endSample) through the full graph (export). Runs
    // on the caller's thread; `sink` receives stereo master blocks; `progress` (optional)
    // is updated 0..1. Returns false + err on failure.
    bool renderOffline(const Model& model, int64_t startSample, int64_t endSample,
                       int blockSize,
                       const std::function<void(const float* const* ch, int numCh,
                                                int frames)>& sink,
                       std::atomic<float>* progress, std::string& err);

    // Bounce/freeze variant: solo `soloTrackId` in place (its routing/sends stay live,
    // everything else is implicit-muted). soloTrackId == 0 behaves like the base overload.
    bool renderOffline(const Model& model, int64_t startSample, int64_t endSample,
                       int blockSize,
                       const std::function<void(const float* const* ch, int numCh,
                                                int frames)>& sink,
                       std::atomic<float>* progress, std::string& err,
                       uint64_t soloTrackId);

    // PDC samples at master for the current plan (engine/getStatus pdcSamples).
    int latencyTotal() const;

    // Recording tap: while the transport is recording, processBlock pushes the capture
    // input via AudioRecorder::pushFromRt. nullptr clears. Any thread (atomic).
    void setRecordTap(AudioRecorder* recorder);

    // engine/panic: all-notes-off + chain silence on the next RT block. Any thread.
    void allNotesOff();

    // midi/preview: inject one live MIDI event into `trackId`'s node — audible
    // regardless of arm/monitor and while stopped. Internal SPSC ring (cap 256), single
    // producer (E9 main loop, App::previewNote), drained by the RT thread at block
    // start. Silently drops when the ring is full or the track has no node.
    void injectLiveMidi(uint64_t trackId, const MidiEvent& e);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace mydaw
