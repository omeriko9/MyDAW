// MyDAW — util/Base64.h
//
// Header-only base64 (standard alphabet, '=' padding; decode skips whitespace).
// Twin of the copies in plugins/HostProcess.cpp (pipe chunkB64) and
// plugin-host/src/Base64.h — this one is for model-side users that persist
// binary blobs inside project JSON (e.g. a DOP chain entry's inline VST state).

#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace mydaw {

inline std::string base64Encode(const std::vector<uint8_t>& data) {
    static const char kAlpha[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((data.size() + 2) / 3) * 4);
    size_t i = 0;
    while (i + 2 < data.size()) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) |
                           static_cast<uint32_t>(data[i + 2]);
        out.push_back(kAlpha[(v >> 18) & 63]);
        out.push_back(kAlpha[(v >> 12) & 63]);
        out.push_back(kAlpha[(v >> 6) & 63]);
        out.push_back(kAlpha[v & 63]);
        i += 3;
    }
    const size_t rem = data.size() - i;
    if (rem == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kAlpha[(v >> 18) & 63]);
        out.push_back(kAlpha[(v >> 12) & 63]);
        out.push_back('=');
        out.push_back('=');
    } else if (rem == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kAlpha[(v >> 18) & 63]);
        out.push_back(kAlpha[(v >> 12) & 63]);
        out.push_back(kAlpha[(v >> 6) & 63]);
        out.push_back('=');
    }
    return out;
}

// False on any character outside the alphabet (whitespace/padding is skipped).
inline bool base64Decode(const std::string& s, std::vector<uint8_t>& out) {
    static const char kAlpha[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int8_t rev[256];
    std::memset(rev, -1, sizeof(rev));
    for (int i = 0; i < 64; ++i)
        rev[static_cast<unsigned char>(kAlpha[i])] = static_cast<int8_t>(i);
    out.clear();
    out.reserve((s.size() / 4) * 3);
    uint32_t acc = 0;
    int bits = 0;
    for (const char ch : s) {
        if (ch == '=' || ch == '\r' || ch == '\n' || ch == ' ' || ch == '\t')
            continue;
        const int8_t v = rev[static_cast<unsigned char>(ch)];
        if (v < 0)
            return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>((acc >> bits) & 0xFF));
        }
    }
    return true;
}

} // namespace mydaw
