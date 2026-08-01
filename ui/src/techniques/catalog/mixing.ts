/**
 * Mixing — space & dynamics: Sidechain Pump, Polished Vocal Reverb.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import { setPlugin, setPluginParam } from "../../store/actions";
import type { Track } from "../../protocol/types";
import {
  Tx,
  addInsert,
  dbToLin,
  eqHighCut,
  eqLowCut,
  isMixerTrack,
  newTrack,
  paramIdByName,
  sendTo,
  setEqBands,
} from "../ops";
import { normFor } from "../norm";
import type { TechniqueCtx, TechniqueDef } from "../types";

const audioLike = (t: Track) => t.kind === "audio" || t.kind === "instrument";

const defaultSelectedTrack = (ctx: TechniqueCtx, filter: (t: Track) => boolean) => {
  const sel = ctx.project.tracks.find((t) => t.id === ctx.selection.trackIds[0]);
  return (sel && filter(sel) ? sel.id : ctx.project.tracks.find(filter)?.id) ?? 0;
};

/* ============================================================================
 * Sidechain Pump
 * ========================================================================= */

/** Stage-2 fallback: the target's sidechained builtin compressor. */
function findPumpComp(ctx: TechniqueCtx, state: Record<string, unknown>) {
  const instanceId = state.pumpInstanceId as number | undefined;
  for (const t of ctx.project.tracks) {
    const ins = t.inserts.find(
      (i) =>
        i.uid === "builtin:compressor" &&
        (instanceId !== undefined ? i.instanceId === instanceId : (i.sidechainSource ?? 0) !== 0),
    );
    if (ins) return ins.instanceId;
  }
  throw new Error("No sidechained compressor found — run the Key stage first.");
}

const sidechainPump: TechniqueDef = {
  id: "sidechain-pump",
  category: "mixing",
  title: "Sidechain Pump",
  tagline: "The mix breathes with the kick.",
  description:
    "The most listener-audible mix move in modern electronic music: a compressor on the " +
    "bass/pads/music bus is KEYED from the kick, so every kick hit pushes the rest down " +
    "and the mix pumps back up between hits.",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.filter(isMixerTrack).length >= 2,
      label: "Two tracks — a source to key from (kick) and a target to duck",
    },
  ],
  stages: [
    {
      id: "key",
      title: "Key",
      reveal: "mixer",
      summary:
        "Puts the stock Compressor on the target track and keys its detector from the " +
        "source track (fast attack; release timed to the project tempo).",
      manual:
        "Add the stock Compressor to the track that should duck. Set its Sidechain source " +
        "to the kick track. Fast attack (≤1 ms), release around a third of a beat, ratio ~6:1.",
      params: [
        {
          key: "targetId",
          label: "Duck this",
          kind: "track",
          trackFilter: isMixerTrack,
          default: (ctx) => defaultSelectedTrack(ctx, isMixerTrack),
          help: "Bass, pads, or a whole music bus.",
        },
        {
          key: "sourceId",
          label: "Keyed from",
          kind: "track",
          trackFilter: isMixerTrack,
          default: (ctx) =>
            ctx.project.tracks.find((t) => isMixerTrack(t) && /kick|drum/i.test(t.name))?.id ??
            ctx.project.tracks.find(isMixerTrack)?.id ??
            0,
          help: "Usually the kick (a muted 4-on-the-floor “ghost kick” track works too).",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const targetId = params.targetId as number;
        const sourceId = params.sourceId as number;
        if (targetId === sourceId) throw new Error("Source and target must be different tracks.");
        if (!ctx.project.tracks.some((t) => t.id === targetId))
          throw new Error("Pick a target track to duck.");
        const releaseMs = Math.min(400, Math.max(60, (60000 / ctx.bpm) * 0.35));
        const comp = await addInsert(tx, targetId, "builtin:compressor", {
          Threshold: -30,
          Ratio: 6,
          Attack: 0.3,
          Release: releaseMs,
          Makeup: 3,
        });
        await tx.cmd(setPlugin(comp.instanceId, { sidechainSource: sourceId }));
        state.pumpInstanceId = comp.instanceId;
        return {
          commands: tx.count,
          note: `Compressor keyed from “${ctx.project.tracks.find((t) => t.id === sourceId)?.name}” — release ${Math.round(releaseMs)} ms for ${Math.round(ctx.bpm)} BPM.`,
        };
      },
    },
    {
      id: "depth",
      title: "Depth",
      reveal: "mixer",
      summary: "Dials the pump amount: Gentle, Classic, or Full-pump presets.",
      manual:
        "Lower the compressor's threshold (and raise ratio/makeup) until the meter ducks " +
        "4–6 dB on hits for a classic pump — more for the exaggerated EDM effect.",
      params: [
        {
          key: "amount",
          label: "Amount",
          kind: "select",
          options: [
            { value: "gentle", label: "Gentle (–3 dB dips)" },
            { value: "classic", label: "Classic (–6 dB pump)" },
            { value: "full", label: "Full pump (–12 dB)" },
          ],
          default: () => "classic",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const instanceId = findPumpComp(ctx, state);
        const presets: Record<string, { Threshold: number; Ratio: number; Makeup: number }> = {
          gentle: { Threshold: -22, Ratio: 3, Makeup: 1.5 },
          classic: { Threshold: -32, Ratio: 6, Makeup: 3 },
          full: { Threshold: -42, Ratio: 12, Makeup: 6 },
        };
        const p = presets[(params.amount as string) ?? "classic"];
        for (const [name, value] of Object.entries(p)) {
          const id = await paramIdByName(instanceId, name);
          await tx.cmd(setPluginParam(instanceId, id, normFor("builtin:compressor", name, value)));
        }
        return { commands: tx.count, note: `Pump depth set to “${params.amount}”.` };
      },
    },
  ],
};

/* ============================================================================
 * Polished Vocal Reverb (EQ'd, ducked send)
 * ========================================================================= */

function findVerbBus(ctx: TechniqueCtx, state: Record<string, unknown>): Track {
  const id = state.verbBusId as number | undefined;
  const bus =
    ctx.project.tracks.find((t) => t.id === id) ??
    ctx.project.tracks.find((t) => t.kind === "bus" && /verb|reverb/i.test(t.name));
  if (!bus) throw new Error("No reverb bus found — run the Bus stage first.");
  return bus;
}

const vocalReverb: TechniqueDef = {
  id: "vocal-reverb-send",
  category: "mixing",
  title: "Polished Vocal Reverb",
  tagline: "Send → EQ → reverb → ducking: lush but out of the way.",
  description:
    "The engineer's reverb sandwich: the send passes through a low cut (~550 Hz) and " +
    "high cut (~10 kHz) into a 100%-wet reverb, and the verb is compressed KEYED from " +
    "the dry vocal — the tail blooms in the gaps instead of washing over the words.",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some(audioLike),
      label: "An audio or instrument track to send from (the vocal)",
    },
  ],
  stages: [
    {
      id: "bus",
      title: "Bus",
      reveal: "mixer",
      summary:
        "Creates a “Vocal Verb” bus: channel EQ (low cut 550 Hz, high cut 10 kHz) into the " +
        "stock Reverb at 100% wet.",
      manual:
        "Add a bus. On its channel EQ, enable a low cut at ~550 Hz and a high cut at ~10 kHz. " +
        "Insert the stock Reverb and set Mix to 100% — a send effect must be fully wet.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const bus = await newTrack(tx, "bus", "Vocal Verb");
        await setEqBands(tx, bus.id, [eqLowCut(550), eqHighCut(10000)]);
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.68, Damp: 0.35, Mix: 100 });
        state.verbBusId = bus.id;
        return { commands: tx.count, note: "Vocal Verb bus ready (EQ'd, 100% wet)." };
      },
    },
    {
      id: "send",
      title: "Send",
      reveal: "mixer",
      summary: "Adds a send from the vocal track into the bus at −10 dB.",
      manual: "On the vocal track, add a send to the Vocal Verb bus and set it around −10 dB.",
      params: [
        {
          key: "vocalId",
          label: "Vocal track",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const vocalId = params.vocalId as number;
        if (!ctx.project.tracks.some((t) => t.id === vocalId))
          throw new Error("Pick the vocal track to send from.");
        const bus = findVerbBus(ctx, state);
        await sendTo(tx, ctx.project, vocalId, bus.id, dbToLin(-10));
        state.verbVocalId = vocalId;
        return { commands: tx.count, note: "Send added at −10 dB — push it for choruses." };
      },
    },
    {
      id: "duck",
      title: "Duck",
      reveal: "mixer",
      optional: true,
      summary:
        "Compresses the reverb bus KEYED from the dry vocal, so the tail ducks while the " +
        "singer sings and blooms between phrases.",
      manual:
        "Insert the stock Compressor on the reverb bus and set its Sidechain source to the " +
        "vocal track — moderate ratio (4:1), ~5 ms attack, ~160 ms release.",
      params: [
        {
          key: "vocalId",
          label: "Keyed from",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const bus = findVerbBus(ctx, state);
        const vocalId = (state.verbVocalId as number | undefined) ?? (params.vocalId as number);
        if (!ctx.project.tracks.some((t) => t.id === vocalId))
          throw new Error("Pick the vocal track that keys the ducking.");
        const comp = await addInsert(tx, bus.id, "builtin:compressor", {
          Threshold: -32,
          Ratio: 4,
          Attack: 5,
          Release: 160,
        });
        await tx.cmd(setPlugin(comp.instanceId, { sidechainSource: vocalId }));
        return { commands: tx.count, note: "Verb ducks under the dry vocal; tail blooms in the gaps." };
      },
    },
  ],
};

export const mixingTechniques: TechniqueDef[] = [sidechainPump, vocalReverb];
