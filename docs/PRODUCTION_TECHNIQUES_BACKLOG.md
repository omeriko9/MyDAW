# Production Techniques — backlog

The living queue. [PRODUCTION_TECHNIQUES_PLAN.md](PRODUCTION_TECHNIQUES_PLAN.md) says
what the feature is and how it grows; THIS file tracks what shipped per category and
what is queued next. When a technique ships: move its row to the shipped table, note
the date, and add any new primitive gaps discovered. Do not start a third list.

## Shipped — 40 techniques, 8 per category (v1: 2026-08-01 · batch 2: same day)

### Transitions & arrangement FX
| Technique | id | Notes |
|---|---|---|
| Build-Up Riser | `riser-buildup` | polysynth noise+saw, cutoff/gain ramps, verb-send ramp |
| Snare-Roll Accelerator | `snare-roll` | 1/8→1/16→1/32 + velocity climb, one-undo batch |
| Tape Stop | `tape-stop` | `clip.stretch` tape varispeed ×0.5 on the split tail |
| Reverse Build-In | `reverse-build` | duplicate → DOP reverse → place before, long fade-in |
| Downlifter | `downlifter` | riser inverted after the drop (falling cutoff/gain) |
| Noise Sweep | `noise-sweep` | pure noise, cutoff opens while PAN crosses −0.8→0.8 |
| Pre-Drop Silence | `predrop-silence` | slice around the gap + MUTE (auditionable), DROP marker |
| Impact Rumble | `impact-rumble` | sine+sub boom on the downbeat into a huge 100%-wet verb |

### Mixing — space & dynamics
| Technique | id | Notes |
|---|---|---|
| Sidechain Pump | `sidechain-pump` | comp keyed from kick, tempo-timed release, depth presets |
| Polished Vocal Reverb | `vocal-reverb-send` | EQ'd 100%-wet bus + send + vocal-keyed ducking |
| Haas Widener | `haas-widener` | duplicate, ±70% pans, 15 ms late; mono-safety stage |
| Telephone Section | `telephone-section` | clip → own track, 700–3.2k bandpass + 8:1 crunch |
| Ducking Bed | `ducking-bed` | VO auto-duck: slow attack/500 ms release, depth presets |
| Auto-Pan Motion | `auto-pan` | triangle pan lane at 1/8..1-bar rates + matching tremolo |
| Gated Reverb | `gated-reverb` | reverb → stock gate (full range, 120 ms hold) — the 80s snare |
| Vocal Presence Chain | `vocal-presence` | HPF+mud dip → 3:1 comp → +3 dB air shelf |

### Vocal production
| Technique | id | Notes |
|---|---|---|
| Stereo Doubler | `vocal-doubler` | 2 duplicates, ±60%, −4 dB, 10/22 ms, HPF |
| Delay Throw | `delay-throw` | ping-pong bus at dotted-1/8, send spike on the tail |
| Slapback Echo | `slapback` | delay INSERT 90 ms / 1/16, fb ≤10%, mix ~20% |
| Harmony Stack | `harmony-stack` | dup + pitch (audio: stretch transpose; MIDI: note edit) |
| Octave-Under Double | `octave-under` | −12 st copy, centered, −9 dB, HPF 120 |
| Ad-Lib Placement | `adlib-space` | pan aside −3 dB + own wet bus (delay→verb 100%) |
| Noise Gate Cleanup | `vocal-gate` | gentle gate: Range −18 dB, breath-safety timing stage |
| ADT — Fake Double | `adt-double` | +30 cents + 14 ms drift on a −5 dB copy (Abbey Road) |

### Editing & sound design
| Technique | id | Notes |
|---|---|---|
| Vocal Chop Kit | `chop-sampler` | `clip.createSampler` + chop pattern + tight envelope |
| Stutter Fill | `stutter-fill` | last beat → 4×1/16 of its first slice, fades + gain steps |
| Glitch Ratchet | `glitch-ratchet` | 1/8→1/16→1/32 repeats of one fragment, rising gain |
| Reverse Chop Tails | `reverse-chops` | beat-grid slices, every 2nd DOP-reversed, de-click fades |
| Humanize Groove | `humanize-groove` | off-beat 8ths late + ±4 ms drift; velocity re-accents |
| MIDI Note Echo | `midi-echo` | note copies at 1/8..1/4, 65%/40% (+25% tail tap) |
| Beat Shuffle Fill | `beat-shuffle` | last bar's beats reordered 4-3-2-1 |
| Chop Pitch Riser | `pitch-chop-riser` | sampler chops climb a scale on 8ths into the drop |

### Bus, glue & master
| Technique | id | Notes |
|---|---|---|
| Master Glue Chain | `master-glue` | 2:1 slow-attack glue + −1 dB limiter + loudness pointer |
| Parallel Drum Crush | `parallel-crush` | smashed-comp bus, full sends, −12 dB blend |
| Stem Bus Architecture | `stem-buses` | Drums/Bass/Music/Vocals buses + outputTarget routing |
| VCA Group Rider | `vca-groups` | cmd/vca.add + member assign + first ride |
| Headroom Reset | `headroom-reset` | all source faders ×lin(−3/−6/−9), master to unity |
| Drum Bus Glue | `drum-bus-glue` | route kit → bus, 4:1/10 ms/150 ms serial glue |
| Mono Compatibility Check | `mono-check` | Utility Mono on master (engage), then REMOVE (disengage) |
| Mix-Bus Pump | `mixbus-pump` | master comp keyed from kick — French-house pump, presets |

## Queued — Transitions & arrangement FX

| Technique | Ingredients (all existing unless noted) | Size |
|---|---|---|
| Reverse-REVERB Swell | print the verb tail (`renderTrackInPlace`/`bounceSelection`), DOP reverse — the wetter cousin of Reverse Build-In | M |
| Half-Time Drop | section split + `clip.stretch` ×2 + arrangement shove (the shove needs care) | M |
| Impact + sub drop one-shots | GAP: no bundled sample content (licensing first) | M |
| DJ backspin | reverse + accelerating varispeed — needs segmented tape stretch | M |

## Queued — Mixing: space & dynamics

| Technique | Ingredients | Size |
|---|---|---|
| Telephone-EQ by AUTOMATION | GAP: EQ bands are not automatable paramRefs (section-track workaround shipped) | M |
| Mid/Side width | GAP: no M/S processing in Utility | M |
| De-esser chain | GAP: no stock de-esser (comp lacks a detector filter) | M |
| Frequency-conscious slotting (EQ mirroring) | two-track EQ cut/boost pairs — easy, queue when wanted | S |

## Queued — Vocal production

| Technique | Ingredients | Size |
|---|---|---|
| Comp-and-tighten helper | take lanes exist; mostly guidance stages over comping | M |
| Formant-preserving shifts | GAP: spectral stretch shifts formants too (chipmunk at big intervals — noted honestly in Harmony Stack) | L |
| Whisper layer | needs a real recording — guidance-only candidate | S |

## Queued — Editing & sound design

| Technique | Ingredients | Size |
|---|---|---|
| Chord-aware chop pitches | chord events exist — pitch chop patterns from the chord track | M |
| Granular freeze pad | GAP: no granular engine | L |
| Arrangement A/B sections | arranger sections exist — "try the chorus twice" wizard | M |

## Queued — Bus, glue & master

| Technique | Ingredients | Size |
|---|---|---|
| Loudness-target ladder | export loudnessTarget exists; measure → adjust → re-measure loop | M |
| Mono-lows / width by band | GAP: no multiband utility | M |
| Saturation stage | GAP: no stock saturator/distortion (risers + crush want it too) | M |
| Master fade-out | GAP: master-track automation lanes have no timeline row to edit them in | S |

## Primitive gaps (engine/UI work that unlocks queued rows)

| Gap | Unlocks | Notes |
|---|---|---|
| Stock saturator/distortion insert | Saturation stage, riser grit, crush color | most-wanted; `core/effects` pattern is settled |
| Tempo-sync toggle on Delay time | slapback/throw that follow tempo changes | wizard computes ms today — works, just not tempo-tracking |
| EQ bands as automation targets | telephone-by-automation, filter sweeps sans insert | paramRef scheme extension + plan rebuild cost |
| Multiband utility (or M/S mode) | mono-lows, width-by-band | |
| Bundled sample content (one-shots) | impacts, sub drops | licensing question first |
| Stock de-esser (or comp detector filter) | de-esser chain | sidechain detector EQ would also serve |
| Master-track automation editing | master fade-out, mix-bus filter rides | engine may already apply it; no UI row to draw in |
| Formant-preserving pitch mode | natural big-interval harmonies | signalsmith-stretch may expose this |
| Wizard: non-modal / preview / agent op | all — UX depth | see plan §5 |
