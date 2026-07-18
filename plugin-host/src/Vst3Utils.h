#pragma once
//
// plugin-host/src/Vst3Utils.h
//
// Helpers for the VST3 host side of mydaw-host{64,32} (SPEC §8.4):
//   * the MyDAW VST3 state-chunk container ('MD3S' + two length-prefixed
//     blobs: component state then controller state),
//   * UTF conversions (wide path <-> UTF-8, Vst::String128 -> UTF-8),
//   * VST3::UID parse/format,
//   * misc (speaker arrangement for a channel count, instrument category
//     detection, MemoryStream -> bytes).
//
// The chunk container + plain string helpers are SDK-independent so the
// MYDAW_NO_VST3 / MYDAW_HOST32_VST2_ONLY stub build still compiles them.
// Everything that touches Steinberg types lives behind MYDAW_VST3_DISABLED.
//
// base64 is NOT here — the pipe layer (H1) owns it (PluginAdapter.h rule:
// no JSON/transport concerns in the adapter layer).
//
#include <cstdint>
#include <span>
#include <string>
#include <vector>

#if (defined(MYDAW_NO_VST3) || defined(MYDAW_HOST32_VST2_ONLY)) && \
    !defined(MYDAW_VST3_DISABLED)
#define MYDAW_VST3_DISABLED 1
#endif

#if !defined(MYDAW_VST3_DISABLED)
#include "pluginterfaces/vst/vsttypes.h" // Vst::TChar / String128 / SpeakerArrangement

namespace Steinberg {
class MemoryStream;
}
namespace VST3 {
struct UID;
}
#endif

namespace mydaw {

// ---------------------------------------------------------------------------
// MyDAW VST3 state chunk container (SPEC §8.4):
//   { u32 'MD3S', u32 lenA, bytesA /*IComponent::getState*/,
//                 u32 lenB, bytesB /*IEditController::getState*/ }
// All integers little-endian. Engine persists the container opaquely as
// plugin-states/<instanceId>.bin.
// ---------------------------------------------------------------------------
// Bytes "MD3S" in memory => LE u32 ('S'<<24 | '3'<<16 | 'D'<<8 | 'M').
constexpr uint32_t kVst3ChunkMagic = 0x5333444Du;

void vst3PackChunk(std::span<const uint8_t> componentState,
                   std::span<const uint8_t> controllerState,
                   std::vector<uint8_t>& out);

// Strict parse (magic + exact length accounting). Returns false on anything
// that is not a well-formed 'MD3S' container.
bool vst3UnpackChunk(std::span<const uint8_t> chunk,
                     std::vector<uint8_t>& componentState,
                     std::vector<uint8_t>& controllerState);

// ---------------------------------------------------------------------------
// String helpers (SDK-independent).
// ---------------------------------------------------------------------------
std::string vst3WideToUtf8(const std::wstring& w);
std::wstring vst3Utf8ToWide(const std::string& s);

// ASCII case-insensitive equality (uids are hex strings).
bool vst3IEqualsAscii(const std::string& a, const std::string& b);

// Canonical uid form for comparisons: uppercase hex digits only (strips
// '{', '}', '-', spaces). Scan and load both normalize through this, so the
// engine-side uid string (SPEC §5.6 "vst3 = class GUID string") round-trips.
std::string vst3NormalizeUid(const std::string& uid);

// SPEC §5.6 isInstrument: subCategories string contains "Instrument".
bool vst3IsInstrumentCategory(const std::string& subCategories);

#if !defined(MYDAW_VST3_DISABLED)
// ---------------------------------------------------------------------------
// SDK-typed helpers.
// ---------------------------------------------------------------------------

// NUL-terminated UTF-16 (Vst::String128 et al) -> UTF-8, reading at most
// maxChars characters.
std::string vst3ToUtf8(const Steinberg::Vst::TChar* str, size_t maxChars = 128);

// 1 -> mono, 2 -> stereo, n -> first-n-speakers bitmask (v1 is stereo-centric;
// >2 only appears when a plugin refuses stereo).
Steinberg::Vst::SpeakerArrangement vst3ArrangementForChannels(int32_t channels);

// Copy the written portion of a MemoryStream into `out` (cursor untouched).
bool vst3StreamBytes(Steinberg::MemoryStream& stream, std::vector<uint8_t>& out);

// VST3::UID <-> string (COM format on Windows — matches UID::toString()).
bool vst3ParseUid(const std::string& s, VST3::UID& out);
std::string vst3UidToString(const VST3::UID& uid);
#endif // !MYDAW_VST3_DISABLED

} // namespace mydaw
