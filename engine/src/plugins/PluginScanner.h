// MyDAW — plugins/PluginScanner.h (E6)
// Async plugin scanner per SPEC §8.3:
//   * worker thread walks the registry's configured folders recursively for .dll and
//     .vst3 files (.vst3 bundle directories -> Contents/x86_64-win/*.vst3 and
//     Contents/x86-win/*.vst3),
//   * routes each binary by its PE IMAGE_FILE_HEADER.Machine field
//     (0x8664 -> mydaw-host64.exe, 0x14c -> mydaw-host32.exe),
//   * spawns `<host>.exe --scan <path>` with captured stdout (CREATE_NO_WINDOW),
//     20 s timeout per file -> TerminateProcess + blacklist("scan timeout"),
//     crash / nonzero exit without a result line -> blacklist("crashed during scan (0x..)"),
//   * parses the host's one-line JSON {ok, plugins:[...]} (ScannedPlugin fields per
//     plugin-host/src/PluginAdapter.h) and merges the results into the PluginRegistry
//     and the persistent cache %APPDATA%/MyDAW/plugin-cache.json keyed {path,size,mtimeMs}.
// Files whose host reports ok:false ("no VST entry" etc) are cached as non-plugins —
// NOT blacklisted. Blacklisted paths are never spawned (the blacklist persists; a *full*
// rescan only ignores the cache). Cache hits skip spawning entirely unless full==true.
//
// Construction: PluginScanner(registry, blacklist) immediately loads the cache and
// pre-populates the registry from it (plus synthetic entries for blacklisted files), so
// session/hello has a plugin list before any scan runs. It also attaches the blacklist
// to the registry for live blacklisted-flag reporting.
//
// Threading: scanAsync runs on one worker std::thread; progress/done callbacks fire on
// that worker thread (E9 marshals/broadcasts as needed; HttpWsServer::broadcast is
// thread-safe). If a scan is already running, scanAsync logs a warning and returns
// without starting a second one (no callbacks invoked). The destructor cancels any
// running scan (terminating the in-flight scan host) and joins. Non-RT only.

#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "PluginRegistry.h" // PluginInfo

namespace mydaw {

class Blacklist;

class PluginScanner {
public:
    using ProgressFn = std::function<void(int cur, int total, const std::string& path, int found)>;
    using DoneFn = std::function<void()>;

    // Loads %APPDATA%/MyDAW/plugin-cache.json and pre-populates `registry` (see above).
    // Both references must outlive the scanner.
    PluginScanner(PluginRegistry& registry, Blacklist& blacklist);
    ~PluginScanner();

    PluginScanner(const PluginScanner&) = delete;
    PluginScanner& operator=(const PluginScanner&) = delete;

    // Absolute paths of mydaw-host64.exe / mydaw-host32.exe (E9 resolves per SPEC §3).
    // An empty/missing host32 means x86 binaries are skipped with a log line (not
    // blacklisted); likewise host64 for x64. If never called, the scanner falls back to
    // "<exeDir>/mydaw-host64.exe" / "<exeDir>/mydaw-host32.exe" when those files exist.
    void setHostPaths(const std::string& host64, const std::string& host32);

    // Starts the async scan. full=true ignores the cache (every file is re-spawned);
    // the blacklist still applies. `progress` fires once per file as it is processed
    // (cur 1-based, found = plugins discovered so far incl. cache hits); `done` fires
    // after the registry has been replaced and the cache saved.
    void scanAsync(bool full, ProgressFn progress, DoneFn done);

    bool scanning() const { return running_.load(std::memory_order_acquire); }

    // Re-derive the registry from the cache, keeping ONLY plugins that live under a folder
    // currently configured on the registry. Call after the plugin folders change (startup and
    // plugins/setFolders): removing a folder drops its plugins immediately, and re-adding one
    // brings them straight back from the cache with no rescan. Built-ins are unaffected (the
    // registry keeps them in a separate list). No-op while a scan is running.
    void refreshFromCache();

private:
    // One cache record, keyed by file path: {path,size,mtimeMs} -> scan result.
    struct CacheEntry {
        std::string path;     // original-case absolute path
        int64_t size = 0;
        int64_t mtimeMs = 0;
        bool ok = false;      // false => known non-plugin (error explains why)
        std::string error;
        std::vector<PluginInfo> plugins;
    };

    struct FileTask {
        std::string path;     // UTF-8 absolute path of the binary to scan
        std::string format;   // "vst2" | "vst3" (by extension / bundle layout)
    };

    void loadCache();
    void saveCache();
    void populateRegistryFromCache();
    void workerMain(bool full, ProgressFn progress, DoneFn done);
    std::vector<FileTask> collectFiles() const;

    PluginRegistry& registry_;
    Blacklist& blacklist_;

    mutable std::mutex mutex_;             // host paths + cache map
    std::string host64Path_;
    std::string host32Path_;
    std::map<std::string, CacheEntry> cache_; // key: normalized (lower, fwd-slash) path

    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> cancel_{false};
};

} // namespace mydaw
