// MyDAW — plugins/Blacklist.cpp (E6)

#include "Blacklist.h"

#include <cstdio>
#include <ctime>
#include <fstream>
#include <sstream>

#include "../util/Log.h"
#include "../util/Paths.h"
#include "../util/Strings.h"

namespace mydaw {

namespace {

// Normalize a path for comparison: lowercase ASCII + forward slashes.
std::string normPath(std::string_view p) {
    std::string out = lower(p);
    for (char& c : out)
        if (c == '\\')
            c = '/';
    return out;
}

bool samePath(const std::string& a, const std::string& b) {
    return normPath(a) == normPath(b);
}

std::string nowIso8601Utc() {
    const std::time_t t = std::time(nullptr);
    std::tm tmv{};
#if defined(_WIN32)
    gmtime_s(&tmv, &t);
#else
    gmtime_r(&t, &tmv);
#endif
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
                  tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                  tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
    return std::string(buf);
}

// Atomic-ish write: tmp file + rename over the destination.
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
    // std::rename fails if the destination exists on Windows; remove first.
    std::remove(path.c_str()); // ANSI-path limitation acceptable: %APPDATA%/MyDAW is ours
#endif
    if (std::rename(tmp.c_str(), path.c_str()) != 0) {
        // Fallback: direct write (non-atomic) so the data is not lost.
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

} // namespace

Blacklist::Blacklist() : filePath_(pathJoin(appDataDir(), "blacklist.json")) {
    load();
}

Blacklist::Blacklist(std::string filePath) : filePath_(std::move(filePath)) {
    load();
}

void Blacklist::load() {
    std::lock_guard<std::mutex> lock(mutex_);
    entries_.clear();
    if (!fileExists(filePath_))
        return;
    const json j = parseJson(readFileText(filePath_));
    if (j.is_discarded()) {
        Log::warn("Blacklist: failed to parse %s — starting empty", filePath_.c_str());
        return;
    }
    // Accept {"entries":[...]} (our format) or a bare array (liberal).
    const json* arr = nullptr;
    if (j.is_object() && j.contains("entries") && j["entries"].is_array())
        arr = &j["entries"];
    else if (j.is_array())
        arr = &j;
    if (!arr)
        return;
    for (const json& e : *arr) {
        if (!e.is_object())
            continue;
        BlacklistEntry entry;
        entry.uid = getOr(e, "uid", "");
        entry.path = getOr(e, "path", "");
        entry.reason = getOr(e, "reason", "");
        entry.when = getOr(e, "when", "");
        if (entry.path.empty() && entry.uid.empty())
            continue;
        entries_.push_back(std::move(entry));
    }
}

void Blacklist::saveLocked() const {
    json arr = json::array();
    for (const BlacklistEntry& e : entries_) {
        json je{{"path", e.path}, {"reason", e.reason}, {"when", e.when}};
        if (!e.uid.empty())
            je["uid"] = e.uid;
        arr.push_back(std::move(je));
    }
    const json root{{"entries", std::move(arr)}};
    if (!writeFileAtomic(filePath_, root.dump(2)))
        Log::error("Blacklist: failed to write %s", filePath_.c_str());
}

bool Blacklist::contains(const std::string& pathOrUid) const {
    BlacklistEntry tmp;
    return find(pathOrUid, tmp);
}

bool Blacklist::find(const std::string& pathOrUid, BlacklistEntry& out) const {
    if (pathOrUid.empty())
        return false;
    std::lock_guard<std::mutex> lock(mutex_);
    for (const BlacklistEntry& e : entries_) {
        if ((!e.uid.empty() && e.uid == pathOrUid) ||
            (!e.path.empty() && samePath(e.path, pathOrUid))) {
            out = e;
            return true;
        }
    }
    return false;
}

void Blacklist::add(const std::string& uid, const std::string& path, const std::string& reason) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        BlacklistEntry entry{uid, path, reason, nowIso8601Utc()};
        bool replaced = false;
        for (BlacklistEntry& e : entries_) {
            if (!path.empty() && samePath(e.path, path)) {
                e = entry;
                replaced = true;
                break;
            }
        }
        if (!replaced)
            entries_.push_back(std::move(entry));
        saveLocked();
    }
    Log::warn("Blacklist: %s — %s", path.c_str(), reason.c_str());
}

bool Blacklist::removeByUid(const std::string& uid) {
    if (uid.empty())
        return false;
    std::lock_guard<std::mutex> lock(mutex_);
    bool removed = false;
    for (size_t i = entries_.size(); i-- > 0;) {
        const BlacklistEntry& e = entries_[i];
        if ((!e.uid.empty() && e.uid == uid) ||
            (!e.path.empty() && samePath(e.path, uid))) {
            entries_.erase(entries_.begin() + static_cast<std::ptrdiff_t>(i));
            removed = true;
        }
    }
    if (removed)
        saveLocked();
    return removed;
}

json Blacklist::toJson() const {
    std::lock_guard<std::mutex> lock(mutex_);
    json arr = json::array();
    for (const BlacklistEntry& e : entries_) {
        json je{{"path", e.path}, {"reason", e.reason}, {"when", e.when}};
        if (!e.uid.empty())
            je["uid"] = e.uid;
        arr.push_back(std::move(je));
    }
    return arr;
}

std::vector<BlacklistEntry> Blacklist::entries() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return entries_;
}

size_t Blacklist::size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return entries_.size();
}

} // namespace mydaw
