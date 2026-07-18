// MyDAW — plugins/PluginProxyNode.h (E7)
// Engine-side real-time proxy for ONE out-of-process plugin instance (SPEC §8.1).
//
// The proxy owns no IPC resources — HostProcessManager (HostProcess.h) creates the
// shared-memory block, the req/done named events and the host process, and wires raw
// pointers into this node. The node's processRt() is called from the audio thread by
// E2's TrackNode insert chain (and from the offline-render thread during export/bounce).
//
// ---------------------------------------------------------------------------
// RT-WAIT TRADEOFF (SPEC §8.1, documented per SPEC/ARCHITECTURE):
// processRt() performs a BLOCKING WaitForSingleObject on the host's "done" event with a
// timeout of max(2, 2 × block duration) ms (2000 ms in offline mode). This is the single
// sanctioned exception to the "RT thread never blocks" rule — the standard bridge
// tradeoff every out-of-process plugin host makes. A well-behaved host signals within a
// fraction of the block duration; a hung/crashed host costs at most ~2 block durations
// per block, after which we output the dry signal (effects) or silence (instruments).
// Three consecutive misses disable the node and request an async restart (picked up by
// HostProcessManager::pump()).
//
// A late "done" from a timed-out block can desynchronize one exchange: the host may
// still be reading/writing shm regions while we fill the next block. The protocol
// self-recovers (events are auto-reset; we drain a stale done signal before the next
// exchange and all counts are re-read per block) at the cost of one block of possibly
// inconsistent audio — accepted v1 behavior.
// ---------------------------------------------------------------------------
//
// Threading:
//   * processRt()                — RT audio thread (or the offline-render thread; never
//                                  both concurrently for the same instance — the engine
//                                  suppresses the driver during offline render, SPEC §7).
//   * setParamRt()               — single non-RT producer (main-thread command path /
//                                  graph param dispatch); SPSC ring into processRt().
//   * setBypass/setWetDry/setOfflineMode/latencySamples — any thread (atomics).
//   * private setIpcRt/enableRt/disableRt — HostProcessManager only, under its
//     per-instance lifecycle lock; IPC pointers are only mutated while rtEnabled_ is
//     false AND after a drain delay that outlasts any in-flight processRt() call.

#pragma once

#include <atomic>
#include <cstdint>

#include "core/GraphNode.h"   // ProcessContext, RtRing
#include "core/IInsertNode.h" // IInsertNode
#include "midi/MidiEvent.h"   // MidiBuffer

namespace mydaw {

class HostProcessManager;
class NamedEvent; // shared/ipc/SharedMem.h

class PluginProxyNode final : public IInsertNode {
public:
    PluginProxyNode(HostProcessManager& manager, uint64_t instanceId);
    ~PluginProxyNode();
    PluginProxyNode(const PluginProxyNode&) = delete;
    PluginProxyNode& operator=(const PluginProxyNode&) = delete;

    // RT. Processes `frames = ctx.frames` samples in place: io[c][0..frames) for
    // c in [0, numCh). Handles bypass (dry pass-through, no shm round-trip),
    // engine-side wet/dry mix (dry is read back from io while mixing the wet shm
    // output in), and the crash/timeout fallback (effect: dry; instrument: silence).
    // midiIn carries this block's events for the plugin (instruments/MIDI FX).
    void processRt(const ProcessContext& ctx, float* const* io, int numCh,
                   const MidiBuffer& midiIn) noexcept override;

    // Current plugin latency in samples (host-reported via shm header / pipe push).
    int latencySamples() const noexcept override;

    // Queue a normalized (0..1) parameter change for delivery inside the next
    // processRt() exchange (shm paramIn region). Single producer; drops when the
    // 4096-slot ring is full.
    void setParamRt(uint32_t paramId, float value) noexcept override;

    // Engine-side insert controls (SPEC §5.6 cmd/plugin.set). Bypass skips the shm
    // round-trip entirely and passes dry through (NOTE(spec): no crossfade ramp on
    // toggle in v1 — the wet tail is simply cut). wetDry: 0 = dry .. 1 = wet.
    void setBypass(bool bypass) override;
    void setWetDry(float wetDry) override;

    // Offline (export/bounce) mode: the done-event wait stretches to 2000 ms so slow
    // plugins are never misdiagnosed as hung while rendering faster than realtime.
    void setOfflineMode(bool offline) override;

    uint64_t instanceId() const noexcept { return instanceId_; }
    bool offlineMode() const noexcept { return offline_.load(std::memory_order_relaxed); }
    bool isInstrument() const noexcept { return isInstrument_.load(std::memory_order_relaxed); }

private:
    friend class HostProcessManager;

    struct RtParam {
        uint32_t id = 0;
        float value = 0.0f;
    };

    // --- manager-side lifecycle hooks (called under the instance lifecycle lock,
    // --- only while the node is disabled; see threading notes above) -------------
    void setIpcRt(void* shmBase, uint32_t numIn, uint32_t numOut,
                  NamedEvent* reqEvent, NamedEvent* doneEvent, int sampleRate);
    void clearIpcRt();
    void enableRt();
    bool disableRt(); // returns the previous enabled state (false = already disabled)
    void setLatencyFromHost(int samples);
    void setIsInstrument(bool isInstrument);

    // Crash/timeout output policy: effects keep the dry signal already in io;
    // instruments are silenced.
    void fallbackRt(float* const* io, int numCh, int frames) noexcept;

    HostProcessManager& mgr_;
    const uint64_t instanceId_;

    // IPC plumbing. Plain members: written by the manager ONLY while rtEnabled_ is
    // false (publication via the release-store of rtEnabled_ / acquire-load in
    // processRt). Raw pointers into manager-owned objects that outlive the node.
    void* shmBase_ = nullptr;
    uint32_t numIn_ = 0;
    uint32_t numOut_ = 0;
    NamedEvent* reqEvent_ = nullptr;
    NamedEvent* doneEvent_ = nullptr;
    int sampleRate_ = 48000;

    std::atomic<bool> rtEnabled_{false};
    std::atomic<uint32_t> ipcGen_{0}; // bumped per (re)spawn; resets the RT miss counter
    std::atomic<bool> bypass_{false};
    std::atomic<float> wetDry_{1.0f};
    std::atomic<bool> offline_{false};
    std::atomic<bool> isInstrument_{false};
    std::atomic<int> latencySamples_{0};
    // Set by the RT thread after 3 consecutive deadline misses (or a host-reported
    // fault); consumed by HostProcessManager::pump() which schedules the restart.
    std::atomic<bool> restartRequested_{false};

    // RT-thread-local state (touched only inside processRt()).
    uint32_t rtSeenGen_ = 0;
    int rtMisses_ = 0;

    // setParamRt() producer -> processRt() consumer. Capacity matches the shm
    // paramIn region (kMaxParamChanges).
    RtRing<RtParam> paramQueue_{4096};
};

} // namespace mydaw
