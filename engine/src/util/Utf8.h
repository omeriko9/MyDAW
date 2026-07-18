// MyDAW — util/Utf8.h
// Header-only UTF-8 validation / sanitization for import boundaries. nlohmann::json
// THROWS on invalid UTF-8 (strict default error handler at dump time), so NO string may
// reach the Model — and therefore project.json / autosave / recent.json — unsanitized.
// Import code (cpr lpstr decode, SMF track names) is the chokepoint; these helpers
// implement it. Strict UTF-8 per RFC 3629: overlong encodings, UTF-16 surrogate
// codepoints and values > U+10FFFF are invalid.
//
// Non-RT use only (like all string handling).

#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace mydaw {

// Appends one codepoint as UTF-8. Callers pass cp <= 0x10FFFF and non-surrogates
// (values above U+10FFFF would encode an invalid sequence).
inline void appendCodepointUtf8(std::string& s, uint32_t cp) {
    if (cp < 0x80) {
        s.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
        s.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        s.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        s.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        s.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        s.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        s.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

// True when `s` is valid UTF-8 (control characters are valid — they are the caller's
// policy, not an encoding concern).
inline bool isValidUtf8(std::string_view s) {
    const uint8_t* p = reinterpret_cast<const uint8_t*>(s.data());
    const size_t n = s.size();
    size_t i = 0;
    while (i < n) {
        const uint8_t c = p[i];
        if (c < 0x80) {
            ++i;
            continue;
        }
        int len = 0;
        uint32_t cp = 0;
        if ((c & 0xE0) == 0xC0) { len = 2; cp = c & 0x1F; }
        else if ((c & 0xF0) == 0xE0) { len = 3; cp = c & 0x0F; }
        else if ((c & 0xF8) == 0xF0) { len = 4; cp = c & 0x07; }
        else return false; // stray continuation byte or 0xFE/0xFF
        if (i + static_cast<size_t>(len) > n)
            return false; // truncated sequence
        for (int k = 1; k < len; ++k) {
            if ((p[i + k] & 0xC0) != 0x80)
                return false;
            cp = (cp << 6) | (p[i + k] & 0x3F);
        }
        if ((len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) ||
            (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) ||
            (cp >= 0xD800 && cp <= 0xDFFF))
            return false; // overlong / out of range / surrogate
        i += static_cast<size_t>(len);
    }
    return true;
}

// Validate UTF-8; invalid sequences / control chars become '?' (tab becomes a space).
// This is the cpr-import lpstr policy (every decoded string passes through here or
// through a legacy-codepage transcode that only emits valid UTF-8).
inline std::string sanitizeUtf8(const uint8_t* p, size_t n) {
    std::string out;
    out.reserve(n);
    size_t i = 0;
    while (i < n) {
        const uint8_t c = p[i];
        if (c < 0x20) { // control chars
            out.push_back(c == '\t' ? ' ' : '?');
            ++i;
            continue;
        }
        if (c < 0x80) {
            out.push_back(static_cast<char>(c));
            ++i;
            continue;
        }
        int len = 0;
        uint32_t cp = 0;
        if ((c & 0xE0) == 0xC0) { len = 2; cp = c & 0x1F; }
        else if ((c & 0xF0) == 0xE0) { len = 3; cp = c & 0x0F; }
        else if ((c & 0xF8) == 0xF0) { len = 4; cp = c & 0x07; }
        else { out.push_back('?'); ++i; continue; }
        if (i + static_cast<size_t>(len) > n) { out.push_back('?'); ++i; continue; }
        bool ok = true;
        for (int k = 1; k < len; ++k) {
            if ((p[i + k] & 0xC0) != 0x80) { ok = false; break; }
            cp = (cp << 6) | (p[i + k] & 0x3F);
        }
        if (!ok || (len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) ||
            (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) ||
            (cp >= 0xD800 && cp <= 0xDFFF)) {
            out.push_back('?');
            ++i;
            continue;
        }
        out.append(reinterpret_cast<const char*>(p + i), static_cast<size_t>(len));
        i += static_cast<size_t>(len);
    }
    return out;
}

inline std::string sanitizeUtf8(std::string_view s) {
    return sanitizeUtf8(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

// Latin-1 -> UTF-8: every byte maps to U+00XX, so the result is ALWAYS valid UTF-8.
// Fallback for legacy 8-bit strings that fail isValidUtf8 (e.g. track names in
// 90s/2000s SMF exports): Western-European accents survive verbatim; other 8-bit
// codepages degrade to wrong-but-valid Latin-1 glyphs instead of crashing json::dump.
inline std::string latin1ToUtf8(std::string_view s) {
    std::string out;
    out.reserve(s.size() * 2);
    for (const char ch : s) {
        const uint8_t c = static_cast<uint8_t>(ch);
        if (c < 0x80)
            out.push_back(ch);
        else
            appendCodepointUtf8(out, c);
    }
    return out;
}

} // namespace mydaw
