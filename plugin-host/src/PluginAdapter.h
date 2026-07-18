#pragma once
//
// plugin-host/src/PluginAdapter.h
//
// Format-neutral plugin interface implemented by Vst2Host (vestige ABI) and
// Vst3Host (Steinberg hosting SDK). main.cpp / ShmServer.cpp drive a single
// adapter instance per host process; Scan.cpp uses the per-format scan
// entries. Plain structs only — no JSON types in this header (SPEC F2 rule);
// JSON (de)serialization for the control pipe (§8.2) lives in the callers.
//
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include "../../shared/ipc/PluginIpc.h" // MidiMsg, ParamChange, ShmHeader, flags

// Avoid dragging <windows.h> into every TU: forward-declare HWND exactly the
// way <windef.h> defines it under STRICT (the SDK default). Including
// windows.h before or after this header is harmless.
#if !defined(_WINDEF_) && !defined(MYDAW_HWND_FWD)
#define MYDAW_HWND_FWD
struct HWND__;
typedef struct HWND__* HWND;
#endif

namespace mydaw {

// Result of PluginAdapter::init — feeds the §8.2 `init` pipe reply
// {ok, info:{name, numParams, latency, isInstrument, ins, outs, hasEditor}}
// plus vendor.
struct InitInfo {
  std::string name;
  std::string vendor;
  uint32_t numParams = 0;
  uint32_t latencySamples = 0;
  bool isInstrument = false;
  uint32_t numIns = 0;  // channel count the plugin actually processes
  uint32_t numOuts = 0;
  // Plugin provides a native editor (vst2 effFlagsHasEditor; vst3 probed via
  // createView). openEditor may still fail at attach time — this is the
  // capability flag the UI uses to offer the "Native UI" button.
  bool hasEditor = false;
};

// One parameter, values normalized 0..1 (SPEC §5.6 plugin/getParams).
struct ParamInfo {
  uint32_t id = 0;
  std::string name;
  std::string label; // units, e.g. "dB"
  double defaultValue = 0.0;
  int32_t steps = 0; // 0 = continuous, N>1 = stepped with N positions
  double value = 0.0;
  std::string valueText;
};

struct PresetInfo {
  int32_t id = 0;
  std::string name;
};

struct EditorSize {
  int32_t width = 0;
  int32_t height = 0;
};

// One audio block, viewed through the PluginIpc shm regions (§8.1). The
// ShmServer fills this from the mapped view each time the "_req" event
// fires; all pointers alias shared memory and are valid only for the call.
struct ProcessBlock {
  const float* const* in = nullptr;  // [numIns][frames]
  float* const* out = nullptr;       // [numOuts][frames]
  uint32_t numIns = 0;
  uint32_t numOuts = 0;
  uint32_t frames = 0;               // ≤ kMaxBlock

  // Transport (mirrors ShmHeader per-block fields).
  double sampleRate = 0.0;
  double tempo = 120.0;
  double ppqPos = 0.0;
  uint32_t flags = 0;                // kShmFlagPlaying|Recording|Loop

  // Engine → plugin.
  const MidiMsg* midiIn = nullptr;
  uint32_t numMidiIn = 0;
  const ParamChange* paramIn = nullptr;
  uint32_t numParamIn = 0;

  // Plugin → engine (host writes counts through the pointers, which alias
  // ShmHeader::numMidiOut / numParamOut / latencySamples).
  MidiMsg* midiOut = nullptr;
  uint32_t midiOutCapacity = 0;      // kMaxMidi
  uint32_t* numMidiOut = nullptr;
  ParamChange* paramOut = nullptr;
  uint32_t paramOutCapacity = 0;     // kMaxParamChanges
  uint32_t* numParamOut = nullptr;
  uint32_t* latencySamples = nullptr;
};

// Abstract plugin host. Lifecycle: load → init → (resume) → process... →
// suspend ⇄ resume → closeEditor → destructor unloads. All methods are
// called from the host process's main/audio loops, never concurrently;
// process() is the host's hot path and must not allocate, lock, or throw.
class PluginAdapter {
public:
  virtual ~PluginAdapter() = default;

  // Load the plugin binary. uid: vst2 = decimal uniqueID string (may be
  // empty — first/only plugin in the DLL), vst3 = class GUID string
  // selecting the class inside the module (SPEC §5.6).
  virtual bool load(const std::wstring& path, const std::string& uid) = 0;

  // Initialize processing. `shm` (may be null in offline/tool use) carries
  // the engine-decided channel counts; sampleRate/maxBlock come from the
  // §8.2 `init` pipe message and take precedence over shm header copies.
  virtual bool init(double sampleRate, uint32_t maxBlock,
                    const ShmHeader* shm, InitInfo& outInfo) = 0;

  // Process one block (RT path of the host process).
  virtual void process(const ProcessBlock& block) noexcept = 0;

  // Parameters (normalized 0..1).
  virtual std::vector<ParamInfo> getParams() = 0;
  virtual void setParam(uint32_t id, double value) = 0;
  virtual std::string getParamText(uint32_t id) = 0;

  // Opaque state chunk (vst2: effGetChunk/effSetChunk or param array
  // fallback; vst3: component+controller streams, two length-prefixed
  // blobs — SPEC §8.4). Engine persists it as plugin-states/<id>.bin.
  virtual bool getState(std::vector<uint8_t>& out) = 0;
  virtual bool setState(std::span<const uint8_t> data) = 0;

  // Presets (vst2: programs; vst3: unit program list if exposed).
  virtual std::vector<PresetInfo> getPresets() = 0;
  virtual bool loadPreset(int32_t id) = 0;

  // Native editor, attached to a host-owned top-level window (EditorWindow).
  virtual bool openEditor(HWND parent, EditorSize& outSize) = 0;
  virtual void closeEditor() = 0;
  virtual void editorIdle() = 0; // pump ~50 Hz while the editor is open
  // True once if the plugin requested a new editor size (vst2
  // audioMasterSizeWindow / vst3 IPlugFrame::resizeView) since last checked;
  // EditorWindow polls this from its idle timer.
  virtual bool resizePending(EditorSize& outNewSize) = 0;

  // Stop/start processing without unloading (vst2 effMainsChanged, vst3
  // setActive/setProcessing) — §8.2 suspend/resume pipe messages.
  virtual void suspend() = 0;
  virtual void resume() = 0;

  // Human-readable reason for the most recent failed call.
  const std::string& lastError() const { return lastError_; }

protected:
  std::string lastError_;
};

// ---------------------------------------------------------------------------
// Scanning (SPEC §8.3) — `mydaw-host{64,32}.exe --scan <path>`.
// One record per plugin found in the file; mirrors PluginInfo (§5.6) minus
// engine-side fields (blacklist). Scan.cpp calls the per-format entries
// below and prints {ok:true, plugins:[...]} as one JSON line.
// ---------------------------------------------------------------------------
struct ScannedPlugin {
  std::string uid;      // vst2: decimal uniqueID; vst3: class GUID string
  std::string format;   // "vst2" | "vst3"
  std::string path;     // UTF-8 absolute path of the scanned file
  uint32_t bitness = static_cast<uint32_t>(sizeof(void*) * 8); // this host's
  std::string name;
  std::string vendor;
  std::string category;
  bool isInstrument = false;
  uint32_t numInputs = 0;
  uint32_t numOutputs = 0;
};

// Implemented in Vst2Host.cpp: load DLL, resolve VSTPluginMain/main,
// instantiate, query metadata, unload. For VST2 shell DLLs this enumerates
// every advertised child uid/name and returns one record per child.
// Returns false + `error` if the file is not a usable VST2 plugin.
bool scanVst2File(const std::wstring& path, std::vector<ScannedPlugin>& out,
                  std::string& error);

// Implemented in Vst3Host.cpp: enumerate every class in the module factory.
// When the host is built with MYDAW_NO_VST3 this must still link — the
// implementation returns false with error = "built without VST3 support".
bool scanVst3File(const std::wstring& path, std::vector<ScannedPlugin>& out,
                  std::string& error);

// Factories used by main.cpp --serve (format from the --format argument).
// Implemented in Vst2Host.cpp / Vst3Host.cpp. createVst3Adapter returns
// nullptr when built with MYDAW_NO_VST3 (caller reports the reason on the
// control pipe).
std::unique_ptr<PluginAdapter> createVst2Adapter();
std::unique_ptr<PluginAdapter> createVst3Adapter();

} // namespace mydaw
