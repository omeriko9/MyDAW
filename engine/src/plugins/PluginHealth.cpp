// MyDAW — plugins/PluginHealth.cpp (E6). See PluginHealth.h.

#include "PluginHealth.h"

#include <chrono>
#include <cstdio>
#include <fstream>
#include <sstream>

#include "../util/Log.h"
#include "../util/Paths.h"
#include "../util/Strings.h"

namespace mydaw {

namespace {

constexpr int64_t kFlushDebounceMs = 500;
constexpr size_t kMaxLogBytes = 8000;

int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// Atomic-ish write (same shape as Blacklist.cpp's).
bool writeFileAtomic(const std::string& path, const std::string& text) {
    const std::string tmp = path + ".tmp";
    {
        std::ofstream f(utf8ToWide(tmp), std::ios::binary | std::ios::trunc);
        if (!f.is_open())
            return false;
        f.write(text.data(), static_cast<std::streamsize>(text.size()));
        if (!f.good())
            return false;
    }
#if defined(_WIN32)
    std::remove(path.c_str()); // ANSI-path limitation acceptable: %APPDATA%/MyDAW is ours
#endif
    if (std::rename(tmp.c_str(), path.c_str()) != 0) {
        std::ofstream f(utf8ToWide(path), std::ios::binary | std::ios::trunc);
        if (!f.is_open())
            return false;
        f.write(text.data(), static_cast<std::streamsize>(text.size()));
        std::remove(tmp.c_str());
        return f.good();
    }
    return true;
}

std::string readFileText(const std::string& path) {
    std::ifstream f(utf8ToWide(path), std::ios::binary);
    if (!f.is_open())
        return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

json outcomeToJson(const PluginHealth::Outcome& o, bool logs) {
    json j{{"verdict", o.verdict}, {"whenMs", o.whenMs}};
    if (!o.message.empty())
        j["message"] = o.message;
    if (!o.stages.is_null())
        j["stages"] = o.stages;
    if (logs && !o.log.empty())
        j["log"] = o.log;
    return j;
}

void outcomeFromJson(const json& j, PluginHealth::Outcome& o) {
    if (!j.is_object())
        return;
    o.verdict = getOr(j, "verdict", "");
    o.message = getOr(j, "message", "");
    o.whenMs = getOr<int64_t>(j, "whenMs", 0);
    o.log = getOr(j, "log", "");
    const auto it = j.find("stages");
    o.stages = (it != j.end() && it->is_object()) ? *it : json();
}

} // namespace

std::string PluginHealth::makeKey(const std::string& format, const std::string& uid,
                                  int bitness, const std::string& path) {
    // Mirrors ui/src/lib/ids.ts pluginKey — path included because shell uids collide.
    return format + "|" + uid + "|" + std::to_string(bitness) + "|" + path;
}

PluginHealth::PluginHealth() : filePath_(pathJoin(appDataDir(), "plugin-health.json")) {
    load();
}

PluginHealth::PluginHealth(std::string filePath) : filePath_(std::move(filePath)) {
    load();
}

void PluginHealth::load() {
    std::lock_guard<std::mutex> lock(mutex_);
    records_.clear();
    if (!fileExists(filePath_))
        return;
    const json j = parseJson(readFileText(filePath_));
    if (j.is_discarded() || !j.is_object() || !j.contains("records") ||
        !j["records"].is_object()) {
        Log::warn("PluginHealth: failed to parse %s — starting empty", filePath_.c_str());
        return;
    }
    for (const auto& [key, jr] : j["records"].items()) {
        if (!jr.is_object())
            continue;
        Record r;
        r.key = key;
        r.path = getOr(jr, "path", "");
        r.uid = getOr(jr, "uid", "");
        r.format = getOr(jr, "format", "");
        r.name = getOr(jr, "name", "");
        r.bitness = getOr<int>(jr, "bitness", 64);
        if (jr.contains("load"))
            outcomeFromJson(jr["load"], r.load);
        if (jr.contains("probe"))
            outcomeFromJson(jr["probe"], r.probe);
        records_[key] = std::move(r);
    }
}

void PluginHealth::recordLoad(const Record& identity, const std::string& verdict,
                              const std::string& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    Record& r = records_[identity.key];
    r.key = identity.key;
    r.path = identity.path;
    r.uid = identity.uid;
    r.format = identity.format;
    r.name = identity.name;
    r.bitness = identity.bitness;
    r.load.verdict = verdict;
    r.load.message = message;
    r.load.whenMs = nowMs();
    dirty_ = true;
    lastMutationMs_ = r.load.whenMs;
}

void PluginHealth::recordProbe(const Record& identity, const std::string& verdict,
                               const std::string& message, const json& stages,
                               const std::string& log) {
    std::lock_guard<std::mutex> lock(mutex_);
    Record& r = records_[identity.key];
    r.key = identity.key;
    r.path = identity.path;
    r.uid = identity.uid;
    r.format = identity.format;
    r.name = identity.name;
    r.bitness = identity.bitness;
    r.probe.verdict = verdict;
    r.probe.message = message;
    r.probe.whenMs = nowMs();
    r.probe.stages = stages;
    r.probe.log = log.size() > kMaxLogBytes ? log.substr(log.size() - kMaxLogBytes) : log;
    dirty_ = true;
    lastMutationMs_ = r.probe.whenMs;
}

json PluginHealth::toJson(bool logs) const {
    std::lock_guard<std::mutex> lock(mutex_);
    json out = json::object();
    for (const auto& [key, r] : records_) {
        json jr{{"path", r.path},
                {"uid", r.uid},
                {"format", r.format},
                {"name", r.name},
                {"bitness", r.bitness}};
        if (!r.load.verdict.empty())
            jr["load"] = outcomeToJson(r.load, logs);
        if (!r.probe.verdict.empty())
            jr["probe"] = outcomeToJson(r.probe, logs);
        out[key] = std::move(jr);
    }
    return out;
}

bool PluginHealth::find(const std::string& key, Record& out) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = records_.find(key);
    if (it == records_.end())
        return false;
    out = it->second;
    return true;
}

void PluginHealth::flush(bool force) {
    json root;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!dirty_)
            return;
        if (!force && nowMs() - lastMutationMs_ < kFlushDebounceMs)
            return; // a crash-restart storm settles before we touch the disk
        json recs = json::object();
        for (const auto& [key, r] : records_) {
            json jr{{"path", r.path},
                    {"uid", r.uid},
                    {"format", r.format},
                    {"name", r.name},
                    {"bitness", r.bitness}};
            if (!r.load.verdict.empty())
                jr["load"] = outcomeToJson(r.load, /*logs=*/true);
            if (!r.probe.verdict.empty())
                jr["probe"] = outcomeToJson(r.probe, /*logs=*/true);
            recs[key] = std::move(jr);
        }
        root = json{{"version", 1}, {"records", std::move(recs)}};
        dirty_ = false;
    }
    if (!writeFileAtomic(filePath_, root.dump()))
        Log::error("PluginHealth: failed to write %s", filePath_.c_str());
}

} // namespace mydaw
