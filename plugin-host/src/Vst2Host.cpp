//
// plugin-host/src/Vst2Host.cpp — see Vst2Host.h. SPEC §8.4 (VST2 specifics).
//
#include "Vst2Host.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "../../shared/ipc/SharedMem.h" // ipcWideToUtf8

namespace mydaw {

namespace {

// The instance currently inside load(): pre-instance audioMaster callbacks
// (issued by the plugin's entry point before AEffect::resvd1 is set) are
// routed here. load() only ever runs on the host main thread.
Vst2Host* g_loadingInstance = nullptr;

// Diagnostic trace for stubborn plugins: set MYDAW_VST2_TRACE=1 to log the
// load sequence and every audioMaster call to stderr.
bool vst2Trace() {
  static const bool on = [] {
    char buf[8];
    return GetEnvironmentVariableA("MYDAW_VST2_TRACE", buf, sizeof(buf)) > 0;
  }();
  return on;
}

void copyToBuf(void* dst, const char* src, size_t cap) {
  if (!dst || cap == 0) return;
  // Write only strlen+1 bytes — NEVER strncpy-pad to cap: VST1-era plugins
  // (e.g. UVI PlugSound) pass buffers smaller than kVstMax*StrLen and padding
  // smashes their stack, making the entry point bail and return NULL.
  char* d = static_cast<char*>(dst);
  size_t n = std::strlen(src);
  if (n >= cap) n = cap - 1;
  std::memcpy(d, src, n);
  d[n] = 0;
}

// Trim leading/trailing whitespace in place; returns dst.
char* trimInPlace(char* s) {
  char* b = s;
  while (*b == ' ' || *b == '\t') ++b;
  size_t n = std::strlen(b);
  while (n > 0 && (b[n - 1] == ' ' || b[n - 1] == '\t' || b[n - 1] == '\r' ||
                   b[n - 1] == '\n'))
    --n;
  if (b != s) std::memmove(s, b, n);
  s[n] = 0;
  return s;
}

// Number of valid bytes of a channel/system MIDI message from its status.
uint32_t midiMsgLen(uint8_t status) {
  switch (status & 0xF0u) {
    case 0xC0u: // program change
    case 0xD0u: // channel pressure
      return 2;
    case 0xF0u: // system
      switch (status) {
        case 0xF1u:
        case 0xF3u:
          return 2;
        case 0xF2u:
          return 3;
        default:
          return 1;
      }
    default:
      return 3;
  }
}

const char* categoryName(VstInt32 categ) {
  switch (categ) {
    case kPlugCategEffect: return "Effect";
    case kPlugCategSynth: return "Instrument";
    case kPlugCategAnalysis: return "Analysis";
    case kPlugCategMastering: return "Mastering";
    case kPlugCategSpacializer: return "Spacializer";
    case kPlugCategRoomFx: return "Room Fx";
    case kPlugSurroundFx: return "Surround Fx";
    case kPlugCategRestoration: return "Restoration";
    case kPlugCategOfflineProcess: return "Offline Process";
    case kPlugCategShell: return "Shell";
    case kPlugCategGenerator: return "Generator";
    default: return "";
  }
}

double clamp01(double v) { return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }

} // namespace

// ===========================================================================
// Lifecycle
// ===========================================================================
Vst2Host::Vst2Host() = default;

Vst2Host::~Vst2Host() { unload(); }

void Vst2Host::unload() {
  if (effect_) {
    if (editorOpen_) closeEditor();
    if (resumed_) suspend();
    dispatch(effClose);
    effect_ = nullptr;
  }
  if (module_) {
    FreeLibrary(static_cast<HMODULE>(module_));
    module_ = nullptr;
  }
}

bool Vst2Host::load(const std::wstring& path, const std::string& uid) {
  if (effect_) {
    lastError_ = "load() called twice";
    return false;
  }
  isShell_ = false;
  shellUidRequested_ = false;
  requestedShellUid_ = 0;
  if (!uid.empty()) {
    char* end = nullptr;
    const long long want = std::strtoll(uid.c_str(), &end, 10);
    if (!end || *end != 0) {
      lastError_ = "invalid vst2 uid \"" + uid + "\" (expected decimal)";
      return false;
    }
    shellUidRequested_ = true;
    requestedShellUid_ = static_cast<VstInt32>(want);
  }
  if (vst2Trace())
    std::fprintf(stderr, "[vst2] LoadLibraryW(%ls) begin\n", path.c_str());
  HMODULE mod = LoadLibraryW(path.c_str());
  if (vst2Trace())
    std::fprintf(stderr, "[vst2] LoadLibraryW(%ls) -> %p\n", path.c_str(),
                 static_cast<void*>(mod));
  if (!mod) {
    lastError_ = "LoadLibrary failed: " + win32ErrorString(GetLastError());
    return false;
  }
  module_ = mod;

  if (vst2Trace())
    std::fprintf(stderr, "[vst2] GetProcAddress(VSTPluginMain)\n");
  auto entry = reinterpret_cast<VstEntryProc>(
      reinterpret_cast<void*>(GetProcAddress(mod, "VSTPluginMain")));
  if (!entry) {
    if (vst2Trace())
      std::fprintf(stderr, "[vst2] GetProcAddress(main)\n");
    entry = reinterpret_cast<VstEntryProc>(
        reinterpret_cast<void*>(GetProcAddress(mod, "main")));
  }
  if (vst2Trace())
    std::fprintf(stderr, "[vst2] entry resolved -> %p\n",
                 reinterpret_cast<void*>(entry));
  if (!entry) {
    lastError_ = "not a VST2 plugin (no VSTPluginMain/main export)";
    unload();
    return false;
  }

  // Path bookkeeping (name fallback + audioMasterGetDirectory).
  {
    const size_t slash = path.find_last_of(L"\\/");
    std::wstring file =
        slash == std::wstring::npos ? path : path.substr(slash + 1);
    const size_t dot = file.find_last_of(L'.');
    if (dot != std::wstring::npos) file.resize(dot);
    moduleStemUtf8_ = ipcWideToUtf8(file);
    const std::wstring dir =
        slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
    if (!dir.empty()) {
      const int n = WideCharToMultiByte(CP_ACP, 0, dir.c_str(),
                                        static_cast<int>(dir.size()), nullptr,
                                        0, nullptr, nullptr);
      if (n > 0) {
        ansiDir_.resize(static_cast<size_t>(n));
        WideCharToMultiByte(CP_ACP, 0, dir.c_str(),
                            static_cast<int>(dir.size()), ansiDir_.data(), n,
                            nullptr, nullptr);
      }
    }
  }

  if (vst2Trace())
    std::fprintf(stderr, "[vst2] entry=%p (%s) calling...\n",
                 reinterpret_cast<void*>(entry),
                 GetProcAddress(mod, "VSTPluginMain") ? "VSTPluginMain" : "main");
  g_loadingInstance = this;
  AEffect* e = entry(&Vst2Host::audioMasterThunk);
  g_loadingInstance = nullptr;
  if (vst2Trace())
    std::fprintf(stderr, "[vst2] entry returned %p magic=0x%08X\n",
                 static_cast<void*>(e),
                 e ? static_cast<unsigned>(e->magic) : 0u);

  if (!e || e->magic != kEffectMagic) {
    lastError_ = "plugin entry point did not return a valid AEffect";
    unload();
    return false;
  }
  e->resvd1 = reinterpret_cast<VstIntPtr>(this);
  effect_ = e;

  if (vst2Trace())
    std::fprintf(stderr, "[vst2] dispatch(effOpen) begin\n");
  dispatch(effOpen);
  if (vst2Trace())
    std::fprintf(stderr, "[vst2] dispatch(effOpen) done\n");

  // v1: no VST2 shell-plugin support (SPEC §8.3).
  if (vst2Trace())
    std::fprintf(stderr, "[vst2] dispatch(effGetPlugCategory) begin\n");
  const VstIntPtr category = dispatch(effGetPlugCategory);
  if (vst2Trace())
    std::fprintf(stderr, "[vst2] dispatch(effGetPlugCategory) -> %lld\n",
                 static_cast<long long>(category));
  isShell_ = (category == kPlugCategShell);

  if (isShell_ && !shellUidRequested_) {
    // Shell containers are valid scan targets, but runtime loading needs the
    // selected child uid so audioMasterCurrentId can identify the sub-plugin.
    return true;
  }

  if (shellUidRequested_ &&
      requestedShellUid_ != static_cast<VstInt32>(effect_->uniqueID)) {
    lastError_ = "uid mismatch: plugin reports " +
                 std::to_string(effect_->uniqueID) + ", expected " + uid;
    unload();
    return false;
  }

  // Capture initial parameter values: VST2 has no default-value query, so
  // the post-instantiation values serve as defaults (SPEC §5.6).
  const int numParams = effect_->numParams > 0 ? effect_->numParams : 0;
  defaults_.resize(static_cast<size_t>(numParams));
  for (int i = 0; i < numParams; ++i)
    defaults_[static_cast<size_t>(i)] =
        effect_->getParameter ? effect_->getParameter(effect_, i) : 0.0f;

  return true;
}

bool Vst2Host::init(double sampleRate, uint32_t maxBlock, const ShmHeader* shm,
                    InitInfo& outInfo) {
  (void)shm; // channel decisions live in process() channel mapping
  if (!effect_) {
    lastError_ = "init() before load()";
    return false;
  }
  if (!(effect_->flags & effFlagsCanReplacing) || !effect_->processReplacing) {
    lastError_ =
        "plugin does not support float32 processReplacing "
        "(effFlagsCanReplacing missing) — not hostable";
    return false;
  }
  sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
  maxBlock_ = (maxBlock > 0 && maxBlock <= kMaxBlock) ? maxBlock : kMaxBlock;

  dispatch(effSetSampleRate, 0, 0, nullptr, static_cast<float>(sampleRate_));
  dispatch(effSetBlockSize, 0, static_cast<VstIntPtr>(maxBlock_));

  // Channel mapping scratch (allocation happens here, never on the RT path).
  const int pIns = effect_->numInputs > 0 ? effect_->numInputs : 0;
  const int pOuts = effect_->numOutputs > 0 ? effect_->numOutputs : 0;
  zeroBuf_.assign(maxBlock_, 0.0f);
  procIn_.assign(static_cast<size_t>(pIns > 0 ? pIns : 1), zeroBuf_.data());
  dumpBufs_.resize(static_cast<size_t>(pOuts));
  for (auto& b : dumpBufs_) b.assign(maxBlock_, 0.0f);
  procOut_.assign(static_cast<size_t>(pOuts > 0 ? pOuts : 1), nullptr);
  for (size_t c = 0; c < procOut_.size(); ++c)
    procOut_[c] = c < dumpBufs_.size() ? dumpBufs_[c].data() : zeroBuf_.data();

  // Default time info until the first block arrives.
  std::memset(&timeInfo_, 0, sizeof(timeInfo_));
  timeInfo_.sampleRate = sampleRate_;
  timeInfo_.tempo = 120.0;
  timeInfo_.timeSigNumerator = 4;
  timeInfo_.timeSigDenominator = 4;
  timeInfo_.flags = kVstTempoValid | kVstPpqPosValid | kVstTimeSigValid;

  resume(); // effMainsChanged(1) + effStartProcess

  std::string name = effString(effGetEffectName);
  if (name.empty()) name = moduleStemUtf8_;
  outInfo.name = name;
  outInfo.vendor = effString(effGetVendorString);
  outInfo.numParams =
      effect_->numParams > 0 ? static_cast<uint32_t>(effect_->numParams) : 0;
  outInfo.latencySamples = effect_->initialDelay > 0
                               ? static_cast<uint32_t>(effect_->initialDelay)
                               : 0;
  outInfo.isInstrument = (effect_->flags & effFlagsIsSynth) != 0 ||
                         dispatch(effGetPlugCategory) == kPlugCategSynth;
  outInfo.numIns = static_cast<uint32_t>(pIns);
  outInfo.numOuts = static_cast<uint32_t>(pOuts);
  outInfo.hasEditor = (effect_->flags & effFlagsHasEditor) != 0;
  return true;
}

void Vst2Host::suspend() {
  if (!effect_ || !resumed_) return;
  dispatch(effStopProcess);
  dispatch(effMainsChanged, 0, 0);
  resumed_ = false;
}

void Vst2Host::resume() {
  if (!effect_ || resumed_) return;
  dispatch(effMainsChanged, 0, 1);
  dispatch(effStartProcess);
  resumed_ = true;
}

// ===========================================================================
// Processing (host audio thread — no allocation, no locks, no throw)
// ===========================================================================
void Vst2Host::fillTimeInfo(const ProcessBlock& block) noexcept {
  timeInfo_.sampleRate = block.sampleRate > 0.0 ? block.sampleRate : sampleRate_;
  timeInfo_.tempo = block.tempo > 0.0 ? block.tempo : 120.0;
  timeInfo_.ppqPos = block.ppqPos;
  timeInfo_.samplePos =
      block.ppqPos * 60.0 / timeInfo_.tempo * timeInfo_.sampleRate;
  // NOTE(spec): the shm header carries no time signature; assume 4/4 (v1 has
  // a single timeSig and most projects are 4/4 — SPEC §8.1 field list).
  timeInfo_.timeSigNumerator = 4;
  timeInfo_.timeSigDenominator = 4;
  timeInfo_.barStartPos = std::floor(block.ppqPos / 4.0) * 4.0;

  VstInt32 flags = kVstTempoValid | kVstPpqPosValid | kVstBarsValid |
                   kVstTimeSigValid;
  if (block.flags & kShmFlagPlaying) flags |= kVstTransportPlaying;
  if (block.flags & kShmFlagRecording) flags |= kVstTransportRecording;
  if (block.flags & kShmFlagLoop) flags |= kVstTransportCycleActive;
  if (block.flags != lastShmFlags_) flags |= kVstTransportChanged;
  lastShmFlags_ = block.flags;
  timeInfo_.flags = flags;
}

void Vst2Host::process(const ProcessBlock& block) noexcept {
  const uint32_t frames = block.frames;
  if (!effect_ || !resumed_) {
    for (uint32_t c = 0; c < block.numOuts; ++c)
      std::memset(block.out[c], 0, size_t(frames) * sizeof(float));
    if (block.latencySamples)
      *block.latencySamples =
          (effect_ && effect_->initialDelay > 0)
              ? static_cast<uint32_t>(effect_->initialDelay)
              : 0;
    return;
  }

  curBlock_ = &block;
  inProcess_.store(true, std::memory_order_release);

  fillTimeInfo(block);

  // MIDI in → effProcessEvents (fixed arena, before processReplacing).
  if (block.numMidiIn > 0 && block.midiIn) {
    uint32_t n = block.numMidiIn <= kMaxMidi ? block.numMidiIn : kMaxMidi;
    uint32_t used = 0;
    for (uint32_t i = 0; i < n; ++i) {
      const MidiMsg& m = block.midiIn[i];
      if (m.len == 0 || m.len > 4) continue;
      VstMidiEvent& ev = midiArena_[used];
      std::memset(&ev, 0, sizeof(ev));
      ev.type = kVstMidiType;
      ev.byteSize = static_cast<VstInt32>(sizeof(VstMidiEvent));
      ev.deltaFrames =
          m.sampleOffset < frames ? static_cast<VstInt32>(m.sampleOffset)
                                  : static_cast<VstInt32>(frames ? frames - 1 : 0);
      ev.flags = kVstMidiEventIsRealtime;
      ev.midiData[0] = static_cast<char>(m.data[0]);
      ev.midiData[1] = static_cast<char>(m.data[1]);
      ev.midiData[2] = static_cast<char>(m.data[2]);
      ev.midiData[3] = 0;
      eventsArena_.events[used] = reinterpret_cast<VstEvent*>(&ev);
      ++used;
    }
    if (used > 0) {
      eventsArena_.numEvents = static_cast<VstInt32>(used);
      eventsArena_.reserved = 0;
      dispatch(effProcessEvents, 0, 0, &eventsArena_);
    }
  }

  // Param changes in (engine RT fast path). VST2 has no sample-accurate
  // parameter API; apply at block start.
  if (block.numParamIn > 0 && block.paramIn && effect_->setParameter) {
    for (uint32_t i = 0; i < block.numParamIn; ++i) {
      const ParamChange& pc = block.paramIn[i];
      effect_->setParameter(effect_, static_cast<VstInt32>(pc.id),
                            static_cast<float>(clamp01(pc.value)));
    }
  }

  // Channel mapping: process through min(plugin io, shm channels); silent
  // input / dump output for the plugin's extra channels; zero extra shm outs.
  const uint32_t pIns = static_cast<uint32_t>(procIn_.size());
  const uint32_t pOuts = static_cast<uint32_t>(procOut_.size());
  const uint32_t nIns =
      effect_->numInputs > 0 ? static_cast<uint32_t>(effect_->numInputs) : 0;
  const uint32_t nOuts =
      effect_->numOutputs > 0 ? static_cast<uint32_t>(effect_->numOutputs) : 0;
  for (uint32_t c = 0; c < pIns; ++c)
    procIn_[c] = (c < nIns && c < block.numIns)
                     ? const_cast<float*>(block.in[c])
                     : zeroBuf_.data();
  for (uint32_t c = 0; c < pOuts; ++c)
    procOut_[c] = (c < nOuts && c < block.numOuts) ? block.out[c]
                                                   : dumpBufs_[c].data();
  for (uint32_t c = nOuts; c < block.numOuts; ++c)
    std::memset(block.out[c], 0, size_t(frames) * sizeof(float));

  if (frames > 0)
    effect_->processReplacing(effect_, procIn_.data(), procOut_.data(),
                              static_cast<VstInt32>(frames));

  if (block.latencySamples)
    *block.latencySamples = effect_->initialDelay > 0
                                ? static_cast<uint32_t>(effect_->initialDelay)
                                : 0;

  inProcess_.store(false, std::memory_order_release);
  curBlock_ = nullptr;
}

// ===========================================================================
// Parameters
// ===========================================================================
std::vector<ParamInfo> Vst2Host::getParams() {
  std::vector<ParamInfo> out;
  if (!effect_) return out;
  const int n = effect_->numParams > 0 ? effect_->numParams : 0;
  out.reserve(static_cast<size_t>(n));
  for (int i = 0; i < n; ++i) {
    ParamInfo p;
    p.id = static_cast<uint32_t>(i);
    p.name = effString(effGetParamName, i);
    if (p.name.empty()) p.name = "Param " + std::to_string(i);
    p.label = effString(effGetParamLabel, i);
    p.value = effect_->getParameter
                  ? clamp01(static_cast<double>(
                        effect_->getParameter(effect_, i)))
                  : 0.0;
    p.defaultValue = i < static_cast<int>(defaults_.size())
                         ? clamp01(static_cast<double>(
                               defaults_[static_cast<size_t>(i)]))
                         : 0.0;
    p.steps = 0; // v1: continuous (effGetParameterProperties not queried)
    char text[128];
    paramTextRaw(i, text, sizeof(text));
    p.valueText = text;
    out.push_back(std::move(p));
  }
  return out;
}

void Vst2Host::setParam(uint32_t id, double value) {
  if (!effect_ || !effect_->setParameter) return;
  if (static_cast<int32_t>(id) < 0 ||
      static_cast<VstInt32>(id) >= effect_->numParams)
    return;
  effect_->setParameter(effect_, static_cast<VstInt32>(id),
                        static_cast<float>(clamp01(value)));
}

void Vst2Host::paramTextRaw(VstInt32 index, char* out, uint32_t cap) noexcept {
  if (!out || cap == 0) return;
  out[0] = 0;
  if (!effect_ || index < 0 || index >= effect_->numParams) return;
  // Plugins are notorious for overrunning the nominal 8-char kVstMaxParamStrLen
  // buffers; give them generous stack space.
  char disp[128] = {0};
  char label[128] = {0};
  dispatch(effGetParamDisplay, index, 0, disp);
  dispatch(effGetParamLabel, index, 0, label);
  disp[sizeof(disp) - 1] = 0;
  label[sizeof(label) - 1] = 0;
  trimInPlace(disp);
  trimInPlace(label);
  if (label[0])
    std::snprintf(out, cap, "%s %s", disp, label);
  else
    std::snprintf(out, cap, "%s", disp);
}

std::string Vst2Host::getParamText(uint32_t id) {
  char text[128];
  paramTextRaw(static_cast<VstInt32>(id), text, sizeof(text));
  return text;
}

// ===========================================================================
// State (SPEC §8.4: prefer chunks, else param array)
// ===========================================================================
bool Vst2Host::getState(std::vector<uint8_t>& out) {
  out.clear();
  if (!effect_) {
    lastError_ = "no plugin loaded";
    return false;
  }
  if (effect_->flags & effFlagsProgramChunks) {
    void* data = nullptr;
    const VstIntPtr n = dispatch(effGetChunk, 0 /*bank*/, 0, &data);
    if (n <= 0 || !data) {
      lastError_ = "effGetChunk returned no data";
      return false;
    }
    out.assign(static_cast<const uint8_t*>(data),
               static_cast<const uint8_t*>(data) + n);
    return true;
  }
  // Param-array fallback: {u32 magic, u32 version, u32 count, float[count]}.
  const uint32_t count =
      effect_->numParams > 0 ? static_cast<uint32_t>(effect_->numParams) : 0;
  out.resize(12 + size_t(count) * 4);
  const uint32_t magic = kParamStateMagic;
  const uint32_t version = kParamStateVersion;
  std::memcpy(out.data(), &magic, 4);
  std::memcpy(out.data() + 4, &version, 4);
  std::memcpy(out.data() + 8, &count, 4);
  for (uint32_t i = 0; i < count; ++i) {
    const float v = effect_->getParameter
                        ? effect_->getParameter(effect_,
                                                static_cast<VstInt32>(i))
                        : 0.0f;
    std::memcpy(out.data() + 12 + size_t(i) * 4, &v, 4);
  }
  return true;
}

bool Vst2Host::setState(std::span<const uint8_t> data) {
  if (!effect_) {
    lastError_ = "no plugin loaded";
    return false;
  }
  if (data.empty()) {
    lastError_ = "empty state chunk";
    return false;
  }
  if (effect_->flags & effFlagsProgramChunks) {
    dispatch(effSetChunk, 0 /*bank*/, static_cast<VstIntPtr>(data.size()),
             const_cast<uint8_t*>(data.data()));
    return true;
  }
  if (data.size() < 12) {
    lastError_ = "state chunk too small for param-array format";
    return false;
  }
  uint32_t magic = 0, version = 0, count = 0;
  std::memcpy(&magic, data.data(), 4);
  std::memcpy(&version, data.data() + 4, 4);
  std::memcpy(&count, data.data() + 8, 4);
  if (magic != kParamStateMagic || version != kParamStateVersion) {
    lastError_ = "state chunk is not a MyDAW vst2 param-array blob";
    return false;
  }
  if (data.size() < 12 + size_t(count) * 4) {
    lastError_ = "truncated param-array state chunk";
    return false;
  }
  const uint32_t n =
      effect_->numParams > 0
          ? (count < static_cast<uint32_t>(effect_->numParams)
                 ? count
                 : static_cast<uint32_t>(effect_->numParams))
          : 0;
  for (uint32_t i = 0; i < n && effect_->setParameter; ++i) {
    float v = 0.0f;
    std::memcpy(&v, data.data() + 12 + size_t(i) * 4, 4);
    effect_->setParameter(effect_, static_cast<VstInt32>(i),
                          static_cast<float>(clamp01(v)));
  }
  return true;
}

// ===========================================================================
// Presets = programs
// ===========================================================================
std::vector<PresetInfo> Vst2Host::getPresets() {
  std::vector<PresetInfo> out;
  if (!effect_) return out;
  const int n = effect_->numPrograms > 0 ? effect_->numPrograms : 0;
  out.reserve(static_cast<size_t>(n));
  for (int i = 0; i < n; ++i) {
    char name[256] = {0};
    const VstIntPtr ok =
        dispatch(effGetProgramNameIndexed, i, -1, name);
    name[sizeof(name) - 1] = 0;
    trimInPlace(name);
    PresetInfo p;
    p.id = i;
    p.name = (ok && name[0]) ? name : ("Program " + std::to_string(i + 1));
    out.push_back(std::move(p));
  }
  return out;
}

bool Vst2Host::loadPreset(int32_t id) {
  if (!effect_) {
    lastError_ = "no plugin loaded";
    return false;
  }
  if (id < 0 || id >= effect_->numPrograms) {
    lastError_ = "program index out of range";
    return false;
  }
  dispatch(effBeginSetProgram);
  dispatch(effSetProgram, 0, id);
  dispatch(effEndSetProgram);
  return true;
}

// ===========================================================================
// Editor
// ===========================================================================
bool Vst2Host::openEditor(HWND parent, EditorSize& outSize) {
  if (!effect_) {
    lastError_ = "no plugin loaded";
    return false;
  }
  if (!(effect_->flags & effFlagsHasEditor)) {
    lastError_ = "plugin has no native editor";
    return false;
  }
  if (editorOpen_) {
    outSize.width = pendW_.load(std::memory_order_relaxed);
    outSize.height = pendH_.load(std::memory_order_relaxed);
    return true;
  }
  // Some plugins want the rect queried before open.
  ERect* rect = nullptr;
  dispatch(effEditGetRect, 0, 0, &rect);
  dispatch(effEditOpen, 0, 0, parent);
  editorOpen_ = true;
  rect = nullptr;
  dispatch(effEditGetRect, 0, 0, &rect);
  int32_t w = 0, h = 0;
  if (rect) {
    w = rect->right - rect->left;
    h = rect->bottom - rect->top;
  }
  if (w <= 0 || h <= 0) {
    w = 640;
    h = 480;
  }
  outSize.width = w;
  outSize.height = h;
  resizePending_.store(false, std::memory_order_relaxed);
  return true;
}

void Vst2Host::closeEditor() {
  if (!effect_ || !editorOpen_) return;
  dispatch(effEditClose);
  editorOpen_ = false;
}

void Vst2Host::editorIdle() {
  if (!effect_) return;
  if (editorOpen_) dispatch(effEditIdle);
  if (needIdle_) {
    // Old plugins ask for host idle (audioMasterIdle) and expect effIdle
    // pumping until they are satisfied; returning 0 means "done".
    if (dispatch(effIdle) == 0) needIdle_ = false;
  }
}

bool Vst2Host::resizePending(EditorSize& outNewSize) {
  if (!resizePending_.exchange(false, std::memory_order_acq_rel)) return false;
  outNewSize.width = pendW_.load(std::memory_order_acquire);
  outNewSize.height = pendH_.load(std::memory_order_acquire);
  return outNewSize.width > 0 && outNewSize.height > 0;
}

// ===========================================================================
// Scan support
// ===========================================================================
void Vst2Host::fillScanInfo(ScannedPlugin& out) const {
  out.format = "vst2";
  out.bitness = static_cast<uint32_t>(sizeof(void*) * 8);
  if (!effect_) return;
  out.uid = std::to_string(effect_->uniqueID);
  char buf[256] = {0};
  dispatch(effGetEffectName, 0, 0, buf);
  buf[sizeof(buf) - 1] = 0;
  trimInPlace(buf);
  out.name = buf[0] ? buf : moduleStemUtf8_;
  char vend[256] = {0};
  dispatch(effGetVendorString, 0, 0, vend);
  vend[sizeof(vend) - 1] = 0;
  trimInPlace(vend);
  out.vendor = vend;
  const VstInt32 categ = static_cast<VstInt32>(dispatch(effGetPlugCategory));
  out.category = categoryName(categ);
  out.isInstrument =
      (effect_->flags & effFlagsIsSynth) != 0 || categ == kPlugCategSynth;
  out.numInputs =
      effect_->numInputs > 0 ? static_cast<uint32_t>(effect_->numInputs) : 0;
  out.numOutputs =
      effect_->numOutputs > 0 ? static_cast<uint32_t>(effect_->numOutputs) : 0;
}

bool Vst2Host::enumerateShellPlugins(
    std::vector<std::pair<VstInt32, std::string>>& out) {
  out.clear();
  if (!effect_) {
    lastError_ = "no plugin loaded";
    return false;
  }
  if (!isShell_) return true;

  char name[256];
  for (;;) {
    std::memset(name, 0, sizeof(name));
    const VstIntPtr uid = dispatch(effShellGetNextPlugin, 0, 0, name);
    if (!uid) break;
    name[sizeof(name) - 1] = 0;
    trimInPlace(name);
    out.emplace_back(static_cast<VstInt32>(uid),
                     name[0] ? std::string(name)
                             : ("Shell Plugin " + std::to_string(uid)));
  }
  return true;
}

bool scanVst2File(const std::wstring& path, std::vector<ScannedPlugin>& out,
                  std::string& error) {
  Vst2Host host;
  if (!host.load(path, std::string())) {
    error = host.lastError();
    return false;
  }
  if (host.isShell()) {
    std::vector<std::pair<VstInt32, std::string>> shellPlugins;
    if (!host.enumerateShellPlugins(shellPlugins)) {
      error = host.lastError();
      return false;
    }
    ScannedPlugin shellMeta;
    host.fillScanInfo(shellMeta);
    for (const auto& [uid, shellName] : shellPlugins) {
      ScannedPlugin sp;
      sp.format = "vst2";
      sp.bitness = static_cast<uint32_t>(sizeof(void*) * 8);
      sp.uid = std::to_string(uid);
      sp.name = shellName;
      sp.vendor = shellMeta.vendor;
      sp.category = shellMeta.category;
      sp.isInstrument = shellMeta.isInstrument;
      sp.numInputs = shellMeta.numInputs;
      sp.numOutputs = shellMeta.numOutputs;
      sp.path = ipcWideToUtf8(path);
      out.push_back(std::move(sp));
    }
    if (out.empty()) {
      error = "VST2 shell plugin exposed no child plugins";
      return false;
    }
    return true;
  }
  ScannedPlugin sp;
  host.fillScanInfo(sp);
  sp.path = ipcWideToUtf8(path);
  out.push_back(std::move(sp));
  return true;
}

std::unique_ptr<PluginAdapter> createVst2Adapter() {
  return std::make_unique<Vst2Host>();
}

// ===========================================================================
// audioMaster
// ===========================================================================
VstIntPtr VESTIGE_CALLBACK Vst2Host::audioMasterThunk(AEffect* effect,
                                                      VstInt32 opcode,
                                                      VstInt32 index,
                                                      VstIntPtr value,
                                                      void* ptr, float opt) {
  Vst2Host* self = nullptr;
  if (effect && effect->resvd1)
    self = reinterpret_cast<Vst2Host*>(effect->resvd1);
  if (!self) self = g_loadingInstance;
  if (vst2Trace())
    std::fprintf(stderr, "[vst2]   audioMaster op=%d idx=%d val=%lld ptr=%p self=%p\n",
                 opcode, index, static_cast<long long>(value), ptr,
                 static_cast<void*>(self));
  if (self) return self->onAudioMaster(opcode, index, value, ptr, opt);

  // Pre-instance fallbacks (no host instance reachable).
  switch (opcode) {
    case audioMasterVersion: return kVstVersion;
    case audioMasterCurrentId:
      return g_loadingInstance && g_loadingInstance->shellUidRequested_
                 ? g_loadingInstance->requestedShellUid_
                 : 0;
    case audioMasterWantMidi: return 1;
    case audioMasterGetSampleRate: return 44100;
    case audioMasterGetBlockSize: return static_cast<VstIntPtr>(kMaxBlock);
    case audioMasterGetLanguage: return kVstLangEnglish;
    case audioMasterGetVendorString:
      copyToBuf(ptr, "MyDAW", kVstMaxVendorStrLen);
      return 1;
    case audioMasterGetProductString:
      copyToBuf(ptr, "MyDAW", kVstMaxProductStrLen);
      return 1;
    case audioMasterGetVendorVersion: return 1000;
    default: return 0;
  }
}

VstIntPtr Vst2Host::onAudioMaster(VstInt32 opcode, VstInt32 index,
                                  VstIntPtr value, void* ptr,
                                  float opt) noexcept {
  (void)value;
  switch (opcode) {
    case audioMasterVersion:
      return kVstVersion;
    case audioMasterCurrentId:
      if (shellUidRequested_) return requestedShellUid_;
      return effect_ ? effect_->uniqueID : 0;

    case audioMasterAutomate: { // editor edit → paramEdited push (SPEC §8.2)
      if (cb_.paramEdited) {
        char text[128] = {0};
        // Fetch display text only off the audio path (no re-entrant
        // dispatcher call while the plugin is inside processReplacing).
        if (!inProcess_.load(std::memory_order_acquire))
          paramTextRaw(index, text, sizeof(text));
        cb_.paramEdited(static_cast<uint32_t>(index),
                        clamp01(static_cast<double>(opt)), text);
      }
      return 0;
    }

    case audioMasterIdle:
      needIdle_ = true;
      return 0;
    case audioMasterWantMidi:
      return 1;

    case audioMasterGetTime:
      // Per-block VstTimeInfo (filled in fillTimeInfo; defaults until the
      // first block). Valid until the next process call — VST2 convention.
      return reinterpret_cast<VstIntPtr>(&timeInfo_);

    case audioMasterProcessEvents: { // plugin MIDI out → shm midiOut region
      const VstEvents* evs = static_cast<const VstEvents*>(ptr);
      const ProcessBlock* b = curBlock_;
      if (!evs || !b || !b->midiOut || !b->numMidiOut) return 0;
      uint32_t count = *b->numMidiOut;
      for (VstInt32 i = 0; i < evs->numEvents; ++i) {
        const VstEvent* e = evs->events[i];
        if (!e || e->type != kVstMidiType) continue; // sysex skipped (v1)
        if (count >= b->midiOutCapacity) break;
        const VstMidiEvent* me = reinterpret_cast<const VstMidiEvent*>(e);
        MidiMsg& m = b->midiOut[count++];
        m.sampleOffset =
            me->deltaFrames > 0 ? static_cast<uint32_t>(me->deltaFrames) : 0;
        if (m.sampleOffset >= b->frames)
          m.sampleOffset = b->frames ? b->frames - 1 : 0;
        m.data[0] = static_cast<uint8_t>(me->midiData[0]);
        m.data[1] = static_cast<uint8_t>(me->midiData[1]);
        m.data[2] = static_cast<uint8_t>(me->midiData[2]);
        m.data[3] = 0;
        m.len = midiMsgLen(m.data[0]);
      }
      *b->numMidiOut = count;
      return 1;
    }

    case audioMasterIoChanged: { // latency changed → re-read initialDelay
      if (cb_.latencyChanged && effect_)
        cb_.latencyChanged(effect_->initialDelay > 0
                               ? static_cast<uint32_t>(effect_->initialDelay)
                               : 0);
      return 1;
    }

    case audioMasterSizeWindow: { // index = width, value = height
      pendW_.store(static_cast<int32_t>(index), std::memory_order_release);
      pendH_.store(static_cast<int32_t>(value), std::memory_order_release);
      resizePending_.store(true, std::memory_order_release);
      return 1;
    }

    case audioMasterGetSampleRate:
      return static_cast<VstIntPtr>(sampleRate_);
    case audioMasterGetBlockSize:
      return static_cast<VstIntPtr>(maxBlock_);
    case audioMasterGetInputLatency:
    case audioMasterGetOutputLatency:
      return 0;
    case audioMasterGetCurrentProcessLevel:
      return inProcess_.load(std::memory_order_acquire)
                 ? kVstProcessLevelRealtime
                 : kVstProcessLevelUser;
    case audioMasterGetAutomationState:
      return kVstAutomationReadWrite;

    case audioMasterGetVendorString:
      copyToBuf(ptr, "MyDAW", kVstMaxVendorStrLen);
      return 1;
    case audioMasterGetProductString:
      copyToBuf(ptr, "MyDAW", kVstMaxProductStrLen);
      return 1;
    case audioMasterGetVendorVersion:
      return 1000;
    case audioMasterVendorSpecific:
      return 0;

    case audioMasterCanDo: {
      const char* s = static_cast<const char*>(ptr);
      if (!s) return 0;
      static const char* kYes[] = {
          "sendVstEvents",       "sendVstMidiEvent",
          "sendVstTimeInfo",     "receiveVstEvents",
          "receiveVstMidiEvent", "receiveVstTimeInfo",
          "sizeWindow",          "startStopProcess",
          "supplyIdle",          "acceptIOChanges",
          "sendVstMidiEventFlagIsRealtime"};
      for (const char* y : kYes)
        if (std::strcmp(s, y) == 0) return 1;
      if (std::strcmp(s, "shellCategory") == 0) return 1;
      return 0;
    }

    case audioMasterGetLanguage:
      return kVstLangEnglish;
    case audioMasterGetDirectory:
      return reinterpret_cast<VstIntPtr>(ansiDir_.c_str());
    case audioMasterUpdateDisplay:
      return 1;
    case audioMasterBeginEdit:
    case audioMasterEndEdit:
      return 1;
    case audioMasterOpenFileSelector:
    case audioMasterCloseFileSelector:
      return 0;

    default:
      return 0;
  }
}

VstIntPtr Vst2Host::dispatch(VstInt32 opcode, VstInt32 index, VstIntPtr value,
                             void* ptr, float opt) const noexcept {
  if (!effect_ || !effect_->dispatcher) return 0;
  return effect_->dispatcher(effect_, opcode, index, value, ptr, opt);
}

std::string Vst2Host::effString(VstInt32 opcode, VstInt32 index) {
  char buf[512] = {0};
  dispatch(opcode, index, 0, buf);
  buf[sizeof(buf) - 1] = 0;
  trimInPlace(buf);
  return buf;
}

} // namespace mydaw
