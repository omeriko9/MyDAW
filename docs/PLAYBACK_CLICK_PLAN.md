# Pickup: the playback click when selecting a track (2026-08-15)

**Symptom (Omer).** During playback, clicking a different track makes a short
clipping-like noise. A UI action must never make a sound.

**Cause (confirmed by reading the path, not guessed).** Track selection sends
`midi/setThruTracks`; live-MIDI thru is *baked into the graph plan*
(`AudioGraph::buildPlan` sets `cfg.liveMidi = midiThru.count(t.id) || t.monitor`),
so `App::setMidiThruTracks` ends with `requestGraphRebuild()`. Rebuilding the graph
mid-playback is the artifact.

## Attempt 1 — reverted (do not repeat verbatim)

Flip the flag on the already-running nodes instead of rebuilding:

- `TrackNode`: `std::atomic<bool> liveMidi_` + `setLiveMidiRt()`, seeded from
  `cfg_.liveMidi`; the RT read at `TrackNode.cpp` (`cfg_.liveMidi || isNoteOff…`)
  reads the atomic instead.
- `Config::monitorLive` remembers the MONITOR half, so a selection change cannot
  switch off thru for a monitored track.
- `AudioGraph::setMidiThruTracks` walks the published plan and sets the flag.
- `App::setMidiThruTracks` drops `requestGraphRebuild()`.

Result: **0 rebuilds while clicking tracks during playback** (verified), but
`scripts/midi-lap-test.mjs` failed — laps held notes that were never played in them.
Reverted rather than shipped half-right.

**Why it probably failed.** The walk paired `plan->typed[i]` with
`plan->base.entries[i].trackId` **by index**. Those arrays include synthesised
entries (rack instruments per SPEC §5.9, feeders ordered before their targets), so
the indices need not line up — the flag then lands on the wrong node, which is
exactly how a recording lap ends up with foreign notes.

## Next attempt (recommended order)

1. **Resolve by id, not by index.** Use the plan's existing `trackLookup`
   (`lookupById(plan->trackLookup, id)`) instead of index pairing, and **clear the
   flag on every node first** so a deselected track really loses thru. Then re-run
   `node scripts/midi-lap-test.mjs` — it fails in seconds when this is wrong — plus
   the record/punch suites, before anything else.
2. **Fallback if thru still misbehaves: defer instead of rebuild.** Send the thru
   set only while the transport is stopped (coalesce and apply on stop). Live thru
   following selection a beat late is far cheaper than a click mid-playback. Small
   change, store-side (`ui/src/store/store.ts`, the selection → `midi/setThruTracks`
   effect).
3. **The general cure (own piece of work): make ANY rebuild inaudible.** Every
   mid-playback rebuild clicks — adding a plugin does too. Fresh `TrackNode`s start
   with reset gain smoothers/filter state instead of adopting the outgoing plan's
   (buildPlan already adopts *some* state by trackId — see the "look up the SAME
   trackId's node in the currently-published (old) plan" comment in AudioGraph.cpp).
   Carrying the rest across the swap removes the whole class of artifact.

## Verification bar

- `node scripts/midi-lap-test.mjs` (the regression that caught attempt 1)
- `node scripts/gate.mjs` — 36/36
- Audible check by hand: play, click between tracks, listen. The engine logs no
  rebuild for a selection change once this is right.
