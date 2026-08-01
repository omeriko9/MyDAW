# Production Techniques — backlog

The living queue. [PRODUCTION_TECHNIQUES_PLAN.md](PRODUCTION_TECHNIQUES_PLAN.md) says
what the feature is and how it grows; THIS file tracks what shipped per category and
what is queued next. When a technique ships: move its row to the shipped table, note
the date, and add any new primitive gaps discovered. Do not start a third list.

## Shipped

| Date | Category | Technique | id | Notes |
|---|---|---|---|---|
| 2026-08-01 | Transitions | Build-Up Riser | `riser-buildup` | polysynth noise+saw source, cutoff/volume ramps, optional verb-send ramp |
| 2026-08-01 | Transitions | Snare-Roll Accelerator | `snare-roll` | accelerating subdivisions + velocity ramp, one-undo note batch |
| 2026-08-01 | Mixing | Sidechain Pump | `sidechain-pump` | builtin compressor `sidechainSource`, release from tempo |
| 2026-08-01 | Mixing | Polished Vocal Reverb | `vocal-reverb-send` | EQ'd 100%-wet bus + send + keyed ducking |
| 2026-08-01 | Vocal | Stereo Doubler | `vocal-doubler` | track duplicates, pan/level/±12 ms nudge, HPF |
| 2026-08-01 | Vocal | Delay Throw | `delay-throw` | ping-pong bus at dotted-1/8, send-automation spike |
| 2026-08-01 | Editing | Vocal Chop Kit | `chop-sampler` | `cmd/clip.createSampler` + generated chop pattern |
| 2026-08-01 | Editing | Stutter Fill | `stutter-fill` | last-beat 1/16 repeats via split/delete/duplicate |
| 2026-08-01 | Bus/Master | Master Glue Chain | `master-glue` | 2:1 glue comp + −1 dB limiter + loudness pointer |
| 2026-08-01 | Bus/Master | Parallel Drum Crush | `parallel-crush` | smashed-comp bus, full sends, low blend fader |

## Queued — Transitions & arrangement FX

| Technique | Ingredients (all existing unless noted) | Size |
|---|---|---|
| Tape Stop | `cmd/clip.stretch` with `tape:true` on a split tail segment | S |
| Reverse-Reverb Swell | `renderTrackInPlace`/`bounceSelection` to print the verb, DOP `reverse`, place before the downbeat | M |
| Downlifter | riser inverted: pitch/cutoff falling after the drop | S |
| Impact + sub drop | needs a stock sub/impact source (sampler + bundled one-shot?) — GAP: no bundled sample content | M |
| White-noise sweep (one-shot) | polysynth noise + amp envelope + pan automation | S |
| Half-Time Drop | split section, `clip.stretch` ×2 semantics + arrangement shove — shove needs care | M |

## Queued — Mixing: space & dynamics

| Technique | Ingredients | Size |
|---|---|---|
| Telephone-EQ section | track EQ band automation — GAP: EQ params are not automatable paramRefs yet | M |
| Haas Widener | duplicate + hard pans + ~15 ms nudge (doubler variant, single source) | S |
| Ducking bed (VO over music) | sidechain comp, slow release preset — sidechain-pump variant | S |
| Mid/Side width by section | GAP: no M/S processing in Utility | M |
| De-esser chain | GAP: no stock de-esser (compressor lacks a detector HPF/band) | M |

## Queued — Vocal production

| Technique | Ingredients | Size |
|---|---|---|
| Slapback Echo | delay insert, ~90 ms / 1/16 from BPM, feedback ≤10 %, mix ~18 % | S |
| ADT (fake double) | duplicate + a few-cent `clip.stretch` transpose + jitter nudges | S |
| Comp-and-tighten helper | take lanes exist; wizard over comping = guidance stages mostly | M |
| Harmony stack | duplicates transposed +3/+5 st via stretch transpose, panned | S |

## Queued — Editing & sound design

| Technique | Ingredients | Size |
|---|---|---|
| Glitch Roll (ratcheting) | stutter-fill generalized: per-slice rate patterns | S |
| Reverse chop tails | DOP reverse on alternating slices | S |
| Chopped-and-pitched sequence | chop kit + chord-track-aware pitches (chord events exist) | M |
| Granular freeze pad | GAP: no granular engine | L |

## Queued — Bus, glue & master

| Technique | Ingredients | Size |
|---|---|---|
| Loudness-target master | export loudnessTarget exists; wizard = measure → adjust → re-measure loop | M |
| Mono-lows / width by band | GAP: no multiband utility (mono is full-band only) | M |
| Saturation stage | GAP: no stock saturator/distortion (also wanted by risers) | M |
| Stem-bus architecture starter | buses + routing + VCA groups — all existing | S |

## Primitive gaps (engine/UI work that unlocks queued rows)

| Gap | Unlocks | Notes |
|---|---|---|
| Stock saturator/distortion insert | Saturation stage, riser grit, crush color | most-wanted; `core/effects` pattern is settled |
| Tempo-sync toggle on Delay time | Slapback/throw without ms math | wizard computes ms today — works, just not tempo-tracking |
| EQ bands as automation targets | Telephone-EQ, filter sweeps without an insert | paramRef scheme extension + plan rebuild cost |
| Multiband utility (or M/S mode) | mono-lows, width-by-band | |
| Bundled sample content (one-shots) | impacts, sub drops | licensing question first |
| Stock de-esser (or comp detector filter) | de-esser chain | sidechain detector EQ would also serve |
| Wizard: non-modal / preview / agent op | all — UX depth | see plan §5 |
