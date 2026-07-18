// MyDAW — plugins/PluginScanner.cpp (E6)
// See PluginScanner.h for the behavioral contract (SPEC §8.3).

#include "PluginScanner.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <utility>

#include "Blacklist.h"
#include "../util/Log.h"
#include "../util/Paths.h"
#include "../util/Strings.h"

namespace fs = std::filesystem;

namespace mydaw {

namespace {

constexpr DWORD kScanTimeoutMs = 20000;       // SPEC §8.3: 20 s per file
constexpr size_t kMaxScanOutput = 8u << 20;   // 8 MB stdout cap per scan process
constexpr uint16_t kPeMachineX64 = 0x8664;    // IMAGE_FILE_MACHINE_AMD64
constexpr uint16_t kPeMachineX86 = 0x014C;    // IMAGE_FILE_MACHINE_I386

// Normalize a path for map keys / comparisons: lowercase ASCII + forward slashes.
std::string normPath(std::string_view p) {
    std::string out = lower(p);
    for (char& c : out)
        if (c == '\\')
            c = '/';
    return out;
}

std::string cacheFilePath() {
    return pathJoin(appDataDir(), "plugin-cache.json");
}

bool envEnabled(const char* name) {
    if (!name || !*name)
        return false;
    char buf[16] = {};
    const DWORD n = GetEnvironmentVariableA(name, buf, static_cast<DWORD>(sizeof(buf)));
    if (n == 0 || n >= sizeof(buf))
        return false;
    const std::string v = lower(trim(std::string(buf, buf + n)));
    return v == "1" || v == "true" || v == "yes" || v == "on";
}

std::string readFileText(const std::string& utf8Path) {
    std::ifstream f(utf8ToWide(utf8Path), std::ios::binary);
    if (!f.is_open())
        return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

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
    std::error_code ec;
    fs::rename(fs::path(utf8ToWide(tmp)), fs::path(utf8ToWide(path)), ec); // replaces on Win32
    if (ec) {
        std::ofstream f(utf8ToWide(path), std::ios::binary | std::ios::trunc);
        if (!f.is_open())
            return false;
        f.write(text.data(), static_cast<std::streamsize>(text.size()));
        fs::remove(fs::path(utf8ToWide(tmp)), ec);
        return f.good();
    }
    return true;
}

// "C:/x/Surge XT.vst3" -> "Surge XT"
std::string displayName(const std::string& path) {
    std::string base = fileName(path);
    const std::string ext = fileExtension(path);
    if (!ext.empty() && base.size() > ext.size())
        base.resize(base.size() - ext.size());
    return base;
}

bool fileStat(const fs::path& p, int64_t& size, int64_t& mtimeMs) {
    std::error_code ec;
    const auto sz = fs::file_size(p, ec);
    if (ec)
        return false;
    const auto t = fs::last_write_time(p, ec);
    if (ec)
        return false;
    size = static_cast<int64_t>(sz);
    mtimeMs = static_cast<int64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(t.time_since_epoch()).count());
    return true;
}

// Reads IMAGE_FILE_HEADER.Machine straight from the file (SPEC §8.3 — route x86 vs x64
// without spawning both hosts). Returns 0 if the file is not a PE binary.
uint16_t readPeMachine(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f.is_open())
        return 0;
    char mz[2] = {0, 0};
    if (!f.read(mz, 2) || mz[0] != 'M' || mz[1] != 'Z')
        return 0;
    uint32_t lfanew = 0;
    if (!f.seekg(0x3C, std::ios::beg) || !f.read(reinterpret_cast<char*>(&lfanew), 4))
        return 0;
    char sig[4] = {0, 0, 0, 0};
    if (!f.seekg(static_cast<std::streamoff>(lfanew), std::ios::beg) || !f.read(sig, 4))
        return 0;
    if (sig[0] != 'P' || sig[1] != 'E' || sig[2] != 0 || sig[3] != 0)
        return 0;
    uint16_t machine = 0; // first field of IMAGE_FILE_HEADER, right after the PE signature
    if (!f.read(reinterpret_cast<char*>(&machine), 2))
        return 0;
    return machine;
}

// Last stdout line that parses as a JSON object containing "ok" (the host may emit log
// noise on stderr, which shares the pipe). Discarded json if none.
json extractResultJson(const std::string& output) {
    const std::vector<std::string> lines = split(output, '\n', false);
    for (size_t i = lines.size(); i-- > 0;) {
        const std::string t = trim(lines[i]);
        if (t.empty() || t[0] != '{')
            continue;
        json j = parseJson(t);
        if (j.is_object() && j.contains("ok"))
            return j;
    }
    return json(json::value_t::discarded);
}

struct ScanProcOutcome {
    bool spawned = false;
    bool cancelled = false; // engine shutdown, not the plugin's fault
    bool timedOut = false;
    DWORD exitCode = 0;
    std::string output;
    std::string spawnError;
};

std::wstring buildScanEnvironmentBlock() {
    if (!envEnabled("MYDAW_SCAN_TRACE"))
        return std::wstring();

    std::map<std::wstring, std::wstring> vars;
    if (LPWCH env = GetEnvironmentStringsW()) {
        for (const wchar_t* p = env; *p;) {
            std::wstring entry(p);
            p += entry.size() + 1;
            const size_t eq = entry.find(L'=');
            if (eq == std::wstring::npos || eq == 0)
                continue;
            vars[entry.substr(0, eq)] = entry.substr(eq + 1);
        }
        FreeEnvironmentStringsW(env);
    }

    vars[L"MYDAW_SCAN_TRACE"] = L"1";
    vars[L"MYDAW_VST2_TRACE"] = L"1";
    vars[L"MYDAW_REG_TRACE"] = L"1";

    std::wstring block;
    for (const auto& [key, value] : vars) {
        block += key;
        block += L"=";
        block += value;
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

std::string formatScanOutputForLog(const std::string& output) {
    if (output.empty())
        return "<no host output>";
    std::string s = output;
    for (char& c : s)
        if (c == '\r')
            c = '\n';
    std::vector<std::string> lines = split(s, '\n', false);
    std::vector<std::string> clean;
    clean.reserve(lines.size());
    for (std::string& line : lines) {
        const std::string t = trim(line);
        if (!t.empty())
            clean.push_back(t);
    }
    const size_t start = clean.size() > 25 ? clean.size() - 25 : 0;
    std::string out;
    for (size_t i = start; i < clean.size(); ++i) {
        if (!out.empty())
            out += " | ";
        out += clean[i];
    }
    if (out.size() > 4000)
        out = out.substr(out.size() - 4000);
    return out.empty() ? "<no host output>" : out;
}

// Spawns `"<hostExe>" --scan "<pluginPath>"` with stdout+stderr captured through an
// anonymous pipe, CREATE_NO_WINDOW. Kills the process on timeout or cancel.
ScanProcOutcome runScanProcess(const std::string& hostExe, const std::string& pluginPath,
                               DWORD timeoutMs, const std::atomic<bool>& cancel) {
    ScanProcOutcome r;

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE readH = nullptr;
    HANDLE writeH = nullptr;
    if (!CreatePipe(&readH, &writeH, &sa, 0)) {
        r.spawnError = "CreatePipe failed";
        return r;
    }
    SetHandleInformation(readH, HANDLE_FLAG_INHERIT, 0);

    std::wstring cmd = L"\"" + utf8ToWide(hostExe) + L"\" --scan \"" + utf8ToWide(pluginPath) + L"\"";
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');
    std::wstring envBlock = buildScanEnvironmentBlock();

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = writeH;
    si.hStdError = writeH;
    si.hStdInput = nullptr;
    PROCESS_INFORMATION pi{};
    const DWORD createFlags =
        CREATE_NO_WINDOW | (envBlock.empty() ? 0 : CREATE_UNICODE_ENVIRONMENT);
    const BOOL launched = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr,
                                         /*bInheritHandles=*/TRUE, createFlags,
                                         envBlock.empty() ? nullptr : envBlock.data(), nullptr,
                                         &si, &pi);
    CloseHandle(writeH); // our copy — the child holds the only remaining write end
    if (!launched) {
        CloseHandle(readH);
        r.spawnError = "CreateProcess failed (error " + std::to_string(GetLastError()) + ")";
        return r;
    }
    r.spawned = true;

    // Drain the pipe on a helper thread so a chatty child never blocks on a full pipe.
    std::string output;
    std::thread reader([&output, readH]() {
        char buf[4096];
        DWORD n = 0;
        while (ReadFile(readH, buf, sizeof(buf), &n, nullptr) && n > 0) {
            if (output.size() < kMaxScanOutput)
                output.append(buf, buf + n);
        }
    });

    const ULONGLONG start = GetTickCount64();
    for (;;) {
        const DWORD w = WaitForSingleObject(pi.hProcess, 100);
        if (w == WAIT_OBJECT_0)
            break;
        if (cancel.load(std::memory_order_relaxed)) {
            r.cancelled = true;
            TerminateProcess(pi.hProcess, 0xDEADu);
            WaitForSingleObject(pi.hProcess, 5000);
            break;
        }
        if (GetTickCount64() - start >= timeoutMs) {
            r.timedOut = true;
            TerminateProcess(pi.hProcess, 0xDEADu);
            WaitForSingleObject(pi.hProcess, 5000);
            break;
        }
    }

    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    r.exitCode = code;
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    reader.join(); // EOF is guaranteed: both write ends are closed/dead by now
    CloseHandle(readH);
    r.output = std::move(output);
    return r;
}

PluginInfo syntheticBlacklistedEntry(const std::string& path, const std::string& format,
                                     int bitness, const std::string& reason) {
    PluginInfo p;
    p.uid = path; // path-surrogate uid — see PluginRegistry.h NOTE(spec)
    p.format = format;
    p.path = path;
    p.bitness = bitness;
    p.name = displayName(path);
    p.blacklisted = true;
    p.blacklistReason = reason;
    return p;
}

} // namespace

// ---------------------------------------------------------------------------
// Construction / cache persistence
// ---------------------------------------------------------------------------

PluginScanner::PluginScanner(PluginRegistry& registry, Blacklist& blacklist)
    : registry_(registry), blacklist_(blacklist) {
    loadCache();
    registry_.attachBlacklist(&blacklist_);
    populateRegistryFromCache();
}

PluginScanner::~PluginScanner() {
    cancel_.store(true, std::memory_order_release);
    if (thread_.joinable())
        thread_.join();
}

void PluginScanner::setHostPaths(const std::string& host64, const std::string& host32) {
    std::lock_guard<std::mutex> lock(mutex_);
    host64Path_ = host64;
    host32Path_ = host32;
}

void PluginScanner::loadCache() {
    std::lock_guard<std::mutex> lock(mutex_);
    cache_.clear();
    const std::string path = cacheFilePath();
    if (!fileExists(path))
        return;
    const json j = parseJson(readFileText(path));
    if (j.is_discarded() || !j.is_object() || !j.contains("entries") || !j["entries"].is_array()) {
        Log::warn("PluginScanner: failed to parse %s — starting with an empty cache", path.c_str());
        return;
    }
    for (const json& je : j["entries"]) {
        if (!je.is_object())
            continue;
        CacheEntry e;
        e.path = getOr(je, "path", "");
        e.size = getOr<int64_t>(je, "size", -1);
        e.mtimeMs = getOr<int64_t>(je, "mtimeMs", -1);
        e.ok = getOr<bool>(je, "ok", false);
        e.error = getOr(je, "error", "");
        if (e.path.empty())
            continue;
        if (e.ok && je.contains("plugins") && je["plugins"].is_array()) {
            for (const json& jp : je["plugins"]) {
                PluginInfo p = PluginInfo::fromJson(jp);
                if (p.path.empty())
                    p.path = e.path;
                if (!p.uid.empty())
                    e.plugins.push_back(std::move(p));
            }
        }
        cache_[normPath(e.path)] = std::move(e);
    }
}

void PluginScanner::saveCache() {
    json arr = json::array();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [key, e] : cache_) {
            (void)key;
            json je{{"path", e.path}, {"size", e.size}, {"mtimeMs", e.mtimeMs}, {"ok", e.ok}};
            if (e.ok) {
                json plugins = json::array();
                for (const PluginInfo& p : e.plugins)
                    plugins.push_back(p.toJson());
                je["plugins"] = std::move(plugins);
            } else {
                je["error"] = e.error;
            }
            arr.push_back(std::move(je));
        }
    }
    const json root{{"version", 1}, {"entries", std::move(arr)}};
    const std::string path = cacheFilePath();
    if (!writeFileAtomic(path, root.dump()))
        Log::error("PluginScanner: failed to write %s", path.c_str());
}

void PluginScanner::refreshFromCache() {
    if (scanning())
        return; // a running scan owns the registry; it publishes its own result
    populateRegistryFromCache();
}

void PluginScanner::populateRegistryFromCache() {
    // The cache is a durable record of every file ever scanned — including folders the user
    // has since REMOVED from the settings. Restoring it wholesale resurrected those plugins on
    // every startup (the reported bug: "it loads the default folders even though I deleted
    // them"). Only surface cache entries that live under a folder that is configured RIGHT NOW.
    const auto [vst2Folders, vst3Folders] = registry_.folders();
    // normPath() lowercases and uses FORWARD slashes — build the prefixes in the same shape.
    std::vector<std::string> roots;
    roots.reserve(vst2Folders.size() + vst3Folders.size());
    const auto addRoot = [&roots](const std::string& f) {
        std::string r = normPath(f);
        while (!r.empty() && r.back() == '/')
            r.pop_back();
        if (!r.empty())
            roots.push_back(r + "/");
    };
    for (const std::string& f : vst2Folders)
        addRoot(f);
    for (const std::string& f : vst3Folders)
        addRoot(f);
    const auto underConfiguredFolder = [&roots](const std::string& path) {
        const std::string p = normPath(path);
        for (const std::string& prefix : roots)
            if (p.size() > prefix.size() && p.compare(0, prefix.size(), prefix) == 0)
                return true;
        return false;
    };

    std::vector<PluginInfo> initial;
    std::set<std::string> coveredPaths;
    size_t dropped = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [key, e] : cache_) {
            if (!e.ok || e.plugins.empty())
                continue;
            if (!fileExists(e.path))
                continue;
            if (!underConfiguredFolder(e.path)) {
                dropped += e.plugins.size(); // folder no longer configured — keep it cached,
                continue;                    // but do not surface it in the registry
            }
            for (const PluginInfo& p : e.plugins)
                initial.push_back(p);
            coveredPaths.insert(key);
        }
    }
    // Blacklisted files that never produced metadata still get a registry entry so the
    // UI can show the badge + unblacklist button (SPEC §9 Browser).
    for (const BlacklistEntry& b : blacklist_.entries()) {
        if (b.path.empty() || !fileExists(b.path))
            continue;
        if (coveredPaths.count(normPath(b.path)))
            continue;
        if (!underConfiguredFolder(b.path))
            continue;
        const std::string format = iendsWith(b.path, ".vst3") ? "vst3" : "vst2";
        const uint16_t machine = readPeMachine(fs::path(utf8ToWide(b.path)));
        const int bitness = (machine == kPeMachineX86) ? 32 : 64;
        initial.push_back(syntheticBlacklistedEntry(b.path, format, bitness, b.reason));
    }
    registry_.replaceAll(std::move(initial));
    if (registry_.size() > 0 || dropped > 0)
        Log::info("PluginScanner: %zu plugin(s) restored from cache (%zu skipped — folder no "
                  "longer configured)",
                  registry_.size(), dropped);
}

// ---------------------------------------------------------------------------
// Folder walk
// ---------------------------------------------------------------------------

std::vector<PluginScanner::FileTask> PluginScanner::collectFiles() const {
    std::vector<FileTask> tasks;
    std::set<std::string> seen;

    auto addTask = [&tasks, &seen](const fs::path& p, const char* format) {
        std::string utf8 = wideToUtf8(p.wstring());
        if (!seen.insert(normPath(utf8)).second)
            return;
        FileTask t;
        t.path = std::move(utf8);
        t.format = format;
        tasks.push_back(std::move(t));
    };

    // .vst3 bundle directory: Contents/x86_64-win/*.vst3 and Contents/x86-win/*.vst3
    // (SPEC §8.3 — the bundle may carry both architectures).
    auto addBundle = [&addTask](const fs::path& bundleDir) {
        for (const wchar_t* arch : {L"x86_64-win", L"x86-win"}) {
            const fs::path sub = bundleDir / L"Contents" / arch;
            std::error_code ec;
            if (!fs::is_directory(sub, ec) || ec)
                continue;
            fs::directory_iterator it(sub, fs::directory_options::skip_permission_denied, ec);
            if (ec)
                continue;
            for (const fs::directory_entry& f : it) {
                std::error_code ec2;
                if (!f.is_regular_file(ec2) || ec2)
                    continue;
                if (iendsWith(wideToUtf8(f.path().filename().wstring()), ".vst3"))
                    addTask(f.path(), "vst3");
            }
        }
    };

    std::function<void(const fs::path&, int)> walk = [&](const fs::path& dir, int depth) {
        if (depth > 16) // symlink-loop / pathological-nesting guard
            return;
        std::error_code ec;
        fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
        if (ec)
            return;
        for (const fs::directory_entry& entry : it) {
            std::error_code ec2;
            if (entry.is_directory(ec2) && !ec2) {
                const std::string name = wideToUtf8(entry.path().filename().wstring());
                if (iendsWith(name, ".vst3"))
                    addBundle(entry.path());
                else
                    walk(entry.path(), depth + 1);
            } else if (entry.is_regular_file(ec2) && !ec2) {
                const std::string name = wideToUtf8(entry.path().filename().wstring());
                if (iendsWith(name, ".dll"))
                    addTask(entry.path(), "vst2");
                else if (iendsWith(name, ".vst3"))
                    addTask(entry.path(), "vst3");
            }
        }
    };

    const auto [vst2Folders, vst3Folders] = registry_.folders();
    auto walkRoot = [&walk](const std::string& folder) {
        const fs::path dir(utf8ToWide(folder));
        std::error_code ec;
        if (fs::is_directory(dir, ec) && !ec)
            walk(dir, 0);
    };
    // NOTE(spec): extension decides the format, so a .vst3 dropped into a VST2 folder
    // (or vice versa) is still picked up correctly.
    for (const std::string& f : vst2Folders)
        walkRoot(f);
    for (const std::string& f : vst3Folders)
        walkRoot(f);
    return tasks;
}

// ---------------------------------------------------------------------------
// Scan worker
// ---------------------------------------------------------------------------

void PluginScanner::scanAsync(bool full, ProgressFn progress, DoneFn done) {
    if (running_.load(std::memory_order_acquire)) {
        Log::warn("PluginScanner: scan already running — request ignored");
        return;
    }
    if (thread_.joinable())
        thread_.join(); // reap the previous, finished worker
    cancel_.store(false, std::memory_order_release);
    running_.store(true, std::memory_order_release);
    thread_ = std::thread([this, full, p = std::move(progress), d = std::move(done)]() mutable {
        workerMain(full, std::move(p), std::move(d));
    });
}

void PluginScanner::workerMain(bool full, ProgressFn progress, DoneFn done) {
    std::string host64;
    std::string host32;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        host64 = host64Path_;
        host32 = host32Path_;
    }
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

    const std::vector<FileTask> tasks = collectFiles();
    const int total = static_cast<int>(tasks.size());
    Log::info("PluginScanner: scanning %d candidate file(s)%s", total,
              full ? " (full rescan, cache ignored)" : "");

    std::vector<PluginInfo> results;
    int found = 0;
    bool warnedNoHost64 = false;
    bool warnedNoHost32 = false;

    for (int i = 0; i < total && !cancel_.load(std::memory_order_relaxed); ++i) {
        const FileTask& task = tasks[i];
        if (progress)
            progress(i + 1, total, task.path, found);

        // 1. Blacklisted paths are never spawned (blacklist persists across full rescans).
        BlacklistEntry ble;
        if (blacklist_.find(task.path, ble)) {
            bool fromCache = false;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                const auto it = cache_.find(normPath(task.path));
                if (it != cache_.end() && it->second.ok && !it->second.plugins.empty()) {
                    for (PluginInfo p : it->second.plugins) {
                        p.blacklisted = true;
                        p.blacklistReason = ble.reason;
                        results.push_back(std::move(p));
                    }
                    fromCache = true;
                }
            }
            if (!fromCache) {
                const uint16_t machine = readPeMachine(fs::path(utf8ToWide(task.path)));
                const int bitness = (machine == kPeMachineX86) ? 32 : 64;
                results.push_back(
                    syntheticBlacklistedEntry(task.path, task.format, bitness, ble.reason));
            }
            continue;
        }

        // 2. Stat for the {path,size,mtimeMs} cache key.
        const fs::path widePath(utf8ToWide(task.path));
        int64_t size = 0;
        int64_t mtimeMs = 0;
        if (!fileStat(widePath, size, mtimeMs)) {
            Log::warn("PluginScanner: cannot stat %s — skipped", task.path.c_str());
            continue;
        }

        // 3. Cache hit (a full rescan ignores the cache but still re-populates it).
        if (!full) {
            std::lock_guard<std::mutex> lock(mutex_);
            const auto it = cache_.find(normPath(task.path));
            if (it != cache_.end() && it->second.size == size && it->second.mtimeMs == mtimeMs) {
                if (it->second.ok) {
                    for (const PluginInfo& p : it->second.plugins) {
                        results.push_back(p);
                        ++found;
                    }
                }
                continue; // cached non-plugins are skipped silently
            }
        }

        // 4. Route by PE machine field.
        const uint16_t machine = readPeMachine(widePath);
        int bitness = 0;
        std::string host;
        if (machine == kPeMachineX64) {
            bitness = 64;
            host = host64;
        } else if (machine == kPeMachineX86) {
            bitness = 32;
            host = host32;
        } else {
            CacheEntry e;
            e.path = task.path;
            e.size = size;
            e.mtimeMs = mtimeMs;
            e.ok = false;
            if (machine == 0) {
                e.error = "not a PE binary";
            } else {
                char buf[64];
                std::snprintf(buf, sizeof(buf), "unsupported PE machine 0x%04X",
                              static_cast<unsigned>(machine));
                e.error = buf;
            }
            std::lock_guard<std::mutex> lock(mutex_);
            cache_[normPath(task.path)] = std::move(e);
            continue;
        }
        if (host.empty() || !fileExists(host)) {
            // Environment problem (host exe not built/found) — skip without caching or
            // blacklisting so the file is retried once the host is available.
            bool& warned = (bitness == 64) ? warnedNoHost64 : warnedNoHost32;
            if (!warned) {
                Log::warn("PluginScanner: no %d-bit scan host available — skipping %d-bit "
                          "plugins (first: %s)",
                          bitness, bitness, task.path.c_str());
                warned = true;
            }
            continue;
        }

        // 5. Spawn `<host> --scan <path>`.
        const ScanProcOutcome r = runScanProcess(host, task.path, kScanTimeoutMs, cancel_);
        if (r.cancelled)
            break;
        if (!r.spawned) {
            Log::warn("PluginScanner: failed to launch %s for %s: %s", host.c_str(),
                      task.path.c_str(), r.spawnError.c_str());
            continue;
        }

        if (r.timedOut) {
            Log::warn("PluginScanner: %s timed out after %lums; host output: %s",
                      task.path.c_str(), static_cast<unsigned long>(kScanTimeoutMs),
                      formatScanOutputForLog(r.output).c_str());
            blacklist_.add("", task.path, "scan timeout");
            results.push_back(
                syntheticBlacklistedEntry(task.path, task.format, bitness, "scan timeout"));
            std::lock_guard<std::mutex> lock(mutex_);
            cache_.erase(normPath(task.path)); // unblacklisting must force a real rescan
            continue;
        }

        const json line = extractResultJson(r.output);
        if (line.is_object()) {
            if (getOr<bool>(line, "ok", false)) {
                std::vector<PluginInfo> plugins;
                const auto it = line.find("plugins");
                if (it != line.end() && it->is_array()) {
                    for (const json& jp : *it) {
                        PluginInfo p = PluginInfo::fromJson(jp);
                        if (p.uid.empty()) {
                            Log::warn("PluginScanner: %s reported a plugin without uid — skipped",
                                      task.path.c_str());
                            continue;
                        }
                        // Canonicalize against what we actually scanned.
                        p.path = task.path;
                        if (p.format.empty())
                            p.format = task.format;
                        if (p.bitness != 32 && p.bitness != 64)
                            p.bitness = bitness;
                        if (p.name.empty())
                            p.name = displayName(task.path);
                        p.blacklisted = false;
                        p.blacklistReason.clear();
                        plugins.push_back(std::move(p));
                    }
                }
                Log::info("PluginScanner: %s -> %zu plugin(s)", task.path.c_str(), plugins.size());
                for (const PluginInfo& p : plugins) {
                    results.push_back(p);
                    ++found;
                }
                CacheEntry e;
                e.path = task.path;
                e.size = size;
                e.mtimeMs = mtimeMs;
                e.ok = true;
                e.plugins = std::move(plugins);
                std::lock_guard<std::mutex> lock(mutex_);
                cache_[normPath(task.path)] = std::move(e);
            } else {
                // Non-plugin DLL ("no VST entry" etc) — cached so it is never re-spawned,
                // but NOT blacklisted (SPEC §8.3).
                Log::info("PluginScanner: %s scan host rejected file: %s; host output: %s",
                          task.path.c_str(), getOr(line, "error", "not a plugin").c_str(),
                          formatScanOutputForLog(r.output).c_str());
                CacheEntry e;
                e.path = task.path;
                e.size = size;
                e.mtimeMs = mtimeMs;
                e.ok = false;
                e.error = getOr(line, "error", "not a plugin");
                std::lock_guard<std::mutex> lock(mutex_);
                cache_[normPath(task.path)] = std::move(e);
            }
        } else if (r.exitCode != 0) {
            char reason[64];
            std::snprintf(reason, sizeof(reason), "crashed during scan (0x%08X)",
                          static_cast<unsigned>(r.exitCode));
            Log::warn("PluginScanner: %s scan host crashed/failed (%s); host output: %s",
                      task.path.c_str(), reason, formatScanOutputForLog(r.output).c_str());
            blacklist_.add("", task.path, reason);
            results.push_back(syntheticBlacklistedEntry(task.path, task.format, bitness, reason));
            std::lock_guard<std::mutex> lock(mutex_);
            cache_.erase(normPath(task.path));
        } else {
            // Exited 0 without a parseable result line — treat as non-plugin.
            Log::info("PluginScanner: %s exited 0 without parseable result; host output: %s",
                      task.path.c_str(), formatScanOutputForLog(r.output).c_str());
            CacheEntry e;
            e.path = task.path;
            e.size = size;
            e.mtimeMs = mtimeMs;
            e.ok = false;
            e.error = "no scan output";
            std::lock_guard<std::mutex> lock(mutex_);
            cache_[normPath(task.path)] = std::move(e);
        }
    }

    if (cancel_.load(std::memory_order_relaxed)) {
        saveCache(); // keep the completed work; no registry publish / done() at shutdown
        Log::info("PluginScanner: scan cancelled");
        running_.store(false, std::memory_order_release);
        return;
    }

    // Prune cache entries whose files vanished, publish, persist, notify.
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto it = cache_.begin(); it != cache_.end();) {
            if (!fileExists(it->second.path))
                it = cache_.erase(it);
            else
                ++it;
        }
    }
    const size_t numEntries = results.size();
    registry_.replaceAll(std::move(results));
    saveCache();
    Log::info("PluginScanner: scan done — %d plugin(s) found, %zu registry entr%s",
              found, numEntries, numEntries == 1 ? "y" : "ies");
    if (done)
        done();
    running_.store(false, std::memory_order_release);
}

} // namespace mydaw
