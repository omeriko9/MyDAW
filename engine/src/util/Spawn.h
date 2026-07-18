// MyDAW — util/Spawn.h
// Small Win32 helpers for launching a detached child process (e.g. a second
// mydaw-engine.exe for a new project window) and for finding / waiting on a loopback TCP
// port. Main-thread callers only for launchDetached; the port helpers may run on a worker.

#pragma once

#include <string>

namespace mydaw {

// Launch `exeUtf8` fully detached (its own process + process group, no inherited handles,
// no shared console). `argsAfterExeUtf8` is the command line that FOLLOWS the exe token
// (space-separated, individually quoted where needed). Returns false + err on failure.
bool launchDetached(const std::string& exeUtf8, const std::string& argsAfterExeUtf8,
                    std::string& err);

// Bind 127.0.0.1:0 and read back the OS-assigned port, then release it — a free ephemeral
// loopback port. Returns 0 + err on failure. (Small TOCTOU window before the child binds;
// the server uses SO_EXCLUSIVEADDRUSE so a lost race fails loudly rather than silently.)
int findFreeLoopbackPort(std::string& err);

// Block (polling) until 127.0.0.1:port accepts a TCP connection, or `timeoutMs` elapses.
// Used to hold a "new window" reply until the child engine is actually serving. Returns
// false + err on timeout.
bool waitForLoopbackPort(int port, int timeoutMs, std::string& err);

} // namespace mydaw
