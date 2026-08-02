# What's next

**This file is the single source of truth for what to work on next.** ROADMAP.md says what
the project is for and what each phase contains; this says what to pick up now. If the two
ever disagree, this one is wrong — fix it here rather than starting a third list somewhere.

Last updated: 2026-08-02 (later) — **MIDI note chase SHIPPED** (`TrackNode::scheduleNoteChaseRt`,
gate suite `midi-chase`, SPEC §7 "Chasing"). Found from a real user project: a Build-Up Riser
was inaudible because the whole technique is ONE held note and the in-block scheduler only ever
saw events at/after the playhead — so any playback start, locate or loop wrap inside a held note
played silence for its remaining length. The engine already chased CC state on exactly those
discontinuities; notes were the missing half. Same pass: technique landing bars (drop/land/at)
now follow the playhead and TRIM a lead-in that doesn't fit instead of silently moving the drop
later (`ops.landingBar`/`leadInRange`/`trimNote`, `placement.test.ts` pins every catalog default).

Earlier the same day — three in one: (1) the flaky `track-types` frequency
assertion (former QUEUED #1) FIXED — `freqOf` counted zero-crossings and read harmonics
as extra crossings; replaced with autocorrelation, ratio now exactly 2.000 across 7 runs,
windows tightened to 1.9–2.1; (2) **v1.1.0 RELEASED** to GitHub (shells + 55 techniques +
saturator) via the new `scripts/release.ps1`; (3) **MIDI hardware output SHIPPED** (the
long-standing NOW item) — `Track.midiOutDevice` → winmm via a lock-free ring + sender
thread, note-hygiene flush on stop/panic, gate suite "midi-out" (SPEC §5.5). Also new
since 08-01: switchable UI shells, the Production Techniques wizard (55 techniques,
backlog-driven), the stock Saturator.

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

## NOW — Single capture endpoint: fix or surface honestly

`App::desiredCaptureDeviceId()` (App.cpp:535) opens ONE endpoint — the first
armed/monitoring audio track's — and hands the same buffer to every armed node. A second
armed track with a different input silently records the first one's audio. Real fix =
multi-endpoint capture (sizeable); honest v1 = warn in the UI when two armed tracks name
different devices (SPEC §10). Must land before anyone else multi-tracks a live source —
and v1.1.0 is on GitHub Releases, so "someone else" is one download away.

(Promoted 2026-08-02: MIDI hardware output — the previous NOW — shipped; SPEC §5.5,
STUBS. The model shape landed exactly as sketched here: `Track.midiOutDevice` mirroring
`inputDevice`, tapped where `midiOutChannel` re-stamps what a track ORIGINATES, with a
new non-RT sender thread fed by a lock-free ring.)

## QUEUED

### 1. Engine suites flake when the gate runs under I/O load (3× on 2026-08-02)

Pattern nailed down over three occurrences: `stock-sampler` twice and `track-types`
once (post-estimator-fix, so NOT measurement) failed ONLY inside gate runs that took
230 s+ instead of the normal ~113 s — and each slow run coincided with concurrent
repo writes (ui build → Dropbox sync churn) from the working session. Every suite
passes 5/5 standalone. So: load-starved harness timing, not suite bugs.

Working rule until fixed: never write to the repo while a gate runs. Real fix
candidates: gate marks build/ AND the repo tmp paths Dropbox-ignored during runs,
or per-suite retry-once-on-slow-run, or engine-boot/render timeout headroom scaled
by a load probe. Diagnose from a captured slow-run log; don't lengthen timeouts
blindly.

---

## ONGOING — not blocked, just not next

- **Production Techniques**: 55 guided wizards shipped 2026-08-01/02 (11 per category —
  Project ▸ Production Techniques… / Alt+T). Growing further is Omer-paced via
  docs/PRODUCTION_TECHNIQUES_BACKLOG.md (per-category queues + the primitive-gaps table;
  the stock-saturator gap is CLOSED, M/S・de-esser・multiband lead the remainder).

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
