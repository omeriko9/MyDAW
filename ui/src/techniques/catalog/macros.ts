/**
 * Macros — full flows (docs/PRODUCTION_TECHNIQUES_PLAN.md, round 4): 5–8 stage
 * techniques that build a complete production MOMENT by composing the primitives the
 * other five categories established. Same wizard contract — every stage applies,
 * can be done by hand, or taken back — the length is the point: Apply All walks an
 * entire arrangement transition / vocal chain / master pass in order.
 */

import {
  addMarker,
  duplicateTrack,
  moveClips,
  setPlugin,
  setPluginParam,
  setClip,
  setTrack,
  splitClips,
} from "../../store/actions";
import { useStore } from "../../store/store";
import type { NoteInput, Track } from "../../protocol/types";
import { clipEndBeat } from "../../lib/keyboard";
import {
  Tx,
  addInsert,
  addNotes,
  allAudioClips,
  dbToLin,
  eqHighCut,
  eqLowCut,
  focusMidiClip,
  isMixerTrack,
  landingBar,
  leadInRange,
  msToBeats,
  newMidiClip,
  newTrack,
  paramIdByName,
  pluginParamRef,
  ramp,
  resolveAudioClip,
  resolveMidiClip,
  sendTo,
  setEqBands,
  trimNote,
} from "../ops";
import { normFor } from "../norm";
import { createSamplerTrack, editNotes } from "../../store/actions";
import type { ParamDef, TechniqueCtx, TechniqueDef } from "../types";

const audioLike = (t: Track) => t.kind === "audio" || t.kind === "instrument";
const feedable = (t: Track) => t.kind === "audio" || t.kind === "instrument" || t.kind === "midi";

const defaultSelectedTrack = (ctx: TechniqueCtx, filter: (t: Track) => boolean) => {
  const sel = ctx.project.tracks.find((t) => t.id === ctx.selection.trackIds[0]);
  return (sel && filter(sel) ? sel.id : ctx.project.tracks.find(filter)?.id) ?? 0;
};

const byName = (ctx: TechniqueCtx, re: RegExp, filter: (t: Track) => boolean = feedable) =>
  ctx.project.tracks.find((t) => filter(t) && re.test(t.name));

/** The drop lands on the bar the playhead is heading into. It is NEVER pushed later to
 *  make the 8-bar build fit — a short project trims the build (see `leadInRange`). */
const dropBarParam = (): ParamDef => ({
  key: "dropBar",
  label: "Drop at bar",
  kind: "number",
  min: 2,
  max: 999,
  step: 1,
  default: landingBar,
});

/* ============================================================================
 * 1. The Drop — the complete EDM transition (8 stages)
 * ========================================================================= */

const theDrop: TechniqueDef = {
  id: "the-drop",
  category: "macros",
  title: "The Drop",
  tagline: "Riser, roll, sweep, silence, impact — the whole transition.",
  description:
    "Every classic drop ingredient, built in order around one bar you choose: a noise " +
    "riser climbing into it, an accelerating roll, a stereo sweep, the half-beat of " +
    "silence, a sub impact ON the downbeat with a rumbling tail, a downlifter clearing " +
    "the stage after — and a marker so the moment stays findable. Each stage stands " +
    "alone; together they are the drop.",
  requirements: () => [],
  stages: [
    {
      id: "riser-src",
      title: "Riser source",
      reveal: "timeline",
      summary: "Adds the “Riser” track (noise PolySynth, filter closed) holding into the drop bar.",
      manual:
        "Instrument track + PolySynth: Noise ~85%, Cutoff low, full sustain; one note ending " +
        "exactly on the drop bar (8 bars is classic).",
      params: [dropBarParam()],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const { start, end, bars } = leadInRange(ctx, params.dropBar as number, 8);
        const track = await newTrack(tx, "instrument", "Riser");
        const synth = await addInsert(tx, track.id, "builtin:polysynth", {
          Noise: 0.85, "Osc Mix": 0, Sub: 0, Cutoff: 220, Resonance: 0.35,
          "Amp Attack": 5, "Amp Sustain": 1, "Amp Release": 350, Gain: -10,
        });
        const clip = await newMidiClip(tx, track.id, start, end - start);
        await addNotes(tx, clip.id, [{ pitch: 48, velocity: 100, startBeat: 0, lengthBeats: end - start }]);
        state.drop = end;
        state.riserStart = start;
        state.riserTrackId = track.id;
        state.riserInstanceId = synth.instanceId;
        state.macroTracks = [track.id];
        return {
          commands: tx.count,
          note: `Riser holds from beat ${start} into bar ${params.dropBar}.` + trimNote(bars, 8),
        };
      },
    },
    {
      id: "riser-motion",
      title: "Riser motion",
      reveal: "timeline",
      summary: "Cutoff 120 Hz → 12 kHz and Gain −14 → −2 dB ramps, bent toward the drop.",
      manual: "Automate the riser synth's Cutoff and Gain rising across the riser, curves bent late.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const trackId = state.riserTrackId as number | undefined;
        const instanceId = state.riserInstanceId as number | undefined;
        if (trackId === undefined || instanceId === undefined)
          throw new Error("Run “Riser source” first.");
        const start = state.riserStart as number;
        const end = state.drop as number;
        const uid = "builtin:polysynth";
        await ramp(tx, trackId, pluginParamRef(instanceId, await paramIdByName(instanceId, "Cutoff")), [
          { t: start, v: normFor(uid, "Cutoff", 120), curve: 0.5 },
          { t: end, v: normFor(uid, "Cutoff", 12000) },
        ]);
        await ramp(tx, trackId, pluginParamRef(instanceId, await paramIdByName(instanceId, "Gain")), [
          { t: start, v: normFor(uid, "Gain", -14), curve: 0.4 },
          { t: end, v: normFor(uid, "Gain", -2) },
        ]);
        return { commands: tx.count, note: "The riser now actually rises." };
      },
    },
    {
      id: "roll",
      title: "Noise roll",
      reveal: "pianoRoll",
      summary:
        "Adds a “Roll” track (PolySynth noise-snare patch) with 1/8 → 1/16 → 1/32 hits " +
        "accelerating through the last 2 bars, velocities climbing.",
      manual:
        "Short-decay noise patch on its own track; hits at 1/8s for a bar, then 1/16s, then " +
        "1/32s into the drop, velocities 60 → 127.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const end = state.drop as number | undefined;
        if (end === undefined) throw new Error("Run “Riser source” first (it fixes the drop bar).");
        const len = 2 * ctx.beatsPerBar;
        const start = Math.max(0, end - len);
        const track = await newTrack(tx, "instrument", "Roll");
        await addInsert(tx, track.id, "builtin:polysynth", {
          Noise: 1, "Osc Mix": 0, Cutoff: 6000, "Amp Attack": 1, "Amp Decay": 90,
          "Amp Sustain": 0, "Amp Release": 60, Gain: -8,
        });
        const notes: NoteInput[] = [];
        const spans: Array<[number, number, number]> = [
          [0, len * 0.5, 0.5], [len * 0.5, len * 0.75, 0.25], [len * 0.75, len, 0.125],
        ];
        for (const [from, to, step] of spans)
          for (let b = from; b < to - 1e-9; b += step)
            notes.push({ pitch: 60, velocity: Math.round(60 + (67 * b) / len), startBeat: b, lengthBeats: step * 0.9 });
        const clip = await newMidiClip(tx, track.id, start, len);
        await addNotes(tx, clip.id, notes);
        focusMidiClip(clip.id);
        (state.macroTracks as number[]).push(track.id);
        return { commands: tx.count, note: `${notes.length} accelerating hits into the drop.` };
      },
    },
    {
      id: "sweep",
      title: "Stereo sweep",
      reveal: "timeline",
      summary: "A 1-bar “Sweep” noise crossing hard-left → hard-right while its filter opens.",
      manual: "Pure-noise track for the final bar: pan automation −80% → +80%, cutoff opening.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const end = state.drop as number | undefined;
        if (end === undefined) throw new Error("Run “Riser source” first.");
        const start = Math.max(0, end - ctx.beatsPerBar);
        const track = await newTrack(tx, "instrument", "Sweep");
        const synth = await addInsert(tx, track.id, "builtin:polysynth", {
          Noise: 1, "Osc Mix": 0, Cutoff: 1200, "Amp Attack": 10, "Amp Sustain": 1,
          "Amp Release": 250, Gain: -12,
        });
        const clip = await newMidiClip(tx, track.id, start, end - start);
        await addNotes(tx, clip.id, [{ pitch: 60, velocity: 100, startBeat: 0, lengthBeats: end - start }]);
        await ramp(tx, track.id, pluginParamRef(synth.instanceId, await paramIdByName(synth.instanceId, "Cutoff")), [
          { t: start, v: normFor("builtin:polysynth", "Cutoff", 400), curve: 0.4 },
          { t: end, v: normFor("builtin:polysynth", "Cutoff", 14000) },
        ]);
        await ramp(tx, track.id, "pan", [{ t: start, v: -0.8 }, { t: end, v: 0.8 }]);
        (state.macroTracks as number[]).push(track.id);
        return { commands: tx.count, note: "Whoosh crosses the field into the downbeat." };
      },
    },
    {
      id: "silence",
      title: "Pre-drop silence",
      reveal: "timeline",
      optional: true,
      summary:
        "Mutes a 1/8-beat slice of every OTHER track right before the drop (the macro's own " +
        "riser/roll/sweep keep playing — they ARE the build).",
      manual:
        "Split all backing clips at (drop − 1/8) and at the drop; mute the slivers. Leave the " +
        "riser family untouched.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const drop = state.drop as number | undefined;
        if (drop === undefined) throw new Error("Run “Riser source” first.");
        const gapStart = drop - 0.5;
        const own = new Set((state.macroTracks as number[]) ?? []);
        let muted = 0;
        for (const t of ctx.project.tracks) {
          if (own.has(t.id) || !feedable(t)) continue;
          for (const clip of [...t.clips]) {
            const cEnd = clipEndBeat(clip, ctx.project);
            if (clip.startBeat >= drop || cEnd <= gapStart) continue;
            let midId = clip.id;
            if (clip.startBeat < gapStart) {
              const s = await tx.cmd(splitClips([midId], gapStart));
              if (s.newClipIds[0] === undefined) continue;
              midId = s.newClipIds[0];
            }
            if (cEnd > drop) await tx.cmd(splitClips([midId], drop));
            await tx.cmd(setClip(midId, { muted: true }));
            muted++;
          }
        }
        if (muted === 0)
          throw new Error("No backing clips span the gap — nothing to silence (skip this stage).");
        return { commands: tx.count, note: `${muted} sliver(s) muted — dead air, then the hit.` };
      },
    },
    {
      id: "impact",
      title: "Impact & rumble",
      reveal: "timeline",
      summary: "Sub boom (sine + sub) ON the drop, sent −6 dB into a huge 100%-wet “Impact Verb” bus.",
      manual: "Low sine C1 right on the downbeat, 2 beats, into a near-max reverb at 100% wet.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const drop = state.drop as number | undefined;
        if (drop === undefined) throw new Error("Run “Riser source” first.");
        const track = await newTrack(tx, "instrument", "Impact");
        await addInsert(tx, track.id, "builtin:polysynth", {
          "Osc 1 Wave": 3, "Osc Mix": 0, Sub: 0.6, Noise: 0.06, Cutoff: 320,
          "Amp Attack": 1, "Amp Decay": 900, "Amp Sustain": 0.35, "Amp Release": 1200, Gain: -4,
        });
        const clip = await newMidiClip(tx, track.id, drop, 2);
        await addNotes(tx, clip.id, [{ pitch: 24, velocity: 127, startBeat: 0, lengthBeats: 2 }]);
        const bus = await newTrack(tx, "bus", "Impact Verb");
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.92, Damp: 0.5, Mix: 100 });
        await sendTo(tx, ctx.project, track.id, bus.id, dbToLin(-6));
        (state.macroTracks as number[]).push(track.id, bus.id);
        return { commands: tx.count, note: "The downbeat now lands with weight and tail." };
      },
    },
    {
      id: "downlifter",
      title: "Downlifter",
      reveal: "timeline",
      optional: true,
      summary: "Airy noise falling away over 4 bars AFTER the drop — the release valve.",
      manual: "Open-filter noise starting ON the drop, cutoff and gain falling front-loaded.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const drop = state.drop as number | undefined;
        if (drop === undefined) throw new Error("Run “Riser source” first.");
        const len = 4 * ctx.beatsPerBar;
        const track = await newTrack(tx, "instrument", "Downlifter");
        const synth = await addInsert(tx, track.id, "builtin:polysynth", {
          Noise: 0.75, "Osc Mix": 0, Cutoff: 9000, "Amp Attack": 5, "Amp Sustain": 1,
          "Amp Release": 500, Gain: -12,
        });
        const clip = await newMidiClip(tx, track.id, drop, len);
        await addNotes(tx, clip.id, [{ pitch: 48, velocity: 90, startBeat: 0, lengthBeats: len }]);
        const uid = "builtin:polysynth";
        await ramp(tx, track.id, pluginParamRef(synth.instanceId, await paramIdByName(synth.instanceId, "Cutoff")), [
          { t: drop, v: normFor(uid, "Cutoff", 9000), curve: -0.5 },
          { t: drop + len, v: normFor(uid, "Cutoff", 150) },
        ]);
        await ramp(tx, track.id, pluginParamRef(synth.instanceId, await paramIdByName(synth.instanceId, "Gain")), [
          { t: drop, v: normFor(uid, "Gain", -6), curve: -0.4 },
          { t: drop + len, v: normFor(uid, "Gain", -18) },
        ]);
        (state.macroTracks as number[]).push(track.id);
        return { commands: tx.count, note: "The air falls away after the hit." };
      },
    },
    {
      id: "mark",
      title: "Mark it",
      reveal: "timeline",
      summary: "A “DROP” marker on the downbeat.",
      manual: "Marker named DROP on the drop bar.",
      run: async (_ctx, _p, state) => {
        const tx = new Tx();
        const drop = state.drop as number | undefined;
        if (drop === undefined) throw new Error("Run “Riser source” first.");
        await tx.cmd(addMarker(drop, "DROP"));
        return { commands: tx.count, note: "DROP marked — the whole transition is in place." };
      },
    },
  ],
};

/* ============================================================================
 * 2. Full Vocal Chain (7 stages)
 * ========================================================================= */

function vcTrack(ctx: TechniqueCtx, state: Record<string, unknown>): Track {
  const t =
    ctx.project.tracks.find((x) => x.id === (state.vcTrackId as number)) ??
    ctx.project.tracks.find((x) => x.id === ctx.selection.trackIds[0] && audioLike(x));
  if (!t) throw new Error("Run “Pick & gate” first (it fixes which track the chain builds on).");
  return t;
}

const vocalChain: TechniqueDef = {
  id: "vocal-chain",
  category: "macros",
  title: "Full Vocal Chain",
  tagline: "Raw take → produced lead, one guided pass.",
  description:
    "The complete modern vocal treatment in order: gate the room out, clean the tone, " +
    "control the dynamics, add harmonic heat, spread doubles left and right, seat it in " +
    "an EQ'd ducked reverb, and throw the last phrase into a tempo delay. Each stage is " +
    "a technique the catalog teaches alone — this runs the whole chain.",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(audioLike), label: "A vocal track (audio or instrument)" },
  ],
  stages: [
    {
      id: "gate",
      title: "Pick & gate",
      reveal: "mixer",
      summary: "Gentle noise gate on the chosen vocal (Range −18 dB — quieter gaps, not dead ones).",
      manual: "Stock Noise Gate: threshold just over the room (−45), hold 90 ms, Range −18 dB.",
      params: [
        {
          key: "trackId",
          label: "Vocal track",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const trackId = params.trackId as number;
        if (!ctx.project.tracks.some((t) => t.id === trackId)) throw new Error("Pick the vocal track.");
        await addInsert(tx, trackId, "builtin:gate", {
          Threshold: -45, Attack: 0.5, Hold: 90, Release: 150, Range: -18,
        });
        state.vcTrackId = trackId;
        return { commands: tx.count, note: "Room noise steps out between phrases." };
      },
    },
    {
      id: "clean",
      title: "Clean",
      reveal: "mixer",
      summary: "Channel EQ: low cut 90 Hz + −2.5 dB mud dip at 300 Hz.",
      manual: "Low cut ~90 Hz; gentle dip around 300 Hz where closeness reads as mud.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const t = vcTrack(ctx, state);
        await setEqBands(tx, t.id, [
          eqLowCut(90),
          { enabled: true, type: 0, freqHz: 300, gainDb: -2.5, q: 1.3 },
        ]);
        return { commands: tx.count, note: "Rumble gone, mud dipped." };
      },
    },
    {
      id: "control",
      title: "Control",
      reveal: "mixer",
      summary: "Compressor 3:1, 8 ms attack, 120 ms release, ~4 dB working, +2.5 makeup.",
      manual: "3:1, attack ~8 ms, release ~120 ms; threshold until loud lines lose ~4 dB.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const t = vcTrack(ctx, state);
        await addInsert(tx, t.id, "builtin:compressor", {
          Threshold: -22, Ratio: 3, Attack: 8, Release: 120, Knee: 9, Makeup: 2.5,
        });
        return { commands: tx.count, note: "Dynamics ride tamed." };
      },
    },
    {
      id: "heat",
      title: "Heat",
      reveal: "mixer",
      summary: "Stock Saturator: Drive 10 dB, Tone 8.5 kHz, Mix 60% — harmonics instead of volume.",
      manual: "Saturator after the comp: moderate drive, tone pulled down, mix ~60%.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const t = vcTrack(ctx, state);
        await addInsert(tx, t.id, "builtin:saturator", { Drive: 10, Tone: 8500, Mix: 60, Output: -4 });
        return { commands: tx.count, note: "The vocal cuts without getting louder." };
      },
    },
    {
      id: "doubles",
      title: "Doubles",
      reveal: "timeline",
      summary:
        "Two deep copies panned ±60%, −4 dB, offset 10/22 ms, high-passed at 160 Hz — the spread.",
      manual:
        "Duplicate twice; pan L/R, drop 4 dB, nudge each copy a different 10–25 ms late, " +
        "low-cut the doubles ~160 Hz.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const src = vcTrack(ctx, state);
        const mkDouble = async (tag: string, pan: number, ms: number) => {
          const copy = (await tx.cmd(duplicateTrack(src.id))).track;
          await tx.cmd(setTrack(copy.id, { name: `${src.name} (${tag})`, pan, volume: src.volume * dbToLin(-4) }));
          const ids = copy.clips.map((c) => c.id);
          if (ids.length > 0) await tx.cmd(moveClips(ids, msToBeats(ms, ctx.bpm)));
          await setEqBands(tx, copy.id, [eqLowCut(160)]);
        };
        await mkDouble("dbl L", -0.6, 10);
        await mkDouble("dbl R", 0.6, 22);
        return { commands: tx.count, note: "Lead centered, doubles flanking." };
      },
    },
    {
      id: "space",
      title: "Space",
      reveal: "mixer",
      summary:
        "“Vocal Verb” bus (low cut 550 / high cut 10k, 100% wet), send at −10 dB, verb " +
        "compressor KEYED from the dry vocal.",
      manual:
        "EQ'd 100%-wet reverb bus; send ~−10 dB; compressor on the bus sidechained from the " +
        "vocal so the tail blooms only in the gaps.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const t = vcTrack(ctx, state);
        const bus = await newTrack(tx, "bus", "Vocal Verb");
        await setEqBands(tx, bus.id, [eqLowCut(550), eqHighCut(10000)]);
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.68, Damp: 0.35, Mix: 100 });
        await sendTo(tx, ctx.project, t.id, bus.id, dbToLin(-10));
        const comp = await addInsert(tx, bus.id, "builtin:compressor", {
          Threshold: -32, Ratio: 4, Attack: 5, Release: 160,
        });
        await tx.cmd(setPlugin(comp.instanceId, { sidechainSource: t.id }));
        return { commands: tx.count, note: "Lush, and out of the way while the singer sings." };
      },
    },
    {
      id: "throw",
      title: "Throw the last phrase",
      reveal: "timeline",
      optional: true,
      summary:
        "Ping-pong delay bus (dotted-1/8 at tempo); the vocal's LAST clip gets a send spike " +
        "over its final beat — the tail echoes into the gap.",
      manual:
        "100%-wet ping-pong delay bus; send automation spike over the last beat of the final " +
        "phrase clip.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const t = vcTrack(ctx, state);
        const clips = t.clips.filter((c) => c.type === "audio");
        const last = clips.sort((a, b) => a.startBeat - b.startBeat)[clips.length - 1];
        if (!last) throw new Error("The vocal track has no audio clips to throw — skip this stage.");
        const bus = await newTrack(tx, "bus", "Throw Delay");
        await setEqBands(tx, bus.id, [eqLowCut(250)]);
        await addInsert(tx, bus.id, "builtin:delay", {
          Time: Math.min(2000, (60000 / ctx.bpm) * 0.75), Feedback: 55, Mix: 100, Tone: 6000, "Ping-Pong": 1,
        });
        const sendIndex = await sendTo(tx, ctx.project, t.id, bus.id, 0);
        const end = clipEndBeat(last, ctx.project);
        const start = Math.max(last.startBeat, end - 1);
        await ramp(tx, t.id, `send:${sendIndex}`, [
          { t: Math.max(0, start - 0.05), v: 0 }, { t: start, v: 1 }, { t: end, v: 1 }, { t: end + 0.1, v: 0 },
        ]);
        return { commands: tx.count, note: "The last word rings into the silence." };
      },
    },
  ],
};

/* ============================================================================
 * 3. Radio-Ready Master (6 stages)
 * ========================================================================= */

const STEM_ROUTES: Array<[string, RegExp]> = [
  ["Drums", /kick|snare|drum|perc|hat|tom|clap/i],
  ["Bass", /bass|sub\b/i],
  ["Vocals", /voc|vox|voice|sing|lead vox|choir/i],
];

const radioMaster: TechniqueDef = {
  id: "radio-master",
  category: "macros",
  title: "Radio-Ready Master",
  tagline: "Headroom → stems → glue → color → ceiling, in the right order.",
  description:
    "The finishing sequence, taught by doing it in order: reclaim headroom at the " +
    "sources, organize the mix into stem buses (routed by track name), glue the drums, " +
    "add console color, glue the whole mix gently, and close with a −1 dB ceiling and a " +
    "MEASURED loudness pass. The order is the lesson.",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(feedable), label: "Tracks to master" },
  ],
  stages: [
    {
      id: "headroom",
      title: "Headroom",
      reveal: "mixer",
      summary: "Every source fader −6 dB (balances intact), master back to unity.",
      manual: "Pull every fader down 6 dB together; master to 0 dB. Loudness comes at the end.",
      run: async (ctx) => {
        const tx = new Tx();
        const targets = ctx.project.tracks.filter(feedable);
        if (targets.length === 0) throw new Error("No tracks to trim.");
        for (const t of targets) await tx.cmd(setTrack(t.id, { volume: t.volume * dbToLin(-6) }));
        await tx.cmd(setTrack(ctx.project.masterTrack.id, { volume: 1 }));
        return { commands: tx.count, note: `${targets.length} faders trimmed −6 dB; master at unity.` };
      },
    },
    {
      id: "stems",
      title: "Stem buses",
      reveal: "mixer",
      summary:
        "Creates Drums/Bass/Music/Vocals buses and routes every track by NAME (kick/snare→" +
        "Drums, bass→Bass, voc→Vocals, the rest→Music). The note lists who went where.",
      manual:
        "Four buses; set each track's output routing to its family. Name-based is a starting " +
        "point — re-route by hand where the guess is wrong.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const busFor = new Map<string, Track>();
        for (const name of ["Drums", "Bass", "Music", "Vocals"]) {
          const existing = ctx.project.tracks.find((t) => t.kind === "bus" && t.name === name);
          busFor.set(name, existing ?? (await newTrack(tx, "bus", name)));
        }
        const placed: string[] = [];
        for (const t of ctx.project.tracks) {
          if (!feedable(t)) continue;
          const family = STEM_ROUTES.find(([, re]) => re.test(t.name))?.[0] ?? "Music";
          await tx.cmd(setTrack(t.id, { outputTarget: busFor.get(family)!.id }));
          placed.push(`${t.name}→${family}`);
        }
        state.drumsBusId = busFor.get("Drums")!.id;
        return { commands: tx.count, note: placed.join(", ") || "no routable tracks" };
      },
    },
    {
      id: "drum-glue",
      title: "Drum glue",
      reveal: "mixer",
      summary: "Compressor on the Drums bus: 4:1, 10 ms attack, 150 ms release, ~3 dB working.",
      manual: "Serial glue on the drum stem: 4:1, attack lets transients through, release recovers between hits.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const bus =
          ctx.project.tracks.find((t) => t.id === (state.drumsBusId as number)) ??
          ctx.project.tracks.find((t) => t.kind === "bus" && t.name === "Drums");
        if (!bus) throw new Error("Run “Stem buses” first.");
        await addInsert(tx, bus.id, "builtin:compressor", {
          Threshold: -20, Ratio: 4, Attack: 10, Release: 150, Knee: 6, Makeup: 2,
        });
        return { commands: tx.count, note: "The kit gels into one instrument." };
      },
    },
    {
      id: "color",
      title: "Console color",
      reveal: "mixer",
      summary: "Stock Saturator on the master: Drive 6, Tone 15k, Mix 35%, Output −1.5 dB.",
      manual: "Gentle saturation blended low on the 2-bus — glue you feel, not hear.",
      run: async (ctx) => {
        const tx = new Tx();
        await addInsert(tx, ctx.project.masterTrack.id, "builtin:saturator", {
          Drive: 6, Tone: 15000, Mix: 35, Output: -1.5,
        });
        return { commands: tx.count, note: "Console color across the mix." };
      },
    },
    {
      id: "glue",
      title: "Mix glue",
      reveal: "mixer",
      summary: "Master compressor 2:1, 30 ms attack, 250 ms release, soft knee — 1–2 dB working.",
      manual: "The classic 2-bus glue: slow attack, low ratio, threshold to 1–2 dB of reduction.",
      run: async (ctx) => {
        const tx = new Tx();
        await addInsert(tx, ctx.project.masterTrack.id, "builtin:compressor", {
          Threshold: -14, Ratio: 2, Attack: 30, Release: 250, Knee: 12, Makeup: 1.5,
        });
        return { commands: tx.count, note: "The mix moves as one thing." };
      },
    },
    {
      id: "ceiling",
      title: "Ceiling & measure",
      reveal: "mixer",
      summary: "Limiter at −1 dB closes the chain; Export opens for a MEASURED −14 LUFS pass.",
      manual:
        "Limiter last, ceiling −1 dB. Render with the −14 LUFS target and READ the measured " +
        "numbers; adjust upstream, not the limiter.",
      run: async (ctx) => {
        const tx = new Tx();
        await addInsert(tx, ctx.project.masterTrack.id, "builtin:limiter", { Ceiling: -1, Release: 120 });
        useStore.getState().setDialogs({ export: true });
        return { commands: tx.count, note: "Chain closed — export with −14 LUFS and read the numbers." };
      },
    },
  ],
};

/* ============================================================================
 * 4. Drum Kit Makeover (7 stages)
 * ========================================================================= */

function drumTracks(ctx: TechniqueCtx, state: Record<string, unknown>): Track[] {
  const ids = (state.dkTrackIds as number[]) ?? [];
  const picked = ctx.project.tracks.filter((t) => ids.includes(t.id));
  if (picked.length > 0) return picked;
  const selected = ctx.project.tracks.filter(
    (t) => ctx.selection.trackIds.includes(t.id) && feedable(t),
  );
  if (selected.length > 0) return selected;
  return ctx.project.tracks.filter((t) => feedable(t) && /kick|snare|drum|perc|hat|tom|clap/i.test(t.name));
}

const drumMakeover: TechniqueDef = {
  id: "drum-makeover",
  category: "macros",
  title: "Drum Kit Makeover",
  tagline: "Bus, glue, crush, gated snare, ghosts, groove, pump.",
  description:
    "Everything the catalog knows about drums, applied as one pass: route the kit " +
    "through a bus, glue it, blend a crushed parallel copy, gate-verb the snare, tuck " +
    "ghost notes into the MIDI, humanize the grid — and pump the bass against the kick. " +
    "Select your drum tracks first (or let it find them by name).",
  requirements: (ctx) => [
    {
      ok:
        ctx.selection.trackIds.some((id) => ctx.project.tracks.some((t) => t.id === id && feedable(t))) ||
        ctx.project.tracks.some((t) => feedable(t) && /kick|snare|drum|perc|hat/i.test(t.name)),
      label: "Drum tracks — selected, or findable by name (kick/snare/drum/perc/hat)",
    },
  ],
  stages: [
    {
      id: "bus",
      title: "Bus & route",
      reveal: "mixer",
      summary: "“Drum Bus” created; every selected (or name-matched) drum track routes through it.",
      manual: "One bus; each drum track's output routing set to it.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const drums = drumTracks(ctx, state);
        if (drums.length === 0) throw new Error("Select the drum tracks (or name them kick/snare/…).");
        const bus = await newTrack(tx, "bus", "Drum Bus");
        for (const t of drums) await tx.cmd(setTrack(t.id, { outputTarget: bus.id }));
        state.dkTrackIds = drums.map((t) => t.id);
        state.dkBusId = bus.id;
        return { commands: tx.count, note: `${drums.length} drum track(s) through the bus.` };
      },
    },
    {
      id: "glue",
      title: "Glue",
      reveal: "mixer",
      summary: "4:1 compressor on the Drum Bus, ~3 dB working.",
      manual: "Serial glue: 4:1, 10 ms attack, 150 ms release.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const bus = ctx.project.tracks.find((t) => t.id === (state.dkBusId as number));
        if (!bus) throw new Error("Run “Bus & route” first.");
        await addInsert(tx, bus.id, "builtin:compressor", {
          Threshold: -20, Ratio: 4, Attack: 10, Release: 150, Knee: 6, Makeup: 2,
        });
        return { commands: tx.count, note: "Kit glued." };
      },
    },
    {
      id: "crush",
      title: "Parallel crush",
      reveal: "mixer",
      summary: "“Crush” bus (12:1 smashed comp), full-level sends from every drum track, blended at −12 dB.",
      manual: "NY compression: full sends into a deliberately over-compressed bus, faded in low.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const drums = drumTracks(ctx, state);
        if (drums.length === 0) throw new Error("Run “Bus & route” first.");
        const crush = await newTrack(tx, "bus", "Crush");
        await addInsert(tx, crush.id, "builtin:compressor", {
          Threshold: -38, Ratio: 12, Attack: 0.4, Release: 90, Knee: 0, Makeup: 8,
        });
        for (const t of drums) await sendTo(tx, ctx.project, t.id, crush.id, 1.0);
        await tx.cmd(setTrack(crush.id, { volume: dbToLin(-12) }));
        return { commands: tx.count, note: "Crushed copy underneath — density without losing transients." };
      },
    },
    {
      id: "snare-verb",
      title: "Gated snare verb",
      reveal: "mixer",
      optional: true,
      summary: "“Gate Verb” bus (big verb → hard gate); the snare-est track sends −6 dB into it.",
      manual: "Reverb into a noise gate (full range, ~120 ms hold); send the snare.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const drums = drumTracks(ctx, state);
        const snare = drums.find((t) => /snare|clap/i.test(t.name)) ?? drums[0];
        if (!snare) throw new Error("Run “Bus & route” first.");
        const bus = await newTrack(tx, "bus", "Gate Verb");
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.85, Damp: 0.15, Mix: 100 });
        await addInsert(tx, bus.id, "builtin:gate", {
          Threshold: -35, Attack: 0.3, Hold: 120, Release: 60, Range: -80,
        });
        await sendTo(tx, ctx.project, snare.id, bus.id, dbToLin(-6));
        return { commands: tx.count, note: `“${snare.name}” blooms huge and stops dead — the 80s snare.` };
      },
    },
    {
      id: "ghosts",
      title: "Ghost notes",
      reveal: "pianoRoll",
      optional: true,
      summary: "Vel-25 hits on empty 1/16 slots of the first MIDI drum clip found.",
      manual: "Quiet in-between snare taps next to the real hits — the groove's connective tissue.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const drums = drumTracks(ctx, state);
        const withMidi = drums.flatMap((t) => t.clips.filter((c) => c.type === "midi" && c.notes.length > 0));
        const clip = withMidi[0];
        if (!clip || clip.type !== "midi")
          throw new Error("No MIDI drum clip found — skip this stage (audio drums don't take ghosts).");
        const occupied = (slot: number) => clip.notes.some((n) => Math.abs(n.startBeat - slot) < 0.12);
        const neighbor = (slot: number) => clip.notes.some((n) => n.velocity > 60 && Math.abs(n.startBeat - slot) <= 0.26);
        const add: NoteInput[] = [];
        for (let slot = 0; slot < clip.lengthBeats - 1e-9 && add.length < 96; slot += 0.25)
          if (!occupied(slot) && neighbor(slot))
            add.push({ pitch: 38, velocity: 22 + ((add.length % 3) * 4), startBeat: slot, lengthBeats: 0.12 });
        if (add.length === 0) throw new Error("No empty neighboring slots — skip this stage.");
        await tx.cmd(editNotes(clip.id, { add }));
        focusMidiClip(clip.id);
        state.dkClipId = clip.id;
        return { commands: tx.count, note: `${add.length} ghosts tucked in.` };
      },
    },
    {
      id: "groove",
      title: "Humanize",
      reveal: "pianoRoll",
      optional: true,
      summary: "Off-beat 8ths pushed 12 ms late + downbeat/off-beat velocity re-accents on that clip.",
      manual: "Swing the off-beats late a hair; accent the downbeats, soften the in-betweens.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const found = resolveMidiClip(ctx, state.dkClipId as number | undefined);
        if (!found) throw new Error("Run “Ghost notes” first (it picks the clip) — or skip.");
        const late = msToBeats(12, ctx.bpm);
        const updates = found.clip.notes.map((n) => {
          const off8 = Math.abs((n.startBeat % 1) - 0.5) < 0.06;
          const onBeat = Math.abs(n.startBeat - Math.round(n.startBeat)) < 0.1;
          return {
            noteId: n.id,
            patch: {
              startBeat: Math.max(0, n.startBeat + (off8 ? late : 0)),
              velocity: Math.min(127, Math.max(1, n.velocity + (onBeat ? 10 : -6))),
            },
          };
        });
        await tx.cmd(editNotes(found.clip.id, { update: updates }));
        return { commands: tx.count, note: "The grid breathes." };
      },
    },
    {
      id: "pump",
      title: "Pump the bass",
      reveal: "mixer",
      optional: true,
      summary: "Compressor on the bass-named track, KEYED from the kick-named track (tempo-timed release).",
      manual: "Sidechain the bass to the kick: fast attack, release ≈ a third of a beat, 6:1.",
      run: async (ctx) => {
        const tx = new Tx();
        const bass = byName(ctx, /bass|sub\b/i);
        const kick = byName(ctx, /kick/i);
        if (!bass || !kick)
          throw new Error("Need a bass-named and kick-named track — skip, or run Sidechain Pump directly.");
        const releaseMs = Math.min(400, Math.max(60, (60000 / ctx.bpm) * 0.35));
        const comp = await addInsert(tx, bass.id, "builtin:compressor", {
          Threshold: -30, Ratio: 6, Attack: 0.3, Release: releaseMs, Makeup: 3,
        });
        await tx.cmd(setPlugin(comp.instanceId, { sidechainSource: kick.id }));
        return { commands: tx.count, note: `“${bass.name}” now ducks with “${kick.name}”.` };
      },
    },
  ],
};

/* ============================================================================
 * 5. Vocal Hook Factory (6 stages)
 * ========================================================================= */

const hookFactory: TechniqueDef = {
  id: "hook-factory",
  category: "macros",
  title: "Vocal Hook Factory",
  tagline: "One phrase → sampler kit, chops, riser, echoes, wet room, gate groove.",
  description:
    "Turns a single recorded phrase into a full chopped hook arrangement: a sampler kit, " +
    "a syncopated chop pattern, a pitch-riser into the next bar, echoing tails, its own " +
    "wet FX room, and a rhythmic gate over the sustains. The whole modern vocal-hook " +
    "sound from one clip.",
  requirements: (ctx) => [
    { ok: allAudioClips(ctx).length > 0, label: "An audio clip to sample (the phrase)" },
  ],
  stages: [
    {
      id: "kit",
      title: "Sampler kit",
      reveal: "timeline",
      summary: "Create Sampler Track from the chosen clip (C3 = original pitch).",
      manual: "Right-click the clip ▸ Create Sampler Track.",
      params: [
        {
          key: "clipId",
          label: "Sample this clip",
          kind: "clip",
          default: (ctx) => resolveAudioClip(ctx, undefined)?.clip.id ?? 0,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the phrase clip.");
        const r = await tx.cmd(createSamplerTrack(found.clip.id));
        state.hfTrackId = r.trackId;
        state.hfInstanceId = r.instanceId;
        state.hfStart = found.clip.startBeat;
        return { commands: tx.count, note: "Kit ready — the phrase is an instrument now." };
      },
    },
    {
      id: "pattern",
      title: "Chop pattern",
      reveal: "pianoRoll",
      summary: "One-bar syncopated chop pattern (pentatonic-safe jumps) + snappy sampler envelope.",
      manual: "1-bar pattern around C3: root, fourth, fifth, octave; Loop off, fast attack, short release.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const trackId = state.hfTrackId as number | undefined;
        const instanceId = state.hfInstanceId as number | undefined;
        if (trackId === undefined || instanceId === undefined) throw new Error("Run “Sampler kit” first.");
        const start = (state.hfStart as number) ?? 0;
        const steps: Array<[number, number, number, number]> = [
          [0, 0, 0.5, 112], [0.75, 12, 0.25, 96], [1, 7, 0.5, 104], [1.75, 0, 0.25, 88],
          [2, 5, 0.75, 108], [3, 0, 0.5, 100], [3.5, 7, 0.5, 92],
        ];
        const clip = await newMidiClip(tx, trackId, start, ctx.beatsPerBar);
        await addNotes(tx, clip.id, steps.map(([b, s, l, v]) => ({ pitch: 60 + s, velocity: v, startBeat: b, lengthBeats: l })));
        for (const [name, value] of Object.entries({ Loop: 0, Attack: 1, Release: 90 })) {
          const id = await paramIdByName(instanceId, name);
          await tx.cmd(setPluginParam(instanceId, id, normFor("builtin:sampler", name, value)));
        }
        focusMidiClip(clip.id);
        state.hfPatternClipId = clip.id;
        state.hfPatternStart = start;
        return { commands: tx.count, note: "Chops in — edit them like any MIDI." };
      },
    },
    {
      id: "riser",
      title: "Pitch riser",
      reveal: "pianoRoll",
      summary: "Ascending 8ths climbing the scale through the NEXT bar, velocities rising.",
      manual: "Straight 8ths, root → octave, velocity 80 → 127, the bar after the pattern.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const trackId = state.hfTrackId as number | undefined;
        if (trackId === undefined) throw new Error("Run “Sampler kit” first.");
        const bar = ctx.beatsPerBar;
        const start = ((state.hfPatternStart as number) ?? 0) + bar;
        const scaleUp = [0, 2, 4, 5, 7, 9, 11, 12];
        const steps = Math.max(4, Math.floor(bar * 2));
        const clip = await newMidiClip(tx, trackId, start, bar);
        await addNotes(tx, clip.id, Array.from({ length: steps }, (_, i) => ({
          pitch: 60 + scaleUp[Math.min(scaleUp.length - 1, Math.floor((i * scaleUp.length) / steps))],
          velocity: Math.round(80 + (47 * i) / Math.max(1, steps - 1)),
          startBeat: i * 0.5,
          lengthBeats: 0.4,
        })));
        return { commands: tx.count, note: "The chops climb into the next section." };
      },
    },
    {
      id: "echoes",
      title: "Echo tails",
      reveal: "pianoRoll",
      summary: "Dotted-1/8 note echoes (65% / 40% velocity) added inside the pattern clip.",
      manual: "Copy the pattern notes at +dotted-1/8 twice, quieter each time.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const found = resolveMidiClip(ctx, state.hfPatternClipId as number | undefined);
        if (!found) throw new Error("Run “Chop pattern” first.");
        const add: NoteInput[] = [];
        for (const tap of [1, 2]) {
          const vel = tap === 1 ? 0.65 : 0.4;
          for (const n of found.clip.notes) {
            const startBeat = n.startBeat + 0.75 * tap;
            if (startBeat >= found.clip.lengthBeats) continue;
            add.push({ pitch: n.pitch, velocity: Math.max(1, Math.round(n.velocity * vel)), startBeat, lengthBeats: Math.min(n.lengthBeats, 0.65) });
          }
        }
        if (add.length === 0) throw new Error("No room for echoes inside the clip.");
        await tx.cmd(editNotes(found.clip.id, { add }));
        return { commands: tx.count, note: `${add.length} echo notes shimmer behind the chops.` };
      },
    },
    {
      id: "room",
      title: "Wet room",
      reveal: "mixer",
      summary: "“Hook FX” bus — 1/8 ping-pong delay into a roomy reverb, both 100% wet; send −8 dB.",
      manual: "Delay (1/8, fb 35%) into reverb, both fully wet, on one bus; send the sampler in.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const trackId = state.hfTrackId as number | undefined;
        if (trackId === undefined) throw new Error("Run “Sampler kit” first.");
        const bus = await newTrack(tx, "bus", "Hook FX");
        await addInsert(tx, bus.id, "builtin:delay", {
          Time: Math.min(2000, 60000 / ctx.bpm / 2), Feedback: 35, Mix: 100, Tone: 5000, "Ping-Pong": 1,
        });
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.7, Damp: 0.4, Mix: 100 });
        await sendTo(tx, ctx.project, trackId, bus.id, dbToLin(-8));
        return { commands: tx.count, note: "The hook lives in its own wet room." };
      },
    },
    {
      id: "gate",
      title: "Gate groove",
      reveal: "timeline",
      optional: true,
      summary: "1/16 trance-gate volume pattern across the pattern bar on the sampler track.",
      manual: "Rhythmic volume automation: hold, sharp dip, pump back — every 16th across the bar.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const trackId = state.hfTrackId as number | undefined;
        if (trackId === undefined) throw new Error("Run “Sampler kit” first.");
        const start = (state.hfPatternStart as number) ?? 0;
        const end = start + ctx.beatsPerBar;
        const points: Array<{ t: number; v: number }> = [];
        for (let s = start; s < end - 1e-9 && points.length < 118; s += 0.25) {
          points.push({ t: s, v: 1 }, { t: s + 0.15, v: 1 }, { t: s + 0.17, v: 0.35 });
        }
        points.push({ t: end, v: 1 });
        await ramp(tx, trackId, "volume", points);
        return { commands: tx.count, note: "The sustains pulse in 16ths." };
      },
    },
  ],
};

/* ============================================================================
 * 6. Podcast Episode Prep (5 stages)
 * ========================================================================= */

const podcastPrep: TechniqueDef = {
  id: "podcast-prep",
  category: "macros",
  title: "Podcast Episode Prep",
  tagline: "Voice cleaned, bed ducked, loudness measured — ship it.",
  description:
    "The spoken-word finishing pass: gate the room out of the voice, give it the " +
    "broadcast presence chain, auto-duck the music bed under speech, set the opening " +
    "balance, and close with a limiter and a measured pass at −16 LUFS (the podcast " +
    "loudness convention).",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.filter(isMixerTrack).length >= 2, label: "A voice track and a music track" },
  ],
  stages: [
    {
      id: "gate",
      title: "Gate the voice",
      reveal: "mixer",
      summary: "Gentle noise gate on the voice (Range −18 dB).",
      manual: "Threshold just above the room tone; partial range so gaps get quieter, not dead.",
      params: [
        {
          key: "voiceId",
          label: "Voice track",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) =>
            byName(ctx, /voc|vox|voice|vo\b|host|mic/i, audioLike)?.id ?? defaultSelectedTrack(ctx, audioLike),
        },
        {
          key: "musicId",
          label: "Music bed",
          kind: "track",
          trackFilter: isMixerTrack,
          default: (ctx) =>
            byName(ctx, /music|bed|song|track/i, isMixerTrack)?.id ??
            ctx.project.tracks.find((t) => t.kind === "bus")?.id ??
            0,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const voiceId = params.voiceId as number;
        const musicId = params.musicId as number;
        if (!ctx.project.tracks.some((t) => t.id === voiceId)) throw new Error("Pick the voice track.");
        if (voiceId === musicId) throw new Error("Voice and music must differ.");
        await addInsert(tx, voiceId, "builtin:gate", {
          Threshold: -45, Attack: 0.5, Hold: 90, Release: 150, Range: -18,
        });
        state.ppVoiceId = voiceId;
        state.ppMusicId = musicId;
        return { commands: tx.count, note: "Room tone steps out between sentences." };
      },
    },
    {
      id: "presence",
      title: "Broadcast presence",
      reveal: "mixer",
      summary: "EQ (low cut 90, mud dip, +3 dB air shelf) + 3:1 compressor on the voice.",
      manual: "The vocal presence chain: clean, control, air — all on the voice channel.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const voiceId = state.ppVoiceId as number | undefined;
        if (voiceId === undefined || !ctx.project.tracks.some((t) => t.id === voiceId))
          throw new Error("Run “Gate the voice” first.");
        await setEqBands(tx, voiceId, [
          eqLowCut(90),
          { enabled: true, type: 0, freqHz: 300, gainDb: -2.5, q: 1.3 },
          { enabled: true, type: 2, freqHz: 10000, gainDb: 3, q: 0.7 },
        ]);
        await addInsert(tx, voiceId, "builtin:compressor", {
          Threshold: -22, Ratio: 3, Attack: 8, Release: 120, Knee: 9, Makeup: 2.5,
        });
        return { commands: tx.count, note: "The voice sits in front, evenly." };
      },
    },
    {
      id: "duck",
      title: "Duck the bed",
      reveal: "mixer",
      summary: "Compressor on the music, sidechained from the voice: −8 dB dips, 500 ms release.",
      manual: "Auto-duck: slow attack, long release, keyed from the voice — courtesy, not pumping.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const voiceId = state.ppVoiceId as number | undefined;
        const musicId = state.ppMusicId as number | undefined;
        if (voiceId === undefined || musicId === undefined) throw new Error("Run “Gate the voice” first.");
        const comp = await addInsert(tx, musicId, "builtin:compressor", {
          Threshold: -38, Ratio: 4, Attack: 15, Release: 500, Knee: 9,
        });
        await tx.cmd(setPlugin(comp.instanceId, { sidechainSource: voiceId }));
        return { commands: tx.count, note: "Music steps aside whenever the host speaks." };
      },
    },
    {
      id: "balance",
      title: "Opening balance",
      reveal: "mixer",
      summary: "Voice centered at unity; music bed set −8 dB as the resting level.",
      manual: "Voice pan center, fader 0; bed around −8 dB before the duck even happens.",
      run: async (ctx, _p, state) => {
        const tx = new Tx();
        const voiceId = state.ppVoiceId as number | undefined;
        const musicId = state.ppMusicId as number | undefined;
        if (voiceId === undefined || musicId === undefined) throw new Error("Run “Gate the voice” first.");
        await tx.cmd(setTrack(voiceId, { pan: 0, volume: 1 }));
        await tx.cmd(setTrack(musicId, { volume: dbToLin(-8) }));
        return { commands: tx.count, note: "Voice forward, bed behind." };
      },
    },
    {
      id: "loudness",
      title: "Ceiling & −16 LUFS",
      reveal: "mixer",
      summary: "Limiter at −1 dB on the master; Export opens — render with the −16 LUFS target.",
      manual: "Limiter last; export with −16 LUFS (podcast convention) and read the measured numbers.",
      run: async (ctx) => {
        const tx = new Tx();
        const existing = ctx.project.masterTrack.inserts.find((i) => i.uid === "builtin:limiter");
        if (existing) {
          const id = await paramIdByName(existing.instanceId, "Ceiling");
          await tx.cmd(setPluginParam(existing.instanceId, id, normFor("builtin:limiter", "Ceiling", -1)));
        } else {
          await addInsert(tx, ctx.project.masterTrack.id, "builtin:limiter", { Ceiling: -1, Release: 120 });
        }
        useStore.getState().setDialogs({ export: true });
        return { commands: tx.count, note: "Export opened — aim the render at −16 LUFS." };
      },
    },
  ],
};

export const macroTechniques: TechniqueDef[] = [
  theDrop,
  vocalChain,
  radioMaster,
  drumMakeover,
  hookFactory,
  podcastPrep,
];
