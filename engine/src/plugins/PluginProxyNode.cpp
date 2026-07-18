// MyDAW — plugins/PluginProxyNode.cpp (E7)
// RT half of the out-of-process plugin bridge (SPEC §8.1). See PluginProxyNode.h for
// the documented RT-wait tradeoff and threading rules.

#include "plugins/PluginProxyNode.h"

#include <cstring>

#include "plugins/HostProcess.h"
#include "shared/ipc/PluginIpc.h"
#include "shared/ipc/SharedMem.h"

namespace mydaw {

namespace {
// Done-event wait while rendering offline (SPEC §8 brief): plugins may legitimately be
// slow when the engine pulls faster than realtime, so allow up to 2 s per block.
constexpr uint32_t kOfflineWaitMs = 2000;
constexpr int kMaxConsecutiveMisses = 3;
} // namespace

PluginProxyNode::PluginProxyNode(HostProcessManager& manager, uint64_t instanceId)
    : mgr_(manager), instanceId_(instanceId) {}

PluginProxyNode::~PluginProxyNode() = default;

int PluginProxyNode::latencySamples() const noexcept {
    return latencySamples_.load(std::memory_order_relaxed);
}

void PluginProxyNode::setParamRt(uint32_t paramId, float value) noexcept {
    // Drops when full (4096 in flight) — same policy as the shm region itself.
    (void)paramQueue_.push(RtParam{paramId, value});
}

void PluginProxyNode::setBypass(bool bypass) {
    bypass_.store(bypass, std::memory_order_relaxed);
}

void PluginProxyNode::setWetDry(float wetDry) {
    if (wetDry < 0.0f) wetDry = 0.0f;
    if (wetDry > 1.0f) wetDry = 1.0f;
    wetDry_.store(wetDry, std::memory_order_relaxed);
}

void PluginProxyNode::setOfflineMode(bool offline) {
    offline_.store(offline, std::memory_order_relaxed);
}

// --- manager-side hooks (instance lifecycle lock held, node disabled) ---------------

void PluginProxyNode::setIpcRt(void* shmBase, uint32_t numIn, uint32_t numOut,
                               NamedEvent* reqEvent, NamedEvent* doneEvent,
                               int sampleRate) {
    shmBase_ = shmBase;
    numIn_ = numIn <= kMaxChannels ? numIn : kMaxChannels;
    numOut_ = numOut <= kMaxChannels ? numOut : kMaxChannels;
    reqEvent_ = reqEvent;
    doneEvent_ = doneEvent;
    sampleRate_ = sampleRate > 0 ? sampleRate : 48000;
    // New spawn generation: the RT thread resets its miss counter when it sees it.
    ipcGen_.fetch_add(1, std::memory_order_release);
}

void PluginProxyNode::clearIpcRt() {
    shmBase_ = nullptr;
    reqEvent_ = nullptr;
    doneEvent_ = nullptr;
}

void PluginProxyNode::enableRt() {
    restartRequested_.store(false, std::memory_order_relaxed);
    rtEnabled_.store(true, std::memory_order_release); // publishes the IPC pointers
}

bool PluginProxyNode::disableRt() {
    return rtEnabled_.exchange(false, std::memory_order_acq_rel);
}

void PluginProxyNode::setLatencyFromHost(int samples) {
    latencySamples_.store(samples >= 0 ? samples : 0, std::memory_order_relaxed);
}

void PluginProxyNode::setIsInstrument(bool isInstrument) {
    isInstrument_.store(isInstrument, std::memory_order_relaxed);
}

// --- RT path -------------------------------------------------------------------------

void PluginProxyNode::fallbackRt(float* const* io, int numCh, int frames) noexcept {
    // Effect: the dry signal is still untouched in io — keep it. Instrument: silence.
    if (!isInstrument_.load(std::memory_order_relaxed))
        return;
    for (int c = 0; c < numCh; ++c)
        if (io[c])
            std::memset(io[c], 0, static_cast<size_t>(frames) * sizeof(float));
}

void PluginProxyNode::processRt(const ProcessContext& ctx, float* const* io, int numCh,
                                const MidiBuffer& midiIn) noexcept {
    if (!io || numCh <= 0)
        return;
    int frames = ctx.frames;
    if (frames <= 0)
        return;
    if (frames > static_cast<int>(kMaxBlock))
        frames = static_cast<int>(kMaxBlock); // shm regions are sized for kMaxBlock

    // Bypass: pass the dry signal through untouched; no shm round-trip at all
    // (SPEC §8 brief). NOTE(spec): no wet/dry crossfade ramp on toggle in v1.
    if (bypass_.load(std::memory_order_relaxed))
        return;

    if (!rtEnabled_.load(std::memory_order_acquire)) {
        fallbackRt(io, numCh, frames);
        return;
    }

    // Reset the miss counter on a fresh spawn generation (manager re-enabled us after
    // a restart — the old consecutive-miss streak is meaningless now).
    const uint32_t gen = ipcGen_.load(std::memory_order_acquire);
    if (gen != rtSeenGen_) {
        rtSeenGen_ = gen;
        rtMisses_ = 0;
    }

    void* base = shmBase_;
    NamedEvent* req = reqEvent_;
    NamedEvent* done = doneEvent_;
    if (!base || !req || !done) { // defensive: enabled implies wired
        fallbackRt(io, numCh, frames);
        return;
    }
    ShmHeader* h = shmHeader(base);

    // Host-detected unrecoverable plugin fault (SPEC §8.1 HostState::Crashed).
    if (shmLoadState(h) == HostState::Crashed) {
        rtEnabled_.store(false, std::memory_order_relaxed);
        restartRequested_.store(true, std::memory_order_release);
        fallbackRt(io, numCh, frames);
        return;
    }

    // After a missed deadline the host may have signaled "done" late; the auto-reset
    // event would stay set and we would mistake it for THIS block's completion. Drain it.
    if (rtMisses_ > 0)
        (void)done->wait(0);

    // ---- engine -> host: audio inputs ------------------------------------------------
    const size_t copyBytes = static_cast<size_t>(frames) * sizeof(float);
    for (uint32_t c = 0; c < numIn_; ++c) {
        const int srcCh = static_cast<int>(c) < numCh ? static_cast<int>(c) : numCh - 1;
        const float* src = io[srcCh];
        float* dst = shmInChannel(base, c);
        if (src)
            std::memcpy(dst, src, copyBytes);
        else
            std::memset(dst, 0, copyBytes);
    }

    // ---- engine -> host: MIDI ---------------------------------------------------------
    MidiMsg* shmMidi = shmMidiIn(base, numIn_, numOut_);
    uint32_t numMidi = 0;
    const int midiCount = midiIn.size();
    for (int i = 0; i < midiCount && numMidi < kMaxMidi; ++i) {
        const MidiEvent& e = midiIn[i];
        if (e.size == 0)
            continue;
        MidiMsg& m = shmMidi[numMidi++];
        int off = e.sampleOffset;
        if (off < 0) off = 0;
        if (off >= frames) off = frames - 1;
        m.sampleOffset = static_cast<uint32_t>(off);
        m.data[0] = e.data[0];
        m.data[1] = e.data[1];
        m.data[2] = e.data[2];
        m.data[3] = 0;
        m.len = e.size <= 3 ? e.size : 3;
    }

    // ---- engine -> host: queued parameter changes -------------------------------------
    ParamChange* shmParams = shmParamIn(base, numIn_, numOut_);
    uint32_t numParams = 0;
    RtParam pc;
    while (numParams < kMaxParamChanges && paramQueue_.pop(pc)) {
        ParamChange& p = shmParams[numParams++];
        p.id = pc.id;
        p.value = static_cast<double>(pc.value);
        p.sampleOffset = 0;
    }

    // ---- per-block header fields -------------------------------------------------------
    h->blockFrames = static_cast<uint32_t>(frames);
    h->tempo = ctx.tempo;
    h->ppqPos = ctx.ppqPos;
    h->flags = (ctx.playing ? kShmFlagPlaying : 0u) |
               (ctx.recording ? kShmFlagRecording : 0u) |
               (ctx.looping ? kShmFlagLoop : 0u);
    h->numMidiIn = numMidi;
    h->numParamChanges = numParams;
    h->numMidiOut = 0;
    h->numParamOut = 0;
    shmStoreState(h, HostState::Processing);

    // ---- the documented blocking exchange (see header) ---------------------------------
    req->set();
    const uint32_t timeoutMs = offline_.load(std::memory_order_relaxed)
                                   ? kOfflineWaitMs
                                   : shmWaitTimeoutMs(static_cast<uint32_t>(frames),
                                                      static_cast<uint32_t>(sampleRate_));
    if (done->wait(timeoutMs) != NamedEvent::WaitResult::Signaled) {
        ++rtMisses_;
        if (rtMisses_ >= kMaxConsecutiveMisses) {
            rtEnabled_.store(false, std::memory_order_relaxed);
            restartRequested_.store(true, std::memory_order_release);
        }
        fallbackRt(io, numCh, frames);
        return;
    }
    rtMisses_ = 0;

    // ---- host -> engine: outputs + engine-side wet/dry mix -----------------------------
    // io still holds the dry input (the host worked on shm copies), so the mix can read
    // it in place: out = wet*w + dry*(1-w).
    const float w = wetDry_.load(std::memory_order_relaxed);
    if (numOut_ == 0) {
        fallbackRt(io, numCh, frames); // nothing came back; keep dry / silence
    } else {
        for (int c = 0; c < numCh; ++c) {
            float* dst = io[c];
            if (!dst)
                continue;
            const uint32_t wetCh =
                static_cast<uint32_t>(c) < numOut_ ? static_cast<uint32_t>(c) : numOut_ - 1;
            const float* wet = shmOutChannel(base, numIn_, wetCh);
            if (w >= 0.9999f) {
                std::memcpy(dst, wet, copyBytes);
            } else if (w <= 0.0001f) {
                // fully dry: io already holds it (the plugin still processed, so its
                // internal state/tails keep advancing — intended wet/dry semantics)
            } else {
                const float d = 1.0f - w;
                for (int i = 0; i < frames; ++i)
                    dst[i] = wet[i] * w + dst[i] * d;
            }
        }
    }

    // ---- host -> engine: latency + native-editor param edits ---------------------------
    const int lat = static_cast<int>(h->latencySamples);
    if (lat != latencySamples_.load(std::memory_order_relaxed))
        latencySamples_.store(lat, std::memory_order_relaxed); // pump() notifies E9

    uint32_t numOutParams = h->numParamOut;
    if (numOutParams > kMaxParamChanges)
        numOutParams = kMaxParamChanges;
    if (numOutParams > 0) {
        const ParamChange* outParams = shmParamOut(base, numIn_, numOut_);
        for (uint32_t i = 0; i < numOutParams; ++i) {
            // MPSC push: short CAS loop, no lock/alloc — accepted on the RT thread per
            // the E7 brief (drops when the 8192-slot ring is full).
            (void)mgr_.paramOutRing_.push(HostProcessManager::ParamOutMsg{
                instanceId_, outParams[i].id, static_cast<float>(outParams[i].value)});
        }
    }

    // h->numMidiOut is intentionally ignored: v1 has no routing target for plugin MIDI
    // output (SPEC §10 — MIDI hardware output / plugin-to-plugin MIDI are stubs).
}

} // namespace mydaw
