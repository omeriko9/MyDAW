// MyDAW — plugins/PluginRegistry.h (E6)
// In-memory registry of scanned plugins (PluginInfo per SPEC §5.6) + the configured scan
// folders.
// Populated at startup from %APPDATA%/MyDAW/plugin-cache.json by PluginScanner's
// constructor and replaced wholesale at the end of every scan.
//
// Thread-safety: all methods take an internal mutex (scanner worker writes, main/server
// threads read). byUid() returns a pointer into internal storage — it stays valid until
// the next scan completes (replaceAll/upsert); callers should copy the fields they need
// immediately. Non-RT only.

#pragma once

#include <cstddef>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "../util/Json.h"

namespace mydaw {

class Blacklist;

// SPEC §5.6. uid: vst2 = decimal uniqueID string; vst3 = class GUID string.
// NOTE(spec): for blacklisted files that crashed/timed out before reporting metadata we
// never learned a real uid, so the absolute path is used as a surrogate uid (it is unique
// and Blacklist::removeByUid matches paths too, so plugins/unblacklist {uid} still works).
struct PluginInfo {
    std::string uid;
    std::string format;   // "vst2" | "vst3"
    std::string path;     // absolute path of the plugin binary (UTF-8)
    int bitness = 64;     // 32 | 64
    std::string name;
    std::string vendor;
    std::string category;
    bool isInstrument = false;
    int numInputs = 0;
    int numOutputs = 0;
    bool blacklisted = false;
    std::string blacklistReason;

    // §5.6 wire shape: {uid, format, path, bitness, name, vendor, category, isInstrument,
    // numInputs, numOutputs, blacklisted?, blacklistReason?} (last two only when set).
    json toJson() const;
    static PluginInfo fromJson(const json& j);
};

class PluginRegistry {
public:
    // Seeds the current scan folders from the built-in defaults (SPEC §8.3): Common
    // Files/VST3, VSTPlugins, Steinberg/VSTPlugins, Common Files/VST2 — both Program
    // Files and (x86) variants.
    PluginRegistry();

    // Built-in scan folders exposed so settings/UI can restore them explicitly.
    static std::vector<std::string> defaultVst2Folders();
    static std::vector<std::string> defaultVst3Folders();

    // Snapshot of all known plugins with live blacklist flags applied.
    std::vector<PluginInfo> list() const;

    // First match by uid; prefers non-blacklisted entries, then 64-bit. nullptr if absent.
    // Pointer valid until the next scan completes — copy what you need.
    const PluginInfo* byUid(const std::string& uid) const;

    // Replaces the configured folders exactly as given (deduped case/slash-insensitive;
    // empties dropped). An empty list means "scan nothing" for that format.
    void setFolders(const std::vector<std::string>& vst2, const std::vector<std::string>& vst3);

    // {vst2 folders, vst3 folders} as currently configured.
    std::pair<std::vector<std::string>, std::vector<std::string>> folders() const;

    // --- E6-internal helpers (used by PluginScanner; safe for E9) -----------------

    // Atomically replaces every entry (end-of-scan publish).
    void replaceAll(std::vector<PluginInfo> entries);

    // Insert or replace one entry, keyed by (format, uid, bitness).
    void upsert(const PluginInfo& info);

    // Built-in ("stock") effects/instruments: always present in list()/byUid(), never
    // touched by scanning (replaceAll only replaces scanned entries). Seeded once at startup.
    void setBuiltins(std::vector<PluginInfo> builtins);

    // Attach the blacklist consulted by list()/byUid() so blacklisted/blacklistReason
    // are always current (e.g. right after plugins/unblacklist, before any rescan).
    void attachBlacklist(const Blacklist* blacklist);

    size_t size() const;

    // Convenience: json array of list() (session/hello, event/scanDone payloads).
    json listJson() const;

private:
    void refreshFlagsLocked() const; // re-evaluates blacklist flags; caller holds mutex_

    mutable std::mutex mutex_;
    mutable std::vector<PluginInfo> entries_; // mutable: const readers refresh flags
    std::vector<PluginInfo> builtins_;        // stock effects, immune to scan replaceAll
    std::vector<std::string> vst2Folders_;
    std::vector<std::string> vst3Folders_;
    const Blacklist* blacklist_ = nullptr;
};

} // namespace mydaw
