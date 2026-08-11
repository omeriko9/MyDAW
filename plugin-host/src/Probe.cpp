//
// plugin-host/src/Probe.cpp — see Probe.h (SPEC §5.6).
//
#include "Probe.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <objbase.h> // CoInitializeEx — excluded by WIN32_LEAN_AND_MEAN

#include <cstdio>
#include <cwctype>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "../../shared/ipc/PluginIpc.h"  // MidiMsg, kMaxBlock, kMaxMidi
#include "../../shared/ipc/SharedMem.h"  // ipcWideToUtf8
#include "PluginAdapter.h"

namespace mydaw {

namespace {

std::string inferFormat(const std::wstring& path) {
  const size_t dot = path.find_last_of(L'.');
  std::wstring ext = (dot == std::wstring::npos) ? L"" : path.substr(dot);
  for (wchar_t& c : ext) c = static_cast<wchar_t>(std::towlower(c));
  return ext == L".vst3" ? "vst3" : "vst2";
}

// SEH-guarded stage calls. Each frame holds only pointers/ints (no unwinding, so
// __try compiles under /EHsc) — all C++ objects live in the caller. Returns
// 1 = stage returned true, 0 = returned false, -1 = SEH fault (*sehCode set).

int guardedLoad(PluginAdapter* a, const std::wstring* path, const std::string* uid,
                unsigned long* sehCode) {
  __try {
    return a->load(*path, *uid) ? 1 : 0;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *sehCode = static_cast<unsigned long>(GetExceptionCode());
    return -1;
  }
}

int guardedInit(PluginAdapter* a, double rate, uint32_t block, InitInfo* info,
                unsigned long* sehCode) {
  __try {
    return a->init(rate, block, nullptr, *info) ? 1 : 0;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *sehCode = static_cast<unsigned long>(GetExceptionCode());
    return -1;
  }
}

int guardedResume(PluginAdapter* a, unsigned long* sehCode) {
  __try {
    a->resume();
    return 1;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *sehCode = static_cast<unsigned long>(GetExceptionCode());
    return -1;
  }
}

int guardedProcess(PluginAdapter* a, const ProcessBlock* block, unsigned long* sehCode) {
  __try {
    a->process(*block);
    return 1;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *sehCode = static_cast<unsigned long>(GetExceptionCode());
    return -1;
  }
}

int guardedGetState(PluginAdapter* a, std::vector<uint8_t>* out, unsigned long* sehCode) {
  __try {
    return a->getState(*out) ? 1 : 0;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *sehCode = static_cast<unsigned long>(GetExceptionCode());
    return -1;
  }
}

std::string sehText(const char* stage, unsigned long code) {
  char msg[96];
  std::snprintf(msg, sizeof(msg), "%s crashed (SEH 0x%08lX)", stage, code);
  return msg;
}

} // namespace

int runProbe(const std::wstring& path, const std::string& uid,
             const std::string& formatHint, double sampleRate, uint32_t blockSize) {
  const std::string format = formatHint.empty() ? inferFormat(path) : formatHint;
  if (sampleRate <= 0.0) sampleRate = 48000.0;
  if (blockSize == 0 || blockSize > kMaxBlock) blockSize = 512;

  nlohmann::json stages{{"load", false}, {"init", false}, {"process", false},
                        {"getState", false}};
  std::string error;
  bool nonSilent = false;
  unsigned long seh = 0;

  // Match serve mode: some plugins (DirectShow-backed Waves shells) need COM up
  // before load — see the 2026-08-08 shell-hosting commit.
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  std::unique_ptr<PluginAdapter> adapter;
  if (format == "vst2")
    adapter = createVst2Adapter();
  else if (format == "vst3")
    adapter = createVst3Adapter(); // nullptr when built MYDAW_NO_VST3
  if (!adapter) {
    error = "unknown or unsupported format \"" + format + "\"";
  } else {
    InitInfo info;
    for (;;) { // single-pass staging; break at the first failure
      int rc = guardedLoad(adapter.get(), &path, &uid, &seh);
      if (rc != 1) { error = rc < 0 ? sehText("load", seh) : "load failed (not a usable plugin)"; break; }
      stages["load"] = true;

      rc = guardedInit(adapter.get(), sampleRate, blockSize, &info, &seh);
      if (rc != 1) { error = rc < 0 ? sehText("init", seh) : "init failed"; break; }
      stages["init"] = true;

      if (guardedResume(adapter.get(), &seh) < 0) { error = sehText("resume", seh); break; }

      // 16 blocks of silence; a note on/off mid-way for instruments. Buffer counts come
      // from the plugin itself (info), floored at stereo so effects with weird I/O still
      // get valid pointers.
      const uint32_t nIn = info.numIns > 0 ? info.numIns : 2;
      const uint32_t nOut = info.numOuts > 0 ? info.numOuts : 2;
      std::vector<std::vector<float>> inBufs(nIn, std::vector<float>(blockSize, 0.0f));
      std::vector<std::vector<float>> outBufs(nOut, std::vector<float>(blockSize, 0.0f));
      std::vector<const float*> inPtrs(nIn);
      std::vector<float*> outPtrs(nOut);
      for (uint32_t c = 0; c < nIn; ++c) inPtrs[c] = inBufs[c].data();
      for (uint32_t c = 0; c < nOut; ++c) outPtrs[c] = outBufs[c].data();

      MidiMsg noteOn{};   // C4 @ 100, frame 0
      noteOn.data[0] = 0x90; noteOn.data[1] = 60; noteOn.data[2] = 100; noteOn.len = 3;
      MidiMsg noteOff{};
      noteOff.data[0] = 0x80; noteOff.data[1] = 60; noteOff.data[2] = 0; noteOff.len = 3;

      MidiMsg midiOut[16]{};
      uint32_t numMidiOut = 0;
      ParamChange paramOut[16]{};
      uint32_t numParamOut = 0;
      uint32_t latency = 0;

      bool processOk = true;
      for (int b = 0; b < 16 && processOk; ++b) {
        ProcessBlock pb;
        pb.in = inPtrs.data();
        pb.out = outPtrs.data();
        pb.numIns = nIn;
        pb.numOuts = nOut;
        pb.frames = blockSize;
        pb.sampleRate = sampleRate;
        pb.tempo = 120.0;
        pb.ppqPos = (static_cast<double>(b) * blockSize / sampleRate) * 2.0;
        pb.flags = 1; // playing
        if (info.isInstrument && b == 4) { pb.midiIn = &noteOn; pb.numMidiIn = 1; }
        else if (info.isInstrument && b == 12) { pb.midiIn = &noteOff; pb.numMidiIn = 1; }
        numMidiOut = 0;
        numParamOut = 0;
        pb.midiOut = midiOut;
        pb.midiOutCapacity = 16;
        pb.numMidiOut = &numMidiOut;
        pb.paramOut = paramOut;
        pb.paramOutCapacity = 16;
        pb.numParamOut = &numParamOut;
        pb.latencySamples = &latency;
        if (guardedProcess(adapter.get(), &pb, &seh) < 0) {
          error = sehText("process", seh);
          processOk = false;
          break;
        }
        for (uint32_t c = 0; c < nOut && !nonSilent; ++c)
          for (uint32_t i = 0; i < blockSize; ++i)
            if (outBufs[c][i] != 0.0f) { nonSilent = true; break; }
      }
      if (!processOk) break;
      stages["process"] = true;

      std::vector<uint8_t> state;
      const int st = guardedGetState(adapter.get(), &state, &seh);
      if (st < 0) { error = sehText("getState", seh); break; }
      // A false getState (no chunk support at all) is unusual but not fatal — the
      // adapter's param-array fallback normally answers. Record honestly either way.
      stages["getState"] = (st == 1);
      break;
    }
  }

  const bool ok = error.empty() && stages["load"].get<bool>() &&
                  stages["init"].get<bool>() && stages["process"].get<bool>();
  nlohmann::json result{{"ok", ok}, {"stages", stages}};
  if (ok)
    result["nonSilent"] = nonSilent;
  if (!error.empty())
    result["error"] = error;

  const std::string line = result.dump();
  std::printf("%s\n", line.c_str());
  std::fflush(stdout);
  return ok ? 0 : 1;
}

} // namespace mydaw
