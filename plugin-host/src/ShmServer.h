#pragma once
//
// plugin-host/src/ShmServer.h
//
// Host-process side of the §8.1 shared-memory audio exchange:
//   * opens the engine-created mapping + "<shm>_req"/"<shm>_done" events,
//   * runs the dedicated audio thread: WaitForSingleObject(req, 500 ms) →
//     build a ProcessBlock view of the shm regions → adapter->process()
//     inside an SEH guard → SetEvent(done),
//   * on an SEH fault in process(): shm state = Crashed, crash notifier
//     (pipe log) is invoked, then _exit(3) (SPEC §8.1 crash flow).
//
// Also defines ParamEditBuffer — a fixed-capacity, lock-free "latest edit per
// param id" map. Vst2Host's audioMasterAutomate callback (plugin UI thread or
// audio thread) writes into it without allocating or locking; main.cpp's
// notifier thread drains it and pushes throttled `paramEdited` messages
// (30 Hz per param id) over the control pipe. The audio thread additionally
// mirrors any shm paramOut entries the adapter produced into the buffer so
// VST3 editor edits reach the pipe push path too.
//
#include <atomic>
#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <thread>

#include "../../shared/ipc/PluginIpc.h"
#include "../../shared/ipc/SharedMem.h"
#include "PluginAdapter.h"

namespace mydaw {

// ---------------------------------------------------------------------------
// ParamEditBuffer
// ---------------------------------------------------------------------------
class ParamEditBuffer {
public:
  static constexpr uint32_t kCapacity = 1024; // power of two
  static constexpr uint32_t kTextLen = 64;

  // Record the latest edit for a param. Lock-free, allocation-free; callable
  // from the audio thread and the plugin UI thread concurrently. `text` may
  // be null (valueText then empty). Slots are claimed per id on first use and
  // never released; if all kCapacity slots are claimed by distinct ids the
  // edit is dropped (harmless: engine re-syncs via plugin/getParams).
  void note(uint32_t id, double value, const char* text) noexcept {
    if (id == 0xFFFFFFFFu) return; // key encoding reserves id+1 == 0
    Slot* s = findSlot(id);
    if (!s) return;
    s->ver.fetch_add(1, std::memory_order_acq_rel); // odd: write in progress
    s->value = value;
    if (text) {
      uint32_t i = 0;
      for (; i < kTextLen - 1 && text[i]; ++i) s->text[i] = text[i];
      s->text[i] = 0;
    } else {
      s->text[0] = 0;
    }
    s->ver.fetch_add(1, std::memory_order_release); // even: write done
    s->dirty.store(true, std::memory_order_release);
  }

  // Visit every dirty slot from a single consumer thread. f(id, value, text)
  // returns true to consume the edit (clear dirty) or false to leave it
  // pending (used for the 30 Hz per-param throttle).
  template <typename F>
  void forEachDirty(F&& f) {
    for (uint32_t i = 0; i < kCapacity; ++i) {
      Slot& s = slots_[i];
      const uint32_t key = s.key.load(std::memory_order_acquire);
      if (key == 0) continue;
      if (!s.dirty.load(std::memory_order_acquire)) continue;
      double value = 0.0;
      char text[kTextLen];
      uint32_t v2;
      for (;;) { // seqlock read
        const uint32_t v1 = s.ver.load(std::memory_order_acquire);
        if (v1 & 1u) continue; // writer active (writers never park mid-write)
        value = s.value;
        std::memcpy(text, s.text, kTextLen);
        std::atomic_thread_fence(std::memory_order_acquire);
        v2 = s.ver.load(std::memory_order_acquire);
        if (v1 == v2) break;
      }
      text[kTextLen - 1] = 0;
      if (f(key - 1, value, text)) {
        s.dirty.store(false, std::memory_order_release);
        // A writer may have raced between our read and the clear; if the
        // version moved, re-flag so the newest value is not lost.
        if (s.ver.load(std::memory_order_acquire) != v2)
          s.dirty.store(true, std::memory_order_release);
      }
    }
  }

private:
  struct Slot {
    std::atomic<uint32_t> key{0}; // id+1; 0 = empty. Claimed once via CAS.
    std::atomic<uint32_t> ver{0}; // seqlock version (odd = write in progress)
    std::atomic<bool> dirty{false};
    double value = 0.0;
    char text[kTextLen] = {};
  };

  Slot* findSlot(uint32_t id) noexcept {
    const uint32_t want = id + 1;
    const uint32_t start = (id * 2654435761u) & (kCapacity - 1);
    for (uint32_t probe = 0; probe < kCapacity; ++probe) {
      Slot& s = slots_[(start + probe) & (kCapacity - 1)];
      uint32_t k = s.key.load(std::memory_order_acquire);
      if (k == want) return &s;
      if (k == 0) {
        if (s.key.compare_exchange_strong(k, want, std::memory_order_acq_rel))
          return &s;
        if (k == want) return &s; // lost the race to the same id
        // else another id claimed it; keep probing
      }
    }
    return nullptr; // table full
  }

  Slot slots_[kCapacity];
};

// ---------------------------------------------------------------------------
// ShmServer
// ---------------------------------------------------------------------------
class ShmServer {
public:
  ShmServer() = default;
  ~ShmServer() { stop(); }
  ShmServer(const ShmServer&) = delete;
  ShmServer& operator=(const ShmServer&) = delete;

  // Open the engine-created mapping and its req/done events; validates the
  // header (magic/version/maxBlock/channel counts). Returns false + err.
  bool open(const std::string& shmName, std::string& err);

  ShmHeader* header() const {
    return shm_.valid() ? shmHeader(shm_.data()) : nullptr;
  }

  // Spawn the audio thread. Until setAdapter() is called every req is
  // answered with silence + done so the engine RT wait never times out
  // while the plugin is still loading.
  void start();

  // Join the audio thread (returns within ~500 ms). Idempotent.
  void stop();

  // Called from the main thread once adapter->init() succeeded. The audio
  // thread starts routing blocks through the adapter on the next req.
  void setAdapter(PluginAdapter* adapter) {
    adapter_.store(adapter, std::memory_order_release);
  }

  // suspend/resume gate (§8.2): while false, blocks are answered with
  // silence and the adapter is not called.
  void setProcessing(bool enabled) {
    processing_.store(enabled, std::memory_order_release);
  }

  // Invoked on the audio thread after the shm state is set to Crashed and
  // before _exit(3) — used to push a `log` message over the control pipe
  // (Pipe::sendMessage is synchronous, so the message is flushed before
  // the process dies).
  void setCrashNotifier(std::function<void(uint32_t sehCode)> fn) {
    crashNotifier_ = std::move(fn);
  }

  ParamEditBuffer& edits() { return edits_; }

private:
  void audioThreadMain();
  void answerSilence(ShmHeader* h);

  SharedMem shm_;
  NamedEvent reqEvent_;
  NamedEvent doneEvent_;
  std::thread thread_;
  std::atomic<bool> quit_{false};
  bool started_ = false;
  std::atomic<PluginAdapter*> adapter_{nullptr};
  std::atomic<bool> processing_{true};
  std::function<void(uint32_t)> crashNotifier_;
  ParamEditBuffer edits_;

  // Channel pointer tables into the mapped regions, fixed at open() (numIn/
  // numOut are immutable for the mapping's lifetime).
  float* inPtrs_[kMaxChannels] = {};
  float* outPtrs_[kMaxChannels] = {};
};

} // namespace mydaw
