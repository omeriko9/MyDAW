/**
 * Transitions & arrangement FX — Build-Up Riser, Snare-Roll Accelerator.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import { addPlugin, addTrack } from "../../store/actions";
import type { NoteInput, Track } from "../../protocol/types";
import {
  Tx,
  addInsert,
  addNotes,
  eqLowCut,
  focusMidiClip,
  newMidiClip,
  newTrack,
  nextBarBeat,
  paramIdByName,
  pluginParamRef,
  ramp,
  sendTo,
  setEqBands,
} from "../ops";
import { normFor } from "../norm";
import type { TechniqueCtx, TechniqueDef } from "../types";

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

export const transitionTechniques: TechniqueDef[] = [riser, snareRoll];
