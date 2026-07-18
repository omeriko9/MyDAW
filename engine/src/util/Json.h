// MyDAW — util/Json.h
// Engine-wide alias for the vendored nlohmann::json (third_party/nlohmann/json.hpp) plus
// small lookup helpers. JSON is used on non-RT threads only (SPEC §4).

#pragma once

#include <nlohmann/json.hpp>

#include <string>

namespace mydaw {

using json = nlohmann::json;

// getOr<T>(j, key, def): returns j[key] converted to T, or `def` when j is not an object,
// the key is absent, the value is null, or the value cannot convert to T. Never throws.
template <typename T>
inline T getOr(const json& j, const char* key, const T& def) {
    if (!j.is_object())
        return def;
    const auto it = j.find(key);
    if (it == j.end() || it->is_null())
        return def;
    T out{};
    try {
        out = it->get<T>();
    } catch (...) {
        return def;
    }
    return out;
}

// Convenience overload so getOr(j, "name", "fallback") yields std::string.
inline std::string getOr(const json& j, const char* key, const char* def) {
    return getOr<std::string>(j, key, std::string(def ? def : ""));
}

// True if j is an object containing a non-null `key`.
inline bool hasKey(const json& j, const char* key) {
    if (!j.is_object())
        return false;
    const auto it = j.find(key);
    return it != j.end() && !it->is_null();
}

// Non-throwing parse; returns json::value_t::discarded on failure (check with is_discarded()).
inline json parseJson(const std::string& text) {
    return json::parse(text, nullptr, /*allow_exceptions=*/false);
}

} // namespace mydaw
