# Cubase 13 Audio + MIDI Feature Parity — Gap Analysis & Implementation Plan

Source: Cubase 13 right-click feature survey (`c:\temp\cubase 13 audio and midi features.png`) — audio Processes menu,
Direct Offline Processing (DOP), Pitch Shift dialog, sizing-tool time-stretch modes, MIDI Functions menu,
plug-ins-as-offline-processes, and MIDI insert effects.

Codebase evidence gathered 2026-07-28 (three deep scans: audio clip processing, MIDI functions, command/menu/plugin infra).
File:line references are to the state of `main` at `b0a167e`.

---

## Part 1 — Gap analysis

### 1a. Audio offline processes (Cubase: Audio ▸ Processes + DOP window)

| Cubase 13 | MyDAW status | Evidence |
|---|---|---|
| Gain | ✅ exists, **weak UI** — fixed ±1/3/6 dB presets only, no dialog | `Commands.cpp:2101`, menu `ClipCanvas.tsx:2242` |
| Normalize | ✅ exists, peak-only (no RMS/LUFS mode) + separate non-destructive gain-normalize in ClipEditor | `Commands.cpp:2106`, `ClipEditor.tsx:714` |
| Fade In / Fade Out | ⚠️ **far below Cubase** — destructive full-span linear op + non-destructive clip fades that are hard-coded linear; no curve shapes, no fade dialog, no presets | `Commands.cpp:2116`, `TrackNode.cpp:388-391`, `clipRender.ts:360` |
| Envelope (draw gain curve over event) | ❌ missing entirely | no per-clip envelope model anywhere |
| Invert Phase | ✅ exists | `Commands.cpp:2129` |
| Remove DC Offset | ✅ exists | `Commands.cpp:2135` |
| Reverse | ✅ exists | `Commands.cpp:2126` |
| Silence | ✅ exists | `Commands.cpp:2132` |
| Stereo Flip (swap/L→both/R→both/merge/subtract) | ❌ missing entirely | — |
| Resample (as a process) | ❌ missing (import-time only) | `Decoder.cpp:471` |
| Pitch Shift (semitones/cents, formant, envelope, chord/multi-shift) | ⚠️ crude — `clip.stretch {transpose:true}` with raw ratio; WSOLA + linear resample; no semitone UI, no formant, no fine-tune | `Commands.cpp:2029`, `TimeStretch.cpp:83` |
| Time Stretch (dialog: target BPM/bars, algorithm choice) | ⚠️ fixed presets (½×, 2×, 1.5×) via WSOLA; no dialog, no target-tempo entry, no algo choice | `Commands.cpp:1999`, `ClipCanvas.tsx:2259` |
| **DOP framework** (per-event ordered process chain, re-editable params, enable/disable, presets, auto-apply, plug-ins as processes, make-permanent) | ❌ missing entirely — every process is instantly destructive (new edit WAV, global-undo only) | `Commands.cpp:2062-2164` |
| Crossfades between overlapping events | ❌ missing | — |
| Selection-range processing (process part of an event) | ❌ missing — always the full clip span | — |

Existing strengths to build on: `pcmToAssetHook` (`App.cpp:254`) is a clean "materialize buffer → asset" primitive; `AudioGraph::renderOffline` takes an arbitrary sample range + solo track; peaks regenerate automatically; the timeline already draws fade triangles + handles (`clipRender.ts:360-426`) and the automation lane already has a point-with-curve editing model (`clipRender.ts:458-501`) that can be reused for a clip envelope.

### 1b. MIDI Functions (Cubase: MIDI ▸ Functions + related)

MyDAW already has a clean 3-file extension pattern: pure fn in `ui/src/lib/midiFunctions.ts` → menu entry in `PianoRoll.tsx:1777` → optional agent enum in `capabilities.json:8930`.

| Cubase 13 | MyDAW status |
|---|---|
| Legato | ✅ (`midiFunctions.ts:44`) — no gap/overlap parameter |
| Fixed Lengths | ⚠️ grid-step only, no length picker |
| Delete Doubles | ✅ (`midiFunctions.ts:148`) |
| Reverse | ✅ (`midiFunctions.ts:125`) |
| Velocity dialog (add / compress / limit) | ⚠️ math exists (`scaleVelocity`) but wired only as hard-coded ±10; no dialog |
| Fixed Velocity | ❌ (trivial: `scaleVelocity(0, v)`) |
| Delete Overlaps (mono) / (poly) | ❌ |
| Delete Notes… (below length/velocity) | ❌ |
| Mirror (pitch inversion) | ❌ |
| Restrict Polyphony | ❌ |
| Thin Out Data (CC thinning) | ❌ |
| Delete Controllers / Delete Continuous Controllers | ⚠️ only "Clear CC Lane…" (one controller, active clip) |
| Pedals to Note Length | ❌ (CC64 stored but no pedal semantics) |
| Extract MIDI Automation (CC → track automation) | ❌ (both models exist, no converter) |
| Dissolve Part (by channel / by pitch) | ❌ |
| Merge MIDI in Loop | ❌ |
| Export MIDI Loop | ❌ (`export/midi` is whole-project only) |
| Calculate Tempo from MIDI Events | ❌ (niche) |
| Logical Editor / Transformer | ❌ — no rule engine anywhere |
| Glue/Join parts | ⚠️ `cmd/clip.join` fully implemented engine-side (`Commands.cpp:2257`) but **zero UI callers** |
| Quantize | ✅ strong (grid/strength/swing/selection) — missing: ends/length quantize, groove templates, iterative |

Infra caveats found:
- `NotesPatch` has no `add` (`midiFunctions.ts:13-16`) — functions cannot create notes today (blocks chord/arp-flatten/split ops).
- Functions receive **notes only** — CC-touching functions (thin out, pedals-to-length, delete controllers) need the signature widened to `(notes, cc)` → `{notes?, cc?}` patches, and ideally a combined engine command so it's one undo entry.
- Piano roll and Score editor duplicate note math (`lib/midiFunctions.ts` vs `SheetMusic/editing.ts`) — new functions appear in only one editor unless unified.

### 1c. MIDI insert effects (Cubase: Arpache, Auto LFO, Beat Designer, Chorder, Context Gate, Density, MIDI Echo, MIDI Modifiers, Micro Tuner, Note To CC, Quantizer, StepDesigner, Transformer…)

**All absent, and the architecture has no slot for them**: `IInsertNode::processRt` consumes MIDI but cannot emit it; `Track` has no MIDI-FX chain (only `midiTarget` + `midiOutChannel`); the live-thru path applies only forced-channel; CPR import explicitly skips MIDI-track inserts (`CprImportProvider.cpp:3044`). This is the one area needing genuinely new engine infrastructure.

### 1d. Arrangement-level commands (Cubase clip context menu)

| Cubase 13 | MyDAW status |
|---|---|
| Render in Place | ❌ — `cmd/track.bounce` is whole-track-from-0 only; `renderOffline` already takes a range + solo, `bounceRenderHook` hardcodes start=0 (`App.cpp:231`) |
| Bounce Selection | ❌ (same hook widening) |
| Create Sampler Track | ⚠️ 90% exists — `builtin:sampler` instrument shipped (`Effects.cpp:1327`, `cmd/plugin.setSample`), missing only the composite command + a dedicated `SamplerEditor` (falls through to generic param list) |
| Events to Part / grouping | ❌ no container/group model; `cmd/clip.join` is the flat-model equivalent for MIDI |
| Sizing Applies Time Stretch (tool mode) | ❌ — resize is "trim only, never stretch" (`Commands.cpp:1985`); all pieces exist (WSOLA + resize drag + tool state) |
| Plug-ins as offline processes | ❌ — no offline `processBuffer` API, but a clean route exists (throwaway instance + `setOfflineMode(true)` + block pump + `pcmToAssetHook`) |

---

## Part 2 — Implementation plan (swipes, ROI-ordered)

Cost scale: **S** ≤ 1 day · **M** 2–4 days · **L** 1–2 weeks · **XL** > 2 weeks.
Value: ★–★★★★★ (how much day-to-day musical utility + Cubase-parity credibility it buys).

Cross-cutting rules for every swipe (learned the hard way, see memory):
1. Any new `cmd/*` or model field → `shared/agent/capabilities.json` (mind `additionalProperties:false` on `Track`/`AudioClip`/`MidiClip`) → `node scripts/generate-agent-catalog.mjs` → `catalog.test.ts` REQUEST_TYPES.
2. New per-clip fields: `Model.h` → `Serialize.cpp` (omit-when-default) → `types.ts` → capabilities schemas.
3. Destructive audio ops follow the asset pattern: write new WAV via `pcmToAssetHook`, repoint clip, never delete files (undo repoints back).
4. Long renders: synchronous-in-handler is acceptable up to a few seconds (bounce precedent); beyond that use the `beginExport()`/worker/`internal/*.commit` pattern (`Api.cpp:1624`, `Commands.cpp:1015`).
5. Menu-bar `MENUS` entries are auto-picked-up by the Ctrl+K palette; context-menu-only items are not — mirror important ops into `MenuBar.tsx`.

---

### Swipe 1 — MIDI Functions parity 🎹  — **Cost: M (≈3d) · Value: ★★★★★ · ROI: best in plan**

> **STATUS: SHIPPED 2026-07-28.** All items below except Extract MIDI Automation, which is
> DEFERRED to Swipe 8: the automation model's `paramRef` grammar (`volume|pan|send:<i>|plugin:…`)
> has no CC target, so extracted CC curves would have nowhere to land until track-level MIDI
> modifiers exist. Also of note: functions ship in the piano roll only (the score editor keeps its
> separate math layer per the unify-opportunistically decision).

Why together: every item is a pure function + menu entry in the same three files; one infra fix (patch shape) unlocks the rest.

| Task | Cost | Notes |
|---|---|---|
| Extend `NotesPatch` with `add: NewNote[]` + plumb through `applyFn` → `cmd/notes.edit` | S | unlocks note-generating functions forever |
| Widen function signature to accept CC + return `{notes?, cc?}`; add combined `cmd/midi.applyFunction`-style single-undo commit (or send notes.edit+cc.edit as one transient-pair) | S–M | needed by 4 functions below |
| Delete Overlaps (mono) + (poly) | S | sort by pitch/start, clamp ends |
| Fixed Velocity + Velocity dialog (add / compress-around-center / limit) | S–M | small modal, reuses `scaleVelocity`; expose pp/p/mf/f/ff presets like the score editor |
| Delete Notes… (below length / below velocity, small dialog) | S | `NotesPatch.remove` |
| Mirror (pitch inversion around selection center or chosen axis) | S | |
| Restrict Polyphony (keep top-N by priority) | S | |
| Fixed Lengths with length picker (submenu: grid, 1/8, 1/16…) | S | generalize existing `fixedLength` |
| Legato gap/overlap amount (submenu: tight / +10% overlap / gap) | S | |
| Thin Out Data (CC decimation, tolerance-based Douglas-Peucker-lite) | S–M | CC-patch |
| Delete Controllers / Delete Continuous Controllers (all lanes, selection scope) | S | CC-patch |
| Pedals to Note Length (CC64 spans extend note ends, delete pedal events) | M | CC-patch, the one Cubase MIDI function drummers/pianists actually miss |
| Extract MIDI Automation (selected CC lane → track automation points, delete CC) | M | engine-side: `cc` → `Track.automation`; both models exist |
| Glue/Join UI entry (context menu + Edit menu) for the orphaned `cmd/clip.join` | S | pure wiring; icon exists |
| Expose new fns + `rampVelocity`/`smoothVelocity` in agent `ui/midi.transform` enum | S | catalog regen |

Deferred from this swipe: Dissolve Part / Merge-in-Loop / Export MIDI Loop (clip-level, → Swipe 5), Calculate Tempo from MIDI (niche, backlog), Logical Editor (→ Swipe 8), score-editor/piano-roll math unification (do opportunistically when a function is requested in both).

---

### Swipe 2 — Fades done right: curves, crossfades, clip envelope 🌊 — **Cost: L (≈1.5w) · Value: ★★★★★ · ROI: very high (explicit pain point)**

> **STATUS: SHIPPED 2026-07-28.** Fade curve shapes (5, incl. equal-power) on model + RT render +
> timeline/ClipEditor drawing; fade dialog on handle double-click; curve selects in Inspector +
> ClipEditor menu; `cmd/clip.crossfade` (X key + menu); non-destructive gain envelope with
> ClipEditor edit mode (click add / drag / right-click delete) + split-rescaling. Deferred from
> this swipe: the transient-fade-drag param-ring optimization (fade drags still rebuild the graph
> per message — pre-existing behavior), and ClipEditor fade-length drag preview of curves during
> the drag itself uses committed curve (cosmetic).

Why together: all four items touch the same model fields (`AudioClip`), the same render hook (`TrackNode::renderClipsRt`), and the same drawing code (`clipRender.ts drawFades`).

| Task | Cost | Notes |
|---|---|---|
| Fade curve shape on `AudioClip` (`fadeInCurve`/`fadeOutCurve`: linear, exp, log, S-curve, equal-power ±) | M | model+serialize+types+capabilities; render in `TrackNode.cpp:388` (precompute per-block, not per-sample pow); draw sampled curve in `drawFades` |
| Fade editor popover (double-click fade handle): curve preset row like Cubase's 8 shapes + length field | M | reuse `ContextMenu`/modal infra; live preview via transient `clip.set` |
| Crossfade command (X on two overlapping/adjacent clips): symmetric equal-power fades + optional overlap creation | M | pure model op over existing fade fields; draw the X overlay |
| Clip gain envelope (Cubase "Envelope" process, but **non-destructive**): points-with-curve on `AudioClip`, edited on the clip like an automation lane, applied in `renderClipsRt` | M–L | reuse `AutomationPoint` model + `drawAutomationLane` editing/drawing; strictly better than Cubase's destructive version |
| ClipEditor parity: same curves/envelope drawn + editable in the big waveform view | S–M | same draw fn |

Gotcha: fade edits are `structural` and rebuild the graph per drag message (`Commands.cpp:2464`) — while in here, consider routing fade/gain/envelope transients through the param ring instead (perf win, not a blocker).

---

### Swipe 3 — Offline processes: parameters, missing DSP, real Pitch Shift dialog 🎚 — **Cost: M–L (≈1w) · Value: ★★★★ · ROI: high**

> **STATUS: SHIPPED 2026-07-28.** Gain/Normalize dialogs (peak/RMS/LUFS), Stereo Flip (5 modes),
> Resample (tape semantics, the only span-changing op), render-fades with curve shapes, Time
> Stretch ratio dialog, Pitch Shift dialog (semitones+cents+time-correction → tape varispeed when
> off), and **signalsmith-stretch vendored** (third_party/signalsmith, MIT) as the default
> stretch/pitch engine (8 kHz tonality limit; `algorithm:"wsola"` keeps the legacy path).
> Deferred: in-dialog audition/preview (needs a preview render path — revisit with DOP in
> Swipe 7); selection-range (partial-event) processing stays in the backlog.

Why together: one new `ProcessDialog` component + extensions to a single engine handler (`clipProcessAudio`).

| Task | Cost | Notes |
|---|---|---|
| Process dialog (replaces fixed-preset submenus): op-specific params, Apply/Cancel | M | Gain: dB field + clip warning; Normalize: peak/RMS/LUFS modes (reuse `media/Loudness`) |
| Stereo Flip (swap, L→both, R→both, merge, mid/side subtract) | S | trivial per-sample ops in `clipProcessAudio` |
| Resample process (rate field, keep-pitch off = Cubase behavior) | S–M | reuse resampler; label the clip |
| Pitch Shift dialog: semitones + cents (keyboard widget optional later), time-correction toggle | M | maps to existing `clip.stretch{transpose}`; ratio = 2^(st/12) |
| Time Stretch dialog: target BPM / target bars / ratio entry | S–M | maps to `clip.stretch` |
| Destructive fade ops gain length + curve params (share curve enum from Swipe 2) | S | |
| Audition/preview button in dialog (render selection through the op into a temp buffer, play via existing preview path) | M | nice-to-have; ship dialog without it if it drags |
| **Quality upgrade: vendor `signalsmith-stretch` (MIT) as the stretch/pitch engine** (WSOLA fallback), enabling formant preservation + better extreme ratios | M | licensing-clean (MIT) — fits the publication posture; unlocks credible Pitch Shift |

---

### Swipe 4 — Render in Place, Bounce Selection, Sampler Track 📦 — **Cost: M (≈4d) · Value: ★★★★ · ROI: high**

> **STATUS: SHIPPED 2026-07-28.** bounceRenderHook widened with startBeat;
> cmd/track.renderInPlace (new audio track below, source muted); cmd/clip.bounceSelection
> (insert-free consolidation, fades/envelopes baked); cmd/track.createSampler (one undo entry)
> + SamplerEditor panel with audition keyboard. Deferred: drag-clip-onto-instrument affordance.

Why together: all three are "render/compose existing primitives into a new command + context-menu entry"; the first two share the `bounceRenderHook` range-widening.

| Task | Cost | Notes |
|---|---|---|
| Widen `bounceRenderHook` with `startBeat` (keep freeze calling with 0) | S | `Commands.h:70`, `App.cpp:199` |
| `cmd/track.renderInPlace {trackId, startBeat, endBeat, mode: dry/withFx}` → new audio clip on new (or same) track, source clips muted | M | near-copy of `trackBounce`; menu on track header + clip context + Audio menu |
| `cmd/clip.bounceSelection` (selected clips' span, solo'd track render → replaces selection with one clip) | S–M | same hook |
| `cmd/track.createSampler {clipId}`: add instrument track + `builtin:sampler` + `setSample(clip.assetId)` as one undo entry | S | all three sub-commands exist and are batch-proven |
| `SamplerEditor` panel (waveform + root/tune/gain/ADSR/loop controls) for `builtin:sampler` | M | add to `InstrumentEditors.tsx SPECS`; params already exist (`Effects.cpp:641`) |
| "Create Sampler Track" in audio-clip context menu + drag-clip-onto-instrument affordance later | S | |

---

### Swipe 5 — Clip-level MIDI arrangement ops ✂️ — **Cost: M (≈3d) · Value: ★★★ · ROI: good**

> **STATUS: SHIPPED 2026-07-28.** cmd/clip.dissolve (by channel/pitch, controllers copied,
> source muted), cmd/midi.mergeLoop (loop-region gather → new track), export/midi range
> (Export MIDI Loop, re-anchored SMF), piano-roll note copy/cut/paste/duplicate via the
> key-context clipboard (Edit menu gates widened to note selections).

Why together: all are engine clip-model surgery + arrangement context-menu entries (same files as each other, distinct from Swipe 1's note-level scope).

| Task | Cost | Notes |
|---|---|---|
| Dissolve Part (by channel / by pitch) → new tracks or lanes | M | model surgery like `clip.join` inverse; import heuristic in `SmfTrackPlan` is prior art |
| Merge MIDI in Loop (flatten overlapping MIDI clips in cycle range into one) | S–M | `clip.join` + range clamp |
| Export MIDI Loop / Export Selection as SMF (`export/midi` gains `{clipIds?/range?}`) | S–M | `SmfWriter` already per-track-plan based |
| Note-level copy/paste in piano roll (Ctrl+C/V within/between clips) | M | closes the clipboard gap found in the scan; huge daily-use win for its size — smuggled into this swipe because it's clip/notes plumbing |

---

### Swipe 6 — Sizing tool modes (time-stretch on resize) 🤏 — **Cost: M (≈3d) · Value: ★★★ · ROI: good**

| Task | Cost | Notes |
|---|---|---|
| `sizingMode: normal / moveContents / timeStretch` store field + toolbar split-button + toolbox rows | S | 6 known touch points for tool-adjacent state |
| `cmd/clip.resizeStretch {clipId, edge, newLengthBeats}` = resize + WSOLA (or signalsmith) bake in one undo entry; lift trim clamps in drag path when mode active | M | reuse `clipStretch` body; clamp ratio 0.25–4 |
| Move-contents resize mode (audio: shift `srcOffsetSamples`; MIDI: shift note offsets) | S–M | |
| Stretch-preview overlay during drag (ghost waveform + ratio label in the drag HUD) | S | shared `.drag-hud` exists |

Caveat: synchronous stretch stalls on long clips — acceptable v1 (bounce precedent); revisit with the async pattern if users hit it.

---

### Swipe 7 — Direct Offline Processing framework + plug-ins as processes 🧪 — **Cost: XL (≈3w) · Value: ★★★★ · ROI: medium (flagship feature, do after quick wins)**

The real Cubase differentiator: per-event, ordered, re-editable, non-destructive process history.

| Task | Cost | Notes |
|---|---|---|
| `ClipProcess[]` chain on `AudioClip` (op + params + enabled), derived asset = f(original asset, chain); keep original `assetId`+span as provenance | L | recompute = replay chain from original slice via existing DSP + `pcmToAssetHook`; undo snapshots chain for free |
| DOP panel (dockable): process list, add/remove/reorder/toggle, param edit re-renders, Auto Apply, "Make Permanent" | L | Cubase-style; banks/favorites later |
| Plug-in as offline process: throwaway instance route (`host_->create` → `setOfflineMode(true)` → block pump + latency-tail drain → capture) | M–L | worker + busy guard for VSTs; builtins can run synchronous |
| Async recompute with progress (`event/exportProgress`-style) + `internal/*.commit` | M | required once plugins are in the chain |
| Orphan edit-WAV GC on save (assets unreferenced by any clip/chain/undo) | S–M | fixes the existing disk-leak too |

Depends on Swipe 3 (parameterized ops become chain entries verbatim).

---

### Swipe 8 — MIDI FX: track modifiers first, real inserts later 🎛 — **Cost: M for tier 1, XL for tier 2 · Value: ★★★ · ROI: tier 1 good, tier 2 low-until-asked**

Tier 1 (**do**): Cubase "MIDI Modifiers" as a Track section — transpose, velocity shift/compress, random, range filter. Applied at bake time (`AudioGraph.cpp:399` next to the transpose-track hook) + in the live-thru path (`applyOutChannelRt` neighbor). No plugin infrastructure needed; playback-only, like Cubase. Cost M, value ★★★ (also improves CPR import fidelity — modifiers exist in .cpr).

Tier 2 (**defer until demanded**): real MIDI insert chain (MIDI-out from `IInsertNode`, `Track.midiInserts`, RT scheduling rework in `TrackNode.cpp:275-340`) + starter effects (Arpache-style arpeggiator, Chorder, MIDI Echo, live Quantizer, StepDesigner). Cost XL. Alternative cheap path: implement Chorder/arp/echo as **offline** Functions first (Swipe 1's `add`-capable patch makes these one-liners) — 80% of the musical value at 5% of the cost.

---

### Swipe 9 — Logical Editor 🧠 — **Cost: L (≈1.5–2w) · Value: ★★★ · ROI: medium, big power-user + agent synergy**

Filter rules (property / condition / value, AND-OR) → actions (set/add/mul/random on pitch/vel/pos/len/chan), preset library (ship Cubase's classic presets: "select every other note", "delete short notes", "randomize velocity ±10"…). Implement as a rule interpreter over the pure-function layer (`midiFunctions.ts`) so it works on selection or whole clip, plus a `cmd`-level twin so the **agent** can run arbitrary logical-editor programs — this doubles as a major agent-capability unlock, which is the hidden ROI here. UI: modal with rule rows + preset dropdown, mirrored into MENUS for palette access.

---

## Part 3 — Suggested order & running total

| # | Swipe | Cost | Value | Rationale |
|---|---|---|---|---|
| 1 | MIDI Functions parity | M | ★★★★★ | Cheapest big surface; pattern already exists |
| 2 | Fades/crossfades/envelope | L | ★★★★★ | The explicitly-called-out quality gap |
| 3 | Process dialogs + missing DSP + signalsmith | M–L | ★★★★ | Turns "toy presets" into real tools; feeds Swipe 7 |
| 4 | Render in Place + Bounce + Sampler Track | M | ★★★★ | Marquee features, mostly composition of existing primitives |
| 5 | Clip-level MIDI ops (+ note clipboard) | M | ★★★ | Rounds out arrangement workflow |
| 6 | Sizing tool stretch modes | M | ★★★ | High-visibility tool parity |
| 7 | DOP framework + offline plugins | XL | ★★★★ | Flagship; needs 3 first |
| 8 | MIDI Modifiers (tier 1) | M | ★★★ | Playback-time infra; tier-2 inserts deferred |
| 9 | Logical Editor | L | ★★★ | Power users + agent synergy |

Backlog (deliberately out): Calculate Tempo from MIDI, groove quantize templates, quantize panel, drum/list editors, VariAudio-style pitch editing, warp markers, per-note expression, program-change model, selection-range (partial-event) processing, true clip grouping/parts container.
