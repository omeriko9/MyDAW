#pragma once
//
// shared/ipc/PluginIpc.h
//
// Shared-memory audio block exchange between mydaw-engine.exe (x64) and
// mydaw-host64.exe / mydaw-host32.exe (x64 / x86). Layout per SPEC.md §8.1.
//
// BOTH a 64-bit and a 32-bit process map this memory, so:
//   * every field is a fixed-width type (no pointers, no long, no size_t),
//   * packing is explicit (#pragma pack(push, 8)),
//   * every offset and struct size is static_assert'ed below — the asserts
//     hold identically on x86 and x64 because nothing is arch-dependent.
//
// One mapping per plugin instance. Region order inside the mapping:
//
//   [ShmHeader]                                     offset 0
//   float in [numIn ][kMaxBlock]                    cache-line aligned
//   float out[numOut][kMaxBlock]
//   MidiMsg     midiIn  [kMaxMidi]
//   MidiMsg     midiOut [kMaxMidi]
//   ParamChange paramIn [kMaxParamChanges]
//   ParamChange paramOut[kMaxParamChanges]
//
// numIn/numOut are chosen by the engine (≤ kMaxChannels) and fixed for the
// lifetime of the mapping; all offsets derive from them via the constexpr
// helpers below.
//
// Synchronization: two named auto-reset events, "<shmName>_req" (engine→host:
// block ready) and "<shmName>_done" (host→engine: block processed). The
// engine RT thread fills inputs/midi/params, SetEvent(req), then waits on
// done with timeoutMs = max(2, 2 × block duration) — see shmWaitTimeoutMs().
//
#include <cstddef>
#include <cstdint>
#include <string>
#include <type_traits>

namespace mydaw {

// ---------------------------------------------------------------------------
// Constants (SPEC §8.1)
// ---------------------------------------------------------------------------
constexpr uint32_t kMaxBlock        = 2048;  // max audio frames per exchange
constexpr uint32_t kMaxMidi         = 1024;  // capacity of each MIDI region
constexpr uint32_t kMaxParamChanges = 4096;  // capacity of each param region
constexpr uint32_t kMaxChannels     = 8;     // engine never allocates more

constexpr uint32_t kShmMagic     = 0x5741444Du; // bytes "MDAW" in memory (LE)
constexpr uint32_t kShmVersion   = 1;
constexpr uint32_t kShmCacheLine = 64;

// ShmHeader::flags bits (transport state for the current block).
constexpr uint32_t kShmFlagPlaying   = 1u << 0;
constexpr uint32_t kShmFlagRecording = 1u << 1;
constexpr uint32_t kShmFlagLoop      = 1u << 2;

// ShmHeader::state values. Written by the host process (engine writes
// Starting once at creation), read by the engine to detect liveness.
enum class HostState : int32_t {
  Starting   = 0,  // host spawned, plugin not yet initialized
  Ready      = 1,  // idle, waiting for a block
  Processing = 2,  // inside the plugin's process call
  Crashed    = 3,  // host detected an unrecoverable plugin fault
};

// ---------------------------------------------------------------------------
// Shared structs — identical layout on x86 and x64.
// ---------------------------------------------------------------------------
#pragma pack(push, 8)

struct ShmHeader {                 // offset 0 of the mapping
  uint32_t magic;                  // kShmMagic
  uint32_t version;                // kShmVersion
  uint32_t maxBlock;               // kMaxBlock (engine writes; host validates)
  uint32_t numIn;                  // input channel count  (≤ kMaxChannels)
  uint32_t numOut;                 // output channel count (≤ kMaxChannels)
  uint32_t sampleRate;             // session sample rate
  // NOTE(spec): SPEC says "volatile LONG"; LONG is 32-bit on every Windows
  // arch, but `long` is banned from shared structs, so int32_t (same layout).
  volatile int32_t state;          // HostState, written with plain aligned
                                   // 32-bit stores (atomic on x86/x64)
  // -- per-block exchange (engine fills, except where noted) --
  uint32_t blockFrames;            // frames in this block (≤ maxBlock)
  double   tempo;                  // BPM
  double   ppqPos;                 // musical position in quarter notes
  uint32_t flags;                  // kShmFlag* bits
  uint32_t numMidiIn;              // valid entries in midiIn region
  uint32_t numParamChanges;        // valid entries in paramIn region
  uint32_t latencySamples;         // host fills: current plugin latency
  uint32_t numMidiOut;             // host fills: valid entries in midiOut
  uint32_t numParamOut;            // host fills: valid entries in paramOut
                                   //   (editor edits → engine)
};

struct MidiMsg {
  uint32_t sampleOffset;           // frame offset inside the block
  uint8_t  data[4];                // raw MIDI bytes (status, d1, d2, unused)
  uint32_t len;                    // number of valid bytes in data (1..4)
};

struct ParamChange {
  uint32_t id;                     // host-format parameter id
  double   value;                  // normalized 0..1
  uint32_t sampleOffset;           // frame offset inside the block
};

#pragma pack(pop)

// ---------------------------------------------------------------------------
// Layout guarantees — these encode the on-the-wire ABI; do not change.
// ---------------------------------------------------------------------------
static_assert(sizeof(float) == 4 && sizeof(double) == 8, "IEEE sizes");
static_assert(std::is_standard_layout_v<ShmHeader>, "ShmHeader layout");

static_assert(offsetof(ShmHeader, magic)           == 0,  "ShmHeader ABI");
static_assert(offsetof(ShmHeader, version)         == 4,  "ShmHeader ABI");
static_assert(offsetof(ShmHeader, maxBlock)        == 8,  "ShmHeader ABI");
static_assert(offsetof(ShmHeader, numIn)           == 12, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, numOut)          == 16, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, sampleRate)      == 20, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, state)           == 24, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, blockFrames)     == 28, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, tempo)           == 32, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, ppqPos)          == 40, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, flags)           == 48, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, numMidiIn)       == 52, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, numParamChanges) == 56, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, latencySamples)  == 60, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, numMidiOut)      == 64, "ShmHeader ABI");
static_assert(offsetof(ShmHeader, numParamOut)     == 68, "ShmHeader ABI");
static_assert(sizeof(ShmHeader)                    == 72, "ShmHeader ABI");

static_assert(offsetof(MidiMsg, sampleOffset) == 0,  "MidiMsg ABI");
static_assert(offsetof(MidiMsg, data)         == 4,  "MidiMsg ABI");
static_assert(offsetof(MidiMsg, len)          == 8,  "MidiMsg ABI");
static_assert(sizeof(MidiMsg)                 == 12, "MidiMsg ABI");

static_assert(offsetof(ParamChange, id)           == 0,  "ParamChange ABI");
static_assert(offsetof(ParamChange, value)        == 8,  "ParamChange ABI");
static_assert(offsetof(ParamChange, sampleOffset) == 16, "ParamChange ABI");
static_assert(sizeof(ParamChange)                 == 24, "ParamChange ABI");

// ---------------------------------------------------------------------------
// Offset / size helpers. All regions start cache-line aligned.
// ---------------------------------------------------------------------------
constexpr uint32_t shmAlignUp(uint32_t v, uint32_t align = kShmCacheLine) {
  return (v + (align - 1)) / align * align;
}

constexpr uint32_t kShmChannelBytes =
    kMaxBlock * static_cast<uint32_t>(sizeof(float)); // 8192, 64-multiple

constexpr uint32_t shmAudioInOffset() {
  return shmAlignUp(static_cast<uint32_t>(sizeof(ShmHeader)));
}
constexpr uint32_t shmAudioOutOffset(uint32_t numIn) {
  return shmAudioInOffset() + numIn * kShmChannelBytes;
}
constexpr uint32_t shmMidiInOffset(uint32_t numIn, uint32_t numOut) {
  return shmAlignUp(shmAudioOutOffset(numIn) + numOut * kShmChannelBytes);
}
constexpr uint32_t shmMidiOutOffset(uint32_t numIn, uint32_t numOut) {
  return shmAlignUp(shmMidiInOffset(numIn, numOut) +
                    kMaxMidi * static_cast<uint32_t>(sizeof(MidiMsg)));
}
constexpr uint32_t shmParamInOffset(uint32_t numIn, uint32_t numOut) {
  return shmAlignUp(shmMidiOutOffset(numIn, numOut) +
                    kMaxMidi * static_cast<uint32_t>(sizeof(MidiMsg)));
}
constexpr uint32_t shmParamOutOffset(uint32_t numIn, uint32_t numOut) {
  return shmAlignUp(shmParamInOffset(numIn, numOut) +
                    kMaxParamChanges * static_cast<uint32_t>(sizeof(ParamChange)));
}
// Total bytes to pass to CreateFileMapping for a (numIn, numOut) instance.
constexpr uint32_t shmTotalSize(uint32_t numIn, uint32_t numOut) {
  return shmAlignUp(shmParamOutOffset(numIn, numOut) +
                    kMaxParamChanges * static_cast<uint32_t>(sizeof(ParamChange)));
}

// Sanity: a stereo effect instance is well under a megabyte.
static_assert(shmTotalSize(2, 2) == 254080, "layout drifted");
static_assert(shmAudioInOffset() == 128, "layout drifted");
static_assert(shmTotalSize(kMaxChannels, kMaxChannels) < (1u << 20), "size");

// ---------------------------------------------------------------------------
// Pointer helpers, given the base address of the mapped view.
// ---------------------------------------------------------------------------
inline ShmHeader*       shmHeader(void* base)       { return static_cast<ShmHeader*>(base); }
inline const ShmHeader* shmHeader(const void* base) { return static_cast<const ShmHeader*>(base); }

inline float* shmInChannel(void* base, uint32_t channel) {
  return reinterpret_cast<float*>(static_cast<char*>(base) +
                                  shmAudioInOffset() + channel * kShmChannelBytes);
}
inline float* shmOutChannel(void* base, uint32_t numIn, uint32_t channel) {
  return reinterpret_cast<float*>(static_cast<char*>(base) +
                                  shmAudioOutOffset(numIn) + channel * kShmChannelBytes);
}
inline MidiMsg* shmMidiIn(void* base, uint32_t numIn, uint32_t numOut) {
  return reinterpret_cast<MidiMsg*>(static_cast<char*>(base) +
                                    shmMidiInOffset(numIn, numOut));
}
inline MidiMsg* shmMidiOut(void* base, uint32_t numIn, uint32_t numOut) {
  return reinterpret_cast<MidiMsg*>(static_cast<char*>(base) +
                                    shmMidiOutOffset(numIn, numOut));
}
inline ParamChange* shmParamIn(void* base, uint32_t numIn, uint32_t numOut) {
  return reinterpret_cast<ParamChange*>(static_cast<char*>(base) +
                                        shmParamInOffset(numIn, numOut));
}
inline ParamChange* shmParamOut(void* base, uint32_t numIn, uint32_t numOut) {
  return reinterpret_cast<ParamChange*>(static_cast<char*>(base) +
                                        shmParamOutOffset(numIn, numOut));
}

// Convenience overloads that read channel counts from the mapped header.
inline float* shmOutChannel(void* base, const ShmHeader& h, uint32_t channel) {
  return shmOutChannel(base, h.numIn, channel);
}
inline MidiMsg* shmMidiIn(void* base, const ShmHeader& h)  { return shmMidiIn(base, h.numIn, h.numOut); }
inline MidiMsg* shmMidiOut(void* base, const ShmHeader& h) { return shmMidiOut(base, h.numIn, h.numOut); }
inline ParamChange* shmParamIn(void* base, const ShmHeader& h)  { return shmParamIn(base, h.numIn, h.numOut); }
inline ParamChange* shmParamOut(void* base, const ShmHeader& h) { return shmParamOut(base, h.numIn, h.numOut); }

// ---------------------------------------------------------------------------
// State access. Plain aligned 32-bit volatile loads/stores are atomic on
// x86/x64; cross-process ordering is provided by the req/done events.
// ---------------------------------------------------------------------------
inline HostState shmLoadState(const ShmHeader* h) {
  return static_cast<HostState>(h->state);
}
inline void shmStoreState(ShmHeader* h, HostState s) {
  h->state = static_cast<int32_t>(s);
}

// Engine-side initialization of a freshly created mapping.
inline void shmInitHeader(ShmHeader* h, uint32_t numIn, uint32_t numOut,
                          uint32_t sampleRate) {
  h->magic = kShmMagic;
  h->version = kShmVersion;
  h->maxBlock = kMaxBlock;
  h->numIn = numIn;
  h->numOut = numOut;
  h->sampleRate = sampleRate;
  shmStoreState(h, HostState::Starting);
  h->blockFrames = 0;
  h->tempo = 120.0;
  h->ppqPos = 0.0;
  h->flags = 0;
  h->numMidiIn = 0;
  h->numParamChanges = 0;
  h->latencySamples = 0;
  h->numMidiOut = 0;
  h->numParamOut = 0;
}

// Host-side validation after opening the mapping.
inline bool shmValidateHeader(const ShmHeader* h) {
  return h && h->magic == kShmMagic && h->version == kShmVersion &&
         h->maxBlock == kMaxBlock &&
         h->numIn <= kMaxChannels && h->numOut <= kMaxChannels &&
         h->sampleRate > 0;
}

// Engine RT wait timeout for the done event: max(2, 2 × block duration) ms.
inline uint32_t shmWaitTimeoutMs(uint32_t blockFrames, uint32_t sampleRate) {
  if (sampleRate == 0) return 2;
  const uint32_t twiceBlockMs =
      static_cast<uint32_t>((2ull * 1000ull * blockFrames) / sampleRate);
  return twiceBlockMs < 2 ? 2 : twiceBlockMs;
}

// ---------------------------------------------------------------------------
// Kernel object names (SPEC §8). Base name: "mydaw_<enginePid>_<instanceId>";
// the pipe is "\\.\pipe\<base>"; the events are "<base>_req" / "<base>_done".
// ---------------------------------------------------------------------------
inline std::string ipcBaseName(uint32_t enginePid, uint64_t instanceId) {
  return "mydaw_" + std::to_string(enginePid) + "_" + std::to_string(instanceId);
}
inline std::string ipcPipeName(const std::string& baseName) {
  return "\\\\.\\pipe\\" + baseName;
}
inline std::string shmReqEventName(const std::string& shmName) {
  return shmName + "_req";
}
inline std::string shmDoneEventName(const std::string& shmName) {
  return shmName + "_done";
}
inline std::wstring shmReqEventName(const std::wstring& shmName) {
  return shmName + L"_req";
}
inline std::wstring shmDoneEventName(const std::wstring& shmName) {
  return shmName + L"_done";
}

} // namespace mydaw
