# Versions refactor (2026-08-11)

Omer's brief, verbatim in intent: **one** versions feature, not two; the weaker "Track
Versions" goes; everything is driven by clicking clips and a mute tool instead of context-menu
homework.

This replaces the comp-segment model with a **mute model**. That is the whole point — every
"which take plays" question becomes "which clips are unmuted", so one mechanism (clip mute)
answers it for versions, for combinations across versions, and for ordinary clips.

## Target model

```
Track
  keepTakes: bool          <- PER-TRACK record mode (was transport-global)
  clips[]                  <- normal material
  takeFolders[]
    lanes[]                <- sub-rows; each holds ordinary Clips
```

- `TrackVersion` / `Track::versions` / `activeVersionId` — **deleted**.
- `TakeFolder::comp` — **deleted**. Audibility is per-clip `muted`, nothing else.
- `TakeLane::playAlong` — **deleted**, subsumed by clip mute.
- `Model::clipById` walks `Track::clips` **and every lane** → lane clips become first-class:
  selectable, movable, deletable, processable, exactly like any other clip.
- Playback (`AudioGraph::buildPlan`): every **unmuted** clip sounds, in lanes and out. No
  segment selection anywhere.

## Requirements → changes

**R1 — remove Track Versions.** Model/Serialize/CprWriter skip-counting, `cmd/version.*`,
`versionMenuItems`, the header version chip, catalog entries, `switchTrackVersion` &co.

**R2 — Keep Takes is per-track.** `Track::keepTakes` set via `cmd/track.set {keepTakes}`,
mirroring the `automationWrite` "W" precedent. The freed header button slot (where the version
chip was) becomes the per-track versions toggle. `transport/setKeepTakes`, `Transport::keepTakes_`,
`Settings::recordKeepTakes` and the TransportBar toggle are **removed**. `recordingCommit` reads
the flag off each armed track, not off the payload.

**R3 — click a clip to choose that version.** `cmd/take.pick {trackId, clipId}` — unmutes that
clip and mutes every clip overlapping it in the same folder, in ONE undo entry. Plain left-click
on a lane clip with the select tool fires it.

**R4 — "X" mute tool.** `Tool` gains `"mute"`; TransportBar gains the button beside
arrow/pencil/eraser/scissors. Clicking ANY clip anywhere toggles its `muted` — including several
clips across several lanes, which is how combinations are built.
NOTE: the `X` **key** stays Crossfade; the new tool takes the next free digit. Flag to Omer.

**R5 — marquee selects lane clips.** `computeMarquee` currently skips non-`track` rows; it must
include `takelane` rows. Everything downstream (delete, process, multi-drag) then works because
of the `clipById` change.

**R6 — track selection stops evaporating.** Clicking empty canvas or a clip must NOT clear the
track selection. Only an empty click in the **track list** (headers) clears it, or Esc.

**Dropped with the comp array:** swipe-comping and `cmd/take.setComp`/`flatten`'s comp walk.
Flatten keeps working off mutes. Swipe-comp could return later as a mute-painting drag — call
it out, do not silently keep a dead code path.

## Phases (each ends gate-green + committed)

1. R1 removal (engine + UI + catalog).
2. R2 per-track keepTakes.
3. R3+comp removal: mute-based playback, `take.pick`, flatten off mutes.
4. R4 mute tool.
5. R5 lane clips addressable + marquee.
6. R6 selection stickiness.

Catalog bookkeeping every time an op is added/removed: `capabilities.json` →
`node scripts/generate-agent-catalog.mjs` → counts in `scripts/generate-agent-catalog.mjs`
AND `ui/src/agent/catalog.test.ts` (two asserts) + REQUEST_TYPES in RequestMap order.

Tests that WILL need rewriting, not deleting: `comping-test.mjs` (comp → mutes),
`takes-record-test.mjs` (per-track flag), ui-smoke `take-lanes-inline-comp` (swipe gone),
`stack-as-versions-from-clip-menu`, any `version.*` coverage.
