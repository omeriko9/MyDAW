/**
 * Transitions & arrangement FX — Build-Up Riser, Snare-Roll Accelerator.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import {
  addMarker,
  addPlugin,
  addTrack,
  duplicateClips,
  moveClips,
  processAudioClip,
  setClip,
  splitClips,
  stretchClip,
} from "../../store/actions";
import type { NoteInput, Track } from "../../protocol/types";
import { clipEndBeat } from "../../lib/keyboard";
import {
  Tx,
  addInsert,
  addNotes,
  allAudioClips,
  dbToLin,
  eqLowCut,
  focusMidiClip,
  newMidiClip,
  newTrack,
  nextBarBeat,
  paramIdByName,
  pluginParamRef,
  ramp,
  resolveAudioClip,
  sendTo,
  setEqBands,
} from "../ops";
import { normFor } from "../norm";
import type { ParamDef, TechniqueCtx, TechniqueDef } from "../types";

/** Clip picker (this file's audio-clip techniques) — defaults to the selection. */
const clipParamT = (label: string): ParamDef => ({
  key: "clipId",
  label,
  kind: "clip",
  default: (ctx) => resolveAudioClip(ctx, undefined)?.clip.id ?? 0,
});
const resolveAudioClipT = resolveAudioClip;

/* ============================================================================
 * Build-Up Riser
 * ========================================================================= */

/** Bar number shown to the user is 1-based; beat = (bar-1) * beatsPerBar. */
const barToBeat = (ctx: TechniqueCtx, bar: number) => (bar - 1) * ctx.beatsPerBar;
/** Next bar line after the playhead — but never so early that `lengthBars` of
 *  build-up can't fit before it (riserRange would silently clamp it short). */
const defaultDropBar = (ctx: TechniqueCtx, lengthBars = 8) =>
  Math.max(Math.round(nextBarBeat(ctx) / ctx.beatsPerBar) + 1, lengthBars + 1);

function riserRange(ctx: TechniqueCtx, params: { dropBar: number; lengthBars: number }) {
  const end = Math.max(ctx.beatsPerBar, barToBeat(ctx, params.dropBar));
  const start = Math.max(0, end - params.lengthBars * ctx.beatsPerBar);
  return { start, end };
}

/** Stage-2/3 fallback when stage 1 was done by hand: the named riser track. */
function findRiser(ctx: TechniqueCtx, state: Record<string, unknown>) {
  const trackId = state.riserTrackId as number | undefined;
  const track =
    ctx.project.tracks.find((t) => t.id === trackId) ??
    ctx.project.tracks.find((t) => t.kind === "instrument" && /riser/i.test(t.name));
  if (!track)
    throw new Error('No riser track found — run the Source stage (or name your riser track "Riser").');
  const synth = track.inserts.find((i) => i.uid === "builtin:polysynth");
  if (!synth)
    throw new Error("The riser track has no PolySynth insert — the Source stage adds one.");
  return { track, instanceId: synth.instanceId };
}

const riser: TechniqueDef = {
  id: "riser-buildup",
  category: "transitions",
  title: "Build-Up Riser",
  tagline: "A noise sweep that ramps into the drop.",
  description:
    "The classic tension build: a simple noise/saw source whose loudness and filter " +
    "open together over the bars before a drop. The processors are ordinary — the " +
    "effect is their coordinated automation.",
  requirements: () => [],
  stages: [
    {
      id: "source",
      title: "Source",
      reveal: "timeline",
      summary:
        "Adds an instrument track “Riser” with a noise-heavy PolySynth (filter closed) " +
        "and one held note that ends exactly on the drop bar.",
      manual:
        "Add an instrument track with the stock PolySynth. Turn Noise up (~85%), Osc Mix down, " +
        "set the filter Cutoff low (~200 Hz), Sustain full. Draw one MIDI note that starts " +
        "N bars before your drop and ends exactly on it.",
      params: [
        {
          key: "dropBar",
          label: "Drop at bar",
          kind: "number",
          min: 2,
          max: 999,
          step: 1,
          default: defaultDropBar,
          help: "The bar the riser resolves into (defaults to the next bar line).",
        },
        {
          key: "lengthBars",
          label: "Length (bars)",
          kind: "number",
          min: 1,
          max: 32,
          step: 1,
          default: () => 8,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const { start, end } = riserRange(ctx, params as { dropBar: number; lengthBars: number });
        const track = await newTrack(tx, "instrument", "Riser");
        const synth = await addInsert(tx, track.id, "builtin:polysynth", {
          Noise: 0.85,
          "Osc Mix": 0,
          Sub: 0,
          Cutoff: 220,
          Resonance: 0.35,
          "Filter Env": 0.5, // bipolar center = no env sweep; automation drives the filter
          "Amp Attack": 5,
          "Amp Sustain": 1,
          "Amp Release": 350,
          Gain: -10,
        });
        const clip = await newMidiClip(tx, track.id, start, end - start);
        await addNotes(tx, clip.id, [
          { pitch: 48, velocity: 100, startBeat: 0, lengthBeats: end - start },
        ]);
        state.riserTrackId = track.id;
        state.riserInstanceId = synth.instanceId;
        state.riserStart = start;
        state.riserEnd = end;
        return {
          commands: tx.count,
          note: `Riser track ready — held note from beat ${start} to the drop at bar ${(params as { dropBar: number }).dropBar}.`,
        };
      },
    },
    {
      id: "motion",
      title: "Motion",
      reveal: "timeline",
      summary:
        "Automates the rise: filter Cutoff sweeps 120 Hz → 12 kHz and synth Gain climbs " +
        "−14 dB → −2 dB across the riser, with upward-bent curves.",
      manual:
        "Open automation lanes for the synth's Cutoff and Gain params. Draw both rising " +
        "across the riser's length — start low/quiet, end open/full, and bend the curves " +
        "upward so most of the movement lands in the last bars.",
      params: [
        {
          key: "dropBar",
          label: "Drop at bar",
          kind: "number",
          min: 2,
          max: 999,
          step: 1,
          default: defaultDropBar,
        },
        {
          key: "lengthBars",
          label: "Length (bars)",
          kind: "number",
          min: 1,
          max: 32,
          step: 1,
          default: () => 8,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const { track, instanceId } = findRiser(ctx, state);
        const start = (state.riserStart as number) ??
          riserRange(ctx, params as { dropBar: number; lengthBars: number }).start;
        const end = (state.riserEnd as number) ??
          riserRange(ctx, params as { dropBar: number; lengthBars: number }).end;
        const cutoffId = await paramIdByName(instanceId, "Cutoff");
        const gainId = await paramIdByName(instanceId, "Gain");
        const uid = "builtin:polysynth";
        await ramp(tx, track.id, pluginParamRef(instanceId, cutoffId), [
          { t: start, v: normFor(uid, "Cutoff", 120), curve: 0.5 },
          { t: end, v: normFor(uid, "Cutoff", 12000) },
        ]);
        await ramp(tx, track.id, pluginParamRef(instanceId, gainId), [
          { t: start, v: normFor(uid, "Gain", -14), curve: 0.4 },
          { t: end, v: normFor(uid, "Gain", -2) },
        ]);
        return { commands: tx.count, note: "Cutoff + gain ramps written (bent toward the drop)." };
      },
    },
    {
      id: "space",
      title: "Space",
      reveal: "mixer",
      optional: true,
      summary:
        "Creates a 100%-wet “Riser Verb” bus (low-cut 300 Hz) and ramps the riser's send " +
        "into it, so the tail keeps growing as the drop approaches.",
      manual:
        "Add a bus with a Reverb (Mix 100%, big Size) and a low-cut around 300 Hz. Send the " +
        "riser track to it and automate the SEND level rising across the riser.",
      params: [
        {
          key: "dropBar",
          label: "Drop at bar",
          kind: "number",
          min: 2,
          max: 999,
          step: 1,
          default: defaultDropBar,
        },
        {
          key: "lengthBars",
          label: "Length (bars)",
          kind: "number",
          min: 1,
          max: 32,
          step: 1,
          default: () => 8,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const { track } = findRiser(ctx, state);
        const start = (state.riserStart as number) ??
          riserRange(ctx, params as { dropBar: number; lengthBars: number }).start;
        const end = (state.riserEnd as number) ??
          riserRange(ctx, params as { dropBar: number; lengthBars: number }).end;
        const bus = await newTrack(tx, "bus", "Riser Verb");
        await setEqBands(tx, bus.id, [eqLowCut(300)]);
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.8, Damp: 0.35, Mix: 100 });
        const sendIndex = await sendTo(tx, ctx.project, track.id, bus.id, 0);
        await ramp(tx, track.id, `send:${sendIndex}`, [
          { t: start, v: 0, curve: 0.4 },
          { t: end, v: 0.7 },
        ]);
        return { commands: tx.count, note: "Riser Verb bus ready; send ramps 0 → 0.7 into the drop." };
      },
    },
  ],
};

/* ============================================================================
 * Snare-Roll Accelerator
 * ========================================================================= */

const rollTrackFilter = (t: Track) => t.kind === "instrument" || t.kind === "midi";

const snareRoll: TechniqueDef = {
  id: "snare-roll",
  category: "transitions",
  title: "Snare-Roll Accelerator",
  tagline: "Quarter → eighth → sixteenth → thirty-second notes into the drop.",
  description:
    "The build-up staple: a repeated hit whose subdivision halves as the drop " +
    "approaches while velocities climb — tension from acceleration alone.",
  requirements: (ctx) => {
    const has = ctx.project.tracks.some(rollTrackFilter);
    return [
      {
        ok: has,
        label: "An instrument (or MIDI) track to play the roll",
        fix: has
          ? undefined
          : {
              label: "Add a Piano track for me",
              run: async () => {
                const r = await addTrack("instrument", { name: "Roll" });
                await addPlugin(r.track.id, "builtin:piano");
              },
            },
      },
    ];
  },
  stages: [
    {
      id: "roll",
      title: "Roll",
      reveal: "pianoRoll",
      summary:
        "Writes the accelerating roll on the chosen track: 1/8s for the first half, 1/16s, " +
        "then 1/32s into the drop, velocities climbing 60 → 127. One undo entry.",
      manual:
        "Create a MIDI clip ending at the drop. Draw one pitch repeatedly: eighth notes for " +
        "the first half, sixteenths for the next quarter, thirty-seconds for the last — and " +
        "ramp the velocities up as it accelerates.",
      params: [
        {
          key: "trackId",
          label: "Play on",
          kind: "track",
          trackFilter: rollTrackFilter,
          default: (ctx) => {
            const sel = ctx.project.tracks.find((t) => t.id === ctx.selection.trackIds[0]);
            return (sel && rollTrackFilter(sel) ? sel.id : ctx.project.tracks.find(rollTrackFilter)?.id) ?? 0;
          },
        },
        {
          key: "dropBar",
          label: "Drop at bar",
          kind: "number",
          min: 2,
          max: 999,
          step: 1,
          default: (ctx) => defaultDropBar(ctx, 2),
        },
        {
          key: "lengthBars",
          label: "Length (bars)",
          kind: "number",
          min: 1,
          max: 8,
          step: 1,
          default: () => 2,
        },
        {
          key: "pitch",
          label: "Note (MIDI pitch)",
          kind: "number",
          min: 0,
          max: 127,
          step: 1,
          default: () => 38, // D1 — GM snare
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const trackId = params.trackId as number;
        if (!ctx.project.tracks.some((t) => t.id === trackId && rollTrackFilter(t)))
          throw new Error("Pick an instrument or MIDI track to play the roll on.");
        const { start, end } = riserRange(ctx, params as { dropBar: number; lengthBars: number });
        const len = end - start;
        const pitch = params.pitch as number;
        const notes: NoteInput[] = [];
        // subdivision schedule over the roll: 1/8s, then 1/16s, then 1/32s
        const spans: Array<[number, number, number]> = [
          [0, len * 0.5, 0.5],
          [len * 0.5, len * 0.75, 0.25],
          [len * 0.75, len, 0.125],
        ];
        for (const [from, to, step] of spans) {
          for (let b = from; b < to - 1e-9; b += step) {
            notes.push({
              pitch,
              velocity: Math.round(60 + (127 - 60) * (b / len)),
              startBeat: b,
              lengthBeats: step * 0.9,
            });
          }
        }
        const clip = await newMidiClip(tx, trackId, start, len);
        await addNotes(tx, clip.id, notes);
        focusMidiClip(clip.id); // reveal("pianoRoll") then shows the roll
        state.rollTrackId = trackId;
        state.rollStart = start;
        state.rollEnd = end;
        return { commands: tx.count, note: `${notes.length} accelerating hits written into bar ${(params as { dropBar: number }).dropBar}.` };
      },
    },
    {
      id: "lift",
      title: "Lift",
      reveal: "timeline",
      optional: true,
      summary:
        "Adds a rising volume ramp under the roll (−6 dB → 0 dB), so the acceleration also " +
        "gets louder as a whole.",
      manual:
        "Open the roll track's volume automation lane and draw a ramp across the roll: about " +
        "−6 dB at the start rising to 0 dB at the drop.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const trackId = state.rollTrackId as number | undefined;
        if (trackId === undefined || !ctx.project.tracks.some((t) => t.id === trackId))
          throw new Error("Run the Roll stage first (Lift ramps the track it created).");
        const start = state.rollStart as number;
        const end = state.rollEnd as number;
        // volume lane domain: LINEAR gain, 1 = 0 dB (Timeline/layout paramSpecFor)
        await ramp(tx, trackId, "volume", [
          { t: start, v: 0.5, curve: 0.3 },
          { t: end, v: 1.0 },
        ]);
        return { commands: tx.count, note: "Volume ramp written under the roll." };
      },
    },
  ],
};

/* ============================================================================
 * Tape Stop
 * ========================================================================= */

const tapeStop: TechniqueDef = {
  id: "tape-stop",
  category: "transitions",
  title: "Tape Stop",
  tagline: "The music grinds to a halt like a stopped reel.",
  description:
    "The clip's tail is resampled tape-style — pitch and speed fall together, exactly " +
    "like power-cut vinyl or a stopped tape reel. A one-move transition into silence " +
    "or a drop.",
  requirements: (ctx) => [
    {
      ok: allAudioClips(ctx).some((f) => clipEndBeat(f.clip, ctx.project) - f.clip.startBeat >= 2),
      label: "An audio clip at least 2 beats long (its tail becomes the stop)",
    },
  ],
  stages: [
    {
      id: "slow",
      title: "Slice & slow",
      reveal: "timeline",
      summary:
        "Splits off the clip's last beat and tape-stretches it ×2 — pitch falls an octave " +
        "as it slows, and the tail now reaches one beat PAST the old clip end.",
      manual:
        "Split the clip one beat before its end. On the tail: right-click ▸ Time-Stretch, " +
        "ratio 0.5 with tape mode (pitch follows speed) — the tail doubles in length and " +
        "falls an octave. Mind what it now overlaps.",
      params: [clipParamT("Stop this clip")],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClipT(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the audio clip to tape-stop.");
        const end = clipEndBeat(found.clip, ctx.project);
        if (end - found.clip.startBeat < 2) throw new Error("The clip must be at least 2 beats long.");
        const s = await tx.cmd(splitClips([found.clip.id], end - 1));
        const tailId = s.newClipIds[0];
        if (tailId === undefined) throw new Error("Split produced no tail.");
        // tape varispeed: pitch × ratio, length ÷ ratio — 0.5 = octave down, twice as long
        await tx.cmd(stretchClip(tailId, 0.5, true, true));
        state.tapeTailId = tailId;
        state.tapeBpm = ctx.bpm;
        return { commands: tx.count, note: "Tail slowed to a stop — it now runs one beat past the old end." };
      },
    },
    {
      id: "fade",
      title: "Fade to nothing",
      reveal: "timeline",
      optional: true,
      summary: "Fades the stopped tail out over its second half so it dies instead of cutting.",
      manual: "Drag a fade-out over the second half of the stretched tail.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const tailId = state.tapeTailId as number | undefined;
        if (tailId === undefined) throw new Error("Run Slice & slow first (in this wizard).");
        const bpm = (state.tapeBpm as number) ?? 120;
        await tx.cmd(setClip(tailId, { fadeOutSec: (60 / bpm) * 1.2 }));
        return { commands: tx.count, note: "Stopped tail fades out." };
      },
    },
  ],
};

/* ============================================================================
 * Reverse Build-In
 * ========================================================================= */

const reverseBuild: TechniqueDef = {
  id: "reverse-build",
  category: "transitions",
  title: "Reverse Build-In",
  tagline: "The sound arrives out of its own mirror image.",
  description:
    "A reversed copy of the clip is placed right before it, swelling INTO the real " +
    "thing — the reverse-cymbal/reverse-vocal lead-in that announces a section without " +
    "a drum fill.",
  requirements: (ctx) => [
    { ok: allAudioClips(ctx).length > 0, label: "An audio clip to mirror (crash, chord, word)" },
  ],
  stages: [
    {
      id: "mirror",
      title: "Mirror",
      reveal: "timeline",
      summary:
        "Duplicates the clip, reverses the copy (destructive on the COPY only), and places " +
        "it immediately before the original.",
      manual:
        "Alt-drag a copy of the clip just before itself, then right-click the copy ▸ " +
        "Process ▸ Reverse. The reversed copy should END exactly where the original starts.",
      params: [clipParamT("Build into this clip")],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClipT(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the clip to build into.");
        const len = clipEndBeat(found.clip, ctx.project) - found.clip.startBeat;
        if (found.clip.startBeat - len < 0)
          throw new Error("No room before the clip — it needs its own length of empty space in front.");
        const dup = await tx.cmd(duplicateClips([found.clip.id], true));
        const copyId = dup.clips[0]?.id;
        if (copyId === undefined) throw new Error("Duplicate returned no clip.");
        await tx.cmd(processAudioClip(copyId, "reverse"));
        await tx.cmd(moveClips([copyId], -len));
        state.reverseCopyId = copyId;
        state.reverseLen = len;
        state.reverseBpm = ctx.bpm;
        return { commands: tx.count, note: "Reversed copy leads into the original." };
      },
    },
    {
      id: "swell",
      title: "Swell shape",
      reveal: "timeline",
      optional: true,
      summary: "Fades the reversed copy in across most of its length and tucks it −4 dB.",
      manual:
        "Give the reversed copy a long fade-in (most of its length) and pull its clip gain " +
        "a few dB under the original — it should grow out of nothing.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const copyId = state.reverseCopyId as number | undefined;
        if (copyId === undefined) throw new Error("Run Mirror first (in this wizard).");
        const len = (state.reverseLen as number) ?? 4;
        const bpm = (state.reverseBpm as number) ?? 120;
        await tx.cmd(setClip(copyId, { fadeInSec: (60 / bpm) * len * 0.7, gain: Math.pow(10, -4 / 20) }));
        return { commands: tx.count, note: "Reverse swell shaped (long fade-in, −4 dB)." };
      },
    },
  ],
};

/* ============================================================================
 * Downlifter
 * ========================================================================= */

const downlifter: TechniqueDef = {
  id: "downlifter",
  category: "transitions",
  title: "Downlifter",
  tagline: "The riser's mirror — falls away AFTER the drop.",
  description:
    "The release valve after a drop or at a section exit: a noise source whose filter " +
    "and level fall together, clearing the stage for what comes next.",
  requirements: () => [],
  stages: [
    {
      id: "source",
      title: "Source",
      reveal: "timeline",
      summary:
        "Adds a “Downlifter” instrument track: airy PolySynth noise with the filter OPEN, " +
        "holding one note that starts on the chosen bar.",
      manual:
        "Add an instrument track with the stock PolySynth: Noise up, filter Cutoff high " +
        "(~9 kHz). Draw one note starting ON the bar (usually the drop) and holding a few bars.",
      params: [
        {
          key: "atBar",
          label: "Starts at bar",
          kind: "number",
          min: 1,
          max: 999,
          step: 1,
          default: (ctx) => Math.round(nextBarBeat(ctx) / ctx.beatsPerBar) + 1,
        },
        {
          key: "lengthBars",
          label: "Length (bars)",
          kind: "number",
          min: 1,
          max: 16,
          step: 1,
          default: () => 4,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const start = barToBeat(ctx, params.atBar as number);
        const len = (params.lengthBars as number) * ctx.beatsPerBar;
        const track = await newTrack(tx, "instrument", "Downlifter");
        const synth = await addInsert(tx, track.id, "builtin:polysynth", {
          Noise: 0.75,
          "Osc Mix": 0,
          Cutoff: 9000,
          Resonance: 0.3,
          "Amp Attack": 5,
          "Amp Sustain": 1,
          "Amp Release": 500,
          Gain: -10,
        });
        const clip = await newMidiClip(tx, track.id, start, len);
        await addNotes(tx, clip.id, [{ pitch: 48, velocity: 100, startBeat: 0, lengthBeats: len }]);
        state.downTrackId = track.id;
        state.downInstanceId = synth.instanceId;
        state.downStart = start;
        state.downEnd = start + len;
        return { commands: tx.count, note: "Downlifter source holding from the bar." };
      },
    },
    {
      id: "fall",
      title: "Fall",
      reveal: "timeline",
      summary: "Automates the descent: Cutoff 9 kHz → 150 Hz and Gain −4 → −18 dB, front-loaded.",
      manual:
        "Automate the synth's Cutoff falling from open to closed and its Gain fading out " +
        "across the note — bend the curves so most of the fall happens early.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const trackId = state.downTrackId as number | undefined;
        const instanceId = state.downInstanceId as number | undefined;
        const track = ctx.project.tracks.find((t) => t.id === trackId);
        if (!track || instanceId === undefined)
          throw new Error("Run the Source stage first (Fall automates the track it created).");
        const start = state.downStart as number;
        const end = state.downEnd as number;
        const uid = "builtin:polysynth";
        const cutoffId = await paramIdByName(instanceId, "Cutoff");
        const gainId = await paramIdByName(instanceId, "Gain");
        await ramp(tx, track.id, pluginParamRef(instanceId, cutoffId), [
          { t: start, v: normFor(uid, "Cutoff", 9000), curve: -0.5 },
          { t: end, v: normFor(uid, "Cutoff", 150) },
        ]);
        await ramp(tx, track.id, pluginParamRef(instanceId, gainId), [
          { t: start, v: normFor(uid, "Gain", -4), curve: -0.4 },
          { t: end, v: normFor(uid, "Gain", -18) },
        ]);
        return { commands: tx.count, note: "Falling cutoff + gain written (front-loaded)." };
      },
    },
  ],
};

/* ============================================================================
 * Noise Sweep (one-shot)
 * ========================================================================= */

const noiseSweep: TechniqueDef = {
  id: "noise-sweep",
  category: "transitions",
  title: "Noise Sweep",
  tagline: "White noise crosses the stereo field into the downbeat.",
  description:
    "The short whoosh that stitches two sections: pure noise whose filter opens while " +
    "it pans across the field, landing on the bar line.",
  requirements: () => [],
  stages: [
    {
      id: "source",
      title: "Source",
      reveal: "timeline",
      summary: "Adds a “Sweep” track — pure PolySynth noise holding through the sweep bars.",
      manual:
        "Add an instrument track with the stock PolySynth: Noise 100%, oscillators silent. " +
        "Draw one note covering the sweep (usually the 1–2 bars before a section).",
      params: [
        {
          key: "endBar",
          label: "Lands on bar",
          kind: "number",
          min: 2,
          max: 999,
          step: 1,
          default: (ctx) => Math.max(Math.round(nextBarBeat(ctx) / ctx.beatsPerBar) + 1, 3),
        },
        {
          key: "lengthBars",
          label: "Length (bars)",
          kind: "number",
          min: 1,
          max: 8,
          step: 1,
          default: () => 2,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const end = Math.max(ctx.beatsPerBar, barToBeat(ctx, params.endBar as number));
        const start = Math.max(0, end - (params.lengthBars as number) * ctx.beatsPerBar);
        const track = await newTrack(tx, "instrument", "Sweep");
        const synth = await addInsert(tx, track.id, "builtin:polysynth", {
          Noise: 1,
          "Osc Mix": 0,
          Sub: 0,
          Cutoff: 1200,
          "Amp Attack": 10,
          "Amp Sustain": 1,
          "Amp Release": 250,
          Gain: -12,
        });
        const clip = await newMidiClip(tx, track.id, start, end - start);
        await addNotes(tx, clip.id, [{ pitch: 60, velocity: 100, startBeat: 0, lengthBeats: end - start }]);
        state.sweepTrackId = track.id;
        state.sweepInstanceId = synth.instanceId;
        state.sweepStart = start;
        state.sweepEnd = end;
        return { commands: tx.count, note: "Noise source in place — it lands on the bar." };
      },
    },
    {
      id: "motion",
      title: "Motion",
      reveal: "timeline",
      summary: "Opens the filter 400 Hz → 14 kHz while panning hard-left → hard-right across the sweep.",
      manual:
        "Automate the synth Cutoff rising across the sweep, and the TRACK PAN travelling " +
        "from one side to the other — the movement is what reads as a whoosh.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const trackId = state.sweepTrackId as number | undefined;
        const instanceId = state.sweepInstanceId as number | undefined;
        if (trackId === undefined || instanceId === undefined)
          throw new Error("Run the Source stage first.");
        const start = state.sweepStart as number;
        const end = state.sweepEnd as number;
        const cutoffId = await paramIdByName(instanceId, "Cutoff");
        await ramp(tx, trackId, pluginParamRef(instanceId, cutoffId), [
          { t: start, v: normFor("builtin:polysynth", "Cutoff", 400), curve: 0.4 },
          { t: end, v: normFor("builtin:polysynth", "Cutoff", 14000) },
        ]);
        // pan lane domain: −1..1 (Timeline/layout paramSpecFor)
        await ramp(tx, trackId, "pan", [
          { t: start, v: -0.8 },
          { t: end, v: 0.8 },
        ]);
        return { commands: tx.count, note: "Filter opens while the noise crosses the field." };
      },
    },
  ],
};

/* ============================================================================
 * Pre-Drop Silence
 * ========================================================================= */

const preDropSilence: TechniqueDef = {
  id: "predrop-silence",
  category: "transitions",
  title: "Pre-Drop Silence",
  tagline: "Half a beat of nothing right before the hit.",
  description:
    "The oldest drop trick: everything cuts to dead silence for the last fraction of a " +
    "beat before the downbeat, so the hit lands into a vacuum. Pure editing — clips are " +
    "sliced around the gap and the slices muted (unmute to undo by ear).",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some(
        (t) => (t.kind === "audio" || t.kind === "instrument" || t.kind === "midi") && t.clips.length > 0,
      ),
      label: "Tracks with clips spanning the drop",
    },
  ],
  stages: [
    {
      id: "cut",
      title: "Cut the gap",
      reveal: "timeline",
      summary:
        "On every selected track (none selected = all), slices each clip around the gap " +
        "before the drop bar and MUTES the slice — the mix goes dead, then hits.",
      manual:
        "On each track, split the clips at (drop − gap) and at the drop, then mute the " +
        "little slices in between (M). Muting instead of deleting keeps it auditionable.",
      params: [
        {
          key: "dropBar",
          label: "Drop at bar",
          kind: "number",
          min: 2,
          max: 999,
          step: 1,
          default: (ctx) => Math.round(nextBarBeat(ctx) / ctx.beatsPerBar) + 1,
        },
        {
          key: "gap",
          label: "Gap",
          kind: "select",
          options: [
            { value: "0.25", label: "1/16 (subtle)" },
            { value: "0.5", label: "1/8 (classic)" },
            { value: "1", label: "1/4 (dramatic)" },
          ],
          default: () => "0.5",
        },
      ],
      run: async (ctx, params) => {
        const tx = new Tx();
        const drop = barToBeat(ctx, params.dropBar as number);
        const gap = Number(params.gap);
        const gapStart = drop - gap;
        if (gapStart <= 0) throw new Error("The drop bar is too early for the gap.");
        const targets = ctx.project.tracks.filter(
          (t) =>
            (t.kind === "audio" || t.kind === "instrument" || t.kind === "midi") &&
            (ctx.selection.trackIds.length === 0 || ctx.selection.trackIds.includes(t.id)),
        );
        let muted = 0;
        for (const t of targets) {
          for (const clip of [...t.clips]) {
            const cEnd = clipEndBeat(clip, ctx.project);
            if (clip.startBeat >= drop || cEnd <= gapStart) continue;
            // isolate the in-gap span of this clip, then mute it
            let midId = clip.id;
            if (clip.startBeat < gapStart) {
              const s = await tx.cmd(splitClips([midId], gapStart));
              if (s.newClipIds[0] === undefined) continue;
              midId = s.newClipIds[0];
            }
            if (cEnd > drop) {
              await tx.cmd(splitClips([midId], drop)); // tail keeps playing from the drop
            }
            await tx.cmd(setClip(midId, { muted: true }));
            muted++;
          }
        }
        if (muted === 0) throw new Error("No clips span the gap — check the drop bar.");
        return { commands: tx.count, note: `${muted} slice(s) muted — ${gap} beat(s) of silence before bar ${params.dropBar}.` };
      },
    },
    {
      id: "mark",
      title: "Mark it",
      reveal: "timeline",
      optional: true,
      summary: "Drops a “DROP” marker on the downbeat so the moment stays findable.",
      manual: "Add a marker named DROP on the drop bar (marker lane in the ruler).",
      params: [
        {
          key: "dropBar",
          label: "Drop at bar",
          kind: "number",
          min: 2,
          max: 999,
          step: 1,
          default: (ctx) => Math.round(nextBarBeat(ctx) / ctx.beatsPerBar) + 1,
        },
      ],
      run: async (ctx, params) => {
        const tx = new Tx();
        await tx.cmd(addMarker(barToBeat(ctx, params.dropBar as number), "DROP"));
        return { commands: tx.count, note: "DROP marker set." };
      },
    },
  ],
};

/* ============================================================================
 * Impact Rumble
 * ========================================================================= */

const impactRumble: TechniqueDef = {
  id: "impact-rumble",
  category: "transitions",
  title: "Impact Rumble",
  tagline: "A sub boom with a long tail lands on the downbeat.",
  description:
    "The cinematic hit that stamps a section change: a low sine thump (sub + soft " +
    "noise) on the downbeat, thrown into a big reverb so the boom keeps rumbling under " +
    "the first bars.",
  requirements: () => [],
  stages: [
    {
      id: "boom",
      title: "Boom",
      reveal: "timeline",
      summary:
        "Adds an “Impact” track: PolySynth sine + sub on a low C, two beats long, " +
        "landing exactly on the chosen bar.",
      manual:
        "Add an instrument track with the stock PolySynth: sine wave, Sub up, filter low, " +
        "fast attack, long-ish release. One low note (C1) right on the downbeat, ~2 beats.",
      params: [
        {
          key: "atBar",
          label: "Lands on bar",
          kind: "number",
          min: 1,
          max: 999,
          step: 1,
          default: (ctx) => Math.round(nextBarBeat(ctx) / ctx.beatsPerBar) + 1,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const start = barToBeat(ctx, params.atBar as number);
        const track = await newTrack(tx, "instrument", "Impact");
        await addInsert(tx, track.id, "builtin:polysynth", {
          "Osc 1 Wave": 3, // sine
          "Osc Mix": 0,
          Sub: 0.6,
          Noise: 0.06,
          Cutoff: 320,
          "Amp Attack": 1,
          "Amp Decay": 900,
          "Amp Sustain": 0.35,
          "Amp Release": 1200,
          Gain: -4,
        });
        const clip = await newMidiClip(tx, track.id, start, 2);
        await addNotes(tx, clip.id, [{ pitch: 24, velocity: 127, startBeat: 0, lengthBeats: 2 }]);
        state.impactTrackId = track.id;
        return { commands: tx.count, note: `Boom lands on bar ${params.atBar}.` };
      },
    },
    {
      id: "tail",
      title: "Tail",
      reveal: "mixer",
      summary: "Creates an “Impact Verb” bus (huge, 100% wet) and sends the boom into it at −6 dB.",
      manual:
        "Add a bus with the stock Reverb: Size near max, Mix 100%. Send the impact track " +
        "into it around −6 dB — the reverb IS the rumble.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const track = ctx.project.tracks.find((t) => t.id === (state.impactTrackId as number));
        if (!track) throw new Error("Run the Boom stage first.");
        const bus = await newTrack(tx, "bus", "Impact Verb");
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.92, Damp: 0.5, Mix: 100 });
        await sendTo(tx, ctx.project, track.id, bus.id, dbToLin(-6));
        return { commands: tx.count, note: "Rumble tail rides the Impact Verb bus." };
      },
    },
  ],
};

export const transitionTechniques: TechniqueDef[] = [
  riser,
  snareRoll,
  tapeStop,
  reverseBuild,
  downlifter,
  noiseSweep,
  preDropSilence,
  impactRumble,
];
