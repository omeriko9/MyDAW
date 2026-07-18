# Cross-platform MyDAW with Windows-native VST DLLs (Linux/macOS plan)

> Reference plan, 2026-07-17. Not scheduled — captured for when porting comes up.
> Question it answers: how do we run MyDAW on Linux/macOS while still hosting
> Windows x86/x64 VST DLLs?

## The architectural head start

MyDAW already hosts plugins **out-of-process**: `mydaw-host64.exe` / `mydaw-host32.exe`
speak an IPC protocol to the engine (shared/ipc). That process boundary is *exactly* the
seam every cross-platform Windows-VST solution exploits. Porting means:

- **UI** — already a browser app; nothing to do.
- **Engine** — port the audio backend (WASAPI/ASIO → PipeWire/JACK/ALSA on Linux,
  CoreAudio on macOS) and Win32 utilities (util/Dialogs, shared/win/Foreground, process
  spawning). Model/commands/graph are portable C++.
- **Plugin host** — the ONLY piece that needs a Windows-ish environment. Everything
  below is about this one process.

## Why Wine is unavoidable (and why that's fine)

A VST DLL doesn't just need x86 instructions executed — it calls the Win32 ABI:
`user32`/`gdi32` (editor windows), `kernel32`, registry, COM. The only implementations
of that surface are **Wine** (Proton/CrossOver/Bottles are all Wine derivatives) or a
full Windows VM. CPU translators (Rosetta 2, box64/FEX) only solve instruction-set,
not the OS ABI — on ARM they sit *under* Wine, not instead of it.

Wine feels heavy when a whole app runs in it. Scoped to a single headless plugin-host
process it is lightweight and production-proven.

## Pattern 1 — winelib host (Linux; the yabridge pattern)

**yabridge** (open source, the de-facto Linux standard; study its source before
designing) compiles its plugin host as a **winelib binary**: one process that can call
Win32 APIs (to load the DLL and create its editor HWND — Wine renders it as a normal
X11/Wayland window) *and* native Unix sockets/shared memory (to talk to the DAW with
no extra hop). Production-grade latency; per-plugin process isolation.

For MyDAW: the Linux engine spawns the host under a Wine prefix (or a winelib port of
`plugin-host/`), keeping our existing IPC protocol across the boundary. Plugin state
(chunk save/restore), param streams, and editor-window handling all conceptually
survive — editors are already separate host-process windows today.

Bonus: **Wine prefixes are per-plugin sandboxes** — our registry-overlay sandbox work
(feat/reg-overlay-sandbox: reg virtualization, DLL-search bundles, COM/file overlay for
old VSTs) maps onto per-prefix isolation, which is *stronger* than what we do on real
Windows.

## Pattern 2 — networked host (solves macOS + cursed plugins + DSP offload)

Precedents: **AudioGridder** (open source — read it), Vienna Ensemble Pro. The plugin
host runs on a real Windows machine or VM; audio blocks + parameters cross the LAN;
plugin GUIs are streamed as video. Cost ≈ one network round-trip per block — fine on a
LAN at sane block sizes.

For MyDAW this is small: our host protocol already assumes process separation, so let
it ride **TCP as an alternative transport** to local shared memory. One feature buys:
- Windows VSTs from a Mac with zero Wine,
- a fallback for any plugin Wine chokes on,
- DSP offload to a beefier machine.

## macOS reality check

Wine on macOS (CrossOver, Whisky) works but is the flaky corner: 32-bit hoops, Apple
Silicon = Rosetta 2 under Wine, GPU-accelerated plugin GUIs suffer. Treat it as
opportunistic polish for favorite plugins; the *dependable* macOS story is Pattern 2
(networked host) plus native mac VSTs if we ever host those.

## Recommended stages

1. Port engine core to Linux (PipeWire first) — browser UI unchanged.
2. Winelib-ify the plugin host (yabridge pattern), keep the IPC protocol.
3. Add the TCP transport to the host protocol (covers macOS/ARM/remote in one move).
4. CrossOver-on-Mac as opportunistic extra, never a pillar.

Prep worth one day before step 2/3: read yabridge's transport + editor-embedding code
and AudioGridder's server/client split.
