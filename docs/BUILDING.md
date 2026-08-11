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

Two failures here are environmental, not your change:

- `npm run build` dies at vite's `emptyDir` roughly half the time because Dropbox holds a
  handle on `ui/dist`. Just retry — but note a *failed* attempt can leave dist
  half-deleted, and then the app will not mount at all, which looks like a catastrophic
  regression rather than a build that never finished.
- The engine link fails `LNK1104: cannot open ... mydaw-engine.exe` when an engine is
  running. **Rename the running exe** (`mydaw-engine.exe.inuse-<stamp>`) and rebuild —
  never kill the process, it may be the user's live session. Delete the leftovers
  afterwards; `rebuild.ps1` kills engines it did not start, which has cost a live session
  before.

## Engine flags

`--port N` (8417) · `--driver wasapi|null` (`asio` once enabled) · `--ui-root <dir>` ·
`--host64-path/--host32-path <exe>` · `--project <Name.mydaw>` · `--no-browser` ·
`--exit-when-idle` · `--null-input N`

`--null-input N` makes the null driver synthesize N capture channels (opt-in, default 0)
so the RECORDING path is reachable headlessly — without it the driver reports no inputs at
all and punch, loop-record takes and input metering cannot be tested by anything. The
signal is a position-recoverable ramp; see SPEC §11.

MIDI has the equivalent affordance over the wire rather than a flag: `midi/feedEvent`
injects a channel-voice message into the recorder's mirror ring (SPEC §5.2).

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

For inspecting or driving the UI in a real browser (console, network, performance
traces, interactive control), see [DEBUGGING_UI.md](DEBUGGING_UI.md).

## Tests

```powershell
node scripts/gate.mjs             # 33 suites, ~2.5 min — run this before every commit
node scripts/gate.mjs --full      # +recovery, real-plugin and CPR corpus suites, ~4 min
node scripts/gate.mjs --list      # the table: which suite is in which tier, and why
node scripts/gate.mjs --only ui-smoke,smoke
```

This is a gate, not a suggestion: **a change is not done until `gate.mjs` is green**, and a
UI bug that no unit test can reach should leave a new `ui-smoke` check behind it. Run
`--full` before a merge or a release.

Individual suites still run standalone (`node scripts/ui-smoke.mjs`, `cd ui; npm test`,
and the 29 harnesses in `scripts/*-test.mjs`) — the gate is a runner over them, not a
replacement. See [UI_TEST_SUITE.md](UI_TEST_SUITE.md) for which layer a new check belongs in.

Three things the gate does that are easy to get wrong by hand:

- **It runs suites sequentially, and must.** Each harness spawns an engine on its own
  hard-coded default port, and several collide — 8547 is shared by `dop-vst` and
  `export-formats`, 8561 by `midi-learn` and `sidechain`, and 8562 by `comping`,
  `midi-out-channel` *and* `timestretch`. Run concurrently they fail in ways that look
  like flakiness.
- **A missing prerequisite is a SKIP, not a failure.** `vst-load` and `dop-vst` need a
  scanned plugin registry, which is machine state a fresh clone does not have; `cpr-write`
  falls back to `--skip-corpus` when the gitignored corpus harness is absent. A runner
  that is red on every machine but one teaches people to ignore it.
- **It builds nothing.** If `ui/dist` or the engine is stale the gate tests the stale
  thing, so build first — and never while `ui-drive` slots are running. This warning was
  already here on 2026-08-10 and was still walked into for a whole session (ui-smoke
  reported green all day against an hours-old bundle that was hiding 7 real failures), so
  it is now **enforced**: `ui-smoke.mjs` refuses to start when `ui/src` is newer than
  `ui/dist`. Nothing enforces it for the engine yet — rebuild it yourself.
- **Never run two `gate.mjs` invocations at once.** The port collisions above are between
  *processes*, so a second gate — or a gate started while you are running a suite by hand —
  produces failures indistinguishable from flake. One cost half an hour chasing a
  `recovery` failure that was only ever a background gate still running.

## Packaging a release (portable single exe)

One command, current state → GitHub release:

```powershell
pwsh scripts/release.ps1 -Version 1.1.0 -Publish
```

Chains build.ps1 → `node scripts/gate.mjs --full` → package-portable.ps1 →
`gh release create v<v>` with the exe + `.sha256` attached (uploads onto the tag if it
already exists). `-SkipBuild` packages what's on disk, `-SkipGate` skips verification
(you own whatever ships), omitting `-Publish` stops after `dist\` and prints the gh
command. A dirty working tree warns loudly — a release should correspond to a commit.

The packaging step alone:

```powershell
pwsh scripts/package-portable.ps1 -Version 1.0.0
```

Wraps the **current** build outputs (`build\bin\Release\mydaw-engine.exe`,
`mydaw-host64.exe`, `build32\...\mydaw-host32.exe`, `ui\dist`, `LICENSE`) in an IExpress
self-extractor → `dist\MyDAW-Portable-<v>.exe` (+ `.sha256`). The packager **builds
nothing** — it freezes whatever is on disk, so build + run `node scripts/gate.mjs --full`
first. On the user's machine the exe unpacks once per version to `%LOCALAPPDATA%\MyDAW\app`
(hidden VBS→PowerShell launcher, `scripts/portable/`) and starts the engine; double-clicking
while MyDAW is running just reopens the browser tab. Per-user, no admin, no registry, no
firewall prompt (loopback-only server). The artifact is unsigned → SmartScreen "More info →
Run anyway" on first download; a code-signing cert is the only cure. Publish with
`gh release create v<v> dist\MyDAW-Portable-<v>.exe ...`.

## Notes

- Static CRT (`/MT`) everywhere — the exes have no VC runtime dependency (this is also
  what makes the portable package dependency-free).
- `build/`, `build32/`, `ui/node_modules` are marked Dropbox-ignored via NTFS streams.
- Plugin scan cache and blacklist live in `%APPDATA%/MyDAW/`.
- `dist/` (packaged artifacts) is gitignored — releases live in GitHub Releases, not git.
