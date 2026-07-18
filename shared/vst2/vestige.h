#pragma once
//
// shared/vst2/vestige.h — clean-room declarations of the VST 2.x plugin ABI.
//
// PROVENANCE / LICENSE NOTE: This header was written from publicly available
// knowledge of the VST2 *binary* interface — the same long-public ABI that
// independent free-software projects (the original "vestige" header used by
// LMMS, Ardour's fst, and others) re-declared from observation of compiled
// plugins and hosts. It contains NO code copied from the Steinberg VST2 SDK;
// that SDK is neither shipped with nor required to build MyDAW (SPEC §1, §8.4).
// Struct layouts and opcode numbers below are dictated entirely by the binary
// interface (they are facts about how compiled VST2 plugins behave) and the
// identifier names follow long-established community convention so hosting
// code reads naturally.
//
// Scope: exactly what mydaw-host{64,32} needs to host VST2 effects and
// instruments per SPEC §8.4 — dispatcher opcodes for lifecycle, state chunks,
// programs, parameters, editor, MIDI events, and the audioMaster callbacks a
// well-behaved plugin expects (time info, automation notification, ioChanged,
// sizeWindow, canDo, vendor strings).
//
// This header is C++-friendly but keeps a C-style flavor (plain structs,
// anonymous enums) because it describes a C ABI. All structs use 8-byte
// packing, matching the ABI on both x86 and x64 Windows.
//
#include <cstdint>

// VST2 uses the cdecl calling convention on Windows.
#if defined(_MSC_VER)
#define VESTIGE_CALLBACK __cdecl
#elif defined(__GNUC__) && defined(_WIN32)
#define VESTIGE_CALLBACK __attribute__((cdecl))
#else
#define VESTIGE_CALLBACK
#endif

typedef int32_t VstInt32;
typedef intptr_t VstIntPtr;

struct AEffect; // fwd

// ---------------------------------------------------------------------------
// Function pointer types
// ---------------------------------------------------------------------------
// Host callback handed to the plugin entry point.
typedef VstIntPtr(VESTIGE_CALLBACK* audioMasterCallback)(
    AEffect* effect, VstInt32 opcode, VstInt32 index, VstIntPtr value,
    void* ptr, float opt);

// Members of AEffect:
typedef VstIntPtr(VESTIGE_CALLBACK* AEffectDispatcherProc)(
    AEffect* effect, VstInt32 opcode, VstInt32 index, VstIntPtr value,
    void* ptr, float opt);
typedef void(VESTIGE_CALLBACK* AEffectProcessProc)(
    AEffect* effect, float** inputs, float** outputs, VstInt32 sampleFrames);
typedef void(VESTIGE_CALLBACK* AEffectProcessDoubleProc)(
    AEffect* effect, double** inputs, double** outputs, VstInt32 sampleFrames);
typedef void(VESTIGE_CALLBACK* AEffectSetParameterProc)(
    AEffect* effect, VstInt32 index, float parameter);
typedef float(VESTIGE_CALLBACK* AEffectGetParameterProc)(
    AEffect* effect, VstInt32 index);

// Plugin entry point: exported as "VSTPluginMain" (sometimes only "main").
typedef AEffect*(VESTIGE_CALLBACK* VstEntryProc)(audioMasterCallback host);

// ---------------------------------------------------------------------------
// AEffect — the structure a VST2 plugin returns from its entry point.
// ---------------------------------------------------------------------------
constexpr VstInt32 kEffectMagic = 0x56737450; // 'VstP'

#pragma pack(push, 8)

struct AEffect {
  VstInt32 magic;                   // kEffectMagic
  AEffectDispatcherProc dispatcher; // opcode dispatch (eff* below)
  AEffectProcessProc process;       // deprecated accumulating process
  AEffectSetParameterProc setParameter;
  AEffectGetParameterProc getParameter;
  VstInt32 numPrograms;
  VstInt32 numParams;
  VstInt32 numInputs;
  VstInt32 numOutputs;
  VstInt32 flags;                   // effFlags* below
  VstIntPtr resvd1;                 // reserved for host use
  VstIntPtr resvd2;                 // reserved for host use
  VstInt32 initialDelay;            // latency in samples (PDC)
  VstInt32 realQualities;           // deprecated, unused
  VstInt32 offQualities;            // deprecated, unused
  float ioRatio;                    // deprecated, unused
  void* object;                     // plugin's internal object
  void* user;                       // host user pointer
  VstInt32 uniqueID;                // registered 4-byte id (our vst2 uid)
  VstInt32 version;                 // plugin version
  AEffectProcessProc processReplacing;             // float32 replacing
  AEffectProcessDoubleProc processDoubleReplacing; // float64 replacing (2.4)
  char future[56];                  // reserved padding
};

// ---------------------------------------------------------------------------
// AEffect::flags
// ---------------------------------------------------------------------------
enum {
  effFlagsHasEditor = 1 << 0,          // plugin provides a native editor
  effFlagsCanReplacing = 1 << 4,       // processReplacing is valid (required)
  effFlagsProgramChunks = 1 << 5,      // state via effGet/SetChunk
  effFlagsIsSynth = 1 << 8,            // instrument (wants MIDI events)
  effFlagsNoSoundInStop = 1 << 9,      // no tail when transport stopped
  effFlagsCanDoubleReplacing = 1 << 12 // processDoubleReplacing valid (2.4)
};

// ---------------------------------------------------------------------------
// Dispatcher opcodes (plugin side): aEffect->dispatcher(effect, opcode, ...)
// ---------------------------------------------------------------------------
enum {
  effOpen = 0,             // instantiate
  effClose = 1,            // destroy (do not use the AEffect afterwards)
  effSetProgram = 2,       // value = program number
  effGetProgram = 3,       // return = current program number
  effSetProgramName = 4,   // ptr = char[kVstMaxProgNameLen+1] new name
  effGetProgramName = 5,   // ptr = char buffer receiving current name
  effGetParamLabel = 6,    // index = param, ptr = char buffer (units, "dB")
  effGetParamDisplay = 7,  // index = param, ptr = char buffer ("-6.0")
  effGetParamName = 8,     // index = param, ptr = char buffer ("Gain")
  effSetSampleRate = 10,   // opt = sample rate (float)
  effSetBlockSize = 11,    // value = max block size
  effMainsChanged = 12,    // value = 0 suspend, 1 resume
  effEditGetRect = 13,     // ptr = ERect** receiving editor rect
  effEditOpen = 14,        // ptr = native parent window handle (HWND)
  effEditClose = 15,       // close editor
  effEditIdle = 19,        // editor idle pump (~50 Hz while open)
  effIdentify = 22,        // deprecated; returns 'NvEf' on old plugins
  effGetChunk = 23,        // ptr = void** receiving chunk; index 0=bank 1=prog
  effSetChunk = 24,        // ptr = chunk data, value = byte size, index as above
  effProcessEvents = 25,   // ptr = VstEvents* (MIDI input for next block)
  effCanBeAutomated = 26,  // index = param; return 1 if automatable
  effString2Parameter = 27,// index = param, ptr = char* text; return 1 if ok
  effGetProgramNameIndexed = 29, // index = program, ptr = char buffer; 1 if ok
  effGetInputProperties = 33,    // index = pin, ptr = VstPinProperties*
  effGetOutputProperties = 34,   // index = pin, ptr = VstPinProperties*
  effGetPlugCategory = 35,       // return = VstPlugCategory
  effGetEffectName = 45,   // ptr = char[kVstMaxEffectNameLen+1]
  effGetVendorString = 47, // ptr = char[kVstMaxVendorStrLen+1]
  effGetProductString = 48,// ptr = char[kVstMaxProductStrLen+1]
  effGetVendorVersion = 49,// return = vendor version
  effVendorSpecific = 50,  // vendor-defined
  effCanDo = 51,           // ptr = const char* canDo string; 1/0/-1
  effGetTailSize = 52,     // return = tail in samples (0 = default, 1 = none)
  effIdle = 53,            // plugin idle (call when audioMasterNeedIdle asked)
  effGetParameterProperties = 56, // index = param, ptr = props struct; 1 if ok
  effGetVstVersion = 58,   // return = 2400 for VST 2.4
  effEditKeyDown = 59,     // index = char, value = virtual key, opt = mods
  effEditKeyUp = 60,
  effBeginSetProgram = 67, // bracket program changes
  effEndSetProgram = 68,
  effShellGetNextPlugin = 70, // shell plugins (NOT supported in v1, SPEC §8.3)
  effStartProcess = 71,    // processing is about to start
  effStopProcess = 72,     // processing has stopped
  effSetTotalSampleToProcess = 73, // offline: total samples
  effBeginLoadBank = 75,   // ptr = VstPatchChunkInfo*
  effBeginLoadProgram = 76 // ptr = VstPatchChunkInfo*
};

// ---------------------------------------------------------------------------
// audioMaster opcodes (host side): host(effect, opcode, ...)
// ---------------------------------------------------------------------------
enum {
  audioMasterAutomate = 0,      // index = param, opt = value; editor edit
  audioMasterVersion = 1,       // return 2400
  audioMasterCurrentId = 2,     // return uniqueID of loading shell sub-plugin
  audioMasterIdle = 3,          // plugin wants host idle
  audioMasterWantMidi = 6,      // deprecated; instruments call it; return 1
  audioMasterGetTime = 7,       // return = VstTimeInfo* (valid until next call)
                                //   value = requested kVst*Valid flag mask
  audioMasterProcessEvents = 8, // ptr = VstEvents* (plugin MIDI output)
  audioMasterIoChanged = 13,    // plugin changed latency/IO → re-query
  audioMasterSizeWindow = 15,   // index = width, value = height; return 1 if ok
  audioMasterGetSampleRate = 16,
  audioMasterGetBlockSize = 17,
  audioMasterGetInputLatency = 18,
  audioMasterGetOutputLatency = 19,
  audioMasterGetCurrentProcessLevel = 23, // return VstProcessLevels
  audioMasterGetAutomationState = 24,     // return VstAutomationStates
  audioMasterGetVendorString = 32,  // ptr = char[kVstMaxVendorStrLen+1]
  audioMasterGetProductString = 33, // ptr = char[kVstMaxProductStrLen+1]
  audioMasterGetVendorVersion = 34,
  audioMasterVendorSpecific = 35,
  audioMasterCanDo = 37,        // ptr = const char* canDo string
  audioMasterGetLanguage = 38,  // return VstHostLanguage
  audioMasterGetDirectory = 41, // return = const char* plugin directory
  audioMasterUpdateDisplay = 42,// plugin program/param names changed
  audioMasterBeginEdit = 43,    // index = param (mouse down in editor)
  audioMasterEndEdit = 44,      // index = param (mouse up in editor)
  audioMasterOpenFileSelector = 45,
  audioMasterCloseFileSelector = 46
};

constexpr VstInt32 kVstVersion = 2400;

// String buffer length conventions (excluding NUL).
enum {
  kVstMaxProgNameLen = 24,
  kVstMaxParamStrLen = 8,
  kVstMaxVendorStrLen = 64,
  kVstMaxProductStrLen = 64,
  kVstMaxEffectNameLen = 32
};

// audioMasterGetCurrentProcessLevel results
enum {
  kVstProcessLevelUnknown = 0,
  kVstProcessLevelUser = 1,    // GUI thread
  kVstProcessLevelRealtime = 2,// audio thread
  kVstProcessLevelPrefetch = 3,
  kVstProcessLevelOffline = 4
};

// audioMasterGetAutomationState results
enum {
  kVstAutomationUnsupported = 0,
  kVstAutomationOff = 1,
  kVstAutomationRead = 2,
  kVstAutomationWrite = 3,
  kVstAutomationReadWrite = 4
};

// audioMasterGetLanguage results
enum { kVstLangEnglish = 1 };

// effGetPlugCategory results
enum {
  kPlugCategUnknown = 0,
  kPlugCategEffect = 1,
  kPlugCategSynth = 2,
  kPlugCategAnalysis = 3,
  kPlugCategMastering = 4,
  kPlugCategSpacializer = 5,
  kPlugCategRoomFx = 6,
  kPlugSurroundFx = 7,
  kPlugCategRestoration = 8,
  kPlugCategOfflineProcess = 9,
  kPlugCategShell = 10, // shell plugin — skipped in v1 (SPEC §8.3)
  kPlugCategGenerator = 11
};

// ---------------------------------------------------------------------------
// Time info (audioMasterGetTime)
// ---------------------------------------------------------------------------
struct VstTimeInfo {
  double samplePos;          // always valid: position in samples
  double sampleRate;         // always valid
  double nanoSeconds;        // system time (kVstNanosValid)
  double ppqPos;             // musical position, quarter notes (kVstPpqPosValid)
  double tempo;              // BPM (kVstTempoValid)
  double barStartPos;        // ppq of bar start (kVstBarsValid)
  double cycleStartPos;      // loop start ppq (kVstCyclePosValid)
  double cycleEndPos;        // loop end ppq (kVstCyclePosValid)
  VstInt32 timeSigNumerator; // (kVstTimeSigValid)
  VstInt32 timeSigDenominator;
  VstInt32 smpteOffset;      // (kVstSmpteValid)
  VstInt32 smpteFrameRate;
  VstInt32 samplesToNextClock; // (kVstClockValid)
  VstInt32 flags;            // kVstTransport* | kVst*Valid
};

enum {
  kVstTransportChanged = 1 << 0,
  kVstTransportPlaying = 1 << 1,
  kVstTransportCycleActive = 1 << 2,
  kVstTransportRecording = 1 << 3,
  kVstAutomationWriting = 1 << 6,
  kVstAutomationReading = 1 << 7,
  kVstNanosValid = 1 << 8,
  kVstPpqPosValid = 1 << 9,
  kVstTempoValid = 1 << 10,
  kVstBarsValid = 1 << 11,
  kVstCyclePosValid = 1 << 12,
  kVstTimeSigValid = 1 << 13,
  kVstSmpteValid = 1 << 14,
  kVstClockValid = 1 << 15
};

// ---------------------------------------------------------------------------
// Events (effProcessEvents / audioMasterProcessEvents)
// ---------------------------------------------------------------------------
enum {
  kVstMidiType = 1, // VstMidiEvent
  kVstSysExType = 6 // sysex (not forwarded in v1)
};

enum { kVstMidiEventIsRealtime = 1 << 0 }; // VstMidiEvent::flags

struct VstEvent {
  VstInt32 type;        // kVst*Type
  VstInt32 byteSize;    // size of the concrete event struct
  VstInt32 deltaFrames; // sample offset into the current block
  VstInt32 flags;
  char data[16];
};

struct VstMidiEvent {
  VstInt32 type;        // kVstMidiType
  VstInt32 byteSize;    // sizeof(VstMidiEvent) == 32
  VstInt32 deltaFrames; // sample offset into the current block
  VstInt32 flags;       // kVstMidiEventIsRealtime or 0
  VstInt32 noteLength;  // 0 = unknown
  VstInt32 noteOffset;  // 0
  char midiData[4];     // status, data1, data2, 0
  char detune;          // -64..+63 cents
  char noteOffVelocity;
  char reserved1;
  char reserved2;
};

struct VstEvents {
  VstInt32 numEvents;
  VstIntPtr reserved;
  VstEvent* events[2]; // variable-length in practice; allocate
                       // sizeof(VstEvents) + (n-2)*sizeof(VstEvent*)
};

// ---------------------------------------------------------------------------
// Editor rectangle (effEditGetRect)
// ---------------------------------------------------------------------------
struct ERect {
  int16_t top;
  int16_t left;
  int16_t bottom;
  int16_t right;
};

#pragma pack(pop)

// ---------------------------------------------------------------------------
// ABI layout checks — these sizes are fixed by the binary interface.
// ---------------------------------------------------------------------------
static_assert(sizeof(VstMidiEvent) == 32, "VST2 ABI: VstMidiEvent");
static_assert(sizeof(VstEvent) == 32, "VST2 ABI: VstEvent");
static_assert(sizeof(VstTimeInfo) == 88, "VST2 ABI: VstTimeInfo");
static_assert(sizeof(ERect) == 8, "VST2 ABI: ERect");
static_assert(sizeof(AEffect) == (sizeof(void*) == 8 ? 192 : 144),
              "VST2 ABI: AEffect");
