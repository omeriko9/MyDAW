#pragma once
//
// plugin-host/src/Probe.h
//
// `mydaw-host{64,32}.exe --probe <path> [--uid <uid>] [--rate n] [--block n]` mode
// (SPEC §5.6, the "automated pass"): a DEEP load test through the real adapters —
// scan proves "enumerates"; probe proves "actually comes up and processes".
//
//   load → init(rate, block) → resume → process 16 blocks of silence (a noteOn/off
//   mid-way when the plugin is an instrument) → getState
//
// Every stage is SEH-guarded; a fault still prints a parseable line. Exactly one JSON
// line on stdout (the engine takes the last line containing "ok"):
//
//   {"ok":true,  "stages":{"load":1,"init":1,"process":1,"getState":1}, "nonSilent":b}
//   {"ok":false, "stages":{...partial...}, "error":"init failed: ..."}
//
// `nonSilent` is INFORMATION, never a failure — an instrument with no soundbank loaded
// is legitimately silent. No window, no shared memory, no pipe in probe mode.
//
#include <string>

namespace mydaw {

// uid: "" = first/only plugin in the file (vst2), or the class GUID (vst3).
// formatHint: "vst2" | "vst3" | "" to infer from the extension.
// Returns the process exit code: 0 when ok:true was printed, 1 otherwise.
int runProbe(const std::wstring& path, const std::string& uid,
             const std::string& formatHint, double sampleRate, uint32_t blockSize);

} // namespace mydaw
