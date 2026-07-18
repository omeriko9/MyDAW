// MyDAW — main.cpp (E9)
// Engine entry point: parses the command line, constructs the App composition root,
// opens the default browser at the served UI (unless --no-browser) and runs the
// main-thread loop until Ctrl+C / console close requests a clean shutdown.
//
// Flags: --port <n> (8417) | --driver wasapi|asio|null | --ui-root <dir>
//        --host32-path <exe> | --host64-path <exe> | --project <path> | --no-browser
// ("--flag=value" is accepted too.)

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <shellapi.h>
#include <timeapi.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <fstream>
#include <sstream>

#include "App.h"
#include "export/CprWriter.h"
#include "util/Json.h"
#include "util/Log.h"
#include "util/LogFile.h"
#include "util/Paths.h"

namespace {

mydaw::App* g_app = nullptr;

BOOL WINAPI consoleCtrlHandler(DWORD ctrlType) {
    switch (ctrlType) {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
        case CTRL_CLOSE_EVENT:
        case CTRL_SHUTDOWN_EVENT:
            if (g_app) {
                mydaw::Log::info("main: shutdown signal received");
                g_app->requestStop();
                return TRUE;
            }
            return FALSE;
        default:
            return FALSE;
    }
}

// Collects argv as UTF-8 (the engine is UTF-8 internally, SPEC §4).
std::vector<std::string> argvUtf8() {
    std::vector<std::string> out;
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv)
        return out;
    for (int i = 0; i < argc; ++i)
        out.push_back(mydaw::wideToUtf8(argv[i]));
    LocalFree(argv);
    return out;
}

bool parseArgs(const std::vector<std::string>& args, mydaw::AppOptions& opts) {
    auto take = [&](size_t& i, const std::string& flag, std::string& out) -> bool {
        const std::string& a = args[i];
        if (a == flag) {
            if (i + 1 >= args.size()) {
                mydaw::Log::error("main: %s requires a value", flag.c_str());
                return false;
            }
            out = args[++i];
            return true;
        }
        if (a.rfind(flag + "=", 0) == 0) {
            out = a.substr(flag.size() + 1);
            return true;
        }
        return false;
    };
    for (size_t i = 1; i < args.size(); ++i) {
        std::string v;
        if (take(i, "--port", v)) {
            const int port = std::atoi(v.c_str());
            if (port <= 0 || port > 65535) {
                mydaw::Log::error("main: invalid --port '%s'", v.c_str());
                return false;
            }
            opts.port = port;
            opts.portExplicit = true;
        } else if (take(i, "--driver", v)) {
            opts.driver = v;
        } else if (take(i, "--ui-root", v)) {
            opts.uiRoot = v;
        } else if (take(i, "--host32-path", v)) {
            opts.host32Path = v;
        } else if (take(i, "--host64-path", v)) {
            opts.host64Path = v;
        } else if (take(i, "--project", v)) {
            opts.projectPath = v;
        } else if (args[i] == "--no-browser") {
            opts.noBrowser = true;
        } else if (args[i] == "--exit-when-idle") {
            opts.exitWhenIdle = true;
        } else {
            mydaw::Log::warn("main: ignoring unknown argument '%s'", args[i].c_str());
        }
    }
    return true;
}

// Hidden byte-parity test mode (docs/CPR_WRITER_M3_NOTES.md §"C++ port"):
//   mydaw-engine --cpr-write <model.json> <out.cpr>
// Runs the CprWriter on a writer-model JSON (the scripts/cpr-write.mjs shape) and exits
// without booting the engine. Output must be byte-identical to the Node reference
// writer for the same model + donor.
int runCprWriteMode(const std::vector<std::string>& args, size_t i) {
    using namespace mydaw;
    if (i + 2 >= args.size()) {
        std::fprintf(stderr, "usage: mydaw-engine --cpr-write <model.json> <out.cpr>\n");
        return 2;
    }
    const std::string& modelPath = args[i + 1];
    const std::string& outPath = args[i + 2];
    std::ifstream in(utf8ToWide(modelPath).c_str(), std::ios::binary);
    if (!in.is_open()) {
        std::fprintf(stderr, "cpr-write: cannot read %s\n", modelPath.c_str());
        return 1;
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    const json model = parseJson(ss.str());
    if (model.is_discarded()) {
        std::fprintf(stderr, "cpr-write: %s is not valid JSON\n", modelPath.c_str());
        return 1;
    }
    std::vector<uint8_t> bytes;
    std::string err;
    if (!CprWriter::writeModelJson(model, bytes, err)) {
        std::fprintf(stderr, "cpr-write: %s\n", err.c_str());
        return 1;
    }
    std::ofstream out(utf8ToWide(outPath).c_str(), std::ios::binary | std::ios::trunc);
    if (!out.is_open()) {
        std::fprintf(stderr, "cpr-write: cannot write %s\n", outPath.c_str());
        return 1;
    }
    out.write(reinterpret_cast<const char*>(bytes.data()),
              static_cast<std::streamsize>(bytes.size()));
    out.close();
    if (!out) {
        std::fprintf(stderr, "cpr-write: write failed for %s\n", outPath.c_str());
        return 1;
    }
    std::printf("wrote %s: %zu bytes\n", outPath.c_str(), bytes.size());
    return 0;
}

} // namespace

int main() {
    using namespace mydaw;

    const std::vector<std::string> args = argvUtf8();
    for (size_t i = 1; i < args.size(); ++i)
        if (args[i] == "--cpr-write")
            return runCprWriteMode(args, i);

    AppOptions opts;
    if (!parseArgs(args, opts))
        return 2;

    // Persistent action log: every Log line also lands in %APPDATA%/MyDAW/logs (rotated).
    // Installed before app.init() so startup is captured. Print the path so it's findable.
    const std::string logPath = initFileLog();
    if (!logPath.empty())
        Log::info("main: logging to %s", logPath.c_str());
    else
        Log::warn("main: file logging unavailable — console/in-memory only");

    timeBeginPeriod(1); // 1 ms scheduler granularity for the 5 ms main-loop tick

    App app(opts);
    g_app = &app;
    SetConsoleCtrlHandler(consoleCtrlHandler, TRUE);

    std::string err;
    if (!app.init(err)) {
        Log::error("main: engine init failed: %s", err.c_str());
        g_app = nullptr;
        timeEndPeriod(1);
        return 1;
    }

    if (!opts.noBrowser) {
        // app.opts.port is the RESOLVED port (init applies settings.json when --port absent).
        const std::string url = "http://127.0.0.1:" + std::to_string(app.opts.port) + "/";
        const HINSTANCE r = ShellExecuteW(nullptr, L"open", utf8ToWide(url).c_str(),
                                          nullptr, nullptr, SW_SHOWNORMAL);
        if (reinterpret_cast<INT_PTR>(r) <= 32)
            Log::warn("main: could not open browser at %s", url.c_str());
    }

    const int rc = app.run();
    g_app = nullptr;
    timeEndPeriod(1);
    return rc;
}
