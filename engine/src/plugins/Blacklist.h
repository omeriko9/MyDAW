// MyDAW — plugins/Blacklist.h (E6)
// Persistent plugin blacklist per SPEC §8.3: %APPDATA%/MyDAW/blacklist.json with entries
// {uid?, path, reason, when ISO8601}. Plugins land here when their scan host crashes or
// times out; blacklisted paths are skipped by the scanner until the user unblacklists
// (plugins/unblacklist {uid}). The blacklist persists across full rescans.
//
// Thread-safety: all methods take an internal mutex (scanner worker adds while the
// main/server thread reads). Non-RT only (file IO on every mutation).

#pragma once

#include <mutex>
#include <string>
#include <vector>

#include "../util/Json.h"

namespace mydaw {

struct BlacklistEntry {
    std::string uid;    // may be empty: a crash/timeout during scan happens before we
                        // ever learn the plugin's uid. The registry then uses the path
                        // as a surrogate uid (see PluginRegistry.h).
    std::string path;   // absolute path of the plugin binary (UTF-8)
    std::string reason; // e.g. "scan timeout", "crashed during scan (0xC0000005)"
    std::string when;   // ISO8601 UTC, e.g. "2026-06-11T12:34:56Z"
};

class Blacklist {
public:
    // Loads %APPDATA%/MyDAW/blacklist.json (missing/corrupt file -> empty list).
    Blacklist();
    // Custom file location (tests).
    explicit Blacklist(std::string filePath);

    // True if `pathOrUid` matches any entry's uid (exact) or path (case-insensitive,
    // slash-direction-insensitive — Windows path semantics).
    bool contains(const std::string& pathOrUid) const;

    // Copies the matching entry out; returns false if not blacklisted.
    bool find(const std::string& pathOrUid, BlacklistEntry& out) const;

    // Adds (or replaces, keyed by path) an entry and saves immediately. `uid` may be "".
    void add(const std::string& uid, const std::string& path, const std::string& reason);

    // Removes every entry whose uid matches exactly OR whose path matches `uid`
    // (case-insensitive) — the latter covers the path-surrogate uids the registry
    // synthesizes for plugins that crashed before reporting a real uid.
    // Returns true if anything was removed; saves immediately.
    bool removeByUid(const std::string& uid);

    // JSON array of entries [{uid?, path, reason, when}] (uid omitted when empty).
    json toJson() const;

    std::vector<BlacklistEntry> entries() const;
    size_t size() const;

private:
    void load();
    void saveLocked() const; // caller holds mutex_

    mutable std::mutex mutex_;
    std::string filePath_;
    std::vector<BlacklistEntry> entries_;
};

} // namespace mydaw
