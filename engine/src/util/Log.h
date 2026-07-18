// MyDAW — util/Log.h
// Header-only logging: printf-style Log::info/warn/error -> stderr with timestamp + level,
// plus an in-memory ring buffer of the last 2000 formatted lines (served via engine/getLog).
//
// Thread-safety: all entry points take an internal mutex. NOT RT-safe — never call from the
// audio callback (allocates + locks). Use only on main/server/worker threads.

#pragma once

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <chrono>
#include <ctime>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace mydaw {

class Log {
public:
    enum Level : int { kInfo = 0, kWarn = 1, kError = 2 };

    static constexpr int kRingCapacity = 2000;

    // Optional sink, invoked (under the log mutex) for every line after it is written to
    // stderr + ring. E8 hooks this to emit `event/log {level,msg}` (it should filter to
    // warn+error per SPEC §5.7 and must not re-enter Log from the sink).
    using Sink = std::function<void(Level, const std::string& line)>;

    // Optional SECOND sink dedicated to the persistent on-disk log file (util/LogFile).
    // Distinct from Sink so the event/log broadcast and the file log coexist (Sink has a
    // single slot). Invoked (under the log mutex) for EVERY line at all levels. Must not
    // re-enter Log. Installed once at startup via setFileSink(); see util/LogFile.h.
    using FileSink = std::function<void(const std::string& line)>;

    static void info(const char* fmt, ...) {
        va_list ap; va_start(ap, fmt); logv(kInfo, fmt, ap); va_end(ap);
    }
    static void warn(const char* fmt, ...) {
        va_list ap; va_start(ap, fmt); logv(kWarn, fmt, ap); va_end(ap);
    }
    static void error(const char* fmt, ...) {
        va_list ap; va_start(ap, fmt); logv(kError, fmt, ap); va_end(ap);
    }

    static void logv(Level level, const char* fmt, va_list ap) {
        // Format the message body (stack buffer fast path, heap fallback).
        char stackBuf[1024];
        va_list ap2;
        va_copy(ap2, ap);
        int needed = std::vsnprintf(stackBuf, sizeof(stackBuf), fmt ? fmt : "", ap);
        std::string msg;
        if (needed < 0) {
            msg = "<log format error>";
        } else if (static_cast<size_t>(needed) < sizeof(stackBuf)) {
            msg.assign(stackBuf, static_cast<size_t>(needed));
        } else {
            std::vector<char> heap(static_cast<size_t>(needed) + 1);
            std::vsnprintf(heap.data(), heap.size(), fmt ? fmt : "", ap2);
            msg.assign(heap.data(), static_cast<size_t>(needed));
        }
        va_end(ap2);

        std::string line = timestamp();
        line += levelTag(level);
        line += msg;

        State& s = state();
        std::lock_guard<std::mutex> lock(s.mutex);
        std::fprintf(stderr, "%s\n", line.c_str());
        std::fflush(stderr);
        if (s.ring.size() >= kRingCapacity)
            s.ring.pop_front();
        s.ring.emplace_back(level, std::move(line));
        if (s.fileSink)
            s.fileSink(s.ring.back().second);
        if (s.sink)
            s.sink(level, s.ring.back().second);
    }

    // Last n lines (oldest first). n <= 0 or n > stored -> all stored lines.
    static std::vector<std::string> tail(int n) {
        State& s = state();
        std::lock_guard<std::mutex> lock(s.mutex);
        const int total = static_cast<int>(s.ring.size());
        const int count = (n <= 0 || n > total) ? total : n;
        std::vector<std::string> out;
        out.reserve(static_cast<size_t>(count));
        for (int i = total - count; i < total; ++i)
            out.push_back(s.ring[static_cast<size_t>(i)].second);
        return out;
    }

    static void setSink(Sink sink) {
        State& s = state();
        std::lock_guard<std::mutex> lock(s.mutex);
        s.sink = std::move(sink);
    }

    static void setFileSink(FileSink sink) {
        State& s = state();
        std::lock_guard<std::mutex> lock(s.mutex);
        s.fileSink = std::move(sink);
    }

    static const char* levelName(Level level) {
        switch (level) {
            case kWarn:  return "warn";
            case kError: return "error";
            default:     return "info";
        }
    }

private:
    struct State {
        std::mutex mutex;
        std::deque<std::pair<Level, std::string>> ring; // (level, formatted line)
        Sink sink;
        FileSink fileSink; // persistent on-disk log (util/LogFile); distinct slot from sink
    };

    static State& state() {
        static State s; // single instance across all TUs (function-local static)
        return s;
    }

    static const char* levelTag(Level level) {
        switch (level) {
            case kWarn:  return " [warn ] ";
            case kError: return " [error] ";
            default:     return " [info ] ";
        }
    }

    static std::string timestamp() {
        using namespace std::chrono;
        const auto now = system_clock::now();
        const auto ms = duration_cast<milliseconds>(now.time_since_epoch()) % 1000;
        const std::time_t t = system_clock::to_time_t(now);
        std::tm tmv{};
#if defined(_WIN32)
        localtime_s(&tmv, &t);
#else
        localtime_r(&t, &tmv);
#endif
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%02d:%02d:%02d.%03d",
                      tmv.tm_hour, tmv.tm_min, tmv.tm_sec, static_cast<int>(ms.count()));
        return std::string(buf);
    }
};

} // namespace mydaw
