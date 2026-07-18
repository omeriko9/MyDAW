// MyDAW — plugins/PluginRegistry.cpp (E6)

#include "PluginRegistry.h"

#include <algorithm>

#include "Blacklist.h"
#include "../util/Strings.h"

namespace mydaw {

namespace {

std::string normPath(std::string_view p) {
    std::string out = lower(p);
    for (char& c : out)
        if (c == '\\')
            c = '/';
    return out;
}

const std::vector<std::string>& kDefaultVst2Folders() {
    static const std::vector<std::string> v{
        "C:/Program Files/VSTPlugins",
        "C:/Program Files/Steinberg/VSTPlugins",
        "C:/Program Files/Common Files/VST2",
        "C:/Program Files (x86)/VSTPlugins",
        "C:/Program Files (x86)/Steinberg/VSTPlugins",
        "C:/Program Files (x86)/Common Files/VST2",
    };
    return v;
}

const std::vector<std::string>& kDefaultVst3Folders() {
    static const std::vector<std::string> v{
        "C:/Program Files/Common Files/VST3",
        "C:/Program Files (x86)/Common Files/VST3",
    };
    return v;
}

// Dedup case/slash-insensitive; empties dropped.
std::vector<std::string> normalizeFolders(const std::vector<std::string>& folders) {
    std::vector<std::string> out;
    std::vector<std::string> seen;
    auto push = [&](const std::string& f) {
        const std::string t = trim(f);
        if (t.empty())
            return;
        const std::string key = normPath(t);
        if (std::find(seen.begin(), seen.end(), key) != seen.end())
            return;
        seen.push_back(key);
        out.push_back(t);
    };
    for (const std::string& f : folders)
        push(f);
    return out;
}

} // namespace

// ---------------------------------------------------------------------------
// PluginInfo
// ---------------------------------------------------------------------------

json PluginInfo::toJson() const {
    json j{
        {"uid", uid},
        {"format", format},
        {"path", path},
        {"bitness", bitness},
        {"name", name},
        {"vendor", vendor},
        {"category", category},
        {"isInstrument", isInstrument},
        {"numInputs", numInputs},
        {"numOutputs", numOutputs},
    };
    if (blacklisted) {
        j["blacklisted"] = true;
        j["blacklistReason"] = blacklistReason;
    }
    return j;
}

PluginInfo PluginInfo::fromJson(const json& j) {
    PluginInfo p;
    p.uid = getOr(j, "uid", "");
    p.format = getOr(j, "format", "");
    p.path = getOr(j, "path", "");
    p.bitness = getOr<int>(j, "bitness", 64);
    p.name = getOr(j, "name", "");
    p.vendor = getOr(j, "vendor", "");
    p.category = getOr(j, "category", "");
    p.isInstrument = getOr<bool>(j, "isInstrument", false);
    p.numInputs = getOr<int>(j, "numInputs", 0);
    p.numOutputs = getOr<int>(j, "numOutputs", 0);
    p.blacklisted = getOr<bool>(j, "blacklisted", false);
    p.blacklistReason = getOr(j, "blacklistReason", "");
    return p;
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

PluginRegistry::PluginRegistry()
    : vst2Folders_(kDefaultVst2Folders()), vst3Folders_(kDefaultVst3Folders()) {}

std::vector<std::string> PluginRegistry::defaultVst2Folders() {
    return kDefaultVst2Folders();
}

std::vector<std::string> PluginRegistry::defaultVst3Folders() {
    return kDefaultVst3Folders();
}

void PluginRegistry::refreshFlagsLocked() const {
    if (!blacklist_)
        return;
    for (PluginInfo& p : entries_) {
        BlacklistEntry e;
        if (blacklist_->find(p.path, e) ||
            (!p.uid.empty() && blacklist_->find(p.uid, e))) {
            p.blacklisted = true;
            p.blacklistReason = e.reason;
        } else {
            p.blacklisted = false;
            p.blacklistReason.clear();
        }
    }
}

void PluginRegistry::setBuiltins(std::vector<PluginInfo> builtins) {
    std::lock_guard<std::mutex> lock(mutex_);
    builtins_ = std::move(builtins);
}

std::vector<PluginInfo> PluginRegistry::list() const {
    std::lock_guard<std::mutex> lock(mutex_);
    refreshFlagsLocked();
    std::vector<PluginInfo> out = entries_;
    out.insert(out.end(), builtins_.begin(), builtins_.end()); // stock effects always listed
    return out;
}

const PluginInfo* PluginRegistry::byUid(const std::string& uid) const {
    if (uid.empty())
        return nullptr;
    std::lock_guard<std::mutex> lock(mutex_);
    refreshFlagsLocked();
    const PluginInfo* best = nullptr;
    for (const PluginInfo& p : entries_) {
        if (p.uid != uid)
            continue;
        if (!best) {
            best = &p;
            continue;
        }
        // Prefer non-blacklisted, then 64-bit.
        const bool betterBlacklist = !p.blacklisted && best->blacklisted;
        const bool sameBlacklist = p.blacklisted == best->blacklisted;
        if (betterBlacklist || (sameBlacklist && p.bitness == 64 && best->bitness != 64))
            best = &p;
    }
    if (best)
        return best;
    for (const PluginInfo& p : builtins_) // stock effects (never blacklisted)
        if (p.uid == uid)
            return &p;
    return nullptr;
}

void PluginRegistry::setFolders(const std::vector<std::string>& vst2,
                                const std::vector<std::string>& vst3) {
    std::lock_guard<std::mutex> lock(mutex_);
    vst2Folders_ = normalizeFolders(vst2);
    vst3Folders_ = normalizeFolders(vst3);
}

std::pair<std::vector<std::string>, std::vector<std::string>> PluginRegistry::folders() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return {vst2Folders_, vst3Folders_};
}

void PluginRegistry::replaceAll(std::vector<PluginInfo> entries) {
    std::lock_guard<std::mutex> lock(mutex_);
    entries_ = std::move(entries);
    refreshFlagsLocked();
}

void PluginRegistry::upsert(const PluginInfo& info) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (PluginInfo& p : entries_) {
        if (p.format == info.format && p.uid == info.uid && p.bitness == info.bitness) {
            p = info;
            refreshFlagsLocked();
            return;
        }
    }
    entries_.push_back(info);
    refreshFlagsLocked();
}

void PluginRegistry::attachBlacklist(const Blacklist* blacklist) {
    std::lock_guard<std::mutex> lock(mutex_);
    blacklist_ = blacklist;
    refreshFlagsLocked();
}

size_t PluginRegistry::size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return entries_.size() + builtins_.size();
}

json PluginRegistry::listJson() const {
    json arr = json::array();
    for (const PluginInfo& p : list())
        arr.push_back(p.toJson());
    return arr;
}

} // namespace mydaw
