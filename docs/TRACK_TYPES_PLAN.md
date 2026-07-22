# Track Types Plan — full Cubase 13 track-list parity

Status: **PLAN ONLY** (2026-07-22). Nothing in this document is implemented unless the
"MyDAW today" column says so. Companion work already shipped: the CPR importer now emits
per-track **skip warnings** (surfaced as a toast after Import Project), so every type
listed here is at least *visible* to the user when a `.cpr` contains it.

Evidence base: the corpus scan of `c:\temp\cubase13_all_tracks.cpr` + the exported track
archives in `c:\temp\cubase13_all_tracks_exported` (one file per track type), plus the
existing import corpus. Class names below are the literal CPR record classes.

---

## 1. Current state — Cubase 13 track list vs MyDAW

| Cubase 13 track type | CPR class | MyDAW today | CPR import today |
| --- | --- | --- | --- |
| Audio | `MAudioTrackEvent` | ✅ `kind:"audio"` | imported (clips, inserts, pan/vol, sends) |
| Instrument | `MInstrumentTrackEvent` | ✅ `kind:"instrument"` | imported (+ Synth Slot promotion) |
| MIDI | `MMidiTrackEvent` | ✅ `kind:"midi"` (+ `midiTarget` feeder) | imported |
| Folder | `MFolderTrack` | ✅ `kind:"folder"` | imported |
| Group channel | `MDeviceTrackEvent` under "Group Tracks" folder | ✅≈ `kind:"bus"` | **skipped + warned** |
| FX channel | `MDeviceTrackEvent`, name `#…`, under "FX Channels" | ✅≈ `kind:"bus"` + sends | **skipped + warned** |
| VCA fader | `MDeviceTrackEvent` under "VCA Tracks" (IDString `VCAChannel`) | ✅≈ `Vca` + `Track.vcaId` | **skipped + warned** |
| Sampler track | `MSamplerTrackEvent` | ✅≈ `builtin:sampler` on an instrument track | **skipped + warned** |
| Marker track | `MMarkerTrackEvent` | ✅≈ project-level `markers[]` (no track lane) | **skipped + warned** |
| Arranger track | `MPlayRangeTrackEvent` | ❌ | **skipped + warned** |
| Chord track | `MChordTrackEvent` | ❌ | **skipped + warned** |
| Transpose track | `MTransposeTrackEvent` | ❌ | **skipped + warned** |
| Tempo track | `MTempoTrackEvent` | ✅ tempo map (no track lane) | imported as map |
| Signature track | `MSignatureTrackEvent` | ✅ time-sig map (no track lane) | imported as map |
| Ruler track | `MTimeScaleTrack` (no `TrackEvent` suffix!) | ❌ | **counted + warned** (invisible to the per-track scan) |
| Video track | `MVideoTrackEvent` | ❌ | **skipped + warned** |

`✅≈` = the *capability* exists in MyDAW but not as the same track-list concept (or the
importer doesn't map it yet). Those are the cheapest wins: mostly import-mapping work,
not new engine features.

---

## 2. Cross-cutting: what "adding a track kind" touches

Checklist derived from the `bus`/`folder` precedents — every new `TrackKind` must walk it:

1. **Model** — `TrackKind` enum + `trackKindFromString`/`trackKindToString` (Model.h),
   `canHoldClips()`, folder/graph invariants (`isDescendantOf`, solo closure in
   core/Mixer.cpp if audible).
2. **Graph** — does it render audio? (`AudioGraph::buildPlan` node creation, routing,
   meters). Non-audio kinds (marker/arranger/chord/…) must be *invisible* to the graph
   the way folders already are.
3. **Serialization** — usually free (kind string), but new per-track payloads (marker
   lists, arranger events, chord events) follow the `takeFolders`/`versions`
   omit-when-empty pattern in Serialize.cpp + tolerant `fromJson`.
4. **Commands** — `cmd/track.add` validation; new content commands follow the
   `cmd/take.*` / `cmd/version.*` shape (label, `scope:"track"`, `eventTrackIds`,
   structural only when audio changes).
5. **UI** — `TrackKind`/`AddableTrackKind` (types.ts), `ADDABLE` + `trackKindIcon`
   (TrackHeaders/layout), row rendering (most new kinds are **fixed-height, non-clip
   lanes** rendered by ClipCanvas like the ruler, not like clip tracks), mixer strip
   visibility (marker/arranger/chord kinds must NOT get a mixer channel — same filter
   folders use), Inspector tab.
6. **Agent catalog** — capabilities.json `TrackKind` schema + any new `cmd/*` ops +
   generator counts (currently 107 engine ops) + catalog.test.ts fixtures +
   `npm run catalog:generate`.
7. **CPR import** — map the class in CprImportProvider `buildTracks` and REMOVE its
   entry from `skippedTrackLabel` so the warning disappears the release the type ships.
8. **CPR export** — decide emit-or-drop; anything we can't round-trip must warn on
   export (same UX as import warnings).

---

## 3. Per-type plans (ordered by suggested priority)

### P0 — import-mapping wins (capability already exists)

#### 3.1 Group channel → `kind:"bus"`
- CPR: `MDeviceTrackEvent` whose parent folder is `"Group Tracks"`. The channel blob
  (`Panner`, fader, inserts) parses with the SAME code path as audio-track channels.
- Work: in `buildTracks`, instead of skipping, create a bus track; route source tracks
  by matching their output-routing ids to the group's channel id (the corpus shows
  routing via the hidden "Input/Output Channels" carrier ids). Order: create groups
  first, then patch `outputTarget` on a second pass (ids are forward-referenced).
- Est: 1–2 days. Risk: routing-id resolution across eras (C5 vs C13 verified only for
  the corpus we have).

#### 3.2 FX channel → `kind:"bus"` + send targets
- CPR: `MDeviceTrackEvent` named `#<name>` under `"FX Channels"`.
- Work: same as 3.1 plus mapping each source track's send slots (already decoded for
  audio tracks) onto `Track.sends[].destTrackId`. Insert chain imports like any other.
- Est: 1 day on top of 3.1 (shares the id-resolution pass).

#### 3.3 VCA fader → `Vca` record + `Track.vcaId`
- CPR: `MDeviceTrackEvent` under `"VCA Tracks"`, IDString `VCAChannel`; membership is
  stored on the member channels.
- Work: create a `Vca` (cmd-level model already exists), set `vcaId` on members, import
  the VCA gain. No graph work — MyDAW's VCA math already multiplies faders.
- Est: 0.5–1 day.

#### 3.4 Sampler track → instrument track + `builtin:sampler`
- CPR: `MSamplerTrackEvent`; the embedded sample + zone/loop parameters live in the
  track's audioComponent blob (format NOT yet reverse-engineered — needs a dedicated
  fixture pass like the Panner work).
- Work (phase A, cheap): import as an instrument track with an EMPTY `builtin:sampler`
  + warning "sample not recovered". Phase B: decode the blob (sample path, root note,
  loop points → `cmd/plugin.setSample` fields).
- Est: A = 0.5 day; B = 2–4 days of format archaeology.

### P1 — new lane-style track types (real features)

#### 3.5 Marker track
- MyDAW already has project-level `markers[]` + marker commands; the feature is a
  **timeline lane UI** and cycle-marker (range) support.
- Model: `kind:"marker"` track holds NO audio; markers stay project-level (single
  source of truth) — the track is a *view* row, max one per project (Cubase allows
  several; not worth the ambiguity). Add `Marker.endBeat?` for cycle markers.
- UI: fixed-height row rendering marker flags in ClipCanvas; drag to move, dbl-click to
  rename; cycle markers set the loop on click. Mixer: hidden.
- CPR: `MMarkerTrackEvent` children carry marker events incl. cycle ranges → merge into
  `markers[]` (drop the "Marker track" warning; keep it if only cycle markers were
  dropped… no — import those too).
- Est: 2–3 days.

#### 3.6 Arranger track (Cubase "Arranger", CPR `MPlayRangeTrackEvent`)
- Model: `arranger: { sections: [{id, name, startBeat, endBeat, color}], chain:
  [sectionId], activeChain?: bool }` at PROJECT level + a `kind:"arranger"` view row
  (same single-row pattern as marker).
- Engine: playback follows the chain = a transport-level jump table (locate at section
  boundaries — reuse the loop-wrap machinery in the transport; the graph doesn't care).
  Flatten command bakes the chain into a linear timeline (mirrors `take.flatten`
  windowed-copy logic; reuse it).
- UI: lane with colored section blocks; a small chain editor panel (ordered list,
  drag to reorder, play/flatten buttons).
- CPR: import sections + chain; if a section chain is active in Cubase, import it
  INACTIVE with a toast (avoid surprise non-linear playback).
- Est: 4–6 days. This is the highest-value "new" type for arrangement workflows.

#### 3.7 Chord track
- Model: project-level `chordEvents: [{beat, root, quality, tensions?, voicing?}]` + a
  `kind:"chord"` view row.
- Engine: OPTIONAL audition (route chord hits to a chosen instrument track —
  reuse the midi-thru injection path). No graph nodes.
- UI: lane showing chord symbols (text glyphs); editor popover (root/quality pickers —
  reuse the scales data from the MIDI-functions work); Piano Roll overlay: highlight
  chord tones (ties into the existing scale-highlight feature); "follow chord track"
  MIDI transform as a later increment.
- CPR: `MChordTrackEvent` events decode root/type; import symbols only (voicings are
  Cubase-internal).
- Est: 3–5 days for lane+editor+highlight; the "follow" transform is its own project.

#### 3.8 Transpose track
- Model: project-level `transposeEvents: [{beat, semitones}]` + `kind:"transpose"` view
  row.
- Engine: applies to MIDI scheduling only (offset pitch at TrackNode::scheduleMidiRt
  bake time — a plan-build input, so changes are structural rebuilds; audio transpose
  via clip stretch is explicitly OUT of scope v1, matching how we already do
  `clip.stretch`).
- UI: step-line lane (reuse automation-lane rendering with integer steps).
- CPR: `MTransposeTrackEvent` → events map 1:1.
- Est: 2–3 days. Cheap and useful with the sheet-music pane.

### P2 — view-only / deferred

#### 3.9 Ruler track (`MTimeScaleTrack`)
- MyDAW's single ruler already offers bars/time; multiple ruler rows are low value.
- Plan: DEFER. Keep the import warning (already counts them — note the class has no
  `TrackEvent` suffix, so it needs the dedicated scan we added, not `isTrackRecord`).

#### 3.10 Video track (`MVideoTrackEvent`)
- Real feature = video decode + frame-locked playback window (media engine work:
  Windows Media Foundation reader, a video window, A/V sync to the transport clock).
- Plan: DEFER to its own spec. Import keeps warning; as an interim nicety we can
  extract the referenced video file path into the warning text so the user knows what
  was dropped.

#### 3.11 Tempo/Signature LANES (maps already import)
- The maps exist and import; a lane UI (editable curve like Cubase's tempo track) is a
  pure-UI increment on top of `cmd/tempoMap.set` — pairs well with the automation-lane
  "flowing paint" work. Est: 2 days when wanted.

---

## 4. Suggested delivery order

1. **P0 batch** (3.1–3.4A): pure import wins, ~3–4 days total, kills the four loudest
   import warnings on real projects (groups/FX/VCA/sampler are everywhere).
2. **Marker track** (3.5) — small, self-contained, immediately visible.
3. **Arranger** (3.6) — flagship feature of the batch.
4. **Transpose** (3.8), then **Chord** (3.7) — share the "project-level events + view
   row" plumbing; build it once in 3.5 and reuse.
5. Re-evaluate Ruler/Video after the above ships.

Each increment must end by updating `skippedTrackLabel` + the import-warning tests so
the warning list always states exactly what MyDAW cannot represent *today*.
