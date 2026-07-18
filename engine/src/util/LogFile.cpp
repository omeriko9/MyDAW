// MyDAW — util/LogFile.cpp. See LogFile.h.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include "util/LogFile.h"

#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <ctime>
#include <mutex>
#include <string>
#include <vector>

#include "util/Log.h"
#include "util/Paths.h"

namespace mydaw {

namespace {

constexpr long long kMaxBytes = 8 * 1024 * 1024; // rotate the active file past 8 MiB
constexpr int kKeepFiles = 10;                   // prune to the newest N mydaw-*.log files

struct FileLogState {
    std::mutex mutex;        // guards all members below (the sink already holds Log's mutex,
                             // but Log's mutex is not visible here — keep our own)
    std::string dir;         // %APPDATA%/MyDAW/logs
    std::string path;        // active file path
    std::string dayStamp;    // YYYYMMDD of the active file (roll over at midnight)
    FILE* fp = nullptr;      // append handle (UTF-8 bytes; lines already UTF-8)
    long long bytes = 0;     // bytes written to the active file
    int rotateSeq = 0;       // suffix for same-day size rotations
    bool installed = false;
};

FileLogState& fls() {
    static FileLogState s;
    return s;
}

std::string todayStamp() {
    const std::time_t t = std::time(nullptr);
    std::tm tmv{};
    localtime_s(&tmv, &t);
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%04d%02d%02d", tmv.tm_year + 1900, tmv.tm_mon + 1,
                  tmv.tm_mday);
    return std::string(buf);
}

// Newest-first prune of mydaw-*.log files in `dir`, keeping at most kKeepFiles.
void pruneOldLogs(const std::string& dir) {
    const std::wstring pat = utf8ToWide(pathJoin(dir, "mydaw-*.log"));
    WIN32_FIND_DATAW fd{};
    HANDLE h = FindFirstFileW(pat.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE)
        return;
    struct Entry {
        std::string name;
        ULONGLONG write;
    };
    std::vector<Entry> entries;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
            continue;
        const ULONGLONG w = (static_cast<ULONGLONG>(fd.ftLastWriteTime.dwHighDateTime) << 32) |
                            fd.ftLastWriteTime.dwLowDateTime;
        entries.push_back({wideToUtf8(fd.cFileName), w});
    } while (FindNextFileW(h, &fd));
    FindClose(h);

    if (static_cast<int>(entries.size()) <= kKeepFiles)
        return;
    // Sort newest first; delete everything past the keep window.
    std::sort(entries.begin(), entries.end(),
              [](const Entry& a, const Entry& b) { return a.write > b.write; });
    for (size_t i = kKeepFiles; i < entries.size(); ++i)
        DeleteFileW(utf8ToWide(pathJoin(dir, entries[i].name)).c_str());
}

// (Re)opens the active file for `dir`/`dayStamp`/`rotateSeq`. Caller holds the mutex.
bool openActive(FileLogState& s) {
    if (s.fp) {
        std::fclose(s.fp);
        s.fp = nullptr;
    }
    std::string name = "mydaw-" + s.dayStamp;
    if (s.rotateSeq > 0)
        name += "-" + std::to_string(s.rotateSeq);
    name += ".log";
    s.path = pathJoin(s.dir, name);
    s.fp = _wfopen(utf8ToWide(s.path).c_str(), L"ab");
    if (!s.fp)
        return false;
    std::fseek(s.fp, 0, SEEK_END);
    const long pos = std::ftell(s.fp);
    s.bytes = pos > 0 ? pos : 0;
    return true;
}

void writeLine(const std::string& line) {
    FileLogState& s = fls();
    std::lock_guard<std::mutex> lock(s.mutex);
    if (!s.fp)
        return;

    // Day rollover: start a fresh mydaw-YYYYMMDD.log at midnight.
    const std::string today = todayStamp();
    if (today != s.dayStamp) {
        s.dayStamp = today;
        s.rotateSeq = 0;
        if (!openActive(s))
            return;
        pruneOldLogs(s.dir);
    }
    // Size rollover within the same day.
    if (s.bytes >= kMaxBytes) {
        ++s.rotateSeq;
        if (!openActive(s))
            return;
        pruneOldLogs(s.dir);
    }

    const size_t n = std::fwrite(line.data(), 1, line.size(), s.fp);
    std::fputc('\n', s.fp);
    std::fflush(s.fp); // every line: cheap vs. a crash losing the action trail
    s.bytes += static_cast<long long>(n) + 1;
}

} // namespace

std::string initFileLog() {
    FileLogState& s = fls();
    std::lock_guard<std::mutex> lock(s.mutex);
    if (s.installed)
        return s.path;

    s.dir = pathJoin(appDataDir(), "logs");
    if (!ensureDir(s.dir))
        return std::string(); // console/ring still work

    s.dayStamp = todayStamp();
    s.rotateSeq = 0;
    if (!openActive(s))
        return std::string();
    pruneOldLogs(s.dir);

    s.installed = true;
    Log::setFileSink([](const std::string& line) { writeLine(line); });
    return s.path;
}

} // namespace mydaw
