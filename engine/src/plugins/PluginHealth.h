// MyDAW — plugins/PluginHealth.h (E6)
// Durable per-plugin health records (SPEC §5.6): what happened the last time each plugin
// was LOADED into a session (event/pluginState crashed/timeout/failed) and the last time
// it was PROBED (plugins/probe, the automated load-test pass). This is the store behind
// "most reverb VSTs fail but aren't blacklisted" finally being visible: runtime failures
// used to be broadcast-and-forgotten, so a plugin that crashed the host on every project
// open looked identical to a healthy one everywhere except the moment it happened.
//
// Deliberately SEPARATE from the scan cache (plugin-cache.json): different writers
// (HostProcess callbacks / the prober vs the scanner worker, different threads),
// different lifetime (a full rescan rewrites the cache wholesale; health records must
// survive it). Records never influence scanning or the blacklist — the user decides.
//
// Persistence: %APPDATA%/MyDAW/plugin-health.json, debounced (mutations mark dirty; the
// next flush() ≥500 ms later writes). App calls flush() from its main-loop tick and once
// at shutdown. Thread-safety: all methods take the internal mutex. Non-RT only.

#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>

#include "../util/Json.h"

namespace mydaw {

class PluginHealth {
public:
    // One outcome section (load = real session load, probe = automated pass).
    struct Outcome {
        std::string verdict;  // "ok" | "load_failed"
        std::string message;  // host state message / probe error ("" for ok)
        int64_t whenMs = 0;   // wall clock, ms since epoch
        std::string log;      // probe only: condensed host output tail (<=8 KB)
        json stages;          // probe only: {"load":bool,"init":bool,...} (null otherwise)
    };

    struct Record {
        // Identity mirrors the UI's pluginKey: format|uid|bitness|path (shell uids are
        // not unique; the same uid at two paths is two records).
        std::string key;
        std::string path, uid, format, name;
        int bitness = 64;
        Outcome load;   // empty verdict = never recorded
        Outcome probe;  // empty verdict = never probed
    };

    static std::string makeKey(const std::string& format, const std::string& uid,
                               int bitness, const std::string& path);

    // Loads %APPDATA%/MyDAW/plugin-health.json (missing/corrupt -> empty).
    PluginHealth();
    explicit PluginHealth(std::string filePath); // tests

    // Upsert the load/probe section of `key`'s record (identity fields refreshed).
    void recordLoad(const Record& identity, const std::string& verdict,
                    const std::string& message);
    void recordProbe(const Record& identity, const std::string& verdict,
                     const std::string& message, const json& stages, const std::string& log);

    // Snapshot for plugins/getHealth. `logs` includes the probe log tails (single-file
    // detail); the list view omits them for size.
    json toJson(bool logs) const;
    bool find(const std::string& key, Record& out) const;

    // Debounced persistence: writes only when dirty AND >=500 ms since the last mutation
    // (a crash-restart storm must not thrash the disk). `force` writes any dirty state
    // immediately (shutdown).
    void flush(bool force = false);

private:
    void load();

    mutable std::mutex mutex_;
    std::string filePath_;
    std::unordered_map<std::string, Record> records_;
    bool dirty_ = false;
    int64_t lastMutationMs_ = 0;
};

} // namespace mydaw
