#pragma once
//
// plugin-host/src/Vst2Host.h
//
// VST2 PluginAdapter implementation over the clean-room vestige ABI
// (shared/vst2/vestige.h, SPEC §8.4):
//   * load: LoadLibraryW → VSTPluginMain/main entry → AEffect, instance
//     routed through AEffect::resvd1 (pre-instance audioMaster callbacks —
//     audioMasterVersion etc. — answered statically/via the loading
//     instance),
//   * processReplacing float32 only (effFlagsCanReplacing required;
//     otherwise init fails with a clear error),
//   * VstTimeInfo built per block from the ProcessBlock transport fields
//     (ppqPos/tempo/flags),
//   * MIDI via effProcessEvents from a fixed pre-allocated arena (no
//     allocation on the process path),
//   * state: effGetChunk/effSetChunk when effFlagsProgramChunks, else a
//     param-array fallback blob {magic,version,count,float[]},
//   * presets = programs (effGetProgramNameIndexed / effSetProgram),
//   * editor: effEditGetRect/Open/Close/Idle; audioMasterSizeWindow →
//     resizePending(),
//   * audioMasterAutomate / audioMasterIoChanged surface through
//     HostCallbacks (main.cpp routes them into the ParamEditBuffer /
//     latencyChanged pipe push).
//
// SEH note: this class uses C++ objects, so no __try/__except lives here.
// The crash guards are in ShmServer.cpp (process path) and Scan.cpp (scan).
//
#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "../../shared/vst2/vestige.h"
#include "PluginAdapter.h"

namespace mydaw {

class Vst2Host final : public PluginAdapter {
public:
  // Magic/version of the param-array state fallback blob (plugins without
  // effFlagsProgramChunks): uint32 magic, uint32 version, uint32 count,
  // float values[count] — all little-endian.
  static constexpr uint32_t kParamStateMagic = 0x3250444Du; // "MDP2"
  static constexpr uint32_t kParamStateVersion = 1;

  struct HostCallbacks {
    // From audioMasterAutomate. May fire on the plugin's UI thread OR the
    // audio thread (inside processReplacing) — targets must be cheap,
    // non-blocking, allocation-free. valueText is "" when the edit happened
    // on the audio path (no re-entrant dispatcher call there).
    std::function<void(uint32_t id, double value, const char* valueText)>
        paramEdited;
    // From audioMasterIoChanged (AEffect::initialDelay re-read).
    std::function<void(uint32_t samples)> latencyChanged;
  };

  Vst2Host();
  ~Vst2Host() override;

  void setHostCallbacks(HostCallbacks cb) { cb_ = std::move(cb); }

  // PluginAdapter ------------------------------------------------------
  bool load(const std::wstring& path, const std::string& uid) override;
  bool init(double sampleRate, uint32_t maxBlock, const ShmHeader* shm,
            InitInfo& outInfo) override;
  void process(const ProcessBlock& block) noexcept override;
  std::vector<ParamInfo> getParams() override;
  void setParam(uint32_t id, double value) override;
  std::string getParamText(uint32_t id) override;
  bool getState(std::vector<uint8_t>& out) override;
  bool setState(std::span<const uint8_t> data) override;
  std::vector<PresetInfo> getPresets() override;
  bool loadPreset(int32_t id) override;
  bool openEditor(HWND parent, EditorSize& outSize) override;
  void closeEditor() override;
  void editorIdle() override;
  bool resizePending(EditorSize& outNewSize) override;
  void suspend() override;
  void resume() override;

  // Scan support (scanVst2File in Vst2Host.cpp): metadata after load(),
  // before init().
  void fillScanInfo(ScannedPlugin& out) const;
  bool isShell() const { return isShell_; }
  bool enumerateShellPlugins(std::vector<std::pair<VstInt32, std::string>>& out);

private:
  static VstIntPtr VESTIGE_CALLBACK audioMasterThunk(AEffect* effect,
                                                     VstInt32 opcode,
                                                     VstInt32 index,
                                                     VstIntPtr value,
                                                     void* ptr, float opt);
  VstIntPtr onAudioMaster(VstInt32 opcode, VstInt32 index, VstIntPtr value,
                          void* ptr, float opt) noexcept;
  VstIntPtr dispatch(VstInt32 opcode, VstInt32 index = 0, VstIntPtr value = 0,
                     void* ptr = nullptr, float opt = 0.0f) const noexcept;
  std::string effString(VstInt32 opcode, VstInt32 index = 0);
  // display + label combined ("−6.0 dB"); raw variant is allocation-free
  // (used from audioMaster callbacks).
  void paramTextRaw(VstInt32 index, char* out, uint32_t cap) noexcept;
  void fillTimeInfo(const ProcessBlock& block) noexcept;
  void unload();

  void* module_ = nullptr; // HMODULE
  AEffect* effect_ = nullptr;
  std::string moduleStemUtf8_;  // filename without extension (name fallback)
  std::string ansiDir_;         // plugin directory, ANSI (audioMasterGetDirectory)
  double sampleRate_ = 44100.0;
  uint32_t maxBlock_ = kMaxBlock;
  bool resumed_ = false;
  bool editorOpen_ = false;
  bool needIdle_ = false; // audioMasterIdle requested effIdle pumping
  bool isShell_ = false;
  bool shellUidRequested_ = false;
  VstInt32 requestedShellUid_ = 0;
  std::vector<float> defaults_; // param values captured right after effOpen

  // Process-path arenas (fixed, allocation-free).
  struct EventsArena { // mirrors VstEvents with a full-capacity pointer array
    VstInt32 numEvents = 0;
    VstIntPtr reserved = 0;
    VstEvent* events[kMaxMidi] = {};
  };
  EventsArena eventsArena_;
  VstMidiEvent midiArena_[kMaxMidi] = {};
  VstTimeInfo timeInfo_ = {};
  uint32_t lastShmFlags_ = 0;

  // Channel mapping: plugin may have more/fewer channels than the shm block.
  std::vector<float*> procIn_;
  std::vector<float*> procOut_;
  std::vector<float> zeroBuf_;                // shared silent input
  std::vector<std::vector<float>> dumpBufs_;  // per-extra-output sinks

  // Valid only while inside process() — used by audioMasterProcessEvents
  // (plugin MIDI out → shm midiOut region).
  const ProcessBlock* curBlock_ = nullptr;
  std::atomic<bool> inProcess_{false};

  // audioMasterSizeWindow → EditorWindow polls resizePending().
  std::atomic<bool> resizePending_{false};
  std::atomic<int32_t> pendW_{0};
  std::atomic<int32_t> pendH_{0};

  HostCallbacks cb_;
};

} // namespace mydaw
