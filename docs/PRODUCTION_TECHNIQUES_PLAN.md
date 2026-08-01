# Production Techniques — plan

Status: v1 SHIPPED 2026-08-01 (10 techniques, wizard, docs). The living per-category
queue lives in [PRODUCTION_TECHNIQUES_BACKLOG.md](PRODUCTION_TECHNIQUES_BACKLOG.md) —
extend THERE, not by starting a new list.

## 1. What this is

Music production has accumulated named, listener-recognizable **techniques** — riser
build-ups, sidechain pumping, doubled vocals, vocal chops, parallel compression, the
EQ'd/ducked reverb send. The individual processors are ordinary (a filter, a delay, a
send, a fader ramp); the technique IS the coordination: a routing topology + tuned
settings + synchronized automation + timing against the arrangement.

MyDAW ships these as **guided wizards**: the user picks a technique, and it progresses
through 2–3 **stages**. Each stage:

- is applied **automatically** on demand (one click), with musical defaults computed
  from context (tempo, selection, the drop bar),
- can be done **manually** instead — every stage carries honest "how to do this by
  hand" instructions, and a *Mark done* button advances the wizard without touching
  the project (the wizard doubles as a teacher),
- can be **taken back** (stage-granular undo), and the whole flow can be stopped in
  the middle — whatever was applied simply stays, as ordinary undoable edits.

Nothing here invents new engine capability. A technique is **data + a few store
actions over existing primitives**: tracks/buses (`cmd/track.add`), sends
(`cmd/track.addSend`), built-in inserts (`cmd/plugin.add` + `setParam`), per-track EQ
(`cmd/track.eq.set`), automation points with curve bend (`cmd/automation.set`), MIDI
note batches (`cmd/notes.edit`, one undo entry), clip ops (split/duplicate/move/
stretch incl. tape mode, DOP incl. reverse), `cmd/clip.createSampler`. That is the
design invariant: **if a technique needs a primitive the engine lacks, the primitive
goes to the backlog's "gaps" table first** — no half-faked techniques (SPEC §10).

## 2. Context awareness

Each technique declares `requirements(ctx)` — checked live in the wizard:

- **Hard requirements** show as ✔/✖ with a reason ("Select an audio clip first —
  the chop kit samples the selected clip").
- **Fixable requirements** carry a Fix button — "This needs an instrument track for
  the roll. Add one with the stock Piano?" → one click creates it.
- **Targets are parameters, not guesses**: stages that operate on a track/clip expose
  a picker (defaulting to the current selection at open), so the modal never forces
  the user back out to click the timeline.
- **Musical defaults from context**: delay times from the tempo (dotted 1/8 at the
  project BPM), ramp ranges from the loop/selection, the riser's drop bar from the
  playhead's next bar.

## 3. Architecture (`ui/src/techniques/`)

- `types.ts` — `TechniqueDef { id, category, title, tagline, description, requirements(ctx), stages[] }`;
  `StageDef { id, title, summary, manual, optional?, params?, run(ctx, params) → { done, commands } }`.
  `commands` = how many undoable engine commands the stage issued — the wizard stores
  it (plus `store.revision`) per applied stage, and **Take back** = that many
  `edit/undo`s, with a confirm warning if the revision moved since (later edits would
  be swept up too).
- `norm.ts` — mirror of the built-in effects' param normalization (Effects.cpp
  `linNorm`/`logNorm` tables). This is the SAME pinned contract
  InstrumentEditors.tsx already relies on: params are set by **name** (looked up via
  `plugin/getParams` at run time) with values computed through this mirror, so a
  technique says "Release 120 ms", not "param 3 = 0.62".
- `ops.ts` — the shared vocabulary: `ensureBus(name, build)`, `addInsert(trackId,
  uid, settingsByName)`, `rampAutomation(trackId, paramRef, points)`, `noteBatch`,
  `sendTo`, tempo helpers. Techniques compose these; new techniques should rarely
  need a new op.
- `catalog/` — one file per category exporting its `TechniqueDef`s; `catalog/index.ts`
  aggregates. Adding technique #11 = one object in one file + a backlog row.
- `components/Techniques/TechniquesDialog.tsx` — the wizard (modal,
  `data-transport-keys="allow"` so play/stop still work): category rail → technique
  cards → stage list with Apply / *I'll do it myself* / Take back per stage.
  Entry: Project ▸ **Production Techniques…** (hence the palette and the Ribbon
  shell's Tracks group, for free).

## 4. v1 catalog — 10 techniques, 2 × 5 categories

| Category | Technique | Stages (→ = optional) |
|---|---|---|
| Transitions & arrangement FX | **Build-Up Riser** | Source (noise/saw riser track + held note into the drop bar) · Motion (cutoff/volume ramps, bent curves) · → Space (reverb send ramp) |
| Transitions & arrangement FX | **Snare-Roll Accelerator** | Roll (1/4→1/16→1/32 accelerating notes, velocity ramp, one undo) · → Lift (volume ramp under the roll) |
| Mixing — space & dynamics | **Sidechain Pump** | Key (compressor on target, sidechained from the kick track) · Depth (pump amount presets; release from tempo) |
| Mixing — space & dynamics | **Polished Vocal Reverb** | Bus (EQ'd send verb — low cut 550 Hz / high cut 10 kHz, 100 % wet) · Send · → Duck (verb compressor keyed by the dry vocal) |
| Vocal production | **Stereo Doubler** | Copies (2 track duplicates) · Spread (pan L/R, −4 dB, ±12 ms nudge) · → Tone (high-pass the doubles) |
| Vocal production | **Delay Throw** | Bus (ping-pong delay, dotted-1/8 from BPM, 100 % wet) · Send (at zero) · Throw (send-automation spike on the phrase tail) |
| Editing & sound design | **Vocal Chop Kit** | Sampler (`clip.createSampler` from the selected clip) · Pattern (rhythmic chop MIDI) · → Tighten (snappy amp envelope, loop off) |
| Editing & sound design | **Stutter Fill** | Slice (last beat → 1/16 repeats of the first slice) · → Shape (fades per repeat) |
| Bus, glue & master | **Master Glue Chain** | Glue (2:1, slow attack, gentle) · Ceiling (limiter −1 dB) · → Loudness check (opens Export with the −14 LUFS preset in mind) |
| Bus, glue & master | **Parallel Drum Crush** | Bus (smashed compressor, 10:1 fast) · Feed (full-level sends from the source tracks) · Blend (crush fader low, ride to taste) |

Complexity target honored: each is 2–3 coordinated actions a user could do by hand in
a few minutes (not 2 seconds), and each teaches its own manual recipe.

## 5. How this grows

- **More techniques per category** — the backlog doc keeps a per-category queue with
  the primitives each candidate needs; implemented rows move to the "shipped" table.
  Cadence is Omer's call; the intended granularity stays "a bunch of coordinated
  actions", with bigger flows (full vocal-chain wizard, stem-mastering) as multi-
  technique chains later.
- **Primitive gaps drive engine work** — the backlog's gaps table (stock saturator,
  tempo-synced delay toggle, clip reverse *with* tail render, multiband) is the
  shopping list; a gap closing unlocks specific queued techniques, which is the
  motivation to close it.
- **Deeper wizard** (later, in rough order): remember last-used params; preview stage
  (audition before commit); non-modal docked wizard so timeline selection stays live
  mid-flow; an agent surface (`technique.apply`) so the in-app agent can run
  techniques — the catalog counts bump in the usual 3 places when that lands;
  per-stage A/B (bypass all inserts a stage added).
- **Authoring** — techniques are plain data + tiny run functions; a user-facing
  "record my own technique" (capture a command sequence into a reusable template) is
  the far-end goal and would subsume layout presets' philosophy at the project level.
