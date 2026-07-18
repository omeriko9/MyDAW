# MyDAW — Master Specification (v1)

This is the single source of truth for all modules. Implementation agents: code EXACTLY against
the names, types, and layouts here. If something is ambiguous, choose the simplest interpretation
consistent with this document and leave a `// NOTE(spec):` comment. Do not rename protocol
messages, schema fields, IPC structs, or files owned by other modules.

## 1. Overview

A Windows DAW. Native C++20 engine does all audio/MIDI/plugin work; the browser UI is a pure
control surface (no audio in the browser). One arrangement window UX (Cubase/Ableton-arrangement
style) with docked mixer / piano roll / clip editor, inspector, browser sidebar.

Processes:

| Process | Arch | Role |
|---|---|---|
| `mydaw-engine.exe` | x64 | Audio engine, project model (authoritative), HTTP+WS server, plugin orchestration |
| `mydaw-host64.exe` | x64 | Hosts ONE VST2/VST3 x64 plugin instance out-of-process (or runs `--scan`) |
| `mydaw-host32.exe` | x86 | Same source as host64, built 32-bit: the jBridge-style bridge for 32-bit plugins |
| Browser (Chrome/Edge) | — | UI at `http://127.0.0.1:<port>` (default 8417; `--port` flag > settings.json `port` > 8417) |

Tech: C++20, CMake (VS 2026 generator), WASAPI (ASIO optional behind SDK flag), Windows Media
Foundation decode, winmm MIDI, nlohmann/json (vendored single header), hand-rolled HTTP/WS server
on Winsock. UI: Vite + React 18 + TypeScript + zustand, canvas rendering for timeline/piano
roll/waveforms, custom dark theme CSS (no UI framework). License caveat: VST3 SDK via FetchContent
(GPLv3); VST2 via clean-room `vestige.h`-style ABI header (we do NOT ship Steinberg VST2 SDK).

## 2. Repository layout & module ownership

```
MyDAW/
  CMakeLists.txt              # superbuild: engine + host64; host32 via preset
  CMakePresets.json           # presets: x64-release, x64-debug, host32-release
  scripts/build.ps1           # full build: ui -> engine x64 -> host32
  scripts/dev.ps1             # vite dev + engine
  docs/  SPEC.md ARCHITECTURE.md IPC_PROTOCOL.md PROJECT_FORMAT.md BUILDING.md STUBS.md
  third_party/nlohmann/json.hpp        # vendored
  shared/                     # code shared by engine + plugin hosts
    ipc/PluginIpc.h           # shm layout, pipe message structs (section 8)
    ipc/SharedMem.h/.cpp      # CreateFileMapping wrapper, events
    ipc/Pipe.h/.cpp           # named pipe, length-prefixed JSON messages
    vst2/vestige.h            # clean-room VST2 ABI
  engine/
    CMakeLists.txt
    src/main.cpp
    src/core/   AudioGraph.* GraphNode.h TrackNode.* Transport.* TempoMap.* Mixer.* Pdc.* Metronome.* RtRing.h Meters.*
    src/audio/  IAudioDriver.h WasapiDriver.* AsioDriver.* DriverManager.*
    src/midi/   MidiInput.* MidiEvent.h SmfReader.* MidiRecorder.*
    src/media/  Decoder.* WavWriter.* PeakFile.* AssetStore.* OfflineRender.*
    src/project/ Model.h Model.cpp Commands.* UndoStack.* ProjectIO.* Autosave.* Serialize.*
    src/plugins/ PluginScanner.* PluginRegistry.* Blacklist.* PluginProxyNode.* HostProcess.*
    src/server/ HttpWsServer.* Api.* StaticFiles.* EventBus.*
    src/util/   Log.h Json.h (alias to nlohmann) Paths.* Strings.*
  plugin-host/
    CMakeLists.txt
    src/main.cpp src/Vst2Host.* src/Vst3Host.* src/EditorWindow.* src/ShmServer.* src/Scan.*
  ui/
    package.json vite.config.ts tsconfig.json index.html
    src/main.tsx src/App.tsx
    src/protocol/types.ts     # mirrors §5 + §6 exactly
    src/protocol/ws.ts        # WS client, request/reply, event sub
    src/store/store.ts        # zustand: project mirror, ui state, engine status
    src/store/actions.ts      # command senders (optimistic helpers)
    src/components/ Transport/ Timeline/ Mixer/ PianoRoll/ ClipEditor/ Inspector/ Browser/ Settings/ PluginEditor/ Dialogs/ common/
    src/lib/ time.ts ids.ts keyboard.ts dnd.ts canvas.ts theme.css
```

Module owners (one agent each; touch ONLY your files + read-only access to everything):
F1 cmake+scripts, F2 shared/ipc+vestige, F3 engine core headers, F4 ui scaffold+protocol/store,
F5 docs. Implementation: E1 audio drivers, E2 graph/transport/mixer/PDC/metronome, E3 project
model/commands/undo/IO, E4 media, E5 midi, E6 plugin scanner/registry/blacklist, E7
PluginProxyNode/HostProcess, E8 server, E9 main wiring; H1 plugin-host exe; U1 timeline, U2
transport+shell, U3 mixer, U4 piano roll, U5 inspector+settings+dialogs, U6 plugin
browser/editor, U7 clip editor.

## 3. Build

- Engine x64: `cmake -S . -B build -A x64` then `cmake --build build --config Release`.
- Host32: `cmake -S . -B build32 -A Win32 -DMYDAW_HOST_ONLY=ON` then build. `MYDAW_HOST_ONLY`
  builds only `mydaw-host32` (skips engine and VST3 SDK if it fails on x86 — VST3 must build for
  x86 too; if FetchContent SDK breaks on Win32 keep going with VST2-only and set
  `MYDAW_HOST32_VST2_ONLY` automatically).
- UI: `cd ui && npm install && npm run build` → `ui/dist`. Engine serves `ui/dist` (path resolved
  relative to exe: `../../ui/dist` then `./ui` fallback; `--ui-root <path>` flag overrides).
- ASIO: `-DMYDAW_ASIO_SDK_DIR=C:/path/to/asiosdk` enables `AsioDriver`. Without it the code is
  compiled out via `#ifdef MYDAW_HAVE_ASIO` and the driver list reports ASIO unavailable+reason.
- VST3 SDK: FetchContent `https://github.com/steinbergmedia/vst3sdk` tag `v3.7.12_build_20`,
  GIT_SHALLOW, only hosting libs (`SMTG_ADD_VST3_HOSTING_SAMPLES=OFF`, plugins/samples OFF). Link
  target `sdk_hosting`. If configure-time fetch fails, CMake option `MYDAW_NO_VST3=ON` compiles
  out VST3 (clear log message); engine then reports vst3 support absent.
- Output dir: `build/bin/Release/` (engine, host64); `build32/bin/Release/` (host32). Engine
  locates hosts: same dir as engine exe first, then `../../../build32/bin/<config>/` (dev layout),
  then `--host32-path`.

## 4. C++ conventions

Namespace `mydaw`. No exceptions across RT paths; engine uses exceptions only at startup/IO edges.
`Log::info/warn/error(fmt,...)` writes to stderr + ring buffer (served via `engine/getLog`).
All WS/JSON on non-RT threads. RT thread allocates nothing, locks nothing (except the documented
plugin-IPC wait, §8). IDs: tracks/clips/etc use `uint64` monotonically increasing per project
(`Model::nextId`). Time: musical positions in `double beats` (quarter notes); audio offsets in
`int64 samples`. Sample rate fixed per session (project stores preferred SR; engine resamples
nothing in v1 — if asset SR != session SR, linear-resample at import time, never at playback).

## 5. WebSocket protocol (browser ⇄ engine)

Endpoint `ws://127.0.0.1:<port>/ws` (default 8417, see §1/§5.7), JSON text frames.

Client→engine: `{"id": <int>, "type": "<name>", "payload": {...}}` — every message gets a reply
`{"replyTo": <id>, "ok": true, "payload": {...}}` or `{"replyTo": <id>, "ok": false, "error": {"code": "<str>", "message": "<str>"}}`.
Engine→client events (no id): `{"type": "event/<name>", "payload": {...}}`.

All mutating `cmd/*` go through the undo stack unless `"transient": true` is present at the
envelope top level (transient = apply to model+audio, no undo entry, no projectChanged broadcast —
used while dragging faders/knobs; the final message of the gesture is sent without transient).
The engine snapshots the project at the FIRST transient message of a gesture and uses that
snapshot as the undo "before" of the gesture's closing non-transient commit, so one undo reverts
the entire drag.

### 5.1 Session & project
- `session/hello {clientName}` → `{engine:{version, sampleRate, blockSize, driver, latencyMs,
  asioAvailable, vst3Available}, project: <Project §6>, pluginRegistry:[PluginInfo §5.6],
  recentProjects:[{path,name,mtime}], audioDevices: <as engine/getDevices>, midiInputs:[{id,name}],
  metronome:{enabled:bool, countInBars:0|1|2} /*engine metronome state — same object as §5.4*/}`
- `project/new {}`, `project/load {path}`, `project/save {}`, `project/saveAs {path}`,
  `project/loadRecent {path}`. Replies carry `{project}` on load/new. `project/save` with no path
  yet → error `no_path` (UI then asks engine to open native dialog: `dialog/saveProject {}` →
  `{path|null}`; `dialog/openProject {}` → `{path|null}`; `dialog/importProject {}` →
  `{path|null}`; `dialog/importFiles {}` → `{paths:[..]|null}` — engine shows native IFileDialog).
  File>Import>Project… in the UI prefers a web paste-path dialog (absolute path →
  `project/importForeign`) since browsers cannot reveal full paths; `dialog/importProject` stays
  as the "Browse (native)…" fallback.
- `project/recoveryInfo {}` → `{available:bool, autosavePath, mtime}`; `project/recover {}`.
- Events: `event/projectChanged` (§5.8), `event/dirty {dirty:bool}`.

### 5.2 Commands — tracks
- `cmd/track.add {kind:"audio"|"midi"|"instrument"|"folder"|"bus", name?, index?, channels?:1|2}`
  → `{track: Track}` (instrument = midi track whose first insert is expected to be an instrument)
- `cmd/track.remove {trackId}` ; `cmd/track.reorder {trackId, newIndex, parentId?}`
- `cmd/track.set {trackId, patch:{name?,color?,height?,volume?,pan?,mute?,solo?,recordArm?,
  monitor?, inputDevice?, inputChannel?, outputTarget?, midiTarget?, vcaId?}}` (outputTarget: trackId
  of bus, or "master", or "none"). `vcaId` assigns the track to a VCA group (0 clears; changing it
  is structural). `midiTarget` (number): valid ONLY on `kind:"midi"` tracks — routes the
  track's MIDI into the `kind:"instrument"` track with that id (one shared instrument instance can
  serve several MIDI tracks); the target must exist and be an instrument track (`bad_request`
  otherwise); `0` clears and is always accepted. Changing it is structural (graph rebuild).
  Instrument tracks never carry a midiTarget, so feeder routing is acyclic by construction.
  A routed MIDI track ("feeder") contributes no audio of its own (its inserts are bypassed);
  muting a feeder silences only its events; soloing a feeder keeps its target instrument audible
  (and soloing the instrument keeps its feeders' events flowing).
- `cmd/track.addSend {trackId, destTrackId, level?, pre?}` ; `cmd/track.removeSend {trackId, sendIndex}` ;
  `cmd/track.setSend {trackId, sendIndex, patch:{level?,pre?,enabled?}}`
- **MIDI control surface / learn** (`Project.midiMaps: [{cc,channel,paramRef}]`): `midimap/learn
  {paramRef}` arms — the next incoming CC (from any hardware MIDI input) binds to it;
  `midimap/remove {paramRef}`; `midimap/feedCc {cc,channel?,value}` injects a CC through the same
  path (real MIDI, a software surface, or tests). paramRef grammar: `track:<id>:volume|pan` |
  `plugin:<instanceId>:<paramId>`. A mapped CC drives the param live (value 0..127 → 0..1;
  applied via a transient `cmd/track.set`/`cmd/plugin.setParam`, so audio AND the on-screen
  control move). Maps + the current arm ride `session/hello` and `event/midiMaps`; maps persist
  in the project. Engine: `MidiInput` non-RT control callback → `App::handleMidiControl`.
- **VCA groups** (`Project.vcas: [{id,name,gain}]`, SPEC §6): `cmd/vca.add {name?}` → `{vca}`;
  `cmd/vca.remove {id}` (detaches members → unity); `cmd/vca.set {id, patch:{gain?,name?}}`
  (transient for fader drags). A VCA's linear gain multiplies the fader of every track whose
  `vcaId == id` — a control-only group (NOT in the audio path, unlike a bus), applied post-fader
  in `TrackNode` via a per-member `VcaGain` param message (live) and baked into the plan on rebuild.
- `cmd/track.setEq {trackId, patch:{bypass?, bands?}}` → `{}` — per-track parametric channel EQ.
  `bands`, when present, REPLACES the whole band list. Each band is
  `{enabled:bool, type:int, freqHz:double, gainDb:double, q:double}` with
  type `0=peak(bell) 1=lowShelf 2=highShelf 3=highCut(lowpass) 4=lowCut(highpass) 5=notch`, ranges
  freqHz 20..20000, gainDb -24..+24 (ignored for cut/notch), q 0.1..18 (values clamped on apply).
  Empty bands or `bypass:true` → no processing. Applied POST-inserts, PRE-fader. Transient-aware
  like `cmd/track.set` (knob/slider drags coalesce into one undo entry; coefficients are recomputed
  on the control thread and published to the RT node without a graph rebuild).
- `cmd/track.duplicate {trackId}` → `{track: Track}` — deep copy named `"<name> copy"` inserted
  right after the source subtree (folders clone all descendants, reparented onto the clones);
  every id is freshly allocated, inserts become new plugin instances with the source state
  transferred; recordArm/monitor reset to false; frozen/frozenAssetId reset (the copy renders
  live — frozen asset records are single-owner); sends/outputTarget aimed inside the duplicated
  subtree are remapped onto the clones, targets outside it stay unchanged; not valid for the
  master track.

### 5.3 Commands — clips, notes, automation, arrangement
- `cmd/clip.addMidi {trackId, startBeat, lengthBeats}` → `{clip}` ;
  `cmd/clip.addAudio {trackId, startBeat, assetId}` → `{clip}`
- `cmd/clip.move {clipIds:[], deltaBeats, targetTrackId?}` ; `cmd/clip.resize {clipId, edge:"l"|"r",
  newStartBeat?, newLengthBeats?}` (audio: trims srcOffset/len; no stretch in v1)
- `cmd/clip.split {clipIds:[], atBeat}` → `{newClipIds:[]}` ; `cmd/clip.join {clipIds:[]}` → `{clip}`
  (midi only in v1; audio join only if contiguous same-asset)
- `cmd/clip.stretch {clipId, ratio, transpose?}` → `{assetId, lengthSamples}` (audio only): offline
  WSOLA time-stretch (`media/TimeStretch`) of the clip's source segment by `ratio` (out ≈ in×ratio,
  pitch preserved) into a NEW derivative asset (`pcmToAssetHook` writes it under the project audio
  dir → persists like any asset). `transpose:true` instead shifts pitch by `ratio` at constant
  length (WSOLA-stretch then resample). The clip is repointed at the derivative and resized. UI:
  audio-clip right-click ▸ Time-Stretch (½×/2×/1.5×, Transpose ±12/+7 st).
- `cmd/clip.processAudio {clipId, op, gainDb?, targetDb?}` → `{assetId}` (audio only): destructive
  Cubase-style Audio ▸ Process on the clip's span. `op` = `gain` (`gainDb` −48..48) | `normalize`
  (peak to `targetDb` dBFS, default −1) | `fadeIn`/`fadeOut` (full-span linear; the clip's
  non-destructive fade handles stay available on top) | `reverse` | `invert` (phase) | `silence` |
  `dcRemove` (per-channel mean removed). Same edit-asset mechanics as `cmd/clip.stretch`
  (`pcmToAssetHook` → NEW derivative asset, clip repointed at offset 0, span length unchanged;
  undoable — undo repoints back, the edit file stays on disk). UI: audio-clip right-click ▸
  Process (Fade In/Out, Gain ±1/3/6 dB, Normalize 0/−1/−3/−6 dBFS, Reverse, Invert Phase,
  Remove DC Offset, Silence).
- `cmd/clip.delete {clipIds:[]}` ; `cmd/clip.duplicate {clipIds:[]}` → `{clips:[]}` ;
  `cmd/clip.set {clipId, patch:{name?,color?,gain?,fadeInSec?,fadeOutSec?,muted?}}`
- **Comping / take folders** (see §6 Comping): `cmd/take.create {trackId, clipIds:[], name?}` →
  `{folder}` moves the listed clips off the flat clip list into a new take folder (one lane per
  clip); `cmd/take.setComp {trackId, folderId, activeLane?|comp:[{startBeat,lane}]}` picks the
  playing take — `activeLane` for the whole span, `comp[]` for per-segment swipe boundaries
  (`lane:-1` = silent gap); `cmd/take.flatten {trackId, folderId}` → `{clipIds:[]}` bounces the
  comp to plain clips and removes the folder. All three are structural (graph rebuild).
- `cmd/notes.edit {clipId, add:[Note], remove:[noteIds], update:[{noteId,patch}]}` — one undo entry
- `cmd/notes.quantize {clipId, noteIds?:[], grid:<beats>, strength:0..1, swing:0..1}`
- `cmd/automation.set {trackId, paramRef, add:[{t,v,curve?}], remove:[pointIds], update:[{pointId,patch}]}`
  `paramRef`: `"volume"|"pan"|"send:<index>"|"plugin:<instanceId>:<paramId>"`. A set that leaves
  the lane with zero points removes the lane — lanes never persist empty.
- `cmd/marker.add {beat,name}` / `cmd/marker.set {markerId,patch}` / `cmd/marker.remove {markerId}`
- `cmd/tempo.set {bpm}` ; `cmd/timesig.set {num, den}` (v1: single tempo/timesig; schema is a map
  for future) ; `cmd/loop.set {startBeat,endBeat,enabled}`
- `cmd/grid.set {division?, snap?, triplet?, swing?}` — patch semantics onto `project.grid` (§6);
  division in beats, must be in (0, 128] (snap mode "Bar" sends beatsPerBar, which can exceed 16,
  e.g. 32/1); swing clamped 0..1; persisted + undoable.
- `edit/undo {}` / `edit/redo {}` → `{label}` ; reply also triggers full `event/projectChanged`.

### 5.4 Transport & engine
- `transport/play {}` `transport/stop {}` (stop at pos; second stop returns to start)
  `transport/pause {}` `transport/record {}` `transport/locate {beat}` `transport/setMetronome
  {enabled, countInBars?:0|1|2}` `transport/setAutomationWrite {enabled}`. Engine metronome
  default is OFF. Every `transport/*` reply returns the full transport snapshot below (incl.
  `metronome` and `automationWrite`), so the state is readable — the UI seeds its mirror from
  `session/hello`, reconciles it from every transport event/reply carrying the field, and keeps
  user toggles optimistic.
- **Automation write** (`transport/setAutomationWrite {enabled}`): while armed AND playing, a
  fader/knob drag records automation points into that param's lane at the playhead. Captured
  targets: `volume`, `pan`, `send:<n>`, `plugin:<instanceId>:<paramId>` — the handlers
  (`CommandProcessor::captureAutomation`) reuse `Model::automationLane(…, createIfMissing)`,
  thin to one point per ~1/96 note, and defer the baking graph rebuild to the gesture commit
  (the live value already rides the RT param ring). v1 is a single write arm (records what you
  move); per-mode touch/latch overwrite-of-untouched-regions needs a continuous writer (future).
- `event/transport {state:"stopped"|"playing"|"recording", beat, timeSec, loop:{...},
  metronome:{enabled:bool, countInBars:0|1|2}, automationWrite:bool} ` ~20 Hz while playing + on change.
  `project/importForeign` applies the source project's click state when the file carries one
  (cpr `clickEnable`) and broadcasts ONE `event/transport` right after the model swap; files
  without click state leave the session's metronome untouched.
- `event/meters {tracks:{"<trackId>":[peakL,peakR,rmsL,rmsR]}, master:[...]} ` ~15 Hz, values in
  linear 0..~1.4.
- `engine/getDevices {}` → `{drivers:[{type:"wasapi"|"asio", available, reason?, devices:[{id,name,
  isDefault, maxInputs, maxOutputs, sampleRates:[]}]}]}`
- `engine/setAudioConfig {driver, deviceId, sampleRate, bufferSize, exclusive?:bool}` → restarts
  stream; reply `{actual:{sampleRate,bufferSize,latencyMs}}`. `engine/getStatus {}` → `{running,
  driver, device, sampleRate, bufferSize, latencyMs, xruns, cpuPercent, pdcSamples}`
- `engine/panic {}` (all notes off / reset)

### 5.5 Recording & media
- `cmd/track.set recordArm` + `transport/record` records armed audio tracks (WASAPI capture of
  selected input) to `audio/rec-<n>.wav` and armed MIDI tracks from enabled MIDI inputs.
- `midi/getInputs {}` → `{inputs:[{id,name,enabled}]}`; `midi/setInputEnabled {id, enabled}`;
  `event/midiActivity {deviceId, trackId?}` (throttled).
- `media/import {paths:[...], trackId?, atBeat?}` → decodes (wav/mp3/flac via MF; .mid via
  SmfReader) into project, creates clips if trackId given. Reply `{assets:[Asset], clips:[Clip],
  tracks:[Track] }` (midi files may create tracks). SMF track names are sanitized (truncated at
  the first control byte, trailing whitespace and Logic region suffixes
  `*recorded|*copied|*merged|*divided|*created` stripped, and guaranteed valid UTF-8 — legacy
  8-bit names transcode Latin-1→UTF-8; no string reaches the model unsanitized, json dump
  throws on invalid UTF-8). Format-1 MTrks sharing a (sanitized
  name, primary channel) — emagic Logic exports one MTrk per region — consolidate into ONE track
  with one clip per source MTrk at its content position on the file's bar grid (start floored /
  end ceiled to a bar; clips may overlap), shifted by `atBeat`; single-member groups (normal
  exports) keep the legacy one-clip-at-`atBeat` layout. Shared logic in `midi/SmfTrackPlan.h`,
  also used by `project/importForeign` for .mid (there single-member clips sit at beat 0).
  Progress: `event/importProgress {path, pct}`.
- HTTP upload alternative: `POST /api/upload` multipart → same as import; used for browser drag-drop.
- `media/relink {assetId, newPath}`; missing files appear in `event/projectChanged` asset records
  (`missing:true`) and `session/hello`.
- `export/render {path?, startBeat, endBeat, format:{type, bitDepth?:16|24|32, kbps?},
  normalize?:bool, loudnessTarget?:LUFS}` → if no path, engine shows save dialog.
  `event/exportProgress {pct}`; reply when done `{path, seconds, format, lufs, peakDb}` (measured
  BS.1770 integrated loudness + peak dBFS of the written signal). Offline (faster than realtime),
  full graph including plugins. `normalize` = peak-to-0 dBFS; `loudnessTarget` (e.g. -14) scales
  the render to that integrated loudness (takes precedence over `normalize`) — measured via
  `media/Loudness` (K-weighting + gated 400 ms integration).
  `format.type`: `"wav"` (PCM, `bitDepth` 16|24 TPDF-dithered | 32 float) or a Media-Foundation
  codec — `"mp3"`, `"flac"` (lossless, negotiated 16/24-bit), `"m4a"`/`"aac"` (`kbps` 64..320 for
  lossy, default 320). An encoder MFT that is unavailable, or an unknown type, returns
  `bad_request` (no silent format switch). `media/AudioEncoder.{h,cpp}` (IMFSinkWriter).
- `cmd/track.bounce {trackId, freeze?:bool}` → renders track to audio asset; if freeze, replaces
  playback with frozen audio and bypasses inserts (track keeps clips; `track.frozen=true`;
  `cmd/track.unfreeze {trackId}` restores).
- `GET /api/peaks/<assetId>?lod=<n>` → binary peak data (§7 PeakFile format). Responses are
  NOT immutable (asset ids recycle per model, so a long-lived HTTP cache entry could serve
  another project's waveform for a colliding id): the engine sends `Cache-Control: no-cache`
  plus a content-derived `ETag` and answers `304 Not Modified` on a matching `If-None-Match`,
  so revalidation is a cheap localhost round-trip. Peak files live in `<projectDir>/peaks/`;
  with NO project dir (never-saved session — every foreign import and File > New) the engine
  falls back to a per-run subdir `%APPDATA%/MyDAW/media/peaks/<pid>-<startupMillis>/` (older
  run dirs are pruned at startup; `media/import` writes there too), so a recycled asset id can
  never resolve to a previous session's file. Responses are parsed by the client with the
  model's `Asset.channels` and cached in memory until invalidated — the UI drops its parsed
  caches on every full `event/projectChanged` and on session adoption; the engine never serves
  bytes inconsistent with the asset record: `.pk` files are validated structurally before
  serving (`<id>.pk` can be a stale stranger — mere existence is never trusted), regenerated
  from decoded PCM when missing/stale, and the endpoint answers 404 (client evicts the failure
  and retries) until the asset record's channel count has been declared and, for foreign
  imports, reconciled with the decoded channel count.
- After each async asset decode the engine reconciles `Asset.channels`/`Asset.lengthSamples`
  with the decoded data (foreign imports may carry guessed values — cpr defaults to stereo),
  marks the project dirty and broadcasts a full `event/projectChanged`. The reconcile survives
  undo/redo: snapshots taken during the decode window carry the pre-reconcile guesses, so
  undo/redo re-imposes the decoded values on every restored model.

### 5.6 Plugins
- `PluginInfo = {uid, format:"vst2"|"vst3"|"builtin", path, bitness:32|64, name, vendor, category,
  isInstrument, numInputs, numOutputs, blacklisted?:bool, blacklistReason?}` (uid: vst2 = decimal
  uniqueID string; vst3 = class GUID string; builtin = `"builtin:<key>"`, in-engine stock effect,
  §8.6). `plugins/getRegistry` always includes the built-ins (never scanned/blacklisted).
- `plugins/scan {full?:bool}` → starts async scan of configured folders. `event/scanProgress
  {current, total, path, found}`; `event/scanDone {registry:[PluginInfo]}`.
- `plugins/getRegistry {}`; `plugins/setFolders {vst2:[paths], vst3:[paths]}` → the saved
  `{vst2, vst3}` (folders are stored EXACTLY as given — deduped case/slash-insensitive, empties
  dropped; an empty list means "scan nothing" for that format); `plugins/getFolders {}`;
  `plugins/getDefaultFolders {}` → the built-in standard VST dirs incl. x86 (seeded into
  settings on first run; the UI "Default" button restores them via setFolders);
  `plugins/unblacklist {uid}`.
- `cmd/plugin.add {trackId, uid, index?, copyFrom?}` → `{instance: PluginInstance}` (`copyFrom` =
  an existing instanceId to clone INCLUDING its current settings — model fields plus the live
  state chunk, falling back to the orphan store / saved stateFile; `uid` may be omitted then;
  undo label "Copy Plugin") ;
  `cmd/plugin.remove {trackId, instanceId}` ; `cmd/plugin.move {trackId, instanceId, newIndex,
  destTrackId?}` (`destTrackId` ≠ `trackId` moves the SAME live instance — state preserved, its
  `plugin:<id>:*` automation lanes follow — to that channel; `newIndex` is then the insertion
  index 0..len in the destination) ;
  `cmd/plugin.set {instanceId, patch:{bypass?, wetDry?, sidechainSource?}}` (wetDry engine-side
  mix 0..1; `sidechainSource` = a track id keying the built-in compressor's detector, `0` = none —
  structural, resolved at graph rebuild, see §6 Sidechain)
- `cmd/plugin.setParam {instanceId, paramId, value}` (normalized 0..1; use transient while dragging)
- `plugin/getParams {instanceId}` → `{params:[{id, name, label/*units*/, value, defaultValue,
  steps?:int, valueText}], hasEditor:bool}` (`hasEditor` mirrors the host's §8.2 init reply so the
  UI can offer the native editor even when `params` is empty — some plugins, e.g. PlugSound,
  genuinely expose 0 parameters) ; `event/pluginParams {instanceId, changed:[{id,value,valueText}]}`
  (edits from native editor)
- `plugin/getPresets {instanceId}` → `{presets:[{id,name}]}` ; `plugin/loadPreset {instanceId, id}` ;
  `plugin/savePreset {instanceId, name}` (vst2 programs; vst3 unit programs if exposed, else
  state-snapshot presets stored in project)
- `plugin/openEditor {instanceId}` / `plugin/closeEditor` — opens the plugin's REAL native editor
  as a floating window owned by its host process (works for 32/64-bit; this is local-machine UI,
  not in-browser). Browser generic editor is always available regardless. Failure replies carry
  the host's real reason in `error.message` (e.g. "plugin has no native editor", attach
  failures), not a generic string.
- `event/pluginState {instanceId, state:"ok"|"loading"|"crashed"|"timeout"|"restarting"|"failed",
  message?, restartCount}` — UI must surface a clear error indicator on the insert slot.
- `project/getUnresolvedPlugins {}` → `{plugins:[{instanceId, name, uid, format:"vst2"|"vst3",
  bitness, version?, source?: string /*import provenance, e.g. "Cubase 5.1.1 project, 2009;
  32-bit era"*/, trackId, trackName, slotIndex, hasState:bool, inRegistry:bool,
  suggestions?:[{uid, name, format, bitness, score}]}]}`. The UI shows
  `source` when present and renders `uid` inline (vst2 signed-decimal fourcc decoded to 4CC
  ASCII when all 4 bytes are printable). Unresolved
  = a PluginInstance in the model with NO live host OR built-in instance (typically a dormant
  insert created
  by `project/importForeign`, which records identity + state but loads nothing). `slotIndex` is
  the index within the track's insert chain; instruments are inserts on Instrument tracks.
  `suggestions` (only when `!inRegistry`, best-first, ≤3) are usable stand-ins from the
  registry: fuzzy name matches that ignore format/bitness and channel-config name suffixes
  (Waves shell sub-plugins: "PS01 - Keyboards stereo2stereo" matches "PS01 - Keyboards"; a
  VST3 64-bit "C1 comp Mono" matches the VST2 32-bit one), else an in-spirit built-in by
  name keywords (piano-ish → `builtin:piano`, other instrument slots → `builtin:polysynth`,
  comp/limiter/verb/delay/gate → the matching stock effect; `score` 20 marks these).
- `plugins/recreate {instanceIds?:[number], substitutions?:[{instanceId, uid}]}` →
  `{results:[{instanceId, ok, error?}]}`. Omitted
  `instanceIds` = recreate ALL unresolved. Resolves each insert against the registry (byUid),
  refreshes path/bitness/name from the matching `PluginInfo`, spawns the host instance and
  restores state. A `substitutions` entry recreates that insert as a DIFFERENT registry
  plugin (uid from `suggestions` or any registry uid, built-ins included): uid/format follow
  the substitute; the saved state chunk carries over only within the SAME format (VST2 chunks
  are bitness-portable but mean nothing to a VST3 build or a built-in — cross-format subs
  start clean, and paramValues are dropped too since ids don't line up); a substitute whose
  state restore fails is brought up clean instead of failing (the original's state was
  best-effort for it anyway). This is RESOURCE RESOLUTION, not an edit — like `media/relink` it is **not
  undoable** (it pushes no undo entry, so a later undo can never leave a live host wired to the
  graph while the model says dormant). It mutates the resolved inserts in place, rebuilds the
  graph and broadcasts a granular `event/projectChanged`, and marks the project dirty. State
  restore uses a generously long timeout (user-triggered, not RT) so a slow soundbank load
  inside `effSetChunk` reports `ok:true` rather than a spurious failure. A genuine host
  rejection/death reports `ok:false` with the reason AND destroys the half-spawned instance so
  the insert stays dormant and retryable; a slow-but-alive timeout likewise leaves the insert
  dormant with an honest "try again" error (the cached good chunk is never overwritten with
  post-failure state). Other failures (not in registry, blacklisted, load error) come back
  per-instance with a readable `error` and leave that insert dormant and untouched. The
  locate-missing-plugins flow reuses `plugins/getFolders` / `plugins/setFolders` /
  `plugins/scan` (+ `event/scanProgress`, `event/scanDone`) before calling `plugins/recreate`.
- Orphan plugin state: foreign-import state chunks arrive before any host instance exists. The
  engine keeps them in an in-memory orphan store keyed by instanceId (cleared on project switch).
  `plugins/recreate` feeds the orphan bytes to the recreated instance's setState; save/autosave
  chunk capture falls back to orphan bytes when the host has no state for an instance and writes
  them to `plugin-states/<instanceId>.bin`. The orphan entry is **kept for the whole session**
  (NOT dropped after the first save): a live host's `getState` always takes priority, so a kept
  entry is harmless, and keeping it lets re-saves, Save-As to a new directory, and undo-across-save
  all re-emit the `.bin`. Autosave of a never-saved import writes the orphan bytes into the
  recovery autosave dir (`%APPDATA%/MyDAW/autosave/plugin-states/`) so a crash before Save-As does
  not lose imported plugin state; `project/recover` reloads them back into the orphan store.
  `stateFile` semantics in §6 are unchanged.

### 5.7 Misc
- `engine/getLog {tail?:int}` → `{lines:[]}` ; `event/log {level,msg}` (warn+error only).
- `settings/get {}` / `settings/set {patch}` — app settings (port, autosaveMinutes, theme, etc),
  persisted to `%APPDATA%/MyDAW/settings.json`. Portable mode: a `settings.json` next to the exe
  (shipped Release folders) takes priority — read AND written there instead. `port` (default
  8417) is applied at startup when no `--port` flag is given.

### 5.8 State sync
Engine is authoritative. After any non-transient mutation: `event/projectChanged {revision,
scope:"project"|"track"|"clip"|"mixer", full?:Project, tracks?:[Track], clips?:[{trackId,clip}],
removedTrackIds?:[], removedClipIds?:[]}`. Undo/redo/load/recover always send `scope:"project",
full:<Project>`. UI store applies granular updates when present, else replaces. UI performs
local-only preview during drags and sends one final command on mouse-up.

## 6. Project format (`project.json` v1)

A project is a folder `Name.mydaw/` containing `project.json`, `audio/`, `peaks/`,
`plugin-states/`, `autosave/`. Paths in JSON are folder-relative. Schema (TS-ish):

```ts
Project = {
  formatVersion: 1, name: string, sampleRate: number,
  tempoMap: [{beat: number, bpm: number}],          // v1: single entry at beat 0
  timeSigMap: [{bar: number, num: number, den: number}],
  loop: {startBeat: number, endBeat: number, enabled: boolean},
  grid: {division: number /*beats*/, snap: boolean, triplet: boolean, swing: number /*0..1*/},
  markers: [{id, beat, name, color?}],
  tracks: Track[],                                   // ordered, tree via parentId (folders)
  masterTrack: Track,                                // kind:"master"
  assets: [{id, file, originalPath?, sampleRate, channels, lengthSamples, missing?:bool}],
  nextId: number, ui?: {zoomX?, zoomY?, scrollX?, ...} // opaque to engine
}
Track = {
  id, kind: "audio"|"midi"|"instrument"|"folder"|"bus"|"master", name, color, height?,
  parentId?: number /*folder*/, channels: 1|2,
  volume: number /*linear, 1=0dB*/, pan: number /*-1..1*/, mute, solo, recordArm, monitor?: bool,
  inputDevice?: string, inputChannel?: number, outputTarget: number|"master"|"none",
  frozen?: bool, frozenAssetId?: number,
  midiTarget?: number,  // kind:"midi" only: id of the instrument track this track's MIDI is
                        // routed into (shared instance, §5.2); omitted when 0/none. A load
                        // clears values that don't reference an existing instrument track.
  inserts: PluginInstance[],
  eq?: {bypass: bool, bands: EqBand[]},            // per-track channel EQ; omitted when no bands && !bypass
  sends: [{destTrackId, level, pre, enabled}],
  automation: [{paramRef: string, points: [{id, beat, value, curve?: number /*-1..1 bend*/}]}],
  clips: (AudioClip|MidiClip)[],
  takeFolders?: TakeFolder[]        // comping; omitted when empty (§6 Comping)
}
TakeFolder = {id, name, startBeat, endBeat,
  lanes: [{id, name, clips: (AudioClip|MidiClip)[]}],   // stacked takes (one clip per lane usually)
  comp: [{startBeat, lane}]}         // sorted; segment [startBeat,next) plays `lane` (-1 = silent);
                                     // empty => lane 0 for the whole span
EqBand = {enabled: bool, type: number /*0=peak 1=lowShelf 2=highShelf 3=highCut 4=lowCut 5=notch*/,
  freqHz: number /*20..20000*/, gainDb: number /*-24..+24, ignored for cut/notch*/, q: number /*0.1..18*/}
PluginInstance = {instanceId, uid, format, path, bitness, name, version?: string /*exact
  plugin version, e.g. from import; omitted when unknown*/, sourceHint?: string /*import
  provenance for the Recreate dialog, e.g. "Cubase 5.1.1 project, 2009; 32-bit era"; omitted
  when none; wire name "source" in project/getUnresolvedPlugins*/, bypass: bool, wetDry: number,
  stateFile?: string /*plugin-states/<instanceId>.bin*/, paramValues?: {[paramId]: number}}
AudioClip = {id, type:"audio", name, startBeat, assetId, srcOffsetSamples, lengthSamples,
  gain: number /*linear*/, fadeInSec, fadeOutSec, muted?, color?}
MidiClip  = {id, type:"midi", name, startBeat, lengthBeats, muted?, color?,
  notes: [{id, pitch: 0..127, velocity: 1..127, startBeat /*rel to clip*/, lengthBeats, channel?:0}]}
```

Save = atomic write (tmp+rename). Autosave every `autosaveMinutes` (default 2) to
`autosave/project-<n>.json` (keep 5, round-robin) — only when dirty. Crash recovery: engine writes
`%APPDATA%/MyDAW/session.lock` with current project path; if present at startup → offer recovery
(§5.1). Plugin state chunks saved as binary files on save (and captured on every autosave).
`project/save` copies any still-external referenced audio into `audio/` (import already does);
assets referenced in place by a foreign import (`file:""`, `originalPath` set) are copied from
`originalPath`, as is any relative `audio/...` reference whose file is absent under the target
project dir (e.g. Save-As after the file landed in a previous project's folder) — an asset is
only skipped as already-present when its file actually exists there, otherwise it is copied or
flagged `missing`.

## 7. Engine internals

- **Threading**: main thread (model + command processing via MPSC queue, owns graph rebuilds), RT
  audio thread (driver callback), server thread (Winsock select loop), worker pool (decode, peaks,
  export, autosave, plugin lifecycle). Graph snapshots: `std::shared_ptr<const RenderPlan>`
  swapped atomically; RT thread copies the shared_ptr at block start (acceptable v1; document).
  RenderPlan = flattened ordered node list with buffer assignments, built from Model on any
  structural change. Param-only changes (volume/pan/sends/plugin params/mute) go through lock-free
  `RtRing<ParamMsg>` without rebuild; clip edits DO rebuild (v1 simplicity, rebuilds are cheap).
- **Transport**: `Transport` holds atomic playhead (samples), loop region (samples, derived),
  state. TempoMap converts beats↔samples (piecewise-constant bpm). Blocks split at loop wrap.
  Record: capture ring from driver input → worker drains to WavWriter; MIDI recorder timestamps
  against transport.
- **Tracks render**: per track: sum clip audio (with clip gain/fades; midi clips → schedule events
  into instrument insert) → insert chain (PluginProxyNode honoring bypass/wetDry) → volume/pan →
  meters tap → route to outputTarget bus/master accumulate buffer; sends tap pre/post fader into
  bus input buffers. Topological order: plain tracks → buses (buses can feed buses; cycle = reject
  command) → master. MIDI feeders (`Track.midiTarget`, §5.2) extend the topo order: a feeder
  processes BEFORE its target instrument node in the sequential RT pass and delivers its scheduled
  MIDI (clips + CC/chase, live MIDI, midi/preview, panic CCs) into the target node's preallocated
  per-block merge buffer (capped at the MidiBuffer capacity; overflow drops + counts, never
  overruns) instead of its own insert chain; it contributes no audio. A midiTarget pointing at a
  missing/non-instrument track degrades to "unrouted" with a log. Folders are organizational only
  (no audio role) in v1.
- **PDC**: each insert reports latency samples (from host process). Track chain latency = sum.
  Compensation v1: all-path alignment via per-track delay lines so every route to master has equal
  total latency = maxLatency; sends compensated to dest. Report `pdcSamples` in status. Live-input
  monitoring bypasses PDC.
- **Automation**: evaluated per block (start value, can step within block at 64-sample
  subdivisions for volume/pan; plugin params once per block), points piecewise-linear with curve
  bend (`v = lerp^(2^curve)` shape).
- **Metronome**: synthesized tick (sine burst 880/440 Hz w/ decay), follows timeSig; count-in
  delays transport start by N bars while emitting clicks (record mode).
- **Solo**: solo-in-place — audible set = soloed tracks + ancestors of their routing + send
  destinations; everything else implicit-muted. midiTarget edges participate: soloing a feeder
  keeps its target instrument (and the instrument's downstream chain) audible; soloing an
  instrument track pulls in its feeders so it keeps sounding.
- **Offline render**: clone graph in offline mode, pull blocks, write WAV; plugins processed via
  same IPC (non-RT waits OK); transient suppress of driver. Bounce/freeze uses same path for a
  single track solo'd internally.
- **WASAPI**: shared mode event-driven default; exclusive optional. Capture device opened only
  when any track armed/monitoring. Resample-at-import policy (§4) keeps RT path clean. Report
  xruns. Driver restart on `engine/setAudioConfig` or device invalidation (auto-fallback to
  default device + `event/log`).
- **ASIO**: full driver implementation written against the ASIO C ABI but compiled only with
  `MYDAW_HAVE_ASIO`. Listed unavailable (with reason "build without ASIO SDK") otherwise. UI shows
  it greyed with that reason. (Stub policy §10.)

## 8. Plugin hosting & IPC (engine ⇄ host processes)

One host process per plugin instance. Engine spawns:
`mydaw-host{64|32}.exe --serve --shm mydaw_<enginePid>_<instanceId> --pipe \\.\pipe\mydaw_<enginePid>_<instanceId> --plugin <path> --format vst2|vst3 --uid <uid> --parent-pid <enginePid>`

### 8.1 Shared memory (RT audio path) — defined in `shared/ipc/PluginIpc.h`
One mapping, layout (all cache-line aligned, fixed offsets computed from header):
```c
struct ShmHeader {           // offset 0
  uint32 magic;              // 'MDAW'
  uint32 version;            // 1
  uint32 maxBlock;           // 2048
  uint32 numIn, numOut;      // channel counts (engine decides, ≤8)
  uint32 sampleRate;
  volatile LONG state;       // HostState enum: Starting/Ready/Processing/Crashed
  // per-block exchange:
  uint32 blockFrames; double tempo; double ppqPos; uint32 flags; // playing|recording|loop
  uint32 numMidiIn; uint32 numParamChanges; uint32 latencySamples; // host fills latency
  uint32 numMidiOut; uint32 numParamOut;     // host→engine (editor edits)
};
// then: float in[numIn][maxBlock]; float out[numOut][maxBlock];
// MidiMsg midiIn[1024]; MidiMsg midiOut[1024];   MidiMsg = {uint32 sampleOffset; uint8 data[4]; uint32 len;}
// ParamChange paramIn[4096]; ParamChange paramOut[4096];  ParamChange = {uint32 id; double value; uint32 sampleOffset;}
```
Two named events: `<shm>_req` (engine→host: block ready) and `<shm>_done` (host→engine).
Engine RT thread: fill inputs/midi/params → SetEvent(req) → WaitForSingleObject(done, timeoutMs)
where timeoutMs = max(2, 2×blockDuration). Timeout → output silence (or dry signal), count miss;
3 consecutive misses or dead process → mark crashed, schedule async restart (worker thread:
kill, respawn, setState(lastChunk), restore params; max 2 auto-restarts, then state "failed"
until user reloads). This blocking wait on the RT thread is the standard bridge tradeoff —
documented in ARCHITECTURE.md.

### 8.2 Control pipe (non-RT)
Length-prefixed (uint32 LE) JSON messages, request/reply with `id`, both directions can push.
Engine→host: `init {sampleRate,maxBlock}` → `{ok, info:{name, numParams, latency, isInstrument,
ins, outs, hasEditor}}` (`hasEditor`: plugin provides a native editor — vst2 `effFlagsHasEditor`;
vst3 probed via `createView("editor")` + `isPlatformTypeSupported(kPlatformTypeHWND)`, view
released without attaching, any probe fault reports false; engine treats an absent field as
false); `getParams` → full param list (id, name, label, defaultValue, steps, value,
valueText); `setParam {id,value}` (non-RT fallback; RT path preferred); `getState` → `{chunkB64}`;
`setState {chunkB64}`; `getPresets` / `loadPreset {id}`; `openEditor` / `closeEditor` (host creates
top-level window + message pump, plugin view attached); `suspend`/`resume`; `quit`.
Host→engine push: `paramEdited {id, value, valueText}` (from native editor, throttled),
`latencyChanged {samples}`, `resized`, `log {level,msg}`.
Host watches `--parent-pid`; exits if engine dies. Engine detects host exit via process handle wait
(registered wait callback) → crash flow.

### 8.3 Scanning
`mydaw-host64.exe --scan <path>` (and host32 for x86 DLLs): loads, enumerates (VST2: one plugin
per DLL, or — for a *shell* DLL, `effGetPlugCategory == kPlugCategShell` — one PluginInfo per
child advertised by `effShellGetNextPlugin`, each carrying its own decimal child uid; VST3: all
classes in factory), prints one JSON line `{ok:true, plugins:[PluginInfo-like]}` or
`{ok:false,error}` and exits.
Engine scanner: walk folders (`.dll`→try vst2 both arches via PE header machine field check first;
`.vst3`→host64 + host32 if bundle has x86), 20 s timeout per file, crash/timeout → blacklist with
reason. Cache `%APPDATA%/MyDAW/plugin-cache.json` keyed `{path,size,mtime}`; blacklist
`%APPDATA%/MyDAW/blacklist.json` (uid+path+reason). `plugins/scan {full:true}` ignores cache.
PE machine check: read IMAGE_FILE_HEADER.Machine to route x86 vs x64 without spawning both.

### 8.4 VST2 / VST3 specifics
VST2 (vestige.h clean-room): entry `VSTPluginMain`/`main`; audioMaster opcodes to support:
version(2400), automate (→paramOut), idle, ioChanged (→latencyChanged), getTime (AVstTimeInfo:
samplePos, sampleRate, ppqPos, tempo, timeSig, flags transport playing|tempoValid|ppqPosValid|
timeSigValid), sizeWindow, getSampleRate/BlockSize, canDo("sendVstEvents","sendVstMidiEvent",
"receiveVstTimeInfo"...), getVendor/Product. Process via `processReplacing` float32. State:
prefer chunks (effFlagsProgramChunks) else param array. Presets = programs (effGetProgramName etc).
Editor: effEditGetRect/effEditOpen(hwnd)/effEditClose + effEditIdle timer ~50 Hz + WM_SIZE via
audioMasterSizeWindow.
VST2 shell plugins: a shell DLL (e.g. Waves' `WaveShell-VST`) exposes many effects behind one
entry. At scan, the shell is opened once and enumerated via `effShellGetNextPlugin` → one
PluginInfo per child (uid = the child's decimal uniqueID). At load, `--uid <child>` is passed to
the host; the shell selects that child during instantiation by reading `audioMasterCurrentId`,
which the host answers with the requested child uid until the child's `effect->uniqueID` matches.
VST3 (sdk_hosting): `VST3::Hosting::Module::create`, PlugProvider per classId, IComponent+
IEditController (connect via ConnectionProxy), `setupProcessing` (kRealtime, Sample32, maxBlock),
activate buses (main stereo in/out + event in), `IAudioProcessor::process` with ProcessData built
from shm block (param changes in/out via ParameterChanges, events via EventList), state =
component+controller streams concatenated (two length-prefixed blobs in our chunk), latency =
`getLatencySamples` (re-query on restartComponent flag), editor `IPlugView` attach to HWND
(kPlatformTypeHWND), presets: program list from unit info if present.

### 8.5 Per-plugin capture overlay (registry + files) — `plugin-host/src/RegOverlay.{h,cpp}`
Optional, opt-in. A plugin may ship inside a *capture bundle*: a folder with `install.reg`
(a `Windows Registry Editor Version 5.00` export) and/or a `files\<DRIVE>\...` mirror of the
original install tree. When present, the host gives the plugin an ARTIFICIAL registry = the
real machine registry EXTENDED by the `.reg`, and redirects hard-coded drive-letter file paths
into the mirror when available, so 25-year-old plugins that expect registry artifacts / legacy
paths load without contaminating the machine. Safe because the host is dedicated to ONE plugin
(its only Reg*/file callers are that plugin + the CRT/COM it drags in).
- **Hook engine**: MinHook (`third_party/minhook`, MIT, in-tree static lib `mydaw_minhook`,
  built for x86+x64). Inline-hooks the Reg* surface (Open/Create/Query/Set/Get/Enum/QueryInfo/
  Delete/Close/Flush, W+A+legacy) in BOTH `advapi32` AND `kernelbase` — on Win10/11 those are
  independent implementations, not forwarders, and a plugin may bind to either. A per-thread
  recursion guard passes read-through (and the advapi32→kernelbase wrapper re-entry) straight
  through. Overlay state is intentionally immortal (leaked): Reg* still fire during CRT/OLE
  static teardown, so destroying it would crash on exit.
- **Arming**: once in `main()` before the runScan/runServe dispatch (covers BOTH modes, before
  the plugin's DllMain + VST entry point). No-op when no sidecar `.reg` is found → byte-identical
  to prior behavior.
- **Semantics**: reads = overlay-first, else read-through to the real Reg* (CRT/COM/Windows and
  the plugin keep working for keys absent from the `.reg`). Writes = overlay only, NEVER the
  machine registry; persisted on quit to `<reg>.local` (e.g. `install.reg.local`) beside the
  `.reg`. Synthetic HKEYs are tagged cookies; predefined roots and foreign real handles are
  forwarded. Enumeration merges overlay + real children.
- **Bundle discovery** (from the plugin path): nearest ancestor dir containing `install.reg` or
  `files\`, else a flat `<dll>.reg` / `<stem>.reg` next to the DLL. That dir is the bundle root;
  `<root>\files` (if present) is the mirror root.
- **Path rebasing** (REG_SZ/REG_EXPAND_SZ values, at parse): `%BUNDLE%`/`%MIRROR%` macros, then
  auto `X:\... → <root>\files\X\...` when the rebased target exists on disk — so a relocated
  capture's registry-driven file lookups resolve into the bundle.
- **Bundle DLL search**: when a `files\<DRIVE>\` mirror is present, the bundle's captured
  `C\WINDOWS\system32` (+ SysWOW64, WINDOWS) is PREPENDED to the host process PATH (additive, so
  the legacy CWD/PATH search old plugins rely on is preserved) and registered via
  `AddDllDirectory`, so helper DLLs the plugin loads BY NAME (e.g. NI Kontakt's NI_DFD/NI_IRC/REX,
  Waves' msvcr71) resolve out of the bundle.
- **File-path virtualization**: common Win32 file APIs (`CreateFile`, `GetFileAttributes`,
  `GetFileAttributesEx`, `FindFirstFile`, `DeleteFile`, and `LoadLibrary`/`LoadLibraryEx`, W+A)
  are hooked in `kernelbase` and `kernel32`. Absolute drive-letter paths (`C:\...`) redirect to
  `<root>\files\C\...` when the mirrored target or parent directory exists (case/short-name aware
  segment matching against the mirror); otherwise the call falls through to the real path.
- **COM class store**: a `.reg` may register the plugin's COM classes under
  `HKLM\Software\Classes\CLSID\{…}` (the canonical machine-wide store — e.g. Waves' DirectX audio
  processors). Because `HKEY_CLASSES_ROOT` merges `HKLM`+`HKCU` `\Software\Classes`, the parser
  mirrors such entries into the HKCR overlay tree (and vice-versa) so both the plugin's own
  `HKCR\CLSID\{…}` reads AND ole32's internal `CoCreateInstance` class lookup (which passes through
  the same Reg* hooks) resolve, with the InprocServer32 DLL path then redirected into the mirror.
  The overlay's whole class subtree is additionally materialized into the real
  `HKCU\Software\Classes` as **volatile** keys at arm-time and torn down on quit (tracked leaf set,
  `RegDeleteTree`), covering COM paths that read the real registry outside our hooks — with no
  persistent machine contamination.
- **Diagnostics**: `MYDAW_REG_TRACE=1` (mirrors `MYDAW_VST2_TRACE`) traces every intercepted Reg*
  and file call; `MYDAW_DIALOG_TRACE=1` traces `MessageBox` calls and `MYDAW_DIALOG_AUTODISMISS=1`
  auto-answers them `IDOK` (so a plugin's modal nag can't hang `--scan`); engine-side
  `MYDAW_HOST_LOG_DIR=<dir>` redirects each out-of-process host's stderr to
  `<dir>\host-<instanceId>.log` to capture load-time traces/crashes.
- **Known limits (v1)**: plugins calling ntdll `Nt*Key` directly bypass the Win32-layer registry
  hooks; editing a bundle's `.reg` does not bust the scan cache (DLL `{path,size,mtime}`) → run
  `plugins/scan {full:true}` after editing; plugins calling `NtCreateFile`/`NtQueryAttributesFile`
  directly bypass the Win32-layer file hooks; APIs not in the hook list still use the real path; a
  plugin whose capture is incomplete (a COM class or file the `.reg`/mirror never recorded) may
  fail to instantiate — captured out-of-process, so it surfaces as a per-instance load error, not
  an engine crash.

### 8.6 Built-in ("stock") effects — `engine/src/core/effects/`
In-engine DSP effects **and instruments** that appear and behave exactly like plugin inserts, so a
fresh install can make sound and mix without any third-party plugin. Identity: `uid =
"builtin:<key>"`, `format = "builtin"`, seeded into the registry via `PluginRegistry::setBuiltins()`
(kept in a separate list, immune to scan `replaceAll`, always listed by `plugins/getRegistry`). v1
catalog: `utility` (gain/pan/phase/mono), `gate`, `compressor`, `limiter`, `delay`, `reverb`
(Freeverb), `synth` (a MIDI-driven instrument: 16-voice subtractive, saw/square/tri/sine osc,
SVF, ADSR), and `sampler` (16-voice pitched sample playback with root note / tune / ADSR / loop —
both `isInstrument=true`, `numInputs=0`).
- **Sampler sample**: `cmd/plugin.setSample {instanceId, assetId}` binds an asset's PCM into the
  sampler; the asset comes from the normal `/api/upload` path (a real `project.assets` entry, so
  `ProjectIO::copyExternalAssets` copies the WAV into the project on save). The instance persists
  the reference as `PluginInstance.sampleAssetId`. Binding is RT-safe: the sampler publishes an
  immutable PCM buffer via an atomic pointer and keeps prior buffers alive until node teardown
  (the RT thread never frees). The generic editor shows a "Load Sample…" button for `builtin:sampler`. An instrument is just an insert whose DSP reports
`isInstrument` (SPEC §8.4: an instrument track's source is its first `isInstrument` insert); the
insert loop passes it the per-block `MidiBuffer`, it reads notes (honoring `sampleOffset`) and
writes synth output into the zeroed buffer. On bypass an instrument outputs silence (an effect
passes dry through).
- **Hosting**: `BuiltinEffectManager` (parallel to `HostProcessManager`) owns a `BuiltinEffectNode`
  per `instanceId`. Both node types implement `core/IInsertNode.h` (`processRt`/`latencySamples`/
  `setParamRt`/`setBypass`/`setWetDry`/`setOfflineMode`); the RT insert loop is type-agnostic and
  the graph resolves an insert by trying `host->node(id)` then `builtin->node(id)` (ids unique).
- **No process, no chunk**: params are the normalized `PluginInstance.paramValues` map — they
  round-trip through project save/load with zero extra code, and `plugin/getParams` is answered
  in-engine (`hasEditor:false`, so the generic editor renders the knobs; no native window/presets).
- **Param application**: live edits ride the RT param ring (`cmd/plugin.setParam` → `setParamRt`);
  every plan (re)build (including offline export) also syncs the node from the model's
  `paramValues`/bypass/wetDry, so a fresh plan reflects the current state without a ring drain.
- **Lifecycle**: `cmd/plugin.add`/`remove`, duplicate, and undo/redo `reconcilePlugins` route
  create/destroy to the right manager by `format`. A removed built-in node is retired to a
  graveyard and freed at project teardown (`destroyAll`) — a live/retiring RenderPlan may still
  hold its raw pointer (the graph rebuilds only *after* the command handler runs).
- **Sidechain (built-in compressor)**: `PluginInstance.sidechainSource` (a track id, `0`/absent =
  none) keys the compressor's detector from **another** track instead of its own input. Signal
  path: a source track flagged `keepSidechain` captures its **pre-fader, post-insert/EQ** block
  into a member buffer (`TrackNode::scL/scR/scFrames`); a destination track's insert loop hands
  that buffer to the insert via `IInsertNode::setSidechainRt(l,r,frames)` right before `processRt`
  (pointers valid only for that call), and `BuiltinEffectNode` forwards it to
  `IEffect::setSidechain`. Only `CompressorEffect` consumes it — the detector reads the sidechain
  channels for the block, then the pointers are cleared (one-shot per block); makeup/ratio/etc.
  are unchanged. Capture is pre-fader on purpose, so muting/automating the *source* (a common
  "silent key" workflow) still feeds the detector. Wiring is resolved at graph rebuild, mirroring
  feeder routing: `AudioGraph::buildPlan` marks each source `keepSidechain` before construction
  (sizes its capture buffer), then after all nodes exist resolves `sidechainSource` → the source
  node pointer and stores it per-insert (`Config::insertSidechain`, parallel to `inserts`). If the
  source runs *after* the destination in the sequential pass the detector reads last block's
  capture (≤1 block latency, never a crash — it is always a valid member buffer). `cmd/plugin.set
  {patch:{sidechainSource}}` is **structural** (no RT param); the generic editor shows a source
  picker for `builtin:compressor`.

### 8.7 Comping (take folders)
Loop-recording a passage stacks alternative takes and a *comp* selects, per time segment, which
take plays — MyDAW models this with `Track.takeFolders` (§6). A `TakeFolder` has a span
`[startBeat,endBeat)`, `lanes` (each a take = a small clip list, normally one clip), and `comp`
(sorted `{startBeat,lane}` boundaries; a segment `[startBeat,next)` plays `lane`, `-1` = silent;
empty ⇒ lane 0). Playback resolves at graph build: `AudioGraph::buildPlan` walks each folder's comp
segments and emits **only the selected lane's material windowed to the segment** — sample-accurate
for audio (`ResolvedAudioClip.startSample/srcOffsetSamples/lengthSamples` are clipped to the
window; a fade survives only on an untrimmed edge), and a MIDI note plays if its onset falls in the
segment (clamped to the segment end). Non-selected lanes never enter the plan, so stacked takes
never sum. Loop-record → takes: a continuous recording that spans >1 loop length is sliced by loop
length in `recordingCommit` into one lane per lap (all pointing into the same recorded asset at
increasing source offsets, stacked at the loop start; comp defaults to the last lap). Commands
(§5.3): `cmd/take.create` (fold clips → folder), `cmd/take.setComp` (`activeLane` whole-span, or
`comp[]` swipe boundaries), `cmd/take.flatten` (bounce the comp to plain clips). UI: the Inspector
"Takes / Comp" section shows a comp bar + one strip per take — click a strip to use that take,
drag across it to swipe just that range in.

## 9. UI architecture

- zustand store: `{connected, engine, project, registry, transport, meters (outside react —
  subscribe via refs), selection {clipIds, trackIds, noteIds}, tool, viewport {zoomX px/beat,
  zoomY, scrollX, scrollY}, focusedPane (timeline|pianoRoll|clipEditor|mixer — set by
  pointerdown-capture on each pane root; keyboard routing prefers it), followPlayhead (bool,
  "J" toggles), panels {mixer, pianoRoll, clipEditor, inspector, browser, poppedOut}, dialogs}`.
- `ws.ts`: auto-reconnect, `request(type,payload) → Promise` (optional per-call timeout override),
  `on(eventType, cb)`. On reconnect → `session/hello` re-sync. Per-type reply timeouts (default
  15 s): `dialog/*`, `plugins/recreate`, `export/render`, `export/midi` 600 s;
  `project/importForeign`, `media/import` 180 s;
  `project/load|loadRecent|save|saveAs|recover` 120 s — the engine replies
  to native-dialog-backed requests only after the user closes the picker (and to long
  decode/recreate work only after it completes), so short timeouts
  dropped those replies and made the flows silently no-op.
- Timeline: single `<canvas>` (devicePixelRatio aware) for grid+clips+automation+playhead overlay
  canvas; React only for track headers column (DOM, resizable). Interactions: tools select(1)/
  draw(2)/erase(3)/split(4); marquee (shift/ctrl-drag on empty space; plain empty-space
  left-drag and middle-drag PAN the view, clamped to content extents), drag-move (snap via
  `lib/time.ts` snapBeat), alt=copy-drag,
  edge-resize, fade handles at clip top corners, clip gain via inspector or drag top edge line,
  double-click midi clip → piano roll, audio clip → clip editor. Ruler: bars+beats per zoom,
  loop-region drag in upper ruler half, marker lane, playhead seek on click. Follow-playhead
  (store.followPlayhead): page-jump scrollX to playheadPx−10% width when the playhead leaves
  [5%,80%] of the view (playback and locate; never per-frame scrolling). Automation lanes:
  expandable below track (per paramRef), draw/edit points. Audio clips render waveform from peaks
  (HTTP, cached, LOD per zoom). Right-click context menus.
- Keyboard (`lib/keyboard.ts`): space play/stop, R record, C metronome on/off, ctrl+Z/Y undo/redo,
  ctrl+C/V/X/D copy/paste/cut/duplicate (paste at playhead), del, ctrl+S save, B split-at-playhead,
  M mute (selected tracks when only tracks are selected, group toggle; else selected clips),
  S solo selected tracks (group toggle), L loop toggle, J follow-playhead toggle, 1-4 tools,
  +/- (and numpad +/-) nudge playhead by one grid step (1 beat when snap off; key-repeat scrubs),
  G/H zoom out/in (shift = vertical) routed to store.focusedPane first (piano roll local view,
  clip editor spp view) with timeline-viewport fallback,
  home/end, ctrl+A, esc clears. Edit actions are also exported as invokeEditAction(name) for the
  menu bar (same context-aware routing). Numpad transport
  (by e.code, NumLock-independent): `.` jump-to-start, Enter play, 0 stop, `*` record, `/` loop
  toggle, 1/2 locate loop start/end. Copy/paste lives in UI (sends cmd/clip.duplicate-like add
  commands) with internal clipboard.
- Mixer (bottom dock tab): channel strips (all tracks + buses + master): fader (dB taper),
  pan, mute/solo/arm, meter (canvas, from event/meters), insert slots (click → generic editor;
  right-click bypass/remove/replace; crash badge per event/pluginState), sends, routing combo,
  name. Narrow/wide toggle.
- Piano roll (bottom dock tab): canvas grid, keys column w/ preview (sends... v1: preview notes
  via cmd? NO — v1 no live preview synth; document), draw/select/resize/velocity lane, quantize
  toolbar (grid, strength, swing), scroll sync w/ timeline beat axis optional.
- Clip editor (audio): waveform zoom view, trim handles, gain, fades, normalize button
  (computes gain, non-destructive), split at cursor.
- Pop-out dock tabs: each bottom dock tab (Mixer / Piano Roll / Clip Editor) can pop out into its
  own browser window (same-JS-context `window.open` + React portal — store/ws/buses shared, no
  duplication). `store.panels.poppedOut` tracks popped tabs; popped panes render regardless of
  the active tab (even with the dock closed) and the dock shows a "Dock back" placeholder for a
  popped active tab. Head styles are mirrored into the popup and kept synced (dev HMR included);
  popup keydowns on non-editable targets are re-dispatched on the main window so global
  shortcuts work. Keyboard focus-context routing (and every dock-tab gate with the same
  semantics, e.g. the transport quantize button) treats a popped-out pane as open
  (`paneVisible`: dock tab active OR popped out) — Delete/Ctrl+A/G/H/arrows in a popped-out
  piano roll act on notes, never on the edited timeline clip. Pane canvases (meters,
  playheads) animate on their OWN window's rAF clock (per-window `rafLoop`), so popped
  panes keep animating while the main window is hidden. Popup close ⇒ dock back;
  main-window unload closes all popups; a
  popup-blocker denial keeps the pane docked with a notice. Accepted quirk: overlays that
  portal into the main document (context menus, tooltips, modals, mixer anchored popups) open
  in the MAIN window even when triggered from a popped-out pane.
- Inspector (right): selected track: name/color/io/sends/inserts list; selected clip: props
  (gain/fades/start/length quantized fields).
- Browser (left): tabs Plugins (registry tree by vendor/category, search, drag onto track/mixer,
  blacklist badge + unblacklist button, rescan button w/ progress) / Files (project assets,
  missing-file badge + relink button, import button).
- Plugin generic editor (modal/floating panel): header (name, preset dropdown+save, bypass,
  wet/dry knob, "Open native UI" button, state badge), body = parameter list: per param a slider
  (or stepped select) + value text (from valueText), double-click to type, search filter,
  automation: right-click param → "Add automation lane". Updates live via event/pluginParams.
- Settings dialog: audio (driver/device/SR/buffer + measured latency + xrun count), MIDI inputs
  toggle list, plugin folders editor + rescan, autosave interval, ASIO greyed w/ reason if absent.
- Transport bar: menu bar (File / Edit / Project / Audio / MIDI — §10 honesty: every entry works
  or is visibly disabled with a tooltip reason; File→Close = confirm-if-dirty then `project/new`
  since the engine has no unloaded state; File→Import→Project… opens a paste-path import dialog
  — absolute path → `project/importForeign`, provider-extension hint, inline engine error text,
  "Browse (native)…" fallback to `dialog/importProject`), play/stop/rec, position (bars.beats +
  min:sec), tempo (editable), timesig, metronome+count-in, follow-playhead toggle, loop toggle,
  snap selector, swing, tool buttons, CPU/xrun badge, panic, master meter mini, save indicator
  (dirty dot), undo/redo buttons, export button. Project-flow failures surface as error toasts
  (ToastHost + `showToast(message, kind)`, mounted from DialogsHost).
- Theme: dark (default) + light, CSS vars in `theme.css` (dark on `:root`, light overrides under
  `:root[data-theme="light"]`; `lib/theme.ts` stamps the attribute — incl. pop-out documents —
  and broadcasts `mydaw:themechange` so canvas palettes re-resolve). Switcher in View → Theme and
  Settings → General; choice persists per user (`lib/prefs.ts`, localStorage `mydaw.*`).
  Inter/system-ui, 13 px base, crisp 1 px borders, subtle radii (6), Lucide-like inline
  SVG icons (hand-drawn paths, no dependency). UI prefs (panel sizes/visibility, viewport zoom,
  tool, browser/settings tabs, export defaults, piano-roll view, plugin-browser grouping) persist
  the same way.

## 10. Stub/honesty policy

Anything not actually working must be (a) absent from UI, or (b) visibly disabled with a tooltip
reason. Never a dead button. `docs/STUBS.md` lists: ASIO (needs SDK flag; code complete),
VST3-off fallback mode, native-UI-streaming-to-browser (future design §11 of ARCHITECTURE.md:
host-side capture via Windows.Graphics.Capture → WebRTC video track + input forwarding channel;
NOT implemented; "Open native UI" opens a real local window instead — implemented), time-stretch
(offline `cmd/clip.stretch` WSOLA + transpose is implemented; interactive *resize*-drag is still
trim only), multichannel >2 (schema+graph ready, UI exposes mono/stereo, panner is stereo), MIDI
hardware output, plugin preview/audition without track. STUBS.md explains exactly where each
interface is and what to implement.

## 11. Definition of done (v1 smoke)

`scripts/smoke-test.mjs` (node, ws client): connect → hello → new project → add audio track + midi
track + bus → set routing/sends → add midi clip + notes → tempo 100 → save to temp dir → load →
verify roundtrip JSON equality (modulo ids) → export 4 bars to wav → verify RIFF header + nonzero
samples (metronome+any content; the smoke sends `transport/setMetronome {enabled:true}` explicitly
— the engine metronome default is OFF) → undo/redo depth test → report PASS/FAIL per step. Must pass
with no audio device assumptions (engine falls back to null/silent driver if WASAPI init fails —
`NullDriver` exists for CI/headless: real clock via waitable timer, processes graph, discards
output; selectable via `--driver null`).

## 12. AI Agent + MCP (see llm_feature.md)

The approved agent/MCP design is `llm_feature.md`; its implementation journey is
`llm_feature_journey.md`. Binding additions to this spec:

- **Canonical catalog.** `shared/agent/capabilities.json` is the single source of truth for
  agent-exposed operations (every §5 `RequestMap` request plus 13 typed `ui/*` operations).
  `scripts/generate-agent-catalog.mjs` validates it and emits checked-in C++/TS views;
  `--check` is a build gate. Adding or removing a typed request cannot pass the build until
  its agent exposure or an explicit exclusion is updated.
- **Engine primitives (outside `RequestMap`).** `agent/query` — bounded/paginated/redacted
  reads carrying the engine revision; `agent/batch` — an atomic group of ≤64 catalog-approved
  `cmd/*` operations with `expectedRevision`, full rollback, one coalesced broadcast, and one
  undo entry. Routed in `Api::dispatch`; `agent/batch` is busy-guarded like `cmd/*`.
- **MCP endpoint.** `POST /mcp` — JSON-RPC 2.0 over Streamable HTTP, stable revision
  `2025-11-25`, stateless JSON responses (no SSE/session id in v1); `GET /mcp` → 405. Methods:
  `initialize`, `notifications/initialized` (202), `ping`, `tools/list|call`,
  `resources/list|templates/list|read`, `prompts/list|get`. Localhost-bound; a bearer token
  (`settings.llm.mcpToken`, generated on first run) and loopback-only Origin checks are
  required; bodies and results are capped.
- **Six tools.** `mydaw_context`, `mydaw_describe`, `mydaw_query`, `mydaw_execute`,
  `mydaw_batch`, `mydaw_ui` — the compact model-facing surface shared by MCP clients and the
  in-app agent.
- **Per-user LLM settings.** Stored under an open-ended `llm` object in
  `%APPDATA%/MyDAW/settings.json` (endpoint, model, apiKey, temperature, maxSteps, yolo,
  mcpToken, and JSON-string `historiesJson`/`customScriptsJson`). Never written to the
  `.mydaw` project. `apiKey`/`mcpToken` are redacted from the `agent/query` `settings` view.

No agent, MCP, HTTP, or LLM work runs on the real-time audio thread.
