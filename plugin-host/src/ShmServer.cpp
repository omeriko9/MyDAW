//
// plugin-host/src/ShmServer.cpp — see ShmServer.h.
//
#include "ShmServer.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <cstdio>
#include <cstdlib>

namespace mydaw {

namespace {

// SEH guard around the adapter's process call (SPEC §8.1 crash flow). Lives
// in a function with no C++ objects needing unwinding (pointers only) so
// __try compiles cleanly (/EHsc C2712). Returns 0 on success, else the SEH
// exception code.
uint32_t processWithSeh(PluginAdapter* adapter, const ProcessBlock* block) {
  __try {
    adapter->process(*block);
    return 0;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    const uint32_t code = static_cast<uint32_t>(GetExceptionCode());
    return code ? code : 0xE0000001u; // never report 0 for a fault
  }
}

} // namespace

bool ShmServer::open(const std::string& shmName, std::string& err) {
  if (!shm_.open(shmName)) {
    err = "failed to open shared memory \"" + shmName + "\": " + shm_.errorString();
    return false;
  }
  ShmHeader* h = shmHeader(shm_.data());
  if (!shmValidateHeader(h)) {
    err = "shared memory \"" + shmName + "\" has an invalid header";
    return false;
  }
  const uint32_t need = shmTotalSize(h->numIn, h->numOut);
  if (shm_.size() < need) {
    err = "shared memory \"" + shmName + "\" is too small (" +
          std::to_string(shm_.size()) + " < " + std::to_string(need) + ")";
    return false;
  }
  if (!reqEvent_.open(shmReqEventName(shmName))) {
    err = "failed to open req event: " + reqEvent_.errorString();
    return false;
  }
  if (!doneEvent_.open(shmDoneEventName(shmName))) {
    err = "failed to open done event: " + doneEvent_.errorString();
    return false;
  }
  void* base = shm_.data();
  for (uint32_t c = 0; c < h->numIn; ++c) inPtrs_[c] = shmInChannel(base, c);
  for (uint32_t c = 0; c < h->numOut; ++c)
    outPtrs_[c] = shmOutChannel(base, h->numIn, c);
  return true;
}

void ShmServer::start() {
  if (started_ || !shm_.valid()) return;
  started_ = true;
  quit_.store(false, std::memory_order_release);
  thread_ = std::thread([this] { audioThreadMain(); });
}

void ShmServer::stop() {
  if (!started_) return;
  quit_.store(true, std::memory_order_release);
  if (thread_.joinable()) thread_.join();
  started_ = false;
}

void ShmServer::answerSilence(ShmHeader* h) {
  const uint32_t frames =
      h->blockFrames <= h->maxBlock ? h->blockFrames : h->maxBlock;
  for (uint32_t c = 0; c < h->numOut; ++c)
    std::memset(outPtrs_[c], 0, size_t(frames) * sizeof(float));
  h->numMidiOut = 0;
  h->numParamOut = 0;
  doneEvent_.set();
}

void ShmServer::audioThreadMain() {
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

  ShmHeader* h = shmHeader(shm_.data());
  void* base = shm_.data();
  MidiMsg* midiInRegion = shmMidiIn(base, *h);
  MidiMsg* midiOutRegion = shmMidiOut(base, *h);
  ParamChange* paramInRegion = shmParamIn(base, *h);
  ParamChange* paramOutRegion = shmParamOut(base, *h);

  for (;;) {
    if (quit_.load(std::memory_order_acquire)) break;
    const NamedEvent::WaitResult r = reqEvent_.wait(500);
    if (r == NamedEvent::WaitResult::Timeout) continue;
    if (r == NamedEvent::WaitResult::Failed) {
      std::fprintf(stderr, "[host] req event wait failed: %s\n",
                   reqEvent_.errorString().c_str());
      break;
    }
    if (quit_.load(std::memory_order_acquire)) break;

    PluginAdapter* adapter = adapter_.load(std::memory_order_acquire);
    if (!adapter || !processing_.load(std::memory_order_acquire)) {
      // Plugin still loading, init failed, or suspended: keep the engine's
      // RT wait satisfied with silence.
      answerSilence(h);
      continue;
    }

    const uint32_t frames =
        h->blockFrames <= h->maxBlock ? h->blockFrames : h->maxBlock;

    // Host fills these; pre-zero in case the adapter does not touch them.
    h->numMidiOut = 0;
    h->numParamOut = 0;

    ProcessBlock pb;
    pb.in = inPtrs_;
    pb.out = outPtrs_;
    pb.numIns = h->numIn;
    pb.numOuts = h->numOut;
    pb.frames = frames;
    pb.sampleRate = static_cast<double>(h->sampleRate);
    pb.tempo = h->tempo;
    pb.ppqPos = h->ppqPos;
    pb.flags = h->flags;
    pb.midiIn = midiInRegion;
    pb.numMidiIn = h->numMidiIn <= kMaxMidi ? h->numMidiIn : kMaxMidi;
    pb.paramIn = paramInRegion;
    pb.numParamIn =
        h->numParamChanges <= kMaxParamChanges ? h->numParamChanges
                                               : kMaxParamChanges;
    pb.midiOut = midiOutRegion;
    pb.midiOutCapacity = kMaxMidi;
    pb.numMidiOut = &h->numMidiOut;
    pb.paramOut = paramOutRegion;
    pb.paramOutCapacity = kMaxParamChanges;
    pb.numParamOut = &h->numParamOut;
    pb.latencySamples = &h->latencySamples;

    shmStoreState(h, HostState::Processing);
    const uint32_t sehCode = processWithSeh(adapter, &pb);
    if (sehCode != 0) {
      // SPEC §8.1: mark crashed, log over the pipe if possible, _exit(3).
      // Deliberately no done event — the engine's RT wait times out, reads
      // the Crashed state and starts the restart flow.
      shmStoreState(h, HostState::Crashed);
      std::fprintf(stderr, "[host] plugin crashed in process (SEH 0x%08X)\n",
                   sehCode);
      if (crashNotifier_) crashNotifier_(sehCode);
      _exit(3);
    }
    shmStoreState(h, HostState::Ready);

    // Mirror any paramOut entries (e.g. VST3 editor edits routed through the
    // shm region) into the edit buffer so the notifier thread can push
    // `paramEdited` over the pipe. Lock-free; no allocation.
    uint32_t nOut = h->numParamOut;
    if (nOut > kMaxParamChanges) nOut = kMaxParamChanges;
    for (uint32_t i = 0; i < nOut; ++i)
      edits_.note(paramOutRegion[i].id, paramOutRegion[i].value, nullptr);

    doneEvent_.set();
  }
}

} // namespace mydaw
