# MyDAW — Project Assessment · 2026-08-01

A dated snapshot of where the project stands, written at the close of the July 2026
hardening cycles (UI bug sweeps, test-infrastructure investment, Phase 3 recording work).

**This is an assessment, not a plan.** [NEXT.md](NEXT.md) remains the single source of truth
for what to pick up; [ROADMAP.md](ROADMAP.md) is the phase map; [STUBS.md](STUBS.md) is the
deferred-feature ledger. If anything here contradicts those, those win. This document records
the *judgement* behind the priorities so it doesn't have to be re-derived — or re-litigated —
later.

---

## 1. Executive summary

**The feature surface is now deeper than the product shell around it.** For editing, mixing
and offline processing, MyDAW covers what most people use a commercial DAW for — all nine
Cubase-13 parity swipes shipped (including the XL-rated DOP framework with VST plugins as
offline processes), and phases 1, 2 and 6 are complete. What remains clusters into four
themes, and they are a different *kind* of work from the feature-building of June–July:
finishing recording depth, hardware I/O completeness, robustness at scale, and — the one
that shouldn't still be open — distribution.

## 2. What is done

| Area | State |
|---|---|
| **Phase 1 — Musical core** | ✅ 2026-06-11. CC/PB end-to-end, tempo/timesig maps, SMF export, piano roll with CC lanes. |
| **Phase 2 — Timeline & editors** | ✅ 2026-06-12. Automation lanes, audio clip editor, track duplicate, multi plugin windows. |
| **Phase 3 — Recording & media** | 🔨 ~70%. Punch in/out, segment-ledger loop-record (audio **and** MIDI lap-splitting), MP3/FLAC/M4A export all done. Remaining: input gain/metering, stem export, undoable import + tempo prompt, take lanes inline. |
| **Phase 6 — Time-stretch** | ✅ Spectral (signalsmith) + WSOLA, stretch-on-resize tool modes, pitch shift dialog. |
| **Cubase-13 parity plan** | ✅ 9/9 swipes shipped 2026-07-28/29 — MIDI functions, fades/crossfades/envelopes, process dialogs, render-in-place/sampler track, clip-level MIDI ops, sizing modes, **DOP framework incl. VST offline + async recompute**, MIDI modifiers, Logical Editor. |
| **Mixing infrastructure** | ✅ Stock effects + synth + sampler, sidechain (built-in comp), VCAs, MIDI learn, BS.1770 loudness-targeted export, per-track EQ. |
| **Plugin hosting** | ✅ VST2/VST3 out-of-process (32+64-bit bridge), shell plugins (Waves), registry-overlay sandbox, plugin manager, insert DnD with Cubase semantics. |
| **Interchange** | ✅ .cpr import (mixer/EQ/pan/routing/plugin state) **and** export round-trip (60/60 corpus), SMF both directions, Track Archive XML. |
| **Track types** | ✅ Marker/arranger/chord/transpose tracks, arranger transport, track versions, folder/Group/FX/VCA promotion on import. |
| **Agent & remote** | ✅ Agent catalog (131 engine ops / 145 total), embedded MCP server, in-app agent runtime + panel. |
| **UI platform** | ✅ Themes, command palette, split dock, layout presets, sheet-music pane with print/MusicXML, minimap, visualizer, multi-window (process-per-window). |
| **Test infrastructure** | ✅ `scripts/gate.mjs` (23 fast / 27 full suites), browser smoke rig, harness APPDATA isolation **enforced by a static guard** after the 2026-07-31 profile-damage incident, `--null-input` position-recoverable capture signal. |

## 3. Gap analysis — the four themes

### 3.1 Recording is deep but narrow

The Phase 3 remainder is small but load-bearing:

- **Input gain + input metering** — was blocked on one sentence in SPEC §5.5 (raw file vs
  gain-baked). Being resolved as part of the Phase 3 close-out that starts today.
- **Single capture endpoint** — `desiredCaptureDeviceId()` opens *one* endpoint and hands the
  same buffer to every armed node. Arm two tracks with different inputs and the second
  silently records the first's audio. Not a missing feature — a correctness trap inside a
  shipped one. Must be fixed (or at minimum honestly surfaced in the UI) before anyone
  multi-tracks a live source.
- **Take folders are invisible in the arrangement** — MIDI loop-record produces a take folder
  the timeline draws as an empty track; the comp is Inspector-only. We built lap-splitting
  and then hid its output (arguably already a SPEC §10 honesty violation).
- **Stem export** and **undoable `media/import` + tempo prompt** — both smaller than they
  look; the taps and parsers already exist.

### 3.2 Hardware I/O completeness

- **No MIDI hardware output at all.** MyDAW cannot drive an external synth or act as a
  sequencer for outboard gear. To an outside musician this is the single most conspicuous
  absence in the whole product.
- **Multichannel (>stereo)** — schema and plugin IPC already allow 8ch; the graph mixes
  stereo. Blocks surround work and multi-out instruments.
- **ASIO** — deliberately deprioritized 2026-07-31: exclusive-mode WASAPI solved the observed
  MIDI-to-audio latency on the resident interface (NI Audio Kontrol 1). ASIO's remaining
  value here is multi-client convenience (system audio alongside the DAW) and interfaces with
  poor WASAPI drivers — a completeness feature, not a fix. The 86-line honest stub stands.
- **Native plugin-UI streaming to browser** — design only; matters only for remote use.

### 3.3 Scale and robustness — everything works, at demo size

- Piano roll rebuilds and scans the **full note array every frame**; 300k-note Logic imports
  exist. The arrangement got a summary-band cap; the editor didn't.
- Automation point drags rebuild the entire render plan per coalesced message.
- **Zero engine-level unit tests** — every check is protocol-level. Great for contracts;
  means core DSP/model invariants are only ever tested through the WS surface (no CTest
  target, ROADMAP Phase 5).
- Sample-accurate live MIDI: live input lands at block offset 0 (≤1.3 ms jitter at a 64-frame
  buffer). The QPC timestamps needed to fix it are already captured for recording.
- `RecoveryDialog.recover()` sets the project without bumping `store.revision` (stale-merge
  hazard, ROADMAP backlog).

None of these bite in a 10-track session; all of them bite in a real project.

### 3.4 Distribution — the gap that shouldn't exist

Publication prep was *done* (GPLv3 committed, personal files scrubbed, licensing posture
verified, clean-room VST2 headers) — the intent is clearly for MyDAW to leave this machine.
Yet packaging (portable zip, Inno Setup, single-exe) has been a TODO since June, and Phase 5
is the only phase with essentially nothing started. **Today MyDAW cannot be installed by
anyone who can't build it.** Every parity swipe raised the ceiling; packaging is what lets
anyone else stand under it.

## 4. Two identities, two orderings

The correct priority order depends on what MyDAW is optimizing for, and the answer changes
the top of NEXT.md:

- **An instrument for its author** → finish Phase 3, take lanes inline, then MIDI hardware
  output. (Fixes the things actually hit while recording here.)
- **A product for others** → packaging + first-run experience jumps the queue, and the
  multi-input capture trap must be fixed before anyone else records with it.

**Decision 2026-08-01:** finish Phase 3 first (work starting today: input gain/metering with
the SPEC §5.5 decision, stem export, undoable import + tempo prompt, take lanes inline).
The identity question gets asked again at the NEXT.md refresh that follows — with
distribution as the standing candidate if the answer is "product".

## 5. Housekeeping ledger (as of writing)

- `main` is **11 commits ahead of origin, unpushed** (the Phase 3 recording merge).
- `feat/phase3-recording` is merged and deletable.
- ~1.6 GB of pre-isolation test residue in `%APPDATA%\MyDAW\media` — queued in NEXT.md;
  pattern-match and list before deleting, never bulk-delete (fallback media dir also holds
  never-saved session audio).
- `track-types-test.mjs` frequency estimator reads ~5% high → flaky gate assertion (the only
  thing in the suite that lies). Queued.
- `scripts/rebuild.ps1` kills running engines it did not start (killed a live session once,
  2026-07-31). Known, deliberately left for a decision.

## 6. Standing invariants (unchanged, restated for completeness)

- `node scripts/gate.mjs` green before every commit; `--full` before a merge or release.
- No engine spawn without a redirected APPDATA (enforced by `harness-isolation-test.mjs`).
- Every check must be able to fail; no fake UI — unfinished features stay invisible or
  visibly disabled with the reason.
