# What's next

**This file is the single source of truth for what to work on next.** ROADMAP.md says what
the project is for and what each phase contains; this says what to pick up now. If the two
ever disagree, this one is wrong — fix it here rather than starting a third list somewhere.

Last updated: 2026-08-07 (evening) — **MULTI-ENDPOINT CAPTURE SHIPPED.** Omer hit the
single-endpoint wall the same day it was surfaced (Rode on default + condenser on the
Audio Kontrol 1: the warning fired — with a raw GUID in it — and the second mic was
unreachable). The honest-v1 warning became the real fix within the day: one WASAPI
capture session per distinct armed device (`WasapiDriver` CaptureSession refactor),
per-device channel bases through `AudioGraph`/`AudioRecorder`, unavailable devices →
SILENCE + `captureState {devices, unavailable, error?}` (chip/toast now resolve device
ids to friendly names — the GUID toast is dead). Two-device routing proven headlessly:
the null driver grew a second synthetic device ("null-b", negated ramp) and
`record-capture-test.mjs` records BOTH at once and asserts each file carries its own
device's ramp. ui-drive slots run `--null-input 2` now (an armed track with no openable
device honestly trips the chip otherwise). Remaining known limit: per-device clock
drift is zero-fill/drop (STUBS.md has the resampler pickup).

Earlier the same day: **both open fix items SHIPPED**, clearing the deck for the
Production Techniques arc (Omer: "first fix what needs fixin', then the prod techniques").

1. **Capture honesty (the former NOW)**: the engine now reports
   `captureState {deviceId, conflicts:[{trackId,device}], error?}` in `session/hello` and as
   `event/captureState` on change (SPEC §5.5); the UI shows a persistent TransportBar chip +
   one-shot toast when an armed track would record the WRONG input, or none at all
   (`ui/src/lib/captureConflict.ts`). While in there, three engine gaps got real fixes:
   capture reconcile is now CENTRAL (`CommandProcessor::execute` after every mutating
   command + `syncEngineFromModel` for load/undo/redo) — before, removing/duplicating an
   armed track or undoing an arm left the capture stream (and now the report) stale; a
   capture-open FAILURE is surfaced (`error`) instead of being log-only; and a missing-brace
   bug in `syncEngineFromModel` ran `setPunchBeats` outside its `if (ctx_.transport)` guard.
   Tests: 4 new checks in `record-capture-test.mjs` (incl. the undo path), ui-smoke
   `capture-conflict-chip`, vitest `captureConflict.test.ts`. Multi-endpoint capture stays
   deferred (STUBS.md has the pickup plan).

2. **Gate flake under I/O load (the former QUEUED #1)**: root cause was Dropbox re-syncing
   rebuildable artifacts mid-run. The gate now marks `build/`, `build32/`, `out/`,
   `ui/dist/`, `ui/node_modules/` with Dropbox's documented per-item ignore
   (`<dir>:com.dropbox.ignored` NTFS stream — `markDropboxIgnored()` in `scripts/gate.mjs`;
   idempotent, permanent by design, all five verified untracked). This also kills the
   ui/dist emptyDir failures and the LNK1104-on-running-exe class. The "never write to the
   repo while a gate runs" rule is RETIRED unless the flake reappears — if it does, capture
   the slow-run log before touching timeouts.

Earlier (2026-08-02): **MIDI note chase SHIPPED** (`TrackNode::scheduleNoteChaseRt`,
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

## NOW — Techniques REDIRECT (Omer, 2026-08-07): make it help him, don't grow it

Omer's verdict on the 61-card catalog: it doesn't help him — the 2-step techniques he
can do by hand, and the jargon-named cards mean nothing to someone who doesn't already
know the techniques ("unknown what should be used at what stage, even with the
categories"). Direction decided with him (in order):

1. **A/B audition — SHIPPED 2026-08-07**: With/Without toggle on every wizard run
   (undo×N / redo×N, exact-state symmetric; stage actions lock while in Without; any
   exit auto-restores). ui-smoke `technique-audition-ab` guards it, including the
   close-mid-Without leg. Plan doc §0 has the mechanism.
2. **Production Guide — SHIPPED 2026-08-07 (later)**: the dialog now LANDS on a
   stage-of-work guide (`techniques/guide.ts` + `GuideView.tsx`) — 6 stages, 22
   plain-language goals, each with why/what-you'll-hear, techniques as
   means-to-a-goal, and project-aware `relevance(ctx)` grounded in the actual song
   ("“Kick” and “Bass 808” found, no sidechain anywhere" → Suggested). Honesty
   rules in the module header. Guards: `guide.test.ts` + ui-smoke
   `technique-guide-landing`. **Omer's reaction to the goal set and the relevance
   rules is the next input** — which suggestions feel right on a real project
   shapes rounds 2 of the rules.
3. **NEXT UP: outcome-level flows become the primary catalog** (Macros shape);
   2-steppers demote to building blocks inside them + search results. The guide's
   goals suggest the outcomes to build first.

Classic-category growth stays PARKED
(docs/PRODUCTION_TECHNIQUES_PLAN.md §0; backlog queues stay but don't extend them).

## DONE — Omer's 2026-08-07 bug list is CLEARED (13/13)

Commits `2c55809` (UI batch), `7632ed9` (host perf), `31ebfe5` (Cubase instrument
tracks), `b48117e` (audio-track dialog + live waveform), `02936b3` (Omer's own
Vst2Host DLL-search fix). The queue below is what's left AFTER that list.

## QUEUED — next up

### 1. Omer re-tests Kontakt 8 / Addictive Drums 2 on the perf fixes (`7632ed9`)
Five root causes fixed (host `timeBeginPeriod`, Win11 EcoQoS opt-out, message-only pump
window so control traffic survives plugin modal loops, suspend/resume around setState +
120 s chunk capture, install.reg-only capture-bundle discovery + miss-diagnostics off).
IF STILL SLOW: the engine log's per-instance `captureOverlay` line is the first check
(`files:true` = a bundle is still arming for that plugin). Then: coalesce
`event/pluginParams` (one WS frame per param change today) and move the periodic
getState captures off the host GUI thread.

### 2. Omer's reaction to the Production Guide's goals + relevance rules
Which suggestions feel right on a real project drives round 2 of the rules, and the
guide's goals name the outcome-level flows worth building (step 3 of the techniques
redirect: outcome flows become the primary catalog, 2-steppers demote to building
blocks inside them).

### 3. Rack ⇄ Cubase-instrument-track follow-ups
Now that MIDI tracks convert in place (`31ebfe5`), the Instrument Rack's remaining job
is SHARED/multitimbral hosts. Worth doing when it bites: list converted instrument
tracks in the rack too (read-only rows), and offer "extract to shared host" for a track
several MIDI parts should drive.

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
