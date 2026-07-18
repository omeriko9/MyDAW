#pragma once
//
// plugin-host/src/Vst3Host.h
//
// VST3 hosting inside the plugin host process (SPEC §8.4). Implements the
// format-neutral PluginAdapter (PluginAdapter.h) on top of the Steinberg
// hosting SDK (vst3sdk v3.7.12, target sdk_hosting):
//
//   Module (module_win32) -> PlugProvider(classInfo) -> IComponent +
//   IEditController (connected via ConnectionProxy; single-component plugins
//   handled by PlugProvider's queryInterface fallback), HostApplication as
//   the plugin context, kRealtime/kSample32 processing over the PluginIpc
//   shared-memory block, native editor via IPlugView attached to the
//   H1-owned EditorWindow HWND.
//
// Threading (one plugin per host process):
//   * load/init/getParams/setParam/getState/setState/presets/suspend/resume
//     run on the host control thread (pipe servicing),
//   * process() runs on the shm audio thread,
//   * IComponentHandler::performEdit / IPlugFrame::resizeView arrive on the
//     editor/UI thread.
//   Cross-thread traffic uses the SDK's ParameterChangeTransfer rings (one
//   ring per producer) and std::atomic flags; process() does not allocate or
//   lock (ParameterChanges queue growth is bounded by pre-sizing; see .cpp).
//
// When the build has no VST3 SDK (MYDAW_NO_VST3, and/or the Win32 fallback
// MYDAW_HOST32_VST2_ONLY) this header intentionally defines nothing — the
// factory + scan symbols in Vst3Host.cpp become stubs per the PluginAdapter.h
// contract (scanVst3File -> false with a clear reason, createVst3Adapter ->
// nullptr; caller reports the reason on the control pipe).
//
#include "PluginAdapter.h"
#include "Vst3Utils.h" // defines MYDAW_VST3_DISABLED for the stub builds

#if !defined(MYDAW_VST3_DISABLED)

#include <array>
#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

// vst3sdk — include root is the SDK source dir (see plugin-host/CMakeLists).
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"

namespace mydaw {

class Vst3ComponentHandler; // IComponentHandler(+2) impl, Vst3Host.cpp
class Vst3PlugFrame;        // IPlugFrame impl, Vst3Host.cpp

class Vst3Host final : public PluginAdapter {
public:
    Vst3Host();
    ~Vst3Host() override;

    Vst3Host(const Vst3Host&) = delete;
    Vst3Host& operator=(const Vst3Host&) = delete;

    // PluginAdapter ----------------------------------------------------------
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
    void editorIdle() override; // no-op: VST3 needs no idle pump
    bool resizePending(EditorSize& outNewSize) override;

    void suspend() override;
    void resume() override;

    // Internal — called by Vst3ComponentHandler / Vst3PlugFrame --------------
    void onEditorParamEdit(Steinberg::Vst::ParamID id,
                           Steinberg::Vst::ParamValue value) noexcept;
    void onRestartComponent(Steinberg::int32 flags) noexcept;
    void onViewResize(int32_t width, int32_t height) noexcept;

private:
    bool activate();
    void deactivate();
    void applyRestartFlags() noexcept;      // process thread
    void rebuildMidiCcMap();
    void discoverPrograms();
    void setupProcessContext(const ProcessBlock& block, uint32_t frames) noexcept;
    void gatherInputChanges(const ProcessBlock& block, uint32_t frames) noexcept;
    void bindAudioBuffers(const ProcessBlock& block, uint32_t inCovered,
                          uint32_t outCovered) noexcept;
    uint32_t collectParamOut(const ProcessBlock& block) noexcept;
    void publishBlockOutputs(const ProcessBlock& block,
                             uint32_t numParamOut) noexcept;
    static void zeroOutputs(const ProcessBlock& block) noexcept;

    // Plugin objects ---------------------------------------------------------
    VST3::Hosting::Module::Ptr module_;
    Steinberg::IPtr<Steinberg::Vst::HostApplication> hostApp_;
    Steinberg::IPtr<Steinberg::Vst::PlugProvider> provider_;
    Steinberg::IPtr<Steinberg::Vst::IComponent> component_;
    Steinberg::IPtr<Steinberg::Vst::IEditController> controller_;
    Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
    Steinberg::IPtr<Steinberg::Vst::IMidiMapping> midiMapping_;
    Steinberg::IPtr<Steinberg::Vst::IUnitInfo> unitInfo_;
    Steinberg::IPtr<Vst3ComponentHandler> handler_;
    VST3::Hosting::ClassInfo classInfo_;

    // Editor -----------------------------------------------------------------
    Steinberg::IPtr<Steinberg::IPlugView> view_;
    Steinberg::IPtr<Vst3PlugFrame> plugFrame_;
    std::atomic<bool> resizePending_{false};
    EditorSize pendingSize_{};

    // Processing -------------------------------------------------------------
    Steinberg::Vst::HostProcessData processData_;
    Steinberg::Vst::ProcessContext processContext_{};
    Steinberg::Vst::ParameterChanges inParamChanges_;
    Steinberg::Vst::ParameterChanges outParamChanges_;
    Steinberg::Vst::EventList inEvents_;

    // Cross-thread rings (single producer each, consumer = process thread).
    Steinberg::Vst::ParameterChangeTransfer engineToProcessor_; // pipe thread
    Steinberg::Vst::ParameterChangeTransfer editorToProcessor_; // UI thread
    Steinberg::Vst::ParameterChangeTransfer editorToEngine_;    // UI thread

    // Engine-facing MIDI CC -> ParamID map (IMidiMapping, cached; rebuilt on
    // kMidiCCAssignmentChanged). [channel][ctrl], kNoParamId = unmapped.
    static constexpr int32_t kNumMidiCtrls = 130; // 0..127, kAfterTouch, kPitchBend
    std::array<std::array<Steinberg::Vst::ParamID, kNumMidiCtrls>, 16> ccParamMap_{};

    // Scratch audio for buses/channels beyond what the shm block carries.
    std::vector<float> scratchIn_;  // stays zeroed (silent aux/extra inputs)
    std::vector<float> scratchOut_; // discarded aux/extra outputs

    double sampleRate_ = 0.0;
    uint32_t maxBlock_ = 0;
    Steinberg::int32 mainInChannels_ = 0;
    Steinberg::int32 mainOutChannels_ = 0;
    bool prepared_ = false;
    bool active_ = false;
    bool processing_ = false;
    bool isInstrument_ = false;

    std::atomic<uint32_t> latencySamples_{0};
    std::atomic<Steinberg::int32> restartFlags_{0};

    // Presets (IUnitInfo program list + program-change parameter).
    bool hasProgramParam_ = false;
    Steinberg::Vst::ParamID programParamId_ = Steinberg::Vst::kNoParamId;
    Steinberg::int32 programStepCount_ = 0;
    Steinberg::Vst::ProgramListID programListId_ = Steinberg::Vst::kNoProgramListId;
    Steinberg::int32 programCount_ = 0;
};

} // namespace mydaw

#endif // !MYDAW_VST3_DISABLED
