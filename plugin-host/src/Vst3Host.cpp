//
// plugin-host/src/Vst3Host.cpp
//
// VST3 hosting (SPEC §8.4) — see Vst3Host.h for the architecture overview.
// Also implements scanVst3File + createVst3Adapter (PluginAdapter.h), which
// must link in every build: the MYDAW_NO_VST3 / MYDAW_HOST32_VST2_ONLY stub
// branch is at the top, the real implementation below it.
//
#include "Vst3Host.h" // pulls PluginAdapter.h + Vst3Utils.h (sets MYDAW_VST3_DISABLED)

#if defined(MYDAW_VST3_DISABLED)
// ===========================================================================
// Stub build (no VST3 SDK). The symbols still exist (SPEC §3 / §10):
// scanVst3File reports a clear reason, createVst3Adapter returns nullptr and
// the caller reports the reason on the control pipe (PluginAdapter.h).
// ===========================================================================
#include <memory>

namespace mydaw {

bool scanVst3File(const std::wstring& /*path*/, std::vector<ScannedPlugin>& /*out*/,
                  std::string& error) {
    error = "built without VST3 support";
    return false;
}

std::unique_ptr<PluginAdapter> createVst3Adapter() {
    return nullptr;
}

} // namespace mydaw

#else // ======================================================================
// Real implementation (vst3sdk v3.7.12, sdk_hosting).
// ===========================================================================

#include <algorithm>
#include <cmath>
#include <cstring>
#include <excpt.h> // SEH guard for the editor-capability probe (init)
#include <iostream>
#include <memory>

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/common/memorystream.h"

namespace mydaw {

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {
inline double clamp01(double v) {
    return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v);
}

// Native-editor capability probe (§8.2 init reply `hasEditor`): create the
// editor view WITHOUT attaching a platform window, check HWND embedding
// support, release it. Some plugins are fragile on this path, so the frame
// holds only pointers — no C++ objects needing unwinding — and an SEH guard
// (which also swallows MSVC C++ exceptions, code 0xE06D7363) turns any fault
// into "no editor" (false). Compiles under /EHsc (C2712 avoided).
bool probeEditorView(IEditController* controller) noexcept {
    __try {
        IPlugView* view = controller->createView(ViewType::kEditor);
        if (!view)
            return false;
        const bool ok =
            view->isPlatformTypeSupported(kPlatformTypeHWND) == kResultTrue;
        view->release();
        return ok;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}
} // namespace

// ===========================================================================
// Vst3ComponentHandler — IComponentHandler(+2) the controller talks to.
// performEdit arrives on the editor/UI thread; restartComponent may arrive on
// any plugin thread. Both only touch atomics / the SDK transfer rings.
// ===========================================================================
class Vst3ComponentHandler final : public IComponentHandler, public IComponentHandler2 {
public:
    explicit Vst3ComponentHandler(Vst3Host* host) : host_(host) {}
    virtual ~Vst3ComponentHandler() = default;

    // Vst3Host is being destroyed; the plugin may still hold a ref briefly.
    void detach() { host_.store(nullptr, std::memory_order_release); }

    // --- FUnknown ---
    tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
        QUERY_INTERFACE(_iid, obj, FUnknown::iid, IComponentHandler)
        QUERY_INTERFACE(_iid, obj, IComponentHandler::iid, IComponentHandler)
        QUERY_INTERFACE(_iid, obj, IComponentHandler2::iid, IComponentHandler2)
        *obj = nullptr;
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override {
        return static_cast<uint32>(++refCount_);
    }
    uint32 PLUGIN_API release() override {
        const int32_t r = --refCount_;
        if (r == 0) {
            delete this;
            return 0;
        }
        return static_cast<uint32>(r > 0 ? r : 0);
    }

    // --- IComponentHandler ---
    tresult PLUGIN_API beginEdit(ParamID /*id*/) override { return kResultOk; }
    tresult PLUGIN_API performEdit(ParamID id, ParamValue valueNormalized) override {
        if (auto* h = host_.load(std::memory_order_acquire))
            h->onEditorParamEdit(id, valueNormalized);
        return kResultOk;
    }
    tresult PLUGIN_API endEdit(ParamID /*id*/) override { return kResultOk; }
    tresult PLUGIN_API restartComponent(int32 flags) override {
        if (auto* h = host_.load(std::memory_order_acquire)) {
            h->onRestartComponent(flags);
            return kResultOk;
        }
        return kResultFalse;
    }

    // --- IComponentHandler2 ---
    tresult PLUGIN_API setDirty(TBool /*state*/) override { return kResultOk; }
    tresult PLUGIN_API requestOpenEditor(FIDString /*name*/) override {
        return kNotImplemented; // engine/UI decides when editors open
    }
    tresult PLUGIN_API startGroupEdit() override { return kResultOk; }
    tresult PLUGIN_API finishGroupEdit() override { return kResultOk; }

private:
    std::atomic<Vst3Host*> host_;
    std::atomic<int32_t> refCount_{1};
};

// ===========================================================================
// Vst3PlugFrame — IPlugFrame: plugin-initiated editor resizes.
// ===========================================================================
class Vst3PlugFrame final : public IPlugFrame {
public:
    explicit Vst3PlugFrame(Vst3Host* host) : host_(host) {}
    virtual ~Vst3PlugFrame() = default;

    void detach() { host_.store(nullptr, std::memory_order_release); }

    // --- FUnknown ---
    tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
        QUERY_INTERFACE(_iid, obj, FUnknown::iid, IPlugFrame)
        QUERY_INTERFACE(_iid, obj, IPlugFrame::iid, IPlugFrame)
        *obj = nullptr;
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override {
        return static_cast<uint32>(++refCount_);
    }
    uint32 PLUGIN_API release() override {
        const int32_t r = --refCount_;
        if (r == 0) {
            delete this;
            return 0;
        }
        return static_cast<uint32>(r > 0 ? r : 0);
    }

    // --- IPlugFrame ---
    tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* newSize) override {
        if (!view || !newSize)
            return kInvalidArgument;
        if (auto* h = host_.load(std::memory_order_acquire))
            h->onViewResize(newSize->getWidth(), newSize->getHeight());
        // The outer window is resized asynchronously by EditorWindow (it polls
        // PluginAdapter::resizePending); confirm the new size to the view now.
        view->onSize(newSize);
        return kResultTrue;
    }

private:
    std::atomic<Vst3Host*> host_;
    std::atomic<int32_t> refCount_{1};
};

// ===========================================================================
// Vst3Host
// ===========================================================================
Vst3Host::Vst3Host() {
    engineToProcessor_.setMaxParameters(256);
    editorToProcessor_.setMaxParameters(512);
    editorToEngine_.setMaxParameters(512);
    for (auto& row : ccParamMap_)
        row.fill(kNoParamId);
}

Vst3Host::~Vst3Host() {
    closeEditor();
    deactivate();
    processData_.unprepare();
    if (controller_)
        controller_->setComponentHandler(nullptr);
    if (handler_)
        handler_->detach();
    if (plugFrame_)
        plugFrame_->detach();
    view_ = nullptr;
    plugFrame_ = nullptr;
    handler_ = nullptr;
    midiMapping_ = nullptr;
    unitInfo_ = nullptr;
    processor_ = nullptr;
    controller_ = nullptr;
    component_ = nullptr;
    provider_ = nullptr; // PlugProvider dtor terminates component + controller
    PluginContextFactory::instance().setPluginContext(nullptr);
    hostApp_ = nullptr;
    module_ = nullptr; // unloads the .vst3 module
}

// ---------------------------------------------------------------------------
bool Vst3Host::load(const std::wstring& path, const std::string& uid) {
    // Keep stdout pristine (scan-mode JSON channel); SDK diagnostics -> stderr.
    PlugProvider::setErrorStream(&std::cerr);

    const std::string utf8Path = vst3WideToUtf8(path);
    std::string err;
    module_ = VST3::Hosting::Module::create(utf8Path, err);
    if (!module_) {
        lastError_ = "failed to load VST3 module '" + utf8Path + "'" +
                     (err.empty() ? "" : (": " + err));
        return false;
    }

    hostApp_ = owned(new HostApplication());
    PluginContextFactory::instance().setPluginContext(hostApp_.get());
    const auto& factory = module_->getFactory();
    factory.setHostContext(hostApp_.get());

    const std::string wantUid = vst3NormalizeUid(uid);
    const auto infos = factory.classInfos();
    const VST3::Hosting::ClassInfo* found = nullptr;
    for (const auto& ci : infos) {
        if (ci.category() != kVstAudioEffectClass)
            continue;
        if (wantUid.empty() || vst3NormalizeUid(ci.ID().toString()) == wantUid) {
            found = &ci;
            break;
        }
    }
    if (!found) {
        lastError_ = wantUid.empty()
                         ? "module contains no VST3 audio effect class"
                         : ("class uid not found in module: " + uid);
        module_ = nullptr;
        return false;
    }
    classInfo_ = *found;
    isInstrument_ = vst3IsInstrumentCategory(classInfo_.subCategoriesString());

    provider_ = owned(new PlugProvider(factory, classInfo_, true));
    if (!provider_->initialize()) {
        lastError_ = "plugin failed to initialize (component/controller creation)";
        provider_ = nullptr;
        return false;
    }
    component_ = provider_->getComponentPtr();
    controller_ = provider_->getControllerPtr(); // may be null (no controller)
    if (!component_) {
        lastError_ = "plugin created no component";
        return false;
    }
    processor_ = FUnknownPtr<IAudioProcessor>(component_.get());
    if (!processor_) {
        lastError_ = "plugin component has no IAudioProcessor";
        return false;
    }
    if (controller_) {
        handler_ = owned(new Vst3ComponentHandler(this));
        controller_->setComponentHandler(handler_);
        midiMapping_ = FUnknownPtr<IMidiMapping>(controller_.get());
    }
    return true;
}

// ---------------------------------------------------------------------------
bool Vst3Host::init(double sampleRate, uint32_t maxBlock, const ShmHeader* shm,
                    InitInfo& outInfo) {
    if (!component_ || !processor_) {
        lastError_ = "init called before a successful load";
        return false;
    }
    deactivate(); // tolerate re-init

    sampleRate_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    maxBlock_ = (maxBlock > 0 && maxBlock <= kMaxBlock) ? maxBlock : kMaxBlock;

    const uint32_t wantIn = shm ? shm->numIn : 2u;
    uint32_t wantOut = shm ? shm->numOut : 2u;
    if (wantOut == 0)
        wantOut = 2u;

    if (processor_->canProcessSampleSize(kSample32) != kResultOk) {
        lastError_ = "plugin does not support 32-bit float processing";
        return false;
    }

    const int32 numInBuses = component_->getBusCount(kAudio, kInput);
    const int32 numOutBuses = component_->getBusCount(kAudio, kOutput);

    // Negotiate the MAIN bus arrangements toward the engine-decided channel
    // counts; aux buses keep whatever the plugin currently reports.
    std::vector<SpeakerArrangement> inArr(static_cast<size_t>(std::max(numInBuses, 0)));
    std::vector<SpeakerArrangement> outArr(static_cast<size_t>(std::max(numOutBuses, 0)));
    for (int32 i = 0; i < numInBuses; ++i) {
        inArr[static_cast<size_t>(i)] = SpeakerArr::kStereo;
        processor_->getBusArrangement(kInput, i, inArr[static_cast<size_t>(i)]);
    }
    for (int32 i = 0; i < numOutBuses; ++i) {
        outArr[static_cast<size_t>(i)] = SpeakerArr::kStereo;
        processor_->getBusArrangement(kOutput, i, outArr[static_cast<size_t>(i)]);
    }
    if (numInBuses > 0 && wantIn > 0)
        inArr[0] = vst3ArrangementForChannels(static_cast<int32_t>(wantIn));
    if (numOutBuses > 0)
        outArr[0] = vst3ArrangementForChannels(static_cast<int32_t>(wantOut));
    // Result is advisory: kResultFalse means the plugin adapted to its own
    // layout — we re-query the actual counts below either way.
    processor_->setBusArrangements(inArr.empty() ? nullptr : inArr.data(), numInBuses,
                                   outArr.empty() ? nullptr : outArr.data(), numOutBuses);

    BusInfo bi{};
    mainInChannels_ = 0;
    mainOutChannels_ = 0;
    if (numInBuses > 0 && component_->getBusInfo(kAudio, kInput, 0, bi) == kResultTrue)
        mainInChannels_ = bi.channelCount;
    if (numOutBuses > 0 && component_->getBusInfo(kAudio, kOutput, 0, bi) == kResultTrue)
        mainOutChannels_ = bi.channelCount;

    ProcessSetup setup{kRealtime, kSample32, static_cast<int32>(maxBlock_), sampleRate_};
    if (processor_->setupProcessing(setup) != kResultOk) {
        lastError_ = "plugin rejected processing setup (kRealtime/kSample32)";
        return false;
    }

    // Activate main audio buses + the first event input bus (SPEC §8.4).
    if (numInBuses > 0)
        component_->activateBus(kAudio, kInput, 0, true);
    if (numOutBuses > 0)
        component_->activateBus(kAudio, kOutput, 0, true);
    if (component_->getBusCount(kEvent, kInput) > 0)
        component_->activateBus(kEvent, kInput, 0, true);
    // NOTE(spec): output event buses stay inactive — output events ignored v1.

    // Bus buffer skeletons only (bufferSamples = 0): channel pointers are
    // rebound to the shm regions / scratch each process() call.
    prepared_ = processData_.prepare(*component_, 0, kSample32);
    if (!prepared_) {
        lastError_ = "failed to prepare process buffers";
        return false;
    }
    processData_.processMode = kRealtime;
    processData_.inputParameterChanges = &inParamChanges_;
    processData_.outputParameterChanges = &outParamChanges_;
    processData_.inputEvents = &inEvents_;
    processData_.outputEvents = nullptr;
    processData_.processContext = &processContext_;

    inParamChanges_.setMaxParameters(256);
    outParamChanges_.setMaxParameters(256);
    inEvents_.setMaxSize(static_cast<int32>(kMaxMidi));
    scratchIn_.assign(maxBlock_, 0.0f);
    scratchOut_.assign(maxBlock_, 0.0f);

    if (!activate()) {
        lastError_ = "component activation failed";
        return false;
    }
    rebuildMidiCcMap();
    discoverPrograms();

    outInfo.name = classInfo_.name();
    outInfo.vendor = classInfo_.vendor();
    outInfo.numParams =
        controller_ ? static_cast<uint32_t>(std::max<int32>(0, controller_->getParameterCount()))
                    : 0u;
    outInfo.latencySamples = latencySamples_.load(std::memory_order_relaxed);
    outInfo.isInstrument = isInstrument_;
    outInfo.numIns = static_cast<uint32_t>(std::max<int32>(0, mainInChannels_));
    outInfo.numOuts = static_cast<uint32_t>(std::max<int32>(0, mainOutChannels_));
    // Editor capability: probe (create + release, never attach) defensively;
    // any refusal or fault reports false. openEditor still re-checks live.
    outInfo.hasEditor = controller_ && probeEditorView(controller_.get());
    return true;
}

// ---------------------------------------------------------------------------
bool Vst3Host::activate() {
    if (!component_ || !processor_)
        return false;
    if (!active_) {
        component_->setActive(true);
        active_ = true;
    }
    latencySamples_.store(processor_->getLatencySamples(), std::memory_order_relaxed);
    return true;
}

void Vst3Host::deactivate() {
    if (processing_ && processor_) {
        processor_->setProcessing(false);
        processing_ = false;
    }
    if (active_ && component_) {
        component_->setActive(false);
        active_ = false;
    }
}

void Vst3Host::suspend() {
    deactivate();
}

void Vst3Host::resume() {
    if (!activate())
        return;
    if (processor_ && !processing_) {
        processor_->setProcessing(true);
        processing_ = true;
    }
}

// ---------------------------------------------------------------------------
// Process path (shm audio thread)
// ---------------------------------------------------------------------------
void Vst3Host::process(const ProcessBlock& block) noexcept {
    if (!prepared_ || !processor_) {
        zeroOutputs(block);
        outParamChanges_.clearQueue();
        publishBlockOutputs(block, collectParamOut(block));
        return;
    }

    applyRestartFlags();

    const uint32_t frames = std::min(block.frames, maxBlock_);
    if (!active_ || frames == 0) {
        zeroOutputs(block);
        outParamChanges_.clearQueue();
        publishBlockOutputs(block, collectParamOut(block));
        return;
    }
    if (!processing_) {
        // §8.2 resume is the normal path; this is a safety net (setProcessing
        // is documented as a light call usable from the processing thread).
        processor_->setProcessing(true);
        processing_ = true;
    }

    setupProcessContext(block, frames);
    gatherInputChanges(block, frames);

    const uint32_t inCovered = std::min<uint32_t>(
        block.numIns, static_cast<uint32_t>(std::max<int32>(0, mainInChannels_)));
    const uint32_t outCovered = std::min<uint32_t>(
        block.numOuts, static_cast<uint32_t>(std::max<int32>(0, mainOutChannels_)));
    bindAudioBuffers(block, inCovered, outCovered);
    processData_.numSamples = static_cast<int32>(frames);

    outParamChanges_.clearQueue();
    processor_->process(processData_);

    // shm out channels the plugin's main bus does not cover: mono-upmix from
    // channel 0 when possible, otherwise silence (engine expects them filled).
    for (uint32_t ch = outCovered; ch < block.numOuts; ++ch) {
        if (!block.out || !block.out[ch])
            continue;
        if (outCovered > 0 && block.out[0])
            std::memcpy(block.out[ch], block.out[0], frames * sizeof(float));
        else
            std::memset(block.out[ch], 0, frames * sizeof(float));
    }

    publishBlockOutputs(block, collectParamOut(block));
}

void Vst3Host::setupProcessContext(const ProcessBlock& block, uint32_t frames) noexcept {
    (void)frames;
    processContext_ = ProcessContext{};
    processContext_.state =
        ProcessContext::kTempoValid | ProcessContext::kProjectTimeMusicValid;
    if (block.flags & kShmFlagPlaying)
        processContext_.state |= ProcessContext::kPlaying;
    if (block.flags & kShmFlagRecording)
        processContext_.state |= ProcessContext::kRecording;
    if (block.flags & kShmFlagLoop)
        processContext_.state |= ProcessContext::kCycleActive;
    processContext_.sampleRate = block.sampleRate > 0.0 ? block.sampleRate : sampleRate_;
    processContext_.tempo = block.tempo > 0.0 ? block.tempo : 120.0;
    processContext_.projectTimeMusic = block.ppqPos;
    processContext_.projectTimeSamples = static_cast<TSamples>(std::llround(
        block.ppqPos * (60.0 / processContext_.tempo) * processContext_.sampleRate));
    // NOTE(spec): the shm block carries no time signature; leave 4/4 in the
    // fields without setting kTimeSigValid.
    processContext_.timeSigNumerator = 4;
    processContext_.timeSigDenominator = 4;
}

void Vst3Host::gatherInputChanges(const ProcessBlock& block, uint32_t frames) noexcept {
    inParamChanges_.clearQueue();
    inEvents_.clear();
    const uint32_t maxOff = frames > 0 ? frames - 1 : 0;

    // Engine RT param changes (shm paramIn; id = VST3 ParamID).
    const uint32_t nParams = std::min<uint32_t>(block.numParamIn, kMaxParamChanges);
    for (uint32_t i = 0; i < nParams && block.paramIn; ++i) {
        const ParamChange& pc = block.paramIn[i];
        int32 qIndex = 0;
        if (auto* q = inParamChanges_.addParameterData(pc.id, qIndex)) {
            int32 pIndex = 0;
            q->addPoint(static_cast<int32>(std::min(pc.sampleOffset, maxOff)),
                        clamp01(pc.value), pIndex);
        }
    }
    // Non-RT fallback (pipe setParam / loadPreset) + native-editor edits: the
    // controller was already updated; this keeps the processor part in sync.
    engineToProcessor_.transferChangesTo(inParamChanges_);
    editorToProcessor_.transferChangesTo(inParamChanges_);

    // MIDI (shm midiIn). Notes -> EventList; CC/pitchbend/aftertouch -> param
    // changes via the cached IMidiMapping assignments (SPEC §8.4).
    auto addCtrl = [&](int32 channel, int32 ctrl, double value, int32 off) noexcept {
        if (channel < 0 || channel >= 16 || ctrl < 0 || ctrl >= kNumMidiCtrls)
            return;
        const ParamID pid =
            ccParamMap_[static_cast<size_t>(channel)][static_cast<size_t>(ctrl)];
        if (pid == kNoParamId)
            return;
        int32 qIndex = 0;
        if (auto* q = inParamChanges_.addParameterData(pid, qIndex)) {
            int32 pIndex = 0;
            q->addPoint(off, clamp01(value), pIndex);
        }
    };

    const uint32_t nMidi = std::min<uint32_t>(block.numMidiIn, kMaxMidi);
    for (uint32_t i = 0; i < nMidi && block.midiIn; ++i) {
        const MidiMsg& m = block.midiIn[i];
        if (m.len < 2)
            continue;
        const uint8_t status = m.data[0] & 0xF0u;
        const int32 channel = m.data[0] & 0x0Fu;
        const int32 off = static_cast<int32>(std::min(m.sampleOffset, maxOff));
        switch (status) {
            case 0x80:
            case 0x90: {
                if (m.len < 3)
                    break;
                const uint8_t vel = m.data[2] & 0x7Fu;
                Event ev{};
                ev.busIndex = 0;
                ev.sampleOffset = off;
                ev.ppqPosition = block.ppqPos;
                ev.flags = 0;
                if (status == 0x80 || vel == 0) {
                    ev.type = Event::kNoteOffEvent;
                    ev.noteOff.channel = static_cast<int16>(channel);
                    ev.noteOff.pitch = static_cast<int16>(m.data[1] & 0x7Fu);
                    ev.noteOff.velocity = static_cast<float>(vel) / 127.0f;
                    ev.noteOff.noteId = -1;
                    ev.noteOff.tuning = 0.0f;
                } else {
                    ev.type = Event::kNoteOnEvent;
                    ev.noteOn.channel = static_cast<int16>(channel);
                    ev.noteOn.pitch = static_cast<int16>(m.data[1] & 0x7Fu);
                    ev.noteOn.velocity = static_cast<float>(vel) / 127.0f;
                    ev.noteOn.length = 0;
                    ev.noteOn.noteId = -1;
                    ev.noteOn.tuning = 0.0f;
                }
                inEvents_.addEvent(ev);
                break;
            }
            case 0xB0: // control change
                if (m.len >= 3)
                    addCtrl(channel, m.data[1] & 0x7F,
                            static_cast<double>(m.data[2] & 0x7Fu) / 127.0, off);
                break;
            case 0xE0: { // pitch bend -> kPitchBend (129)
                if (m.len < 3)
                    break;
                const int32 v14 = (m.data[1] & 0x7F) | ((m.data[2] & 0x7F) << 7);
                addCtrl(channel, kPitchBend, static_cast<double>(v14) / 16383.0, off);
                break;
            }
            case 0xD0: // channel pressure -> kAfterTouch (128)
                addCtrl(channel, kAfterTouch,
                        static_cast<double>(m.data[1] & 0x7Fu) / 127.0, off);
                break;
            default:
                break; // other messages ignored v1
        }
    }
}

void Vst3Host::bindAudioBuffers(const ProcessBlock& block, uint32_t inCovered,
                                uint32_t outCovered) noexcept {
    for (int32 bus = 0; bus < processData_.numInputs; ++bus) {
        const int32 nch = processData_.inputs[bus].numChannels;
        for (int32 ch = 0; ch < nch; ++ch) {
            float* p = scratchIn_.data(); // silent for aux buses / extra channels
            if (bus == 0 && block.in && static_cast<uint32_t>(ch) < inCovered)
                p = const_cast<float*>(block.in[ch]); // plugins read inputs only
            processData_.setChannelBuffer(kInput, bus, ch, p);
        }
        processData_.inputs[bus].silenceFlags = 0;
    }
    for (int32 bus = 0; bus < processData_.numOutputs; ++bus) {
        const int32 nch = processData_.outputs[bus].numChannels;
        for (int32 ch = 0; ch < nch; ++ch) {
            float* p = scratchOut_.data(); // discarded aux / extra outputs
            if (bus == 0 && block.out && static_cast<uint32_t>(ch) < outCovered)
                p = block.out[ch];
            processData_.setChannelBuffer(kOutput, bus, ch, p);
        }
        processData_.outputs[bus].silenceFlags = 0;
    }
}

uint32_t Vst3Host::collectParamOut(const ProcessBlock& block) noexcept {
    uint32_t count = 0;
    auto emit = [&](uint32_t id, double value, uint32_t off) noexcept {
        if (!block.paramOut)
            return;
        for (uint32_t j = 0; j < count; ++j) { // dedup: last value per id wins
            if (block.paramOut[j].id == id) {
                block.paramOut[j].value = value;
                block.paramOut[j].sampleOffset = off;
                return;
            }
        }
        if (count < block.paramOutCapacity) {
            block.paramOut[count].id = id;
            block.paramOut[count].value = value;
            block.paramOut[count].sampleOffset = off;
            ++count;
        }
    };

    // Plugin's output parameter changes from process() (last point per queue).
    const int32 nQueues = outParamChanges_.getParameterCount();
    for (int32 i = 0; i < nQueues; ++i) {
        IParamValueQueue* q = outParamChanges_.getParameterData(i);
        if (!q)
            continue;
        const int32 pts = q->getPointCount();
        if (pts <= 0)
            continue;
        int32 off = 0;
        ParamValue v = 0.0;
        if (q->getPoint(pts - 1, off, v) == kResultTrue)
            emit(q->getParameterId(), v, static_cast<uint32_t>(std::max<int32>(0, off)));
    }
    // Native-editor edits (IComponentHandler::performEdit) -> engine
    // paramEdited flow (E7 drains shm paramOut).
    ParamID pid = 0;
    ParamValue v = 0.0;
    int32 off = 0;
    while (editorToEngine_.getNextChange(pid, v, off))
        emit(pid, v, 0);
    return count;
}

void Vst3Host::publishBlockOutputs(const ProcessBlock& block,
                                   uint32_t numParamOut) noexcept {
    if (block.numMidiOut)
        *block.numMidiOut = 0; // NOTE(spec): plugin MIDI output ignored v1
    if (block.numParamOut)
        *block.numParamOut = numParamOut;
    if (block.latencySamples)
        *block.latencySamples = latencySamples_.load(std::memory_order_relaxed);
}

void Vst3Host::zeroOutputs(const ProcessBlock& block) noexcept {
    const uint32_t frames = std::min(block.frames, kMaxBlock);
    for (uint32_t ch = 0; ch < block.numOuts; ++ch) {
        if (block.out && block.out[ch])
            std::memset(block.out[ch], 0, frames * sizeof(float));
    }
}

void Vst3Host::applyRestartFlags() noexcept {
    const int32 flags = restartFlags_.exchange(0, std::memory_order_acquire);
    if (!flags)
        return;
    if (flags & (kLatencyChanged | kIoChanged)) {
        // NOTE(spec): full bus renegotiation (kIoChanged) is out of scope v1;
        // both flags get the kLatencyChanged treatment — deactivate,
        // reactivate, re-query latency. The refreshed value reaches the
        // engine through ShmHeader::latencySamples this very block, which
        // feeds E7's latencyChanged callback / PDC.
        const bool wasProcessing = processing_;
        if (processing_ && processor_) {
            processor_->setProcessing(false);
            processing_ = false;
        }
        if (active_ && component_) {
            component_->setActive(false);
            component_->setActive(true);
        }
        if (wasProcessing && processor_) {
            processor_->setProcessing(true);
            processing_ = true;
        }
        if (processor_)
            latencySamples_.store(processor_->getLatencySamples(),
                                  std::memory_order_relaxed);
    }
    if (flags & kMidiCCAssignmentChanged)
        rebuildMidiCcMap();
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
std::vector<ParamInfo> Vst3Host::getParams() {
    std::vector<ParamInfo> out;
    if (!controller_)
        return out;
    const int32 n = controller_->getParameterCount();
    out.reserve(static_cast<size_t>(std::max<int32>(0, n)));
    for (int32 i = 0; i < n; ++i) {
        ParameterInfo pi{};
        if (controller_->getParameterInfo(i, pi) != kResultTrue)
            continue;
        ParamInfo p;
        p.id = pi.id;
        p.name = vst3ToUtf8(pi.title);
        if (pi.flags & ParameterInfo::kIsHidden)
            p.name += " [hidden]"; // included but marked (SPEC H2 note)
        p.label = vst3ToUtf8(pi.units);
        p.defaultValue = clamp01(pi.defaultNormalizedValue);
        // VST3 stepCount = positions - 1 (1 = toggle); adapter contract wants
        // N = number of positions, 0 = continuous.
        p.steps = pi.stepCount > 0 ? pi.stepCount + 1 : 0;
        p.value = clamp01(controller_->getParamNormalized(pi.id));
        String128 txt{};
        if (controller_->getParamStringByValue(pi.id, p.value, txt) == kResultTrue)
            p.valueText = vst3ToUtf8(txt);
        out.push_back(std::move(p));
    }
    return out;
}

void Vst3Host::setParam(uint32_t id, double value) {
    const double v = clamp01(value);
    if (controller_)
        controller_->setParamNormalized(id, v); // keep GUI/controller in sync
    engineToProcessor_.addChange(id, v, 0);     // reach the processor next block
}

std::string Vst3Host::getParamText(uint32_t id) {
    if (!controller_)
        return {};
    String128 txt{};
    const ParamValue v = controller_->getParamNormalized(id);
    if (controller_->getParamStringByValue(id, v, txt) != kResultTrue)
        return {};
    return vst3ToUtf8(txt);
}

// ---------------------------------------------------------------------------
// State (SPEC §8.4: component + controller streams in the 'MD3S' container)
// ---------------------------------------------------------------------------
bool Vst3Host::getState(std::vector<uint8_t>& out) {
    out.clear();
    if (!component_) {
        lastError_ = "no component loaded";
        return false;
    }
    std::vector<uint8_t> compBytes;
    std::vector<uint8_t> ctrlBytes;
    {
        MemoryStream stream;
        if (component_->getState(&stream) == kResultTrue)
            vst3StreamBytes(stream, compBytes);
    }
    if (controller_) {
        MemoryStream stream;
        if (controller_->getState(&stream) == kResultTrue)
            vst3StreamBytes(stream, ctrlBytes);
    }
    vst3PackChunk(compBytes, ctrlBytes, out);
    return true;
}

bool Vst3Host::setState(std::span<const uint8_t> data) {
    if (!component_) {
        lastError_ = "no component loaded";
        return false;
    }
    std::vector<uint8_t> compBytes;
    std::vector<uint8_t> ctrlBytes;
    if (!vst3UnpackChunk(data, compBytes, ctrlBytes)) {
        lastError_ = "unrecognized VST3 state chunk (bad 'MD3S' container)";
        return false;
    }
    // Order per SPEC H2: component->setState, controller->setComponentState,
    // controller->setState.
    if (!compBytes.empty()) {
        MemoryStream stream(compBytes.data(), static_cast<TSize>(compBytes.size()));
        component_->setState(&stream);
        if (controller_) {
            MemoryStream stream2(compBytes.data(),
                                 static_cast<TSize>(compBytes.size()));
            controller_->setComponentState(&stream2);
        }
    }
    if (controller_ && !ctrlBytes.empty()) {
        MemoryStream stream(ctrlBytes.data(), static_cast<TSize>(ctrlBytes.size()));
        controller_->setState(&stream);
    }
    return true;
}

// ---------------------------------------------------------------------------
// Presets (IUnitInfo program list, switched via the program-change parameter)
// ---------------------------------------------------------------------------
void Vst3Host::discoverPrograms() {
    hasProgramParam_ = false;
    programParamId_ = kNoParamId;
    programStepCount_ = 0;
    programListId_ = kNoProgramListId;
    programCount_ = 0;
    unitInfo_ = nullptr;
    if (!controller_)
        return;
    unitInfo_ = FUnknownPtr<IUnitInfo>(controller_.get());
    if (!unitInfo_)
        return;

    // Prefer the root unit's program list; otherwise the first unit that has one.
    UnitID targetUnit = kRootUnitId;
    bool haveList = false;
    const int32 unitCount = unitInfo_->getUnitCount();
    for (int32 i = 0; i < unitCount; ++i) {
        UnitInfo ui{};
        if (unitInfo_->getUnitInfo(i, ui) != kResultTrue)
            continue;
        if (ui.programListId == kNoProgramListId)
            continue;
        if (!haveList || ui.id == kRootUnitId) {
            targetUnit = ui.id;
            programListId_ = ui.programListId;
            haveList = true;
            if (ui.id == kRootUnitId)
                break;
        }
    }
    if (!haveList)
        return;

    const int32 listCount = unitInfo_->getProgramListCount();
    for (int32 i = 0; i < listCount; ++i) {
        ProgramListInfo pli{};
        if (unitInfo_->getProgramListInfo(i, pli) == kResultTrue &&
            pli.id == programListId_) {
            programCount_ = pli.programCount;
            break;
        }
    }

    // The program-change parameter that drives the list (prefer one bound to
    // the target unit).
    const int32 paramCount = controller_->getParameterCount();
    for (int32 i = 0; i < paramCount; ++i) {
        ParameterInfo pi{};
        if (controller_->getParameterInfo(i, pi) != kResultTrue)
            continue;
        if (!(pi.flags & ParameterInfo::kIsProgramChange))
            continue;
        if (!hasProgramParam_ || pi.unitId == targetUnit) {
            programParamId_ = pi.id;
            programStepCount_ = pi.stepCount;
            hasProgramParam_ = true;
            if (pi.unitId == targetUnit)
                break;
        }
    }
}

std::vector<PresetInfo> Vst3Host::getPresets() {
    std::vector<PresetInfo> out;
    if (!unitInfo_ || !hasProgramParam_ || programCount_ <= 0)
        return out; // SPEC §5.6: empty when no unit programs exposed
    out.reserve(static_cast<size_t>(programCount_));
    for (int32 i = 0; i < programCount_; ++i) {
        PresetInfo p;
        p.id = i;
        String128 name{};
        if (unitInfo_->getProgramName(programListId_, i, name) == kResultTrue)
            p.name = vst3ToUtf8(name);
        if (p.name.empty())
            p.name = "Program " + std::to_string(i + 1);
        out.push_back(std::move(p));
    }
    return out;
}

bool Vst3Host::loadPreset(int32_t id) {
    if (!controller_ || !hasProgramParam_) {
        lastError_ = "plugin exposes no program list";
        return false;
    }
    if (id < 0 || (programCount_ > 0 && id >= programCount_)) {
        lastError_ = "preset id out of range";
        return false;
    }
    const double norm =
        programStepCount_ > 0
            ? clamp01(static_cast<double>(id) / static_cast<double>(programStepCount_))
            : 0.0;
    controller_->setParamNormalized(programParamId_, norm);
    engineToProcessor_.addChange(programParamId_, norm, 0);
    return true;
}

// ---------------------------------------------------------------------------
// Native editor (IPlugView attached to the H1-owned EditorWindow HWND)
// ---------------------------------------------------------------------------
bool Vst3Host::openEditor(HWND parent, EditorSize& outSize) {
    if (!controller_) {
        lastError_ = "plugin has no edit controller (no native editor)";
        return false;
    }
    closeEditor();

    IPlugView* raw = controller_->createView(ViewType::kEditor);
    if (!raw) {
        lastError_ = "plugin does not provide an editor view";
        return false;
    }
    view_ = owned(raw);
    if (view_->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) {
        view_ = nullptr;
        lastError_ = "editor view does not support HWND embedding";
        return false;
    }
    if (!plugFrame_)
        plugFrame_ = owned(new Vst3PlugFrame(this));
    view_->setFrame(plugFrame_);

    ViewRect rect{};
    if (view_->getSize(&rect) != kResultTrue || rect.getWidth() <= 0 ||
        rect.getHeight() <= 0) {
        rect.left = rect.top = 0;
        rect.right = 640;
        rect.bottom = 400;
    }
    if (view_->attached(parent, kPlatformTypeHWND) != kResultTrue) {
        view_->setFrame(nullptr);
        view_ = nullptr;
        lastError_ = "editor view refused to attach";
        return false;
    }
    // Some plugins finalize their size only after attach.
    ViewRect after{};
    if (view_->getSize(&after) == kResultTrue && after.getWidth() > 0 &&
        after.getHeight() > 0)
        rect = after;

    resizePending_.store(false, std::memory_order_relaxed);
    outSize.width = rect.getWidth();
    outSize.height = rect.getHeight();
    return true;
}

void Vst3Host::closeEditor() {
    if (!view_)
        return;
    view_->removed();
    view_ = nullptr; // released + (canResize/frame ownership stays with plugFrame_)
    resizePending_.store(false, std::memory_order_relaxed);
}

void Vst3Host::editorIdle() {
    // VST3 editors run off the host window's message pump; no idle calls
    // needed (vst2 effEditIdle counterpart does not exist).
}

bool Vst3Host::resizePending(EditorSize& outNewSize) {
    if (!resizePending_.exchange(false, std::memory_order_acquire))
        return false;
    outNewSize = pendingSize_;
    return true;
}

// ---------------------------------------------------------------------------
// Callbacks from Vst3ComponentHandler / Vst3PlugFrame
// ---------------------------------------------------------------------------
void Vst3Host::onEditorParamEdit(ParamID id, ParamValue value) noexcept {
    const double v = clamp01(value);
    editorToEngine_.addChange(id, v, 0);    // -> shm paramOut -> engine paramEdited
    editorToProcessor_.addChange(id, v, 0); // keep the processor part in sync
}

void Vst3Host::onRestartComponent(int32 flags) noexcept {
    const int32 interesting =
        flags & (kLatencyChanged | kIoChanged | kMidiCCAssignmentChanged);
    if (interesting)
        restartFlags_.fetch_or(interesting, std::memory_order_release);
    // kParamValuesChanged etc.: the engine re-pulls the parameter list over
    // the pipe after preset/state operations; nothing to do host-side in v1.
}

void Vst3Host::onViewResize(int32_t width, int32_t height) noexcept {
    pendingSize_.width = width;
    pendingSize_.height = height;
    resizePending_.store(true, std::memory_order_release);
}

void Vst3Host::rebuildMidiCcMap() {
    for (auto& row : ccParamMap_)
        row.fill(kNoParamId);
    if (!midiMapping_)
        return;
    for (int32 channel = 0; channel < 16; ++channel) {
        for (int32 ctrl = 0; ctrl < kNumMidiCtrls; ++ctrl) {
            ParamID pid = kNoParamId;
            if (midiMapping_->getMidiControllerAssignment(
                    0, static_cast<int16>(channel), static_cast<CtrlNumber>(ctrl),
                    pid) == kResultTrue &&
                pid != kNoParamId) {
                ccParamMap_[static_cast<size_t>(channel)][static_cast<size_t>(ctrl)] =
                    pid;
            }
        }
    }
}

// ===========================================================================
// Scan (SPEC §8.3) — enumerate every audio-effect class in the module factory.
// ===========================================================================
bool scanVst3File(const std::wstring& path, std::vector<ScannedPlugin>& out,
                  std::string& error) {
    const std::string utf8Path = vst3WideToUtf8(path);
    std::string err;
    auto module = VST3::Hosting::Module::create(utf8Path, err);
    if (!module) {
        error = err.empty() ? "failed to load VST3 module" : err;
        return false;
    }
    const auto& factory = module->getFactory();
    const std::string factoryVendor = factory.info().vendor();

    for (const auto& ci : factory.classInfos()) {
        if (ci.category() != kVstAudioEffectClass)
            continue;
        ScannedPlugin sp;
        sp.uid = ci.ID().toString(); // class GUID string (SPEC §5.6)
        sp.format = "vst3";
        sp.path = utf8Path;
        // sp.bitness already defaults to this host's bitness.
        sp.name = ci.name();
        sp.vendor = ci.vendor().empty() ? factoryVendor : ci.vendor();
        sp.category = ci.subCategoriesString();
        sp.isInstrument = vst3IsInstrumentCategory(sp.category);
        // NOTE(spec): no instantiation at scan time (cheap scan, SPEC H2);
        // real i/o counts come from init's bus negotiation. Default stereo.
        sp.numInputs = 2;
        sp.numOutputs = 2;
        out.push_back(std::move(sp));
    }
    if (out.empty()) {
        error = "module contains no VST3 audio effect classes";
        return false;
    }
    return true;
}

std::unique_ptr<PluginAdapter> createVst3Adapter() {
    return std::make_unique<Vst3Host>();
}

} // namespace mydaw

// ===========================================================================
// SDK translation units NOT compiled by the sdk_hosting cmake target (it only
// builds connectionproxy/eventlist/hostclasses/module/parameterchanges/
// pluginterfacesupport/processdata/stringconvert/vstinitiids — verified in
// build/_deps/vst3sdk-src/public.sdk/CMakeLists.txt). plugin-host's cmake
// globs only plugin-host/src/*.cpp, so they are compiled here exactly once.
// ===========================================================================
#include "public.sdk/source/common/memorystream.cpp"
#include "public.sdk/source/vst/hosting/module_win32.cpp"
#include "public.sdk/source/vst/hosting/plugprovider.cpp"

#endif // MYDAW_VST3_DISABLED
