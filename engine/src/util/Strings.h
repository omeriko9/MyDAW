// MyDAW — util/Strings.h
// Header-only string helpers: trim / lower / startsWith (+ a few companions used across
// the engine). ASCII semantics only — sufficient for protocol tokens, file extensions, etc.

#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <vector>

namespace mydaw {

inline bool isAsciiSpace(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v';
}

inline std::string trim(std::string_view s) {
    size_t b = 0, e = s.size();
    while (b < e && isAsciiSpace(s[b])) ++b;
    while (e > b && isAsciiSpace(s[e - 1])) --e;
    return std::string(s.substr(b, e - b));
}

inline std::string lower(std::string_view s) {
    std::string out(s);
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

inline std::string upper(std::string_view s) {
    std::string out(s);
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return out;
}

inline bool startsWith(std::string_view s, std::string_view prefix) {
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

inline bool endsWith(std::string_view s, std::string_view suffix) {
    return s.size() >= suffix.size() &&
           s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

// Case-insensitive (ASCII) equality — e.g. file-extension comparisons.
inline bool iequals(std::string_view a, std::string_view b) {
    if (a.size() != b.size())
        return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (std::tolower(static_cast<unsigned char>(a[i])) !=
            std::tolower(static_cast<unsigned char>(b[i])))
            return false;
    }
    return true;
}

inline bool iendsWith(std::string_view s, std::string_view suffix) {
    return s.size() >= suffix.size() && iequals(s.substr(s.size() - suffix.size()), suffix);
}

// Splits on `delim`; empty segments skipped unless keepEmpty.
inline std::vector<std::string> split(std::string_view s, char delim, bool keepEmpty = false) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= s.size(); ++i) {
        if (i == s.size() || s[i] == delim) {
            if (i > start || keepEmpty)
                out.emplace_back(s.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

} // namespace mydaw
