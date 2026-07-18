//
// plugin-host/src/Vst3Utils.cpp — see Vst3Utils.h.
//
#include "Vst3Utils.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <cctype>
#include <cstring>

#if !defined(MYDAW_VST3_DISABLED)
#include "pluginterfaces/vst/vstspeaker.h" // Steinberg::Vst::SpeakerArr
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/utility/uid.h"
#endif

namespace mydaw {

// ---------------------------------------------------------------------------
// Chunk container
// ---------------------------------------------------------------------------
namespace {

void appendU32Le(std::vector<uint8_t>& out, uint32_t v) {
    out.push_back(static_cast<uint8_t>(v & 0xFFu));
    out.push_back(static_cast<uint8_t>((v >> 8) & 0xFFu));
    out.push_back(static_cast<uint8_t>((v >> 16) & 0xFFu));
    out.push_back(static_cast<uint8_t>((v >> 24) & 0xFFu));
}

uint32_t readU32Le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

} // namespace

void vst3PackChunk(std::span<const uint8_t> componentState,
                   std::span<const uint8_t> controllerState,
                   std::vector<uint8_t>& out) {
    out.clear();
    out.reserve(12 + componentState.size() + controllerState.size());
    appendU32Le(out, kVst3ChunkMagic);
    appendU32Le(out, static_cast<uint32_t>(componentState.size()));
    out.insert(out.end(), componentState.begin(), componentState.end());
    appendU32Le(out, static_cast<uint32_t>(controllerState.size()));
    out.insert(out.end(), controllerState.begin(), controllerState.end());
}

bool vst3UnpackChunk(std::span<const uint8_t> chunk,
                     std::vector<uint8_t>& componentState,
                     std::vector<uint8_t>& controllerState) {
    componentState.clear();
    controllerState.clear();
    if (chunk.size() < 12)
        return false;
    if (readU32Le(chunk.data()) != kVst3ChunkMagic)
        return false;
    const uint64_t total = chunk.size();
    const uint64_t lenA = readU32Le(chunk.data() + 4);
    if (8 + lenA + 4 > total)
        return false;
    const uint64_t lenB = readU32Le(chunk.data() + 8 + lenA);
    if (12 + lenA + lenB != total)
        return false;
    componentState.assign(chunk.data() + 8, chunk.data() + 8 + lenA);
    controllerState.assign(chunk.data() + 12 + lenA, chunk.data() + 12 + lenA + lenB);
    return true;
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------
std::string vst3WideToUtf8(const std::wstring& w) {
    if (w.empty())
        return {};
    const int n = ::WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()),
                                        nullptr, 0, nullptr, nullptr);
    if (n <= 0)
        return {};
    std::string out(static_cast<size_t>(n), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), n,
                          nullptr, nullptr);
    return out;
}

std::wstring vst3Utf8ToWide(const std::string& s) {
    if (s.empty())
        return {};
    const int n = ::MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                                        nullptr, 0);
    if (n <= 0)
        return {};
    std::wstring out(static_cast<size_t>(n), L'\0');
    ::MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
    return out;
}

bool vst3IEqualsAscii(const std::string& a, const std::string& b) {
    if (a.size() != b.size())
        return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (std::toupper(static_cast<unsigned char>(a[i])) !=
            std::toupper(static_cast<unsigned char>(b[i])))
            return false;
    }
    return true;
}

std::string vst3NormalizeUid(const std::string& uid) {
    std::string out;
    out.reserve(uid.size());
    for (char c : uid) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (std::isxdigit(u))
            out.push_back(static_cast<char>(std::toupper(u)));
        else if (c == '{' || c == '}' || c == '-' || c == ' ')
            continue; // tolerated decorations
        // any other character is simply dropped; comparisons stay best-effort
    }
    return out;
}

bool vst3IsInstrumentCategory(const std::string& subCategories) {
    return subCategories.find("Instrument") != std::string::npos;
}

#if !defined(MYDAW_VST3_DISABLED)
// ---------------------------------------------------------------------------
// SDK-typed helpers
// ---------------------------------------------------------------------------
std::string vst3ToUtf8(const Steinberg::Vst::TChar* str, size_t maxChars) {
    if (!str)
        return {};
    size_t len = 0;
    while (len < maxChars && str[len] != 0)
        ++len;
    if (len == 0)
        return {};
    // Vst::TChar is UTF-16; wchar_t is 16-bit on Windows.
    static_assert(sizeof(Steinberg::Vst::TChar) == sizeof(wchar_t), "UTF-16 host");
    const wchar_t* w = reinterpret_cast<const wchar_t*>(str);
    const int n = ::WideCharToMultiByte(CP_UTF8, 0, w, static_cast<int>(len), nullptr, 0,
                                        nullptr, nullptr);
    if (n <= 0)
        return {};
    std::string out(static_cast<size_t>(n), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, w, static_cast<int>(len), out.data(), n, nullptr,
                          nullptr);
    return out;
}

Steinberg::Vst::SpeakerArrangement vst3ArrangementForChannels(int32_t channels) {
    using namespace Steinberg::Vst;
    if (channels <= 0)
        return 0;
    if (channels == 1)
        return SpeakerArr::kMono;
    if (channels == 2)
        return SpeakerArr::kStereo;
    if (channels >= 64)
        channels = 64;
    return (channels == 64) ? ~SpeakerArrangement(0)
                            : ((SpeakerArrangement(1) << channels) - 1);
}

bool vst3StreamBytes(Steinberg::MemoryStream& stream, std::vector<uint8_t>& out) {
    out.clear();
    const Steinberg::TSize size = stream.getSize();
    const char* data = stream.getData();
    if (size <= 0 || !data)
        return true; // empty state is valid
    out.assign(reinterpret_cast<const uint8_t*>(data),
               reinterpret_cast<const uint8_t*>(data) + size);
    return true;
}

bool vst3ParseUid(const std::string& s, VST3::UID& out) {
    const std::string norm = vst3NormalizeUid(s);
    if (norm.size() != 32)
        return false;
    auto parsed = VST3::UID::fromString(norm);
    if (!parsed)
        return false;
    out = *parsed;
    return true;
}

std::string vst3UidToString(const VST3::UID& uid) {
    return uid.toString();
}
#endif // !MYDAW_VST3_DISABLED

} // namespace mydaw
