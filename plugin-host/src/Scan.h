#pragma once
//
// plugin-host/src/Scan.h
//
// `mydaw-host{64,32}.exe --scan <path>` mode (SPEC §8.3). Loads the file via
// scanVst2File / scanVst3File (PluginAdapter.h) under an SEH crash guard and
// prints exactly one JSON result line to stdout:
//
//   {"ok":true,"plugins":[{uid,format,path,bitness,name,vendor,category,
//                          isInstrument,numInputs,numOutputs}, ...]}
//   {"ok":false,"error":"..."}
//
// No window, no shared memory, no pipe in scan mode. The engine-side scanner
// (PluginScanner.cpp) takes the LAST stdout line that parses as a JSON object
// containing "ok", so plugin printf noise during load is harmless.
//
#include <string>

namespace mydaw {

// formatHint: "vst2", "vst3", or "" to infer from the path extension
// (".vst3" -> vst3, anything else incl. ".dll" -> vst2, SPEC §8.3).
// Returns the process exit code: 0 when ok:true was printed, 1 otherwise.
int runScan(const std::wstring& path, const std::string& formatHint);

} // namespace mydaw
