# What's next

**This file is the single source of truth for what to work on next.** ROADMAP.md says what
the project is for and what each phase contains; this says what to pick up now. If the two
ever disagree, this one is wrong — fix it here rather than starting a third list somewhere.

Last updated: 2026-07-31.

---

## NOW — Phase 3 · input gain + input metering

**Blocked on one decision, and that decision belongs in SPEC before any code.**

Per-track input gain applied PRE-INSERT, plus an input meter that is live while a track is
armed (distinct from the existing output meter).

The judgement call: **is the recorded FILE raw, or is the gain baked in?**

- Raw (recommended) means the input meter shows a level the written WAV does not have.
- Baked means a mis-set trim permanently destroys a take.

Either is defensible; leaving it implicit is not. Write one sentence in SPEC §5.5 and a
tooltip, then build.

What already exists, so do not rebuild it: input DEVICE and CHANNEL selection is complete
end to end — model fields (`Model.h:490-491`), `cmd/track.set`, persistence, agent exposure,
and two UIs (mixer `InputSelect`, Inspector selects). Capture opens on arm-or-monitor via
`App::reconcileCaptureDevice`.

Three traps recorded during the subsystem survey:

- `desiredCaptureDeviceId()` opens ONE endpoint — the first armed/monitoring audio track's —
  and hands the same capture buffer to every node. A second armed track with a different
  input silently records the first one's audio.
- The metering branch must NOT set `liveAudioActive` (`TrackNode.cpp:621`), which gates the
  PDC delay line. Setting it drops every armed track out of plugin-delay compensation — an
  audible, hard-to-attribute timing bug.
- `ParamRef::Kind` has no input-gain kind, so `inputGain` is not automatable and
  `automation.set` will reject `track:<id>:inputGain`. Fine for v1, but do not half-add it
  to the lane picker.

Testable headlessly today: `--null-input N` gives a position-recoverable capture signal
(SPEC §11), so a gain change is verifiable as an exact amplitude ratio.

---

## QUEUED

### 1. Clean the test residue out of the developer profile

`%APPDATA%\MyDAW\media` holds **~1.6 GB across ~910 files** — render, bounce and DOP output
that harnesses wrote there over the project's life (940 MB of it on 2026-07-31 alone).

Harness isolation stops it GROWING (the engine derives its fallback media dir from the
profile, so a redirected APPDATA redirects that too). The existing pile is still there.

**Do not bulk-delete the folder.** `fallbackMediaDir()` is also where a never-saved session's
audio lives — a `.cpr` import that has not been saved yet has its assets there. Match test
patterns (`sine440*`, `bounce-*`, `clip-*`, `rec-*`) and show the list before deleting.

Also still present from the 2026-07-31 incident: autosave slots in `%APPDATA%\MyDAW\autosave`
holding a recovered test fixture, and `mydaw-*` directories in `%TEMP%`.

### 2. Fix the `track-types` flaky assertion

`scripts/track-types-test.mjs:133` asserts a transposed note doubles in frequency with
`ratio > 1.8 && ratio < 2.2`. Measured across four consecutive runs: **2.216, 2.148, 2.107,
2.098** — the estimator reads ~5% high, so the window is centred on 2.0 while the data
clusters at ~2.12, leaving 0.08 of headroom above and 0.32 below. It reddens the gate at
random.

Fix the ESTIMATOR (`freqOf` resolves the upper note poorly) rather than widening the window
to hide it. A gate that cries wolf is the failure mode the gate exists to prevent — this is
currently the only thing in the suite that lies.

---

## ONGOING — Phase 3, the rest

Not blocked, just not next. In rough order of value per effort:

- **Stem export.** Much smaller than ROADMAP implies: the per-track tap already exists as
  data (`TrackNode::workL_/workR_`, filled at `TrackNode.cpp:685-686` before the accumulate),
  and the sidechain tap is a working precedent for exposing a node-internal buffer. Two
  accessors short. Prefer single-pass multi-sink; cap concurrent encoders.
- **Undoable `media/import` + tempo prompt.** `SmfReader` already parses FULL tempo and
  timesig maps (not just a bpm) — only a `hasTempoMeta` flag is missing. Route the import
  through a command like `internal/recording.commit` to make it one undo entry.
- **Take lanes drawn inline in the arrangement.** Audio and MIDI both stack laps into take
  folders now, but the comp is only editable in the Inspector, so a MIDI loop-record looks
  like an empty track in the timeline (arguably a SPEC §10 problem already).

Done in Phase 3 and NOT to be redone: punch in/out, the segment ledger, MIDI lap-splitting,
and the punch UI. See ROADMAP.md Phase 3 for the reasoning behind each.

---

## Standing invariants

- `node scripts/gate.mjs` green before every commit; `--full` before a merge or release.
- Never let a harness spawn an engine without redirecting `APPDATA` — enforced by
  `scripts/harness-isolation-test.mjs`, which runs first in the gate and needs no engine.
- Every check must be able to FAIL. A check that cannot distinguish the bug from correct
  behaviour reads as coverage while providing none.
