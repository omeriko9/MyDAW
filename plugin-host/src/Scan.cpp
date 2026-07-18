//
// plugin-host/src/Scan.cpp — see Scan.h (SPEC §8.3).
//
#include "Scan.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <cstdio>
#include <cwctype>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "../../shared/ipc/SharedMem.h" // ipcWideToUtf8
#include "PluginAdapter.h"              // ScannedPlugin, scanVst2File/scanVst3File

namespace mydaw {

namespace {

std::string inferFormat(const std::wstring& path) {
  const size_t dot = path.find_last_of(L'.');
  std::wstring ext = (dot == std::wstring::npos) ? L"" : path.substr(dot);
  for (wchar_t& c : ext) c = static_cast<wchar_t>(std::towlower(c));
  if (ext == L".vst3") return "vst3";
  return "vst2"; // ".dll" and anything else: try the VST2 entry points
}

using ScanFn = bool (*)(const std::wstring&, std::vector<ScannedPlugin>&,
                        std::string&);

// SEH guard around the scan call (SPEC §8.3 crash/timeout -> blacklist flow:
// a crash here must still terminate with a parseable result + exit code 1).
// This frame holds only pointers/ints — no C++ objects needing unwinding —
// so __try compiles under /EHsc (C2712). Returns 1 = scanner returned true,
// 0 = scanner returned false (error string set), -1 = SEH fault (*sehCode).
int callScanGuarded(ScanFn fn, const std::wstring* path,
                    std::vector<ScannedPlugin>* out, std::string* error,
                    unsigned long* sehCode) {
  __try {
    return fn(*path, *out, *error) ? 1 : 0;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *sehCode = static_cast<unsigned long>(GetExceptionCode());
    return -1;
  }
}

} // namespace

int runScan(const std::wstring& path, const std::string& formatHint) {
  const std::string format = formatHint.empty() ? inferFormat(path) : formatHint;

  nlohmann::json result;
  if (format != "vst2" && format != "vst3") {
    result = {{"ok", false},
              {"error", "unknown format \"" + format + "\" (expected vst2 or vst3)"}};
  } else {
    std::vector<ScannedPlugin> plugins;
    std::string error;
    unsigned long sehCode = 0;
    const ScanFn fn = (format == "vst3") ? &scanVst3File : &scanVst2File;
    const int rc = callScanGuarded(fn, &path, &plugins, &error, &sehCode);

    if (rc == 1) {
      nlohmann::json arr = nlohmann::json::array();
      for (ScannedPlugin& p : plugins) {
        if (p.path.empty()) p.path = ipcWideToUtf8(path);
        if (p.format.empty()) p.format = format;
        if (p.bitness != 32 && p.bitness != 64)
          p.bitness = static_cast<uint32_t>(sizeof(void*) * 8);
        arr.push_back({{"uid", p.uid},
                       {"format", p.format},
                       {"path", p.path},
                       {"bitness", p.bitness},
                       {"name", p.name},
                       {"vendor", p.vendor},
                       {"category", p.category},
                       {"isInstrument", p.isInstrument},
                       {"numInputs", p.numInputs},
                       {"numOutputs", p.numOutputs}});
      }
      result = {{"ok", true}, {"plugins", std::move(arr)}};
    } else if (rc == -1) {
      char msg[64];
      std::snprintf(msg, sizeof(msg), "plugin crashed during scan (SEH 0x%08lX)",
                    sehCode);
      result = {{"ok", false}, {"error", msg}};
    } else {
      result = {{"ok", false},
                {"error", error.empty() ? "not a usable plugin" : error}};
    }
  }

  // Exactly one result line on stdout (the engine parses the last "ok" line).
  const std::string line = result.dump();
  std::printf("%s\n", line.c_str());
  std::fflush(stdout);
  return result.value("ok", false) ? 0 : 1;
}

} // namespace mydaw
