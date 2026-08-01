/**
 * Vocal production — Stereo Doubler, Delay Throw.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import { duplicateTrack, moveClips, setTrack } from "../../store/actions";
import type { Clip, Track } from "../../protocol/types";
import { clipEndBeat } from "../../lib/keyboard";
import {
  Tx,
  addInsert,
  allAudioClips,
  dbToLin,
  eqLowCut,
  msToBeats,
  newTrack,
  ramp,
  resolveAudioClip,
  sendTo,
  setEqBands,
} from "../ops";
import type { ParamDef, TechniqueCtx, TechniqueDef } from "../types";

const audioLike = (t: Track) => t.kind === "audio" || t.kind === "instrument";

const defaultSelectedTrack = (ctx: TechniqueCtx, filter: (t: Track) => boolean) => {
  const sel = ctx.project.tracks.find((t) => t.id === ctx.selection.trackIds[0]);
  return (sel && filter(sel) ? sel.id : ctx.project.tracks.find(filter)?.id) ?? 0;
};

/* ============================================================================
 * Stereo Doubler
 * ========================================================================= */

function findDoubles(ctx: TechniqueCtx, state: Record<string, unknown>): [Track, Track] {
  const l = ctx.project.tracks.find((t) => t.id === (state.doubleLeftId as number));
  const r = ctx.project.tracks.find((t) => t.id === (state.doubleRightId as number));
  if (l && r) return [l, r];
  const byName = ctx.project.tracks.filter((t) => /\(dbl [LR]\)$/.test(t.name));
  if (byName.length >= 2) return [byName[0], byName[1]];
  throw new Error("No doubles found — run the Copies stage first.");
}

const doubler: TechniqueDef = {
  id: "vocal-doubler",
  category: "vocal",
  title: "Stereo Doubler",
  tagline: "Main up the middle, doubles spread left and right.",
  description:
    "The doubled-vocal sound: copies of the part sit panned left and right a few dB under " +
    "the centered lead, slightly offset in time so they read as separate performances. " +
    "(Real second takes beat copies — record them when you can; this builds the spread.)",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some((t) => audioLike(t) && t.clips.length > 0),
      label: "An audio or instrument track with material to double",
    },
  ],
  stages: [
    {
      id: "copies",
      title: "Copies",
      reveal: "timeline",
      summary: "Duplicates the vocal track twice (deep copies) and names them (dbl L) / (dbl R).",
      manual:
        "Duplicate the vocal track twice (right-click ▸ Duplicate — clips, inserts and " +
        "settings come along). Name them so you can find them: “(dbl L)” and “(dbl R)”.",
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
        const src = ctx.project.tracks.find((t) => t.id === (params.trackId as number));
        if (!src) throw new Error("Pick the track to double.");
        const l = (await tx.cmd(duplicateTrack(src.id))).track;
        const r = (await tx.cmd(duplicateTrack(src.id))).track;
        await tx.cmd(setTrack(l.id, { name: `${src.name} (dbl L)` }));
        await tx.cmd(setTrack(r.id, { name: `${src.name} (dbl R)` }));
        state.doubleLeftId = l.id;
        state.doubleRightId = r.id;
        state.doubleSrcVolume = src.volume;
        return { commands: tx.count, note: `Two copies of “${src.name}” created.` };
      },
    },
    {
      id: "spread",
      title: "Spread",
      reveal: "mixer",
      summary:
        "Pans the doubles ±60%, drops them −4 dB under the lead, and offsets their clips " +
        "+10 ms / +22 ms so they stop phase-locking with the original.",
      manual:
        "Pan one double hard-ish left and the other right (±60%), pull both about −4 dB " +
        "below the lead, and nudge each double's clips a few milliseconds late (10–25 ms, " +
        "different per side) so they read as separate performances.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const [l, r] = findDoubles(ctx, state);
        const vol = ((state.doubleSrcVolume as number) ?? 1) * dbToLin(-4);
        await tx.cmd(setTrack(l.id, { pan: -0.6, volume: vol }));
        await tx.cmd(setTrack(r.id, { pan: 0.6, volume: vol }));
        const nudge = async (t: Track, ms: number) => {
          const ids = t.clips.map((c: Clip) => c.id);
          if (ids.length > 0) await tx.cmd(moveClips(ids, msToBeats(ms, ctx.bpm)));
        };
        await nudge(l, 10);
        await nudge(r, 22);
        return { commands: tx.count, note: "Doubles spread ±60%, −4 dB, offset 10/22 ms." };
      },
    },
    {
      id: "tone",
      title: "Tone",
      reveal: "mixer",
      optional: true,
      summary: "High-passes both doubles at 160 Hz so the low end stays the lead's alone.",
      manual:
        "On each double's channel EQ, enable a low cut around 160 Hz — stacked low end " +
        "muddies the center; the doubles only need to add width and air.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const [l, r] = findDoubles(ctx, state);
        await setEqBands(tx, l.id, [eqLowCut(160)]);
        await setEqBands(tx, r.id, [eqLowCut(160)]);
        return { commands: tx.count, note: "Doubles high-passed at 160 Hz." };
      },
    },
  ],
};

/* ============================================================================
 * Delay Throw
 * ========================================================================= */

function findThrowBus(ctx: TechniqueCtx, state: Record<string, unknown>): Track {
  const bus =
    ctx.project.tracks.find((t) => t.id === (state.throwBusId as number)) ??
    ctx.project.tracks.find((t) => t.kind === "bus" && /throw|delay/i.test(t.name));
  if (!bus) throw new Error("No throw-delay bus found — run the Bus stage first.");
  return bus;
}

/** Phrase-clip picker — defaults to the selected audio clip. */
const phraseParam: ParamDef = {
  key: "clipId",
  label: "Phrase clip",
  kind: "clip",
  default: (ctx) => resolveAudioClip(ctx, undefined)?.clip.id ?? 0,
  help: "The clip whose LAST beat gets thrown into the delay.",
};

const delayThrow: TechniqueDef = {
  id: "delay-throw",
  category: "vocal",
  title: "Delay Throw",
  tagline: "The last word of the phrase echoes into the gap.",
  description:
    "A send to a 100%-wet ping-pong delay stays CLOSED except on the tail of a phrase — " +
    "the send automation spikes open for the last beat, so only the final word repeats, " +
    "bouncing left/right in tempo (dotted-eighth).",
  requirements: (ctx) => [
    {
      ok: allAudioClips(ctx).length > 0,
      label: "An audio clip whose tail can be thrown (the phrase)",
    },
  ],
  stages: [
    {
      id: "bus",
      title: "Bus",
      reveal: "mixer",
      summary:
        "Creates a “Throw Delay” bus: stock Delay at 100% wet, ping-pong on, time set to a " +
        "dotted-eighth at the project tempo, feedback 55%.",
      manual:
        "Add a bus with the stock Delay: Mix 100%, Ping-Pong on, Feedback ~55%, Time = a " +
        "dotted eighth (0.75 × one beat) at your tempo, Tone ~6 kHz. Low-cut the bus ~250 Hz.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const dottedEighthMs = Math.min(2000, (60000 / ctx.bpm) * 0.75);
        const bus = await newTrack(tx, "bus", "Throw Delay");
        await setEqBands(tx, bus.id, [eqLowCut(250)]);
        await addInsert(tx, bus.id, "builtin:delay", {
          Time: dottedEighthMs,
          Feedback: 55,
          Mix: 100,
          Tone: 6000,
          "Ping-Pong": 1,
        });
        state.throwBusId = bus.id;
        return {
          commands: tx.count,
          note: `Throw bus ready — dotted-eighth = ${Math.round(dottedEighthMs)} ms at ${Math.round(ctx.bpm)} BPM.`,
        };
      },
    },
    {
      id: "send",
      title: "Send",
      reveal: "mixer",
      summary: "Adds a send from the phrase's track into the bus — at ZERO (the throw opens it).",
      manual:
        "On the vocal track, add a send to the Throw Delay bus and leave its level at zero — " +
        "the whole point is that it only opens when automated.",
      params: [phraseParam],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the phrase clip first.");
        const bus = findThrowBus(ctx, state);
        const sendIndex = await sendTo(tx, ctx.project, found.track.id, bus.id, 0);
        state.throwTrackId = found.track.id;
        state.throwSendIndex = sendIndex;
        return { commands: tx.count, note: `Send ${sendIndex + 1} added at zero on “${found.track.name}”.` };
      },
    },
    {
      id: "throw",
      title: "Throw",
      reveal: "timeline",
      summary:
        "Automates that send: opens over the phrase's LAST beat, closes right after the clip " +
        "ends — only the tail feeds the delay.",
      manual:
        "On the vocal track's send automation lane, draw a spike: zero until one beat before " +
        "the clip ends, up to ~0 dB across that last beat, back to zero just after the clip " +
        "ends. The echoes ring on because the delay's feedback carries them.",
      params: [phraseParam],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the phrase clip first.");
        const trackId = (state.throwTrackId as number) ?? found.track.id;
        const track = ctx.project.tracks.find((t) => t.id === trackId) ?? found.track;
        let sendIndex = state.throwSendIndex as number | undefined;
        if (sendIndex === undefined) {
          const bus = findThrowBus(ctx, state);
          sendIndex = track.sends.findIndex((s) => s.destTrackId === bus.id);
          if (sendIndex < 0) throw new Error("No send to the throw bus — run the Send stage first.");
        }
        const end = clipEndBeat(found.clip, ctx.project);
        const start = Math.max(found.clip.startBeat, end - 1);
        await ramp(tx, track.id, `send:${sendIndex}`, [
          { t: Math.max(0, start - 0.05), v: 0 },
          { t: start, v: 1.0 },
          { t: end, v: 1.0 },
          { t: end + 0.1, v: 0 },
        ]);
        return { commands: tx.count, note: "Throw written on the phrase tail — the echo rides the gap." };
      },
    },
  ],
};

export const vocalTechniques: TechniqueDef[] = [doubler, delayThrow];
