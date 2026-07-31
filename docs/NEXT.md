# What's next

**This file is the single source of truth for what to work on next.** ROADMAP.md says what
the project is for and what each phase contains; this says what to pick up now. If the two
ever disagree, this one is wrong — fix it here rather than starting a third list somewhere.

Last updated: 2026-08-01 — **Phase 3 (Recording & media) is COMPLETE**: input gain/metering
(file stays raw, SPEC §5.5), stem export (single-pass multi-sink), undoable `media/import` +
tempo prompt (`media/probe`), and inline take lanes all shipped today. See ROADMAP Phase 3
for what was built and why; nothing there is to be redone.

---

## NOW — clean the test residue out of the developer profile

`%APPDATA%\MyDAW\media` holds **~1.6 GB across ~910 files** — render, bounce and DOP output
that harnesses wrote there before APPDATA isolation (940 MB of it on 2026-07-31 alone).
Isolation stops it growing; the pile is still there.

**Do not bulk-delete the folder.** `fallbackMediaDir()` is also where a never-saved session's
audio lives — a `.cpr` import that has not been saved yet has its assets there. Match test
patterns (`sine440*`, `bounce-*`, `clip-*`, `rec-*`) and show the list before deleting.

Also still present from the 2026-07-31 incident: autosave slots in `%APPDATA%\MyDAW\autosave`
holding a recovered test fixture, and `mydaw-*` directories in `%TEMP%`.

---

## DECISION PENDING (Omer) — what MyDAW is optimizing for

Recorded in [ASSESSMENT_2026-08-01.md](ASSESSMENT_2026-08-01.md) §4: the next big arc
depends on whether MyDAW is primarily **an instrument for its author** (→ MIDI hardware
output next, then scale/robustness) or **a product for others** (→ packaging/installer +
first-run experience jumps the queue, and the multi-input capture trap below becomes a
blocker). Ask before starting either arc.

## QUEUED

### 1. Fix the `track-types` flaky assertion

`scripts/track-types-test.mjs:133` asserts a transposed note doubles in frequency with
`ratio > 1.8 && ratio < 2.2`. Measured across four consecutive runs: **2.216, 2.148, 2.107,
2.098** — the estimator reads ~5% high, so the window is centred on 2.0 while the data
clusters at ~2.12. It reddens the gate at random.

Fix the ESTIMATOR (`freqOf` resolves the upper note poorly) rather than widening the window
to hide it. A gate that cries wolf is the failure mode the gate exists to prevent — this is
currently the only thing in the suite that lies.

### 2. Single capture endpoint: fix or surface honestly

`App::desiredCaptureDeviceId()` (App.cpp:535) opens ONE endpoint — the first
armed/monitoring audio track's — and hands the same buffer to every armed node. A second
armed track with a different input silently records the first one's audio. Real fix =
multi-endpoint capture (sizeable); honest v1 = warn in the UI when two armed tracks name
different devices (SPEC §10). Must land before anyone else multi-tracks a live source.

---

## ONGOING — not blocked, just not next

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
