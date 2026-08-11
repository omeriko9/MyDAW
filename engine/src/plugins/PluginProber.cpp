// MyDAW — plugins/PluginProber.cpp (E6). See PluginProber.h.

#include "PluginProber.h"

#include <utility>

#include "../util/Json.h"
#include "../util/Log.h"
#include "../util/Paths.h"
#include "../util/Strings.h"
#include "ChildProc.h"
#include "PluginHealth.h"

namespace mydaw {

namespace {

constexpr uint32_t kProbeTimeoutMs = 30000; // deeper than a scan; soundbanks may load

// Last stdout line that parses as a JSON object containing "ok" (same contract as the
// scanner: plugin printf noise during load is harmless).
json extractResultJson(const std::string& output) {
    json result;
    size_t pos = 0;
    while (pos < output.size()) {
        size_t end = output.find('\n', pos);
        if (end == std::string::npos)
            end = output.size();
        std::string line = trim(output.substr(pos, end - pos));
        if (!line.empty() && line.front() == '{') {
            const json j = parseJson(line);
            if (!j.is_discarded() && j.is_object() && j.contains("ok"))
                result = j;
        }
        pos = end + 1;
    }
    return result;
}

std::string condenseTail(const std::string& output) {
    // Keep the last 8 KB verbatim (newlines preserved — this feeds a <pre>).
    constexpr size_t kMax = 8000;
    return output.size() > kMax ? output.substr(output.size() - kMax) : output;
}

} // namespace

PluginProber::PluginProber(PluginHealth& health) : health_(health) {}

PluginProber::~PluginProber() {
    destroying_.store(true, std::memory_order_release);
    cancel_.store(true, std::memory_order_release);
    if (thread_.joinable())
        thread_.join();
}

void PluginProber::setHostPaths(const std::string& host64, const std::string& host32) {
    host64Path_ = host64;
    host32Path_ = host32;
}

bool PluginProber::probeAsync(std::vector<Target> targets, ProgressFn progress, DoneFn done) {
    if (running_.load(std::memory_order_acquire)) {
        Log::warn("PluginProber: probe already running — request ignored");
        return false;
    }
    if (thread_.joinable())
        thread_.join();
    cancel_.store(false, std::memory_order_release);
    running_.store(true, std::memory_order_release);
    thread_ = std::thread([this, ts = std::move(targets), p = std::move(progress),
                           d = std::move(done)]() mutable {
        workerMain(std::move(ts), std::move(p), std::move(d));
    });
    return true;
}

bool PluginProber::cancelProbe() {
    if (!running_.load(std::memory_order_acquire))
        return false;
    cancel_.store(true, std::memory_order_release);
    return true;
}

void PluginProber::workerMain(std::vector<Target> targets, ProgressFn progress, DoneFn done) {
    std::string host64 = host64Path_;
    std::string host32 = host32Path_;
    if (host64.empty()) {
        const std::string fallback = pathJoin(exeDir(), "mydaw-host64.exe");
        if (fileExists(fallback))
            host64 = fallback;
    }
    if (host32.empty()) {
        const std::string fallback = pathJoin(exeDir(), "mydaw-host32.exe");
        if (fileExists(fallback))
            host32 = fallback;
    }

    const int total = static_cast<int>(targets.size());
    Log::info("PluginProber: probing %d plugin(s)", total);
    int passed = 0;
    int failed = 0;
    bool cancelled = false;

    for (int i = 0; i < total; ++i) {
        if (cancel_.load(std::memory_order_relaxed)) {
            cancelled = true;
            break;
        }
        const Target& t = targets[static_cast<size_t>(i)];
        const std::string& host = (t.bitness == 32) ? host32 : host64;
        std::string verdict = "load_failed";
        std::string message;
        json stages;
        std::string log;

        if (host.empty() || !fileExists(host)) {
            message = "no " + std::to_string(t.bitness) + "-bit probe host available";
        } else {
            std::wstring cmd = L"\"" + utf8ToWide(host) + L"\" --probe \"" +
                               utf8ToWide(t.path) + L"\"";
            if (!t.uid.empty())
                cmd += L" --uid \"" + utf8ToWide(t.uid) + L"\"";
            if (!t.format.empty())
                cmd += L" --format " + utf8ToWide(t.format);
            const ChildProcOutcome r = runCaptureProcess(
                cmd, kProbeTimeoutMs, cancel_, /*forceTraceEnv=*/false,
                /*belowNormalPriority=*/true);
            if (r.cancelled) {
                cancelled = true;
                break; // nothing recorded for a half-probed plugin
            }
            log = condenseTail(r.output);
            if (!r.spawned) {
                message = "probe host launch failed: " + r.spawnError;
            } else if (r.timedOut) {
                message = "probe timeout (30s)";
            } else {
                const json line = extractResultJson(r.output);
                if (line.is_object()) {
                    if (line.contains("stages") && line["stages"].is_object())
                        stages = line["stages"];
                    if (getOr<bool>(line, "ok", false))
                        verdict = "ok";
                    else
                        message = getOr(line, "error", "probe failed");
                } else {
                    message = "probe host crashed (0x" +
                              std::to_string(r.exitCode) + ") without a result";
                }
            }
        }

        PluginHealth::Record id;
        id.key = PluginHealth::makeKey(t.format, t.uid.empty() ? t.path : t.uid,
                                       t.bitness, t.path);
        id.path = t.path;
        id.uid = t.uid.empty() ? t.path : t.uid;
        id.format = t.format;
        id.name = t.name;
        id.bitness = t.bitness;
        health_.recordProbe(id, verdict, message, stages, log);
        if (verdict == "ok")
            ++passed;
        else
            ++failed;
        if (progress)
            progress(i + 1, total, t, verdict);
    }

    Log::info("PluginProber: done — %d passed, %d failed%s", passed, failed,
              cancelled ? " (cancelled)" : "");
    health_.flush(/*force=*/true); // the pass's verdicts land before done() broadcasts
    if (!destroying_.load(std::memory_order_acquire) && done)
        done(passed, failed, cancelled);
    running_.store(false, std::memory_order_release);
}

} // namespace mydaw
