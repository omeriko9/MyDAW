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
    using ProgressFn = std::function<void(int cur, int total, const std::string& path, int found,
                                          int failedSoFar)>;
    // cancelled=true when a user cancel ended the scan early: the registry then holds the
    // completed work merged with the prior cache (partial results are kept, not discarded).
    // Never invoked for the destructor's shutdown cancel.
    using DoneFn = std::function<void(bool cancelled)>;

    // One cache record, keyed by file path: {path,size,mtimeMs} -> scan result.
    // Cache v2 (SPEC §8.3): `verdict` is the structured outcome; crash/timeout entries
    // are now KEPT (v1 erased them, losing all history the moment a user unblacklisted).
    // The "unblacklist must force a real rescan" invariant moved into the cache-hit rule:
    // failure verdicts never count as a hit, so the file is genuinely re-spawned.
    struct CacheEntry {
        std::string path;     // original-case absolute path
        int64_t size = 0;
        int64_t mtimeMs = 0;
        bool ok = false;      // false => did not yield plugins (verdict/error say why)
        // "ok" | "not_plugin" | "dep_missing" | "init_failed" | "scan_crashed" |
        // "scan_timeout" (empty only transiently for pre-v2 entries; loadCache migrates).
        std::string verdict;
        std::string error;
        // "<size>-<64-bit content hash>" (SPEC §8.3a). Identifies the BINARY, so copies
        // of one DLL across folders share it; empty for pre-v3 records until re-hashed.
        std::string contentKey;
        int64_t lastScanMs = 0;  // wall clock of the last real spawn (0 = unknown/v1)
        std::string hostTail;    // condensed host output, failure verdicts only (<=4 KB)
        std::vector<PluginInfo> plugins;

        bool failureVerdict() const {
            return verdict == "scan_crashed" || verdict == "scan_timeout";
        }
    };

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
    // the blacklist still applies. `onlyPaths` non-empty = a TARGETED scan: the folder
    // walk still resolves formats/bundles identically, but only files whose normalized
    // path is in the set are processed (used by unblacklist-and-rescan and the manager
    // page's per-file rescan). `progress` fires once per file as it is processed
    // (cur 1-based, found = plugins discovered so far incl. cache hits); `done` fires
    // after the registry has been replaced and the cache saved — cancelled or not.
    void scanAsync(bool full, std::vector<std::string> onlyPaths, ProgressFn progress,
                   DoneFn done);
    void scanAsync(bool full, ProgressFn progress, DoneFn done) {
        scanAsync(full, {}, std::move(progress), std::move(done));
    }

    // One-shot: the NEXT scan spawns its hosts with MYDAW_SCAN_TRACE (+VST2/REG trace)
    // forced on, so the failure hostTail captures the verbose load trace. Cleared when
    // that scan starts (plugins/scan {trace:true}, the manager page's Rescan-with-trace).
    void setTraceNextScan(bool on) { traceNext_.store(on, std::memory_order_release); }

    // Drop one file's cache record (plugins/relocate: the old path's record is obsolete).
    void dropCacheEntry(const std::string& path);

    // Cancel a running scan (SPEC §8.3): the in-flight scan host is terminated, work
    // completed so far is KEPT (cache saved, registry re-derived from it) and done(true)
    // fires. Returns false when no scan was running. Safe from any thread.
    bool cancelScan();

    bool scanning() const { return running_.load(std::memory_order_acquire); }

    // Copy of the scan cache for plugins/getHealth (SPEC §5.6): verdicts, timestamps and
    // failure host-output tails per file. Safe from any thread; a snapshot, not a view.
    std::vector<CacheEntry> snapshotCache() const;

    // Re-derive the registry from the cache, keeping ONLY plugins that live under a folder
    // currently configured on the registry. Call after the plugin folders change (startup and
    // plugins/setFolders): removing a folder drops its plugins immediately, and re-adding one
    // brings them straight back from the cache with no rescan. Built-ins are unaffected (the
    // registry keeps them in a separate list). No-op while a scan is running.
    void refreshFromCache();

private:
    struct FileTask {
        std::string path;     // UTF-8 absolute path of the binary to scan
        std::string format;   // "vst2" | "vst3" (by extension / bundle layout)
    };

    void loadCache();
    void saveCache();
    void populateRegistryFromCache();
    void workerMain(bool full, std::vector<std::string> onlyPaths, ProgressFn progress,
                    DoneFn done);
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
    std::atomic<bool> traceNext_{false}; // one-shot; consumed at scan start
    // Set (only) by the destructor before cancel_: the worker then skips done() — the
    // callback captures App, which is being torn down. A USER cancel keeps done(true).
    std::atomic<bool> destroying_{false};
};

} // namespace mydaw
