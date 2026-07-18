//
// plugin-host/src/RegOverlay.h — optional per-plugin capture virtualization (SPEC §8.5).
//
// When a hosted plugin ships as a "capture bundle" (an ancestor folder containing install.reg
// and/or a files\<DRIVE>\... drive mirror), the host presents captured registry and filesystem
// state to that one plugin via MinHook inline hooks:
//
//   * reads consult the overlay first, then fall through to the real registry (copy-on-write
//     read-through) — so the CRT/COM/Windows and the plugin keep working for every key NOT
//     in the .reg;
//   * writes land only in the overlay (and persist to <reg>.local next to the .reg) — the
//     real machine registry is never modified;
//   * absolute paths in the .reg are rebased onto the bundle (X:\... -> <bundle>\files\X\...,
//     plus a %BUNDLE% macro) so a relocated capture's registry-driven file lookups resolve.
//   * hard-coded drive-letter file paths opened/probed by the plugin are redirected to
//     <bundle>\files\<DRIVE>\... when that mirrored file or parent directory exists.
//
// The host process is dedicated to a single plugin, so process-global hooking is safe here:
// the only Reg* callers are that one plugin and the CRT/COM it drags in — exactly what we
// want virtualized. Entirely opt-in: with no install.reg/files mirror, nothing is installed.
//
#pragma once

#include <string>

namespace mydaw {

// Snapshot of the capture virtualization that was successfully armed for this
// dedicated host process.  Returned to the engine in the init reply so the
// normal MyDAW log can prove which capture supplied a live plugin's registry.
struct RegOverlayStatus {
  bool armed = false;
  bool registryActive = false;
  bool fileActive = false;
  std::wstring registryPath;
  std::wstring mirrorPath;
};

// Locate the capture bundle for the plugin at `pluginPath` and, if found, parse its .reg,
// install Reg*/file hooks, and arm the overlay. No-op returning false when no install.reg or
// files mirror exists (the common case). Must be called ONCE, on the host's main thread,
// BEFORE any plugin DLL is loaded (covers the plugin's DllMain + VST entry point). Safe in
// both --scan and --serve. Honors MYDAW_REG_TRACE=1 (stderr trace of every intercepted call,
// mirroring MYDAW_VST2_TRACE) to author/debug a capture by watching what the plugin requests.
bool installRegOverlayIfPresent(const std::wstring& pluginPath);

// Read the current arming result after installRegOverlayIfPresent().
RegOverlayStatus regOverlayStatus();

// Persist runtime registry writes to the writable sidecar (<reg>.local). Call at shutdown.
// No-op when the overlay is not armed or nothing was written.
void flushRegOverlay();

} // namespace mydaw
