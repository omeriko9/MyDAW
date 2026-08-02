# Production Techniques — backlog

The living queue. [PRODUCTION_TECHNIQUES_PLAN.md](PRODUCTION_TECHNIQUES_PLAN.md) says
what the feature is and how it grows; THIS file tracks what shipped per category and
what is queued next. When a technique ships: move its row to the shipped table, note
the date, and add any new primitive gaps discovered. Do not start a third list.

## Shipped — 61 techniques (v1 + batch 2: 2026-08-01 · round 3 + macros: 2026-08-02)

### Macros — full flows (5–8 stages; round 4, Omer's ask for complex techniques)
| Technique | id | Notes |
|---|---|---|
| The Drop | `the-drop` | 8 stages: riser + motion, noise roll, stereo sweep, pre-drop silence (macro's own tracks exempt), impact+rumble, downlifter, DROP marker |
| Full Vocal Chain | `vocal-chain` | 7: gate, clean EQ, comp, saturator heat, L/R doubles, EQ'd ducked verb, last-phrase throw |
| Radio-Ready Master | `radio-master` | 6: headroom −6, stem buses w/ NAME-heuristic routing, drum glue, console color, mix glue, ceiling+measured LUFS |
| Drum Kit Makeover | `drum-makeover` | 7: bus+route, glue, parallel crush, gated snare verb, ghost notes, humanize, bass-to-kick pump |
| Vocal Hook Factory | `hook-factory` | 6: sampler kit, chop pattern, pitch riser, MIDI echoes, wet FX room, trance-gate groove |
| Podcast Episode Prep | `podcast-prep` | 5: voice gate, broadcast presence, bed auto-duck, opening balance, ceiling + −16 LUFS pass |

### The five classic categories (11 each)

### Transitions & arrangement FX
| Technique | id | Notes |
|---|---|---|
| Build-Up Riser | `riser-buildup` | polysynth noise+saw, cutoff/gain ramps, verb-send ramp, GRIT stage (saturator Drive ramp, restored 2026-08-02) |
| Snare-Roll Accelerator | `snare-roll` | 1/8→1/16→1/32 + velocity climb, one-undo batch |
| Tape Stop | `tape-stop` | `clip.stretch` tape varispeed ×0.5 on the split tail |
| Reverse Build-In | `reverse-build` | duplicate → DOP reverse → place before, long fade-in |
| Downlifter | `downlifter` | riser inverted after the drop (falling cutoff/gain) |
| Noise Sweep | `noise-sweep` | pure noise, cutoff opens while PAN crosses −0.8→0.8 |
| Pre-Drop Silence | `predrop-silence` | slice around the gap + MUTE (auditionable), DROP marker |
| Impact Rumble | `impact-rumble` | sine+sub boom on the downbeat into a huge 100%-wet verb |
| Reverse-Reverb Swell | `reverse-reverb-swell` | print verb via renderInPlace, DOP reverse, place before |
| Half-Time Drop | `half-time-drop` | clip.stretch ×2 pitch-preserved |
| Chord Swell | `chord-swell` | pad voiced from the CHORD TRACK blooms into the bar |

### Mixing — space & dynamics
| Technique | id | Notes |
|---|---|---|
| Sidechain Pump | `sidechain-pump` | comp keyed from kick, tempo-timed release, depth presets, GHOST-KICK stage (muted silent-key trigger track) |
| Polished Vocal Reverb | `vocal-reverb-send` | EQ'd 100%-wet bus + send + vocal-keyed ducking |
| Haas Widener | `haas-widener` | duplicate, ±70% pans, 15 ms late; mono-safety stage |
| Telephone Section | `telephone-section` | clip → own track, 700–3.2k bandpass + 8:1 crunch |
| Ducking Bed | `ducking-bed` | VO auto-duck: slow attack/500 ms release, depth presets |
| Auto-Pan Motion | `auto-pan` | triangle pan lane at 1/8..1-bar rates + matching tremolo |
| Gated Reverb | `gated-reverb` | reverb → stock gate — the 80s snare; CHARACTER stage (Huge/Tight/Modern size+hold presets) |
| Vocal Presence Chain | `vocal-presence` | HPF+mud dip → 3:1 comp → +3 dB air shelf |
| Trance Gate | `trance-gate` | rhythmic volume-lane chop pattern (+pan bounce) |
| EQ Slotting | `eq-slotting` | mirror cut/boost at a contested band on two tracks |
| LCR Spread | `lcr-spread` | hard L / C / hard R placement over the selection |

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
| Gang Vocal Stack | `gang-stack` | 2 copies hard-panned, ±25¢ detunes, HPF 300 |
| Pitch-Drop Tag | `pitch-drop-tag` | last half-beat tape-dropped (ratio 0.6) |
| Vocal Heat | `vocal-heat` | stock SATURATOR drive/mix presets on the voice |

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
| Arpeggio Builder | `arp-builder` | CHORD-TRACK-aware arp as editable MIDI (+groove) |
| Ghost Notes | `ghost-notes` | vel-25 hits on empty 1/16 slots next to real hits |
| Strum Humanizer | `strum-humanizer` | chord notes staggered low→high + velocity slope |

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
| Mix-Bus Color | `mixbus-color` | stock SATURATOR on the master, console/tape/driven |
| Master EQ Tilt | `master-eq-tilt` | shelf-pair tilt on the master EQ + bypass A/B stage |
| Loudness Ladder | `loudness-ladder` | −1 dB ceiling ensured + measured-render loop |

## Queued — Transitions & arrangement FX

| Technique | Ingredients (all existing unless noted) | Size |
|---|---|---|
| Impact + sub drop one-shots | GAP: no bundled sample content (licensing first) | M |
| DJ backspin | reverse + accelerating varispeed — needs segmented tape stretch | M |

## Queued — Mixing: space & dynamics

| Technique | Ingredients | Size |
|---|---|---|
| Telephone-EQ by AUTOMATION | GAP: EQ bands are not automatable paramRefs (section-track workaround shipped) | M |
| Mid/Side width | GAP: no M/S processing in Utility | M |
| De-esser chain | GAP: no stock de-esser (comp lacks a detector filter) | M |

## Queued — Vocal production

| Technique | Ingredients | Size |
|---|---|---|
| Comp-and-tighten helper | take lanes exist; mostly guidance stages over comping | M |
| Formant-preserving shifts | GAP: spectral stretch shifts formants too (chipmunk at big intervals — noted honestly in Harmony Stack) | L |
| Whisper layer | needs a real recording — guidance-only candidate | S |

## Queued — Editing & sound design

| Technique | Ingredients | Size |
|---|---|---|
| Chord-aware chop pitches | arp-builder shipped; chop-kit variant reading chordAt() is now trivial | S |
| Granular freeze pad | GAP: no granular engine | L |
| Arrangement A/B sections | arranger sections exist — "try the chorus twice" wizard | M |

## Queued — Bus, glue & master

| Technique | Ingredients | Size |
|---|---|---|
| Mono-lows / width by band | GAP: no multiband utility | M |
| Master fade-out | GAP: master-track automation lanes have no timeline row to edit them in | S |

## Primitive gaps (engine/UI work that unlocks queued rows)

| Gap | Unlocks | Notes |
|---|---|---|
| ~~Stock saturator~~ CLOSED 2026-08-02 | `builtin:saturator` shipped — vocal-heat, mixbus-color, riser Grit, radio-master use it | riser-grit retrofit DONE same day |
| Tempo-sync toggle on Delay time | slapback/throw that follow tempo changes | wizard computes ms today — works, just not tempo-tracking |
| EQ bands as automation targets | telephone-by-automation, filter sweeps sans insert | paramRef scheme extension + plan rebuild cost |
| Multiband utility (or M/S mode) | mono-lows, width-by-band | |
| Bundled sample content (one-shots) | impacts, sub drops | licensing question first |
| Stock de-esser (or comp detector filter) | de-esser chain | sidechain detector EQ would also serve |
| Master-track automation editing | master fade-out, mix-bus filter rides | engine may already apply it; no UI row to draw in |
| Formant-preserving pitch mode | natural big-interval harmonies | signalsmith-stretch may expose this |
| Wizard: non-modal / preview / agent op | all — UX depth | see plan §5 |
