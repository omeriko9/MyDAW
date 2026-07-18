# Building MyDAW

## Prerequisites

- Windows 10/11 x64
- Visual Studio 2026 (or 2022+) with the **Desktop development with C++** workload
- CMake ≥ 3.25 (VS bundles one; 4.x verified)
- Node.js ≥ 18 (22 verified)
- Network access on first configure (fetches the VST3 SDK from GitHub)

## One-shot build

```powershell
.\scripts\build.ps1            # UI -> engine x64 + host64 -> host32 (x86 bridge)
# switches: -SkipUi -SkipX64 -SkipHost32 -Clean
```

Artifacts:

| File | What |
|---|---|
| `build/bin/Release/mydaw-engine.exe` | The DAW. Serves the UI at `http://127.0.0.1:8417` |
| `build/bin/Release/mydaw-host64.exe` | 64-bit plugin sandbox host |
| `build32/bin/Release/mydaw-host32.exe` | 32-bit plugin sandbox host (jBridge-style bridge) |

## Manual steps

```powershell
cd ui; npm install; npm run build; cd ..
cmake --preset x64-release      && cmake --build --preset x64-release
cmake --preset host32-release   && cmake --build --preset host32-release
```

## Engine flags

`--port N` (8417) · `--driver wasapi|null` (`asio` once enabled) · `--ui-root <dir>` ·
`--host64-path/--host32-path <exe>` · `--project <Name.mydaw>` · `--no-browser`

## Options

- **ASIO**: `-DMYDAW_ASIO_SDK_DIR=C:/path/to/asiosdk` (download from Steinberg — not
  redistributable, so it is never vendored). This wires include dirs + `MYDAW_HAVE_ASIO`.
  Note: the ASIO *backend* implementation is deferred (see STUBS.md); without it the UI
  lists ASIO as unavailable with the reason. WASAPI is the supported MVP driver.
- **No VST3 / offline configure**: `-DMYDAW_NO_VST3=ON` skips the VST3 SDK fetch; hosts
  build VST2-only and report VST3 as unsupported.
- The VST3 SDK (`v3.7.12_build_20`, GPLv3/proprietary dual license) is fetched via
  CMake FetchContent; only the hosting libraries are built (no samples/vstgui).

## Dev mode

```powershell
.\scripts\dev.ps1     # starts the built engine + vite dev server (http://localhost:5173)
```

Vite proxies `/ws` and `/api` to the engine on 8417.

## Tests

```powershell
node scripts/smoke-test.mjs       # spawns engine (null driver), 16 protocol checks
node scripts/vst-load-test.mjs    # real plugin scan + out-of-process load + RT bridge run
```

## Notes

- Static CRT (`/MT`) everywhere — the exes have no VC runtime dependency.
- `build/`, `build32/`, `ui/node_modules` are marked Dropbox-ignored via NTFS streams.
- Plugin scan cache and blacklist live in `%APPDATA%/MyDAW/`.
