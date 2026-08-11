// MyDAW — plugins/ChildProc.cpp (E6). See ChildProc.h.
// Extracted verbatim from PluginScanner's runScanProcess (2026-08-11) so the prober
// shares the exact spawn/pipe/timeout/cancel behavior instead of a second copy.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include "ChildProc.h"

#include <windows.h>

#include <cstdlib>
#include <map>
#include <thread>
#include <vector>

namespace mydaw {

namespace {

constexpr size_t kMaxOutput = 8u * 1024u * 1024u; // matches the scanner's cap

bool envEnabled(const char* name) {
    char buf[8]{};
    const DWORD n = GetEnvironmentVariableA(name, buf, sizeof(buf));
    return n > 0 && buf[0] != '0';
}

// Full environment block with the trace vars forced on (empty = inherit as-is).
std::wstring buildTraceEnvironmentBlock(bool forceTrace) {
    if (!forceTrace && !envEnabled("MYDAW_SCAN_TRACE"))
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

} // namespace

ChildProcOutcome runCaptureProcess(const std::wstring& cmd, uint32_t timeoutMs,
                                   const std::atomic<bool>& cancel, bool forceTraceEnv,
                                   bool belowNormalPriority) {
    ChildProcOutcome r;

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

    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');
    std::wstring envBlock = buildTraceEnvironmentBlock(forceTraceEnv);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = writeH;
    si.hStdError = writeH;
    si.hStdInput = nullptr;
    PROCESS_INFORMATION pi{};
    const DWORD createFlags = CREATE_NO_WINDOW |
                              (envBlock.empty() ? 0 : CREATE_UNICODE_ENVIRONMENT) |
                              (belowNormalPriority ? BELOW_NORMAL_PRIORITY_CLASS : 0);
    const BOOL launched = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr,
                                         /*bInheritHandles=*/TRUE, createFlags,
                                         envBlock.empty() ? nullptr : envBlock.data(),
                                         nullptr, &si, &pi);
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
            if (output.size() < kMaxOutput)
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

} // namespace mydaw
