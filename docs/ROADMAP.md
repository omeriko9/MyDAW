# Roadmap / TODO

Status legend: ✅ done · 🔨 in progress · ⬜ not started.
Complementary docs: [STUBS.md](STUBS.md) (where each interface lives), [SPEC.md](SPEC.md)
(binding contracts — extend it when adding protocol messages or schema fields).

## Phase 1 — Musical core ✅ (2026-06-11)

- MIDI CC / pitch bend / channel pressure end-to-end: `MidiCc` on `MidiClip`
  (`{id, controller 0..127|128=PB|129=ChAT, beat, value 0..1}`), `cmd/cc.edit`,
  sample-accurate playback with controller chase, capture during recording, SMF import,
  VST3 `IMidiMapping` routing (VST2 gets raw bytes already).
- Tempo & time-signature maps: `cmd/tempoMap.set` / `cmd/timeSigMap.set` (engine math was
  always general), transport-bar map editor popup, ruler markers, SMF import adopts maps.
- MIDI export: `export/midi` → format-1 SMF (tempo/timesig maps, notes + CC per track).
- Piano roll: CC/PB lane selector on the bottom lane; note audition through the track's
  instrument (`midi/preview` → live-MIDI injection, works while stopped).

## Phase 2 — Timeline & editors ✅ (2026-06-12)

- Automation lane UI in the timeline: expandable lanes under tracks ("A" toggle on the
  header), point add/move/delete, alt-drag curve bend, lane picker incl. plugin params
  (lazy `plugin/getParams`), live value readouts. No protocol changes were needed.
- Audio clip editor: peaks waveform with zoom/scroll, trim handles (`cmd/clip.resize`),
  fade handles, dB gain, normalize from peak data, split at cursor.
- Track duplicate: `cmd/track.duplicate` — deep copy (clips/notes/CC/automation/sends,
  inserts incl. plugin state via getState→setState, fresh ids, `plugin:<id>:<param>`
  paramRefs renumbered, folders recurse).
- Multiple plugin editor windows: `dialogs.pluginEditors: number[]`, z-order with
  click-to-front, cascading default positions.
- Grid/snap persistence: `cmd/grid.set` writes `project.grid` (undoable, saved); the
  transport snap selector keeps an optimistic local mirror.

## Phase 3 — Recording & media ⬜

- Punch in/out: punch region on transport, record gate in `AudioGraph`/recording commit.
- Loop-record takes: each loop pass → stacked clip (others muted), context-menu take
  picker; same for MIDI.
- Input gain per audio track (pre-insert), input meter while armed.
- `media/import` tempo prompt (`SmfReader` already parses tempo) + make import undoable
  (route through an `internal/recording.commit`-style command).
- Stem export: `export/render` per-track/bus variant (offline render with per-track tap
  or N solo passes — prefer single-pass multi-sink).
- **MP3/FLAC export** — DONE (2026-07-03): `export/render` accepts `format.type` wav/mp3/flac/
  m4a via `media/AudioEncoder` (IMFSinkWriter). FLAC lossless (negotiated 16/24-bit), mp3/m4a
  `kbps` 64..320. Unavailable/unknown codec → honest `bad_request` (no silent switch). Export
  dialog exposes the codec + bitrate. Test: `scripts/export-formats-test.mjs` (6/6).

## Built-in effects ✅ (2026-07-03)

Stock in-engine effects so a fresh install can mix without third-party plugins. They appear and
behave as normal inserts (picker/browser, generic editor, automation, bypass/wetDry, save/load)
but process in-engine with no host process. Catalog: **Utility** (gain/pan/phase/mono), **Noise
Gate**, **Compressor**, **Limiter**, **Delay**, **Reverb** (Freeverb). Architecture in SPEC §8.6
(`core/effects/`, `core/IInsertNode.h`, `BuiltinEffectManager`). Test: `scripts/stock-effects-test.mjs`
(render RMS + param + bypass + persistence, 12/12).

Extended 2026-07-03 with a built-in **Synth** (`builtin:synth`): a 16-voice subtractive instrument
(saw/square/tri/sine, state-variable filter, ADSR) — the first stock *instrument*, so a project
makes sound with no third-party VSTi. It reuses the exact insert plumbing: an instrument is just an
insert whose DSP reports `isInstrument`, MIDI arrives via the insert loop's `MidiBuffer`
(`IEffect::process` now carries `midi` + an `isInstrument()` flag; `BuiltinEffectNode` silences on
bypass for sources). Test: `scripts/stock-instrument-test.mjs` (8/8).

Extended 2026-07-03 with a built-in **Sampler** (`builtin:sampler`): 16-voice pitched sample
playback (root note / tune / ADSR / loop). `cmd/plugin.setSample {instanceId, assetId}` binds an
uploaded asset's PCM (RT-safe atomic publish); `PluginInstance.sampleAssetId` persists it and the
WAV is copied into the project on save (`copyExternalAssets`). Editor "Load Sample…" button. Test:
`scripts/stock-sampler-test.mjs` (8/8 — plays/persists/reloads/clears). Next candidates: a drum
machine (multi-sample), stock EQ-as-insert, chorus/phaser.

## Phase 4 — Plugin system ⬜

Done out of band (2026-06-12): **Cubase `.cpr` mixer import + plugin Recreation**.
The importer extracts insert chains, rack/track instruments, plugin identity and saved
state chunks as dormant inserts; File > Recreate Plugins… resolves them against the
user's VST folders and restores state (32-bit via the bridge, verified with PlugSound).
Format reverse-engineering: `docs/CPR_MIXER_FORMAT.md`. Remaining for this area:

- **`.cpr` channel EQ** — DONE (2026-06-12): MyDAW now has a per-track parametric EQ
  (model + realtime biquad DSP + inspector UI), and the importer maps the decoded Cubase
  EQ bands into `Track.eq`. Remaining: the Cubase band Type→shape integer mapping is
  inferred, not byte-verified (`docs/CPR_MIXER_FORMAT.md` §6 unknown #4) — enabled imported
  bands log a "mapping unverified" warning; SX-era (pre-C5) channel EQ is still not decoded.
- **`.cpr` sends → FX/group channels** — send levels are decoded, but most send
  destinations are FX/group channels MyDAW does not import yet; lands with group-channel
  import. Sends to the master/an imported bus do resolve.

Note: in the headless recreate test, UVI PlugSound's recreate can report `ok:false`
because the plugin pops a dismissible message box during load that no one dismisses in a
null-driver run. In interactive use the user dismisses it and it loads fine — not a bug.

- Sidechain (built-in compressor) — DONE (2026-07-03); see "Sidechain" section above. Still
  open for out-of-process plugins: VST3 aux-input bus activation (`Vst3Host` bus setup) +
  extra input tap routed through shm (extend `ShmHeader.numIn` usage).
- **VST2 shell plugins** — DONE (2026-07-02, `feat/reg-overlay-sandbox`): scan enumerates
  a shell DLL via `effShellGetNextPlugin` (one PluginInfo per child uid); `--uid`-selected
  load answers `audioMasterCurrentId` with the child uid during instantiation. Verified with
  Waves Diamond 5 `WaveShell-VST 5.0` (TrueVerb, L1-Ultramaximizer load live out-of-process).
  Landed alongside capture file-path + COM-class virtualization in the reg-overlay sandbox
  (SPEC §8.5).
- `plugin/savePreset`: new pipe op (VST2 program write; VST3 state-snapshot preset
  library) + `.fxp/.fxb/.vstpreset` file import/export in the generic editor.
- Sample-accurate live MIDI: use the QPC timestamps already captured in `MidiInput`'s
  mirror ring to compute intra-block sample offsets (today live input lands at offset 0).
- Raise caps: 512 meter slots, 1024 MIDI events/block (make dynamic or larger).
- Exact per-send PDC (today: per-track main-route approximation, see `Pdc.h`).
- Incremental automation updates: transient `cmd/automation.set` during a point drag
  triggers a full render-plan rebuild per coalesced message (correct — atomic swap —
  but heavy); patch automation data into the live plan instead.
- **Automation write** — DONE (2026-07-03): `transport/setAutomationWrite {enabled}` arms a
  global write; while armed + playing, volume/pan/send/plugin-param drags record points into
  the param's lane at the playhead (`CommandProcessor::captureAutomation`, thinned, baked at
  the gesture commit). Transport-bar pencil toggle. Test: `scripts/automation-write-test.mjs`
  (4/4). Follow-up: true touch/latch modes (overwrite untouched regions) need a continuous
  per-block writer; per-track arm instead of the single global toggle.

## Loudness metering ✅ (2026-07-03)

BS.1770-4 integrated loudness (K-weighting via RBJ biquads at the session rate + 400 ms/100 ms
gated integration) + peak dBFS, in `media/Loudness.{h,cpp}`. Measured during the export render;
`export/render` reply carries `{lufs, peakDb}` and a `loudnessTarget` request field scales the
render to a target (−14/−16/−23 LUFS presets in the export dialog). Test:
`scripts/loudness-test.mjs` (4/4 — targets hit within 0.01 LU). Next: a live master LUFS meter
(momentary/short-term) streamed to the mixer.

## MIDI control surface / learn ✅ (2026-07-03)

Bind hardware MIDI CC to params: `midimap/learn {paramRef}` arms, the next CC binds; a mapped CC
then drives the param live (`track:<id>:volume|pan`, `plugin:<id>:<pid>`). `MidiInput` gained a
non-RT control callback → `App::handleMidiControl` applies via a transient command (audio + UI
both move). `midimap/feedCc` injects a CC (software surface / OSC bridge / tests). Maps persist in
`Project.midiMaps`; state rides session/hello + `event/midiMaps`. Inspector: per-track MIDI-learn
chips for Volume/Pan. Test: `scripts/midi-learn-test.mjs` (10/10). Next: learn on plugin-editor
knobs + the mixer, 14-bit CC, note/program mappings.

## VCA / group faders ✅ (2026-07-03)

Control-only group faders: a VCA's linear gain multiplies the fader of every member track
(`Track.vcaId`), without being in the audio path (unlike a bus). `Project.vcas`, `cmd/vca.add|
remove|set`, applied in `TrackNode` post-fader via a per-member `VcaGain` param message (live) +
baked on rebuild. Persists through save/load. Inspector: VCA assign select + a group-gain drag.
Test: `scripts/vca-test.mjs` (7/7 — gain 0.5 → exactly half, persists, detaches on remove). Next:
mixer VCA strips, VCA gain automation.

## Sidechain (built-in compressor) ✅ (2026-07-03)

`PluginInstance.sidechainSource` keys the built-in compressor's detector from another track. The
source track captures its **pre-fader** block (`TrackNode` `keepSidechain` → `scL/scR/scFrames`);
the destination insert loop delivers it via `IInsertNode::setSidechainRt` → `IEffect::setSidechain`
right before `processRt`; only `CompressorEffect` reads it (detector on the key channels, one-shot
per block). Pre-fader capture means a **muted "silent key"** track still drives the detector.
Wiring resolves at graph rebuild like feeder routing (`AudioGraph::buildPlan` marks sources
`keepSidechain`, then resolves ids → node pointers into `Config::insertSidechain`); a source
ordered after the destination costs ≤1 block of detector latency, never a crash. `cmd/plugin.set
{patch:{sidechainSource}}` is structural; generic editor shows a source picker for
`builtin:compressor`. Test: `scripts/sidechain-test.mjs` (8/8 — a muted loud key ducks a
sub-threshold target to ~0.40×, self-detection leaves it unchanged, round-trips save/load, clears
to unity). Next: VST3 aux-input bus activation so out-of-process plugins can be sidechained too
(engine: route the extra input tap through shm — extend `ShmHeader.numIn`); per-insert (not
per-instance) UI in the mixer strip; sidechain HPF on the detector.

## Comping (take folders) ✅ (2026-07-03)

`Track.takeFolders`: stacked takes (lanes) + a `comp` (per-segment `{startBeat,lane}` selection).
Playback resolves at graph build — `AudioGraph::buildPlan` emits only the selected lane's material
**windowed to each comp segment** (sample-accurate audio clipping; MIDI notes by onset), so stacked
takes never sum. Loop-record slices a >1-lap continuous recording into one lane per lap in
`recordingCommit` (same asset, increasing source offsets; comp defaults to the last lap). Commands:
`cmd/take.create` (fold clips → folder), `cmd/take.setComp` (`activeLane` | `comp[]`),
`cmd/take.flatten` (bounce to plain clips). UI: Inspector "Takes / Comp" — comp bar + per-take
strips; click a strip to use that take, drag to swipe a range in. Test: `scripts/comping-test.mjs`
(11/11 — a loud take and a quiet take, comp switches sample-accurately at the mid-span boundary
[ratio 0.20 = exact amp split], round-trips save/load, flattens identically). Next: take lanes
drawn inline in the arrangement (ClipCanvas) with on-timeline swipe; MIDI loop-record lap-splitting
(audio-only today); quick-swap take hotkeys.

## Phase 5 — Drivers, remote UI, distribution ⬜

- **ASIO backend**: implement `AsioDriver.cpp` against the Steinberg ASIO SDK
  (`-DMYDAW_ASIO_SDK_DIR`, `MYDAW_HAVE_ASIO`; interface + CMake wiring + UI plumbing all
  exist). Testable on this machine (NI Audio Kontrol 1 has an ASIO driver).
- Multichannel (>stereo) graph: generalize buffer pool channel count in
  `AudioGraph`/`TrackNode` (schema + plugin IPC already allow 8ch).
- MIDI hardware output: `midiOut` sibling of `MidiInput` + per-track MIDI-out routing.
- **Native plugin-UI streaming to browser**: v1 = `Windows.Graphics.Capture` of the host
  process's editor window → JPEG/WebP frames over a dedicated WS + mouse/wheel/keyboard
  forwarding (design in ARCHITECTURE.md §future; WebRTC/H.264 later). Generic editor
  stays the fallback.
- WASAPI exclusive-mode verification on real hardware.
- Packaging: portable zip builder + Inno Setup script; engine unit-test target (CTest)
  beyond the two protocol-level test scripts.

## Phase 6 — Time-stretch ✅ (2026-07-03)

Offline WSOLA time-stretch + pitch transpose in `engine/src/media/TimeStretch.{h,cpp}`:
`cmd/clip.stretch {clipId, ratio, transpose?}` stretches the clip's source segment into a new
derivative asset (persisted via `pcmToAssetHook`) and repoints/resizes the clip. `transpose`
shifts pitch at constant length (stretch + resample). UI: audio-clip right-click ▸ Time-Stretch.
Test: `scripts/timestretch-test.mjs` (7/7 — ×2 → exactly 2× samples, transpose keeps length,
persists/reloads). Next: alt-drag the clip edge to stretch inline; phase-vocoder for cleaner
extreme ratios; audio warp markers.

## UI robustness / performance backlog

From the 2026-06-12 edge-case audit. The crash/hang/garbage guards are FIXED (commit
8333219); these are the deferred follow-ups:

- **Big-clip / big-clip-editor performance** — the arrangement now draws a summary band for
  MIDI clips over 5000 notes (interim cap), but the piano roll still rebuilds and scans the
  full note array every frame (`PianoRoll.tsx` `buildRenderNotes` + the two draw loops).
  Proper fix: keep `clip.notes` sorted by `startBeat` and binary-search the visible window
  in build/draw/marquee/move so per-frame cost scales with visible notes, not total
  (300k-note Logic imports exist). Same windowing for `clipRender.drawMidiContent`.
- **Mixer first-paint windowing** — FIXED (2026-07-03): `Mixer.tsx` now seeds `viewW` in a
  `useLayoutEffect` (pre-paint), so a >40-strip session windows on the first committed paint
  instead of mounting every strip once.
- **pluginState re-render storm** — FIXED (2026-07-03): `InsertSlots`/`TrackSection` now select
  only their own track's insert states via `useShallow`, so an `event/pluginState` for an
  unrelated plugin no longer re-renders every strip.
- **Master-track clip events** — INVESTIGATED, not a bug (2026-07-03): `applyProjectChanged`'s
  clip lookup is `tracks`-only, but clips are structurally impossible on master/bus/folder tracks
  (`Model::canHoldClips`) and the engine's clip-event serializer resolves through
  `clipById → project.tracks`, so a clip event can never be addressed to `masterTrack.id`. The
  invariant is now documented in `store.ts`.
- **Recovery revision** — `RecoveryDialog.recover()` sets the project without updating
  `store.revision`; add a revision/staleness guard in the granular merge.

## Standing quality bar

Every phase must end with: engine + host64 + host32 + UI builds green,
`node scripts/smoke-test.mjs` all green, `node scripts/import-test.mjs` green, relevant
new tests added, docs (SPEC §5/§6 + STUBS) updated, committed. No fake UI — unimplemented
features stay invisible or visibly disabled with a reason.
