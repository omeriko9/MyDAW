# MyDAW

**A free, open-source DAW for Windows.** Native C++ audio engine, browser-based UI,
real VST plugin support — including 32-bit plugins and your old Cubase projects.

The browser is only the control surface: all audio, MIDI, and plugin processing runs in
native processes. Every plugin lives in its own sandboxed process, so a crashing plugin
never takes down your session.

## Highlights

- **Full DAW workflow** — arrangement view, mixer, piano roll, audio clip editor,
  automation lanes, audio/MIDI recording, undo everywhere.
- **VST2 + VST3, 64-bit *and* 32-bit** — sandboxed scanning and hosting, one process per
  plugin, crash/timeout auto-restart, native plugin editors, generic parameter editor.
  The 32-bit bridge means your legacy plugins still work.
- **Cubase `.cpr` import** — projects from Cubase SX (2004) through Cubase 13: tracks,
  notes, audio clips, tempo, mixer fader/pan/EQ, and **your VST inserts and instruments
  with their exact saved settings**. Export back to `.cpr` too (round-trip verified).
- **Built-in instruments & effects** — modeled Piano, PolySynth (with factory presets),
  sampler, and a stock effects suite (EQ-style utility, gate, compressor, limiter,
  delay, reverb).
- **Sheet music** — your MIDI engraved as real notation: proper pitch spelling for the key,
  tied/dotted rhythms, beaming, grand staff, and a live view while you record. Edit on the
  staff (write, delete, join, split, transpose), then print it or export MusicXML for
  MuseScore/Dorico/Sibelius.
- **Room View** — place your channels in a 3D room: left/right = pan, near/far = level.
- **Export** — WAV (16/24/32-bit), MP3, FLAC, AAC, with loudness normalization; MIDI
  file export; Cubase Track Archive export.
- **AI assistant (optional)** — a chat panel driven by any OpenAI-compatible endpoint
  (local LLMs work great) plus an embedded MCP server, with a full capability catalog
  over every engine operation. Mutations need your approval; edits are atomic undo steps.

Honest status: a working MVP used on real projects and hardware. What's deliberately
deferred is listed in [docs/STUBS.md](docs/STUBS.md) — no dead buttons.

## Build

Prerequisites: **Windows 10/11 x64**, **Visual Studio 2026** with the C++ workload
(2022 works — adjust the generator in `CMakePresets.json`), **CMake ≥ 3.25**,
**Node.js ≥ 18**, and network access on first configure (fetches the VST3 SDK).

```powershell
.\build.cmd
```

That's it — one command builds the UI, the engine, and both plugin hosts (x64 + x86).
Details, options (ASIO, VST3-less builds), and manual steps: [docs/BUILDING.md](docs/BUILDING.md).

## Run

```powershell
.\build\bin\Release\mydaw-engine.exe
```

Your browser opens `http://127.0.0.1:8417` with the UI. Point Settings ▸ Plugins at your
VST folders, hit scan, and make some noise.

Quick sanity check (headless): `node scripts/smoke-test.mjs`

## Repository layout

| Path | What |
|---|---|
| `engine/` | C++20 engine: audio graph, WASAPI, project model, media, MIDI, plugin runtime, HTTP+WS server |
| `plugin-host/` | Per-plugin sandbox host executable (x64 + x86 bridge) |
| `shared/` | Shared-memory IPC layout, pipe RPC, clean-room VST2 ABI |
| `ui/` | Vite + React + TypeScript control surface |
| `docs/` | Architecture, build guide, the binding SPEC, format reverse-engineering notes |
| `scripts/` | Build/dev scripts and end-to-end test harnesses |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — processes, threading, the native/web boundary
- [docs/BUILDING.md](docs/BUILDING.md) — build options and troubleshooting
- [docs/SPEC.md](docs/SPEC.md) — the binding contract: protocol, project format, plugin IPC
- [docs/IMPORT_PROJECT.md](docs/IMPORT_PROJECT.md) — writing an import provider for a new project format
- [docs/CPR_MIXER_FORMAT.md](docs/CPR_MIXER_FORMAT.md) — Cubase `.cpr` format notes (reverse-engineered)
- [docs/ROADMAP.md](docs/ROADMAP.md) — where this is going

## License

See [LICENSE](LICENSE). Note: building with VST3 support fetches the Steinberg VST3 SDK
(GPLv3/proprietary dual license); `-DMYDAW_NO_VST3=ON` builds without it. The VST2 ABI
header is a clean-room declaration — the Steinberg VST2 SDK is neither included nor needed.

Third-party assets: the sheet-music view draws with glyph outlines from the **Bravura**
music font (© Steinberg Media Technologies GmbH, SIL Open Font License 1.1 —
[docs/licenses/Bravura-OFL-1.1.txt](docs/licenses/Bravura-OFL-1.1.txt)). Only the ~40 glyphs
used are vendored as path data in `ui/src/components/SheetMusic/bravura.ts`; no font file is
shipped or loaded at runtime.
