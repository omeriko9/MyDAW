// MyDAW — plugins/PluginProber.h (E6)
// The "automated pass" (SPEC §5.6): deep load-tests plugins through
// `mydaw-host{64,32}.exe --probe <path> [--uid u]` — load → init → process → getState —
// and records each verdict + host output into PluginHealth. Scan proves "enumerates";
// probe proves "actually comes up", which is exactly the gap the reverb VSTs that fail
// at load but were never blacklisted lived in.
//
// SERIAL by design, like the scanner: plugins may pop UI during init, and concurrent
// popups are a user nightmare (Omer, 2026-08-11 — do not parallelize). Fully
// out-of-process: never touches HostProcessManager or the audio graph, so probing is
// safe during playback. Children run BELOW_NORMAL priority.
//
// Threading: probeAsync runs one worker std::thread; callbacks fire on it. The caller
// (Api) is responsible for mutual exclusion with the scanner (both spawn hosts against
// the same files).

#pragma once

#include <atomic>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace mydaw {

class PluginHealth;

class PluginProber {
public:
    struct Target {
        std::string path;
        std::string uid;     // "" = first/only plugin (vst2); class GUID (vst3)
        std::string format;  // "vst2" | "vst3"
        int bitness = 64;
        std::string name;    // display, for progress + the health record
    };

    // verdict: "ok" | "load_failed" per target.
    using ProgressFn =
        std::function<void(int cur, int total, const Target& t, const std::string& verdict)>;
    using DoneFn = std::function<void(int passed, int failed, bool cancelled)>;

    explicit PluginProber(PluginHealth& health);
    ~PluginProber();

    PluginProber(const PluginProber&) = delete;
    PluginProber& operator=(const PluginProber&) = delete;

    void setHostPaths(const std::string& host64, const std::string& host32);

    // False (and no callbacks) when a probe run is already in flight.
    bool probeAsync(std::vector<Target> targets, ProgressFn progress, DoneFn done);

    // Cancel the running pass: the in-flight probe host is terminated, verdicts recorded
    // so far are kept, done(..., cancelled=true) fires. False when idle.
    bool cancelProbe();

    bool probing() const { return running_.load(std::memory_order_acquire); }

private:
    void workerMain(std::vector<Target> targets, ProgressFn progress, DoneFn done);

    PluginHealth& health_;
    std::string host64Path_;
    std::string host32Path_;

    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> cancel_{false};
    std::atomic<bool> destroying_{false};
};

} // namespace mydaw
