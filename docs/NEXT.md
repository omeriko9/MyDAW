# What's next

**This file is the single source of truth for what to work on next.** ROADMAP.md says what
the project is for and what each phase contains; this says what to pick up now. If the two
ever disagree, this one is wrong — fix it here rather than starting a third list somewhere.

Last updated: 2026-08-02 — the flaky `track-types` frequency assertion (former QUEUED #1)
is FIXED: `freqOf` counted zero-crossings and read harmonics as extra crossings (a 440 Hz
saw counted ~578); replaced with autocorrelation — the ratio now measures exactly 2.000
across 7 consecutive runs, and the windows tightened to 1.9–2.1. Also new since 08-01:
switchable UI shells, the Production Techniques wizard (55 techniques, backlog-driven),
the stock Saturator, and `scripts/release.ps1` (one-command GitHub release).

2026-08-01 state: **Phase 3 (Recording & media) is COMPLETE** — input gain/metering
(file stays raw, SPEC §5.5), stem export (single-pass multi-sink), undoable `media/import` +
tempo prompt (`media/probe`), inline take lanes. See ROADMAP Phase 3; nothing there is to be
redone. Profile cleanup DONE: 1.83 GB reclaimed — `%APPDATA%\MyDAW` went 1.85 GB → 49 MB,
plus 727 `mydaw-*` dirs (184 MB) out of `%TEMP%`. Only provably harness-generated files were
removed (every deleted prefix traced to a script in the repo); 11 media files of unproven
origin were KEPT, including a real recording `la da da da.wav`. Manifest:
`~\mydaw-cleanup-deleted-2026-08-01.txt`.

---

## DECIDED (Omer, 2026-08-01) — MyDAW is an INSTRUMENT for its author, not a product yet

…with one amendment from the same day: Omer asked for a **1-click portable exe** so
non-technical users can run it — shipped as `MyDAW-Portable-1.0.0.exe` in GitHub Releases
(`scripts/package-portable.ps1`; ROADMAP Phase 5 has the details). That is distribution
*plumbing*, not productization: no installer, no signing, no first-run onboarding — those
stay parked until the identity answer changes. The ordering otherwise stands: fix what gets
hit while *playing* — the flaky gate assertion, then MIDI hardware output, then the
scale/robustness items. The multi-input capture trap below becomes a blocker the moment
someone else records with it — and "someone else" now has an exe they can download.

## NOW — MIDI hardware output (ROADMAP Phase 5)

The most conspicuous absence for an instrument: MyDAW cannot drive an external synth or act
as a sequencer for outboard gear. `midiOutOpen` sibling of `MidiInput` (winmm) + a per-track
MIDI-output routing field. See STUBS "MIDI hardware output".

Start by deciding the model shape (a `Track.midiOutDevice` mirroring `inputDevice`, applied
where `midiOutChannel` already re-stamps what a track ORIGINATES) and whether output events
ride the existing bake path or a new non-RT sender thread.

## QUEUED

### 1. Single capture endpoint: fix or surface honestly

`App::desiredCaptureDeviceId()` (App.cpp:535) opens ONE endpoint — the first
armed/monitoring audio track's — and hands the same buffer to every armed node. A second
armed track with a different input silently records the first one's audio. Real fix =
multi-endpoint capture (sizeable); honest v1 = warn in the UI when two armed tracks name
different devices (SPEC §10). Must land before anyone else multi-tracks a live source.

---

## ONGOING — not blocked, just not next

- **Production Techniques**: 40 guided wizards shipped 2026-08-01 (v1 + the 30-technique
  batch; 8 per category — Project ▸ Production Techniques… / Alt+T). Growing further is
  Omer-paced via docs/PRODUCTION_TECHNIQUES_BACKLOG.md (per-category queues + the
  primitive-gaps table that motivates engine work like a stock saturator).

- **Sample-accurate live MIDI** (ROADMAP Phase 4): live input lands at block offset 0
  (`MidiInput.cpp:277`, ≤1.3 ms jitter at 64 frames); the QPC timestamps needed to place it
  are already captured for recording. The dominant remaining input-timing error now that
  exclusive-mode WASAPI removed the ~23 ms shared-mode offset (2026-07-31).
- **Automation touch/latch write modes** — needs a continuous per-block writer.
- **Take-lane polish**: quick-swap hotkeys; comp swipe snapping is deliberately unsnapped
  (matches the Inspector) — revisit if it feels loose.
- `rebuild.ps1` kills running engines it did not start (killed a live session once,
  2026-07-31) — known, deliberately left for Omer's call.

---

## Standing invariants

- `node scripts/gate.mjs` green before every commit; `--full` before a merge or release.
- Never let a harness spawn an engine without redirecting `APPDATA` — enforced by
  `scripts/harness-isolation-test.mjs`, which runs first in the gate and needs no engine.
- Every check must be able to FAIL. A check that cannot distinguish the bug from correct
  behaviour reads as coverage while providing none.
