// MyDAW — plugins/ChildProc.h (E6)
// One-shot child process with captured stdout+stderr — the spawn/pipe/timeout/cancel
// machinery the scanner always had, extracted so the prober (plugins/probe) reuses it
// instead of growing a second copy. CREATE_NO_WINDOW; output capped at 8 MB; the child
// is TerminateProcess'd on timeout or cancel.
//
// Threading: blocking; call from a worker thread. `cancel` is polled every ~100 ms.

#pragma once

#include <atomic>
#include <cstdint>
#include <string>

namespace mydaw {

struct ChildProcOutcome {
    bool spawned = false;
    std::string spawnError; // when !spawned
    bool timedOut = false;
    bool cancelled = false; // cancel flag observed; child terminated
    uint32_t exitCode = 0;
    std::string output;     // merged stdout+stderr (UTF-8 as written by the child)
};

// `cmd` is the full command line (quoted as needed). forceTraceEnv=true injects
// MYDAW_SCAN_TRACE/MYDAW_VST2_TRACE/MYDAW_REG_TRACE into the child's environment even
// when the engine's own environment lacks them (per-request verbose tracing);
// belowNormalPriority starts the child at BELOW_NORMAL_PRIORITY_CLASS (probe batches
// must not fight the audio engine for cores).
ChildProcOutcome runCaptureProcess(const std::wstring& cmd, uint32_t timeoutMs,
                                   const std::atomic<bool>& cancel, bool forceTraceEnv,
                                   bool belowNormalPriority);

} // namespace mydaw
