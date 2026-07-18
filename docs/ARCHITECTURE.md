# Architecture

Authoritative contracts (message names, schema fields, struct layouts) live in
[SPEC.md](SPEC.md). This document explains the shape and the reasoning.

## Processes

```
Browser (UI only)  ──HTTP/WS──>  mydaw-engine.exe (x64)
                                   │ audio graph, project model, undo, server
                                   │ WASAPI/null driver, MIDI, media, export
                                   ├── shm ring + named pipe ──> mydaw-host64.exe  (one per 64-bit plugin)
                                   └── shm ring + named pipe ──> mydaw-host32.exe  (one per 32-bit plugin)
```

- **The browser never touches audio.** It is a control surface; the engine plays audio
  directly to the device. The engine owns the authoritative project state; the UI sends
  commands over WebSocket and mirrors state from `event/projectChanged` (SPEC §5.8).
- **One host process per plugin instance** (maximum isolation): a crashing/hanging
  plugin can never take down the engine or other plugins. The x86 build of the same
  host source *is* the 32-bit bridge — the engine just spawns the matching binary, so
  bitness is invisible above the IPC layer (the jBridge approach, done as a host-side
  adapter rather than a proxy DLL because we control the host).

## Engine threading

- **Main thread** — project model, command processing (all `cmd/*` are undoable via
  full-model snapshots), graph rebuilds, timers (autosave, transport/meter broadcasts).
- **RT audio thread** (driver callback) — renders the current `RenderPlan`, an immutable
  flattened graph published via atomic `shared_ptr` swap; retired plans are freed on the
  main thread after a grace period. No allocation, locks, or logging on this thread.
  Param-only changes (faders, plugin params) bypass rebuilds via a lock-free ring.
- **Server thread** — Winsock select loop (hand-rolled HTTP/1.1 + RFC6455 WebSocket);
  requests marshal to the main thread, replies/events marshal back.
- **Workers** — decode, peaks, export render, autosave, plugin lifecycle/restart.

## Plugin bridge (SPEC §8)

Per instance: a shared-memory block (header + planar audio I/O + MIDI + param queues)
and two named events form the RT path; a named pipe with length-prefixed JSON is the
control path (params, state chunks, presets, editor open/close).

RT exchange: the engine writes inputs → signals `req` → waits `done` with a timeout of
`max(2, 2×block duration)` ms. On timeout it outputs silence (effects: dry) and counts a
miss; 3 consecutive misses or process death → instance marked crashed, async restart
with the last good state chunk (max 2 attempts, then `failed` until the user reloads).
Blocking the RT thread on the plugin's event is the standard bridge tradeoff: the
penalty for a late plugin is bounded by the timeout and converted into silence + recovery
instead of an engine xrun cascade.

Scanning uses the same host binaries (`--scan <path>`, 20 s timeout, SEH-guarded):
crashes and hangs land in the blacklist with a reason instead of in your session.
Bitness is routed by reading the PE machine field before spawning.

## Plugin delay compensation

Each insert reports latency (VST2 `initialDelay` / VST3 `getLatencySamples`, re-queried
on change notifications). Chain latencies are summed and every path to the master is
aligned with per-track delay lines to the maximum total; `pdcSamples` is reported in
engine status. Live-input monitoring bypasses PDC.

## Plugin editors

The generic editor in the browser is generated from the parameter list (values, units,
presets, bypass, wet/dry, live updates from the native side) and is always available.
"Native UI" opens the plugin's real editor as a top-level window owned by its host
process (works for both bitnesses, fully isolated).

**Future — native UI streaming to the browser** (designed, not implemented): the host
process would capture its editor window via `Windows.Graphics.Capture`, encode, and
stream over WebRTC into a browser modal, forwarding mouse/wheel/keyboard/focus/resize
back over a data channel. The same path works for host64 and host32 since each owns its
editor HWND. The generic editor remains the fallback whenever streaming is unavailable
or a plugin misbehaves. Nothing in the UI pretends this exists today.

## Project persistence (SPEC §6)

`Name.mydaw/` folder: `project.json` (human-readable), `audio/` (copied/recorded
assets), `peaks/` (waveform cache), `plugin-states/` (binary chunks), `autosave/`
(rolling 5). Atomic tmp+rename saves; `%APPDATA%/MyDAW/session.lock` enables crash
recovery; missing assets surface as relink prompts.

## Sample-rate policy

The session runs at the device rate; assets are resampled once at import (never on the
RT path). Tempo is a piecewise map (single entry in v1; math is general).

## AI Agent + MCP

One canonical capability catalog (`shared/agent/capabilities.json`) covers every typed engine
request and 13 typed UI operations. A dependency-free generator emits checked-in C++
(`engine/src/agent/AgentCatalog.gen.*`) and TypeScript (`ui/src/agent/catalog.gen.ts`) views;
a coverage oracle fails the build if any `RequestMap` request lacks agent exposure or an
explicit exclusion. Prepared scripts live in `shared/agent/prompts.json` and are embedded to
both sides the same way.

Two engine primitives sit behind the existing `Api`/`CommandProcessor` boundary (they stay
outside `RequestMap` — the tool layer is their external surface):

- **`agent/query`** (`engine/src/agent/AgentQuery.*`) — bounded, paginated, redacted reads
  over ~40 project/runtime views; every reply carries the engine revision.
- **`agent/batch`** (`CommandProcessor::executeBatch`) — up to 64 catalog-approved `cmd/*`
  operations as one atomic group: `expectedRevision` optimistic concurrency, full model +
  live-plugin rollback on failure, one coalesced rebuild/broadcast, and one undo entry.

Two consumers share those primitives through the same six logical tools (context, describe,
query, execute, batch, ui):

- **MCP server** (`engine/src/server/McpServer.*`) — embedded Streamable-HTTP JSON-RPC 2.0 at
  `POST /mcp` (revision `2025-11-25`). `HttpWsServer` buffers the request on the socket thread
  and replies asynchronously via a raw-HTTP outbox channel; the work runs on the main thread
  (posted into the job queue, exactly like the WebSocket path), so long calls never block the
  socket thread. Security: per-user bearer token (`llm.mcpToken`), loopback-only Origin
  enforcement, body caps, catalog-derived tool annotations.
- **In-app agent** (`ui/src/agent/*`) — talks to an OpenAI-compatible endpoint directly from
  the browser and executes tools itself: query/execute/batch over the WebSocket, context/
  describe locally from the catalog, and `ui/*` operations through a typed UI executor
  (`uiExecutor.ts`) that performs whitelisted store mutations (no arbitrary DOM/JS). The tool
  loop (`agentLoop.ts`) runs read-only calls in parallel, serializes mutations behind approval
  (unless YOLO), and returns tool failures to the model rather than faking success. Chat
  history and custom scripts are per-user, project-keyed, and stored under `settings.llm`
  (never in the `.mydaw` project).

No LLM, HTTP, JSON-schema, or agent work ever runs on the real-time audio thread.
