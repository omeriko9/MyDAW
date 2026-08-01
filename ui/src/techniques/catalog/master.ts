/**
 * Bus, glue & master — Master Glue Chain, Parallel Drum Crush.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import {
  addVca,
  removePlugin,
  setPlugin,
  setPluginParam,
  setTrack,
  setVca,
} from "../../store/actions";
import { useStore } from "../../store/store";
import type { Track } from "../../protocol/types";
import { Tx, addInsert, dbToLin, newTrack, paramIdByName, sendTo } from "../ops";
import { normFor } from "../norm";
import type { TechniqueCtx, TechniqueDef } from "../types";

const feedable = (t: Track) => t.kind === "audio" || t.kind === "instrument" || t.kind === "midi";

/* ============================================================================
 * Master Glue Chain
 * ========================================================================= */

const masterGlue: TechniqueDef = {
  id: "master-glue",
  category: "master",
  title: "Master Glue Chain",
  tagline: "Gentle 2:1 glue into a −1 dB ceiling.",
  description:
    "The standard master-bus starting point: a slow-attack, low-ratio compressor working " +
    "1–2 dB so the mix moves as one thing, followed by a limiter that catches peaks at " +
    "−1 dB. Loudness is a TARGET at export time, not a knob to slam.",
  requirements: () => [],
  stages: [
    {
      id: "glue",
      title: "Glue",
      reveal: "mixer",
      summary:
        "Inserts the stock Compressor on the master: 2:1, 30 ms attack, 250 ms release, " +
        "soft 12 dB knee, threshold −14 dB, +1.5 dB makeup.",
      manual:
        "Insert the stock Compressor on the master bus. Ratio 2:1, Attack ~30 ms (lets " +
        "transients through), Release ~250 ms, a soft knee, and lower the threshold until " +
        "it reads 1–2 dB of reduction on the loud sections — no more.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const comp = await addInsert(tx, ctx.project.masterTrack.id, "builtin:compressor", {
          Threshold: -14,
          Ratio: 2,
          Attack: 30,
          Release: 250,
          Knee: 12,
          Makeup: 1.5,
        });
        state.glueInstanceId = comp.instanceId;
        return { commands: tx.count, note: "Glue compressor on the master — aim for 1–2 dB reduction." };
      },
    },
    {
      id: "ceiling",
      title: "Ceiling",
      reveal: "mixer",
      summary: "Adds the stock Limiter after the glue: ceiling −1 dB, 120 ms release.",
      manual:
        "Insert the stock Limiter AFTER the compressor on the master. Ceiling −1 dB (true-" +
        "peak headroom for encoders), release ~120 ms. It should only catch occasional peaks.",
      run: async (ctx) => {
        const tx = new Tx();
        await addInsert(tx, ctx.project.masterTrack.id, "builtin:limiter", {
          Ceiling: -1,
          Release: 120,
        });
        return { commands: tx.count, note: "Limiter at −1 dB closes the chain." };
      },
    },
    {
      id: "loudness",
      title: "Loudness check",
      optional: true,
      summary:
        "Opens Export Audio — render with the −14 LUFS loudness target and read the " +
        "measured LUFS/peak in the reply. (No project edits; nothing to take back.)",
      manual:
        "File ▸ Export ▸ Export Audio…, pick the −14 LUFS preset (streaming loudness) and " +
        "render. The export reports the measured integrated loudness and peak — adjust the " +
        "glue/limiter and re-render rather than pushing the master fader.",
      run: async () => {
        useStore.getState().setDialogs({ export: true });
        return { commands: 0, note: "Export dialog opened — use the −14 LUFS target." };
      },
    },
  ],
};

/* ============================================================================
 * Parallel Drum Crush (New York compression)
 * ========================================================================= */

const parallelCrush: TechniqueDef = {
  id: "parallel-crush",
  category: "master",
  title: "Parallel Drum Crush",
  tagline: "A smashed copy underneath the clean drums.",
  description:
    "New York compression: the drums are sent AT FULL LEVEL to a bus with a compressor " +
    "set to obliterate (10:1+, fast attack), and that crushed copy is blended in low " +
    "under the untouched originals — density and sustain without losing the transients.",
  requirements: (ctx) => [
    {
      ok: ctx.selection.trackIds.some((id) =>
        ctx.project.tracks.some((t) => t.id === id && feedable(t)),
      ),
      label: "Select the drum track(s) to crush (their sends feed the bus)",
    },
  ],
  stages: [
    {
      id: "bus",
      title: "Bus",
      reveal: "mixer",
      summary:
        "Creates a “Crush” bus with the stock Compressor set to smash: 12:1, 0.4 ms attack, " +
        "90 ms release, threshold −38 dB, +8 dB makeup.",
      manual:
        "Add a bus named Crush. Insert the stock Compressor and set it WRONG on purpose: " +
        "ratio 12:1, fastest attack, ~90 ms release, threshold way down (−35…−40) so it " +
        "slams 10+ dB, makeup gain to compensate.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const bus = await newTrack(tx, "bus", "Crush");
        await addInsert(tx, bus.id, "builtin:compressor", {
          Threshold: -38,
          Ratio: 12,
          Attack: 0.4,
          Release: 90,
          Knee: 0,
          Makeup: 8,
        });
        state.crushBusId = bus.id;
        return { commands: tx.count, note: "Crush bus ready — the compressor is meant to slam." };
      },
    },
    {
      id: "feed",
      title: "Feed",
      reveal: "mixer",
      summary: "Adds a FULL-LEVEL (0 dB) send from every selected drum track into the bus.",
      manual:
        "On each drum track, add a send to the Crush bus at 0 dB (full). Parallel compression " +
        "wants the complete signal in the crushed path — the balance happens at the bus fader.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const bus =
          ctx.project.tracks.find((t) => t.id === (state.crushBusId as number)) ??
          ctx.project.tracks.find((t) => t.kind === "bus" && /crush/i.test(t.name));
        if (!bus) throw new Error("No Crush bus found — run the Bus stage first.");
        const tracks = ctx.project.tracks.filter(
          (t) => ctx.selection.trackIds.includes(t.id) && feedable(t),
        );
        if (tracks.length === 0) throw new Error("Select the drum track(s) to feed the bus.");
        // sendTo computes indices from the passed project snapshot — fine per-track here
        // because each track's own send list gets at most one addition.
        for (const t of tracks) await sendTo(tx, ctx.project, t.id, bus.id, 1.0);
        return { commands: tx.count, note: `${tracks.length} full-level send(s) feeding the Crush bus.` };
      },
    },
    {
      id: "blend",
      title: "Blend",
      reveal: "mixer",
      summary: "Pulls the Crush bus fader to −12 dB — the starting blend; ride it up to taste.",
      manual:
        "Pull the Crush bus fader all the way down, hit play on the busiest section, and " +
        "raise it until the drums thicken without the pumping taking over — usually lands " +
        "somewhere around −15…−9 dB under the dry drums.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const bus =
          ctx.project.tracks.find((t) => t.id === (state.crushBusId as number)) ??
          ctx.project.tracks.find((t) => t.kind === "bus" && /crush/i.test(t.name));
        if (!bus) throw new Error("No Crush bus found — run the Bus stage first.");
        await tx.cmd(setTrack(bus.id, { volume: dbToLin(-12) }));
        return { commands: tx.count, note: "Crush blended at −12 dB — ride it while the mix plays." };
      },
    },
  ],
};

/* ============================================================================
 * Stem Bus Architecture
 * ========================================================================= */

const STEM_NAMES = ["Drums", "Bass", "Music", "Vocals"] as const;

const stemBuses: TechniqueDef = {
  id: "stem-buses",
  category: "master",
  title: "Stem Bus Architecture",
  tagline: "Four buses, and the whole mix rides on four faders.",
  description:
    "The structure every big mix runs on: Drums / Bass / Music / Vocals buses between " +
    "the tracks and the master. Balance whole sections with one fader, process groups " +
    "as one thing, and stems fall out at export time.",
  requirements: () => [],
  stages: [
    {
      id: "buses",
      title: "Buses",
      reveal: "mixer",
      summary: "Creates the four stem buses: Drums, Bass, Music, Vocals (skips names that exist).",
      manual: "Add four buses named Drums, Bass, Music, Vocals — all routed to the master.",
      run: async (ctx) => {
        const tx = new Tx();
        let made = 0;
        for (const name of STEM_NAMES) {
          if (ctx.project.tracks.some((t) => t.kind === "bus" && t.name === name)) continue;
          await newTrack(tx, "bus", name);
          made++;
        }
        if (made === 0) throw new Error("All four stem buses already exist.");
        return { commands: tx.count, note: `${made} stem bus(es) created.` };
      },
    },
    {
      id: "route",
      title: "Route",
      reveal: "mixer",
      summary:
        "Routes every SELECTED track's output into the chosen stem bus (run this stage's " +
        "routing again by hand per group — the manual shows how).",
      manual:
        "Select a group of tracks, then set each track's output routing (mixer strip " +
        "routing combo) to its stem bus. Repeat per group: drums → Drums, and so on.",
      params: [
        {
          key: "bus",
          label: "Selected tracks go to",
          kind: "select",
          options: STEM_NAMES.map((n) => ({ value: n, label: n })),
          default: () => "Drums",
        },
      ],
      run: async (ctx, params) => {
        const tx = new Tx();
        const bus = ctx.project.tracks.find(
          (t) => t.kind === "bus" && t.name === (params.bus as string),
        );
        if (!bus) throw new Error(`No “${params.bus}” bus — run the Buses stage first.`);
        const targets = ctx.project.tracks.filter(
          (t) => ctx.selection.trackIds.includes(t.id) && feedable(t),
        );
        if (targets.length === 0)
          throw new Error("Select the tracks that belong to this stem first (close the wizard, select, reopen).");
        for (const t of targets) await tx.cmd(setTrack(t.id, { outputTarget: bus.id }));
        return { commands: tx.count, note: `${targets.length} track(s) now route through ${bus.name}.` };
      },
    },
  ],
};

/* ============================================================================
 * VCA Group Rider
 * ========================================================================= */

const vcaGroups: TechniqueDef = {
  id: "vca-groups",
  category: "master",
  title: "VCA Group Rider",
  tagline: "One fader rides many tracks — without touching audio routing.",
  description:
    "A VCA is a remote fader: it scales its member tracks' faders without being in the " +
    "signal path (post-fader sends keep their balance — the reason mixers use VCAs over " +
    "buses for riding levels).",
  requirements: (ctx) => [
    {
      ok: ctx.selection.trackIds.some((id) =>
        ctx.project.tracks.some((t) => t.id === id && feedable(t)),
      ),
      label: "Select the tracks the VCA should ride",
    },
  ],
  stages: [
    {
      id: "group",
      title: "Group",
      reveal: "mixer",
      summary: "Creates a VCA and assigns every selected track to it.",
      manual:
        "Add a VCA (Inspector ▸ VCA ▸ assign) and set each selected track's VCA group to it.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const targets = ctx.project.tracks.filter(
          (t) => ctx.selection.trackIds.includes(t.id) && feedable(t),
        );
        if (targets.length === 0) throw new Error("Select the tracks to group first.");
        const { vca } = await tx.cmd(addVca("Group"));
        for (const t of targets) await tx.cmd(setTrack(t.id, { vcaId: vca.id }));
        state.vcaId = vca.id;
        return { commands: tx.count, note: `VCA riding ${targets.length} track(s).` };
      },
    },
    {
      id: "ride",
      title: "First ride",
      reveal: "mixer",
      optional: true,
      summary: "Pulls the whole group −2 dB from the one VCA gain — the fader you'll ride from now on.",
      manual:
        "Drag the VCA's gain (Inspector) — every member fader follows proportionally. " +
        "Automate or ride THIS from now on instead of ten separate faders.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const id = state.vcaId as number | undefined;
        if (id === undefined) throw new Error("Run the Group stage first.");
        await tx.cmd(setVca(id, { gain: dbToLin(-2) }));
        return { commands: tx.count, note: "Group trimmed −2 dB from one fader." };
      },
    },
  ],
};

/* ============================================================================
 * Headroom Reset
 * ========================================================================= */

const headroomReset: TechniqueDef = {
  id: "headroom-reset",
  category: "master",
  title: "Headroom Reset",
  tagline: "Everything down 6 dB — the master can breathe again.",
  description:
    "The classic fix for a red-lining mix: pull EVERY source fader down by the same " +
    "amount. Balances stay identical, the master gets its headroom back, and the " +
    "processing stops fighting for its life.",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(feedable), label: "Tracks to trim" },
  ],
  stages: [
    {
      id: "trim",
      title: "Trim all",
      reveal: "mixer",
      summary: "Scales every audio/instrument/MIDI track fader down by the chosen amount.",
      manual:
        "Select all tracks and pull the faders down together (or subtract the same dB from " +
        "each). Do NOT lower the master fader — the point is less INTO the master chain.",
      params: [
        {
          key: "amount",
          label: "Trim by",
          kind: "select",
          options: [
            { value: "-3", label: "−3 dB" },
            { value: "-6", label: "−6 dB (classic)" },
            { value: "-9", label: "−9 dB" },
          ],
          default: () => "-6",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const factor = dbToLin(Number(params.amount));
        const targets = ctx.project.tracks.filter(feedable);
        if (targets.length === 0) throw new Error("No tracks to trim.");
        for (const t of targets) await tx.cmd(setTrack(t.id, { volume: t.volume * factor }));
        state.headroomTrimmed = true;
        return { commands: tx.count, note: `${targets.length} faders trimmed ${params.amount} dB — balances intact.` };
      },
    },
    {
      id: "master",
      title: "Master to unity",
      reveal: "mixer",
      optional: true,
      summary: "Resets the master fader to 0 dB — level now lives in the sources, not the output.",
      manual: "Set the master fader back to 0 dB. Loudness comes later, at export.",
      run: async (ctx) => {
        const tx = new Tx();
        await tx.cmd(setTrack(ctx.project.masterTrack.id, { volume: 1 }));
        return { commands: tx.count, note: "Master at unity." };
      },
    },
  ],
};

/* ============================================================================
 * Drum Bus Glue
 * ========================================================================= */

const drumBusGlue: TechniqueDef = {
  id: "drum-bus-glue",
  category: "master",
  title: "Drum Bus Glue",
  tagline: "The kit becomes one instrument.",
  description:
    "Route the drums into one bus and compress THE BUS a few dB — kick, snare and hats " +
    "start reacting to each other and the kit gels into a single instrument. (Serial " +
    "glue; for the smashed blend see Parallel Drum Crush.)",
  requirements: (ctx) => [
    {
      ok: ctx.selection.trackIds.some((id) =>
        ctx.project.tracks.some((t) => t.id === id && feedable(t)),
      ),
      label: "Select the drum tracks to route",
    },
  ],
  stages: [
    {
      id: "bus",
      title: "Bus & route",
      reveal: "mixer",
      summary: "Creates a “Drum Bus” and routes every selected track's OUTPUT through it.",
      manual:
        "Add a bus named Drum Bus and set each drum track's output routing to it — the " +
        "whole kit now passes through one channel.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const targets = ctx.project.tracks.filter(
          (t) => ctx.selection.trackIds.includes(t.id) && feedable(t),
        );
        if (targets.length === 0) throw new Error("Select the drum tracks first.");
        const bus = await newTrack(tx, "bus", "Drum Bus");
        for (const t of targets) await tx.cmd(setTrack(t.id, { outputTarget: bus.id }));
        state.drumBusId = bus.id;
        return { commands: tx.count, note: `${targets.length} drum track(s) routed through the bus.` };
      },
    },
    {
      id: "glue",
      title: "Glue",
      reveal: "mixer",
      summary: "Stock Compressor on the bus: 4:1, 10 ms attack, 150 ms release, ~3 dB working.",
      manual:
        "Compressor on the drum bus: 4:1, attack ~10 ms (transients pass), release ~150 ms " +
        "(recovers between hits), threshold until it works 2–4 dB on the busy sections.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const bus =
          ctx.project.tracks.find((t) => t.id === (state.drumBusId as number)) ??
          ctx.project.tracks.find((t) => t.kind === "bus" && /drum/i.test(t.name));
        if (!bus) throw new Error("Run the Bus & route stage first.");
        await addInsert(tx, bus.id, "builtin:compressor", {
          Threshold: -20,
          Ratio: 4,
          Attack: 10,
          Release: 150,
          Knee: 6,
          Makeup: 2,
        });
        return { commands: tx.count, note: "Kit glued — hits now push against each other." };
      },
    },
  ],
};

/* ============================================================================
 * Mono Compatibility Check
 * ========================================================================= */

const monoCheck: TechniqueDef = {
  id: "mono-check",
  category: "master",
  title: "Mono Compatibility Check",
  tagline: "Fold the mix to mono before the club PA does it for you.",
  description:
    "Phones speakers, Bluetooth boxes and club PAs fold your stereo to mono — and " +
    "Haas tricks, wide synths and phasey layers can vanish. This engages a mono fold on " +
    "the master to listen through, then removes it. A ritual, not a setting.",
  requirements: () => [],
  stages: [
    {
      id: "engage",
      title: "Engage mono",
      reveal: "mixer",
      summary: "Inserts the stock Utility on the master with Mono ON. Listen for what disappears.",
      manual:
        "Insert the stock Utility on the master and switch Mono on. Play the busiest " +
        "chorus: whatever gets quiet or hollow (wide pads, Haas doubles) needs attention.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const util = await addInsert(tx, ctx.project.masterTrack.id, "builtin:utility", {
          Mono: 1,
        });
        state.monoInstanceId = util.instanceId;
        return { commands: tx.count, note: "Mix folded to mono — listen for what vanished." };
      },
    },
    {
      id: "disengage",
      title: "Disengage",
      reveal: "mixer",
      summary: "Removes the mono Utility from the master — never ship with the check in the chain.",
      manual: "Remove (or at least bypass) the Utility when you're done listening.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const master = ctx.project.masterTrack;
        const instanceId =
          (state.monoInstanceId as number | undefined) ??
          master.inserts.find((i) => i.uid === "builtin:utility")?.instanceId;
        if (instanceId === undefined)
          throw new Error("No Utility on the master — Engage first (or it was removed already).");
        await tx.cmd(removePlugin(master.id, instanceId));
        return { commands: tx.count, note: "Mono check over — stereo restored." };
      },
    },
  ],
};

/* ============================================================================
 * Mix-Bus Pump
 * ========================================================================= */

const mixBusPump: TechniqueDef = {
  id: "mixbus-pump",
  category: "master",
  title: "Mix-Bus Pump",
  tagline: "The WHOLE mix breathes with the kick — French house in one insert.",
  description:
    "Sidechain pumping applied to the master itself: one compressor on the mix bus, " +
    "keyed from the kick, makes the entire record duck and swell as a single organism — " +
    "Daft Punk / French-house DNA.",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(feedable), label: "A kick track to key from" },
  ],
  stages: [
    {
      id: "key",
      title: "Key",
      reveal: "mixer",
      summary:
        "Stock Compressor on the MASTER, sidechained from the kick — fast attack, release " +
        "timed to the tempo so the swell lands on the off-beat.",
      manual:
        "Compressor on the master bus, Sidechain source = the kick track. Fast attack, " +
        "release around a third of a beat, ratio ~4:1. (A muted ghost-kick track playing " +
        "4-on-the-floor makes the pump land even when the real kick rests.)",
      params: [
        {
          key: "sourceId",
          label: "Keyed from",
          kind: "track",
          trackFilter: feedable,
          default: (ctx) =>
            ctx.project.tracks.find((t) => feedable(t) && /kick|drum/i.test(t.name))?.id ??
            ctx.project.tracks.find(feedable)?.id ??
            0,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const sourceId = params.sourceId as number;
        if (!ctx.project.tracks.some((t) => t.id === sourceId))
          throw new Error("Pick the kick track that drives the pump.");
        const releaseMs = Math.min(400, Math.max(60, (60000 / ctx.bpm) * 0.35));
        const comp = await addInsert(tx, ctx.project.masterTrack.id, "builtin:compressor", {
          Threshold: -28,
          Ratio: 4,
          Attack: 0.5,
          Release: releaseMs,
          Makeup: 2,
        });
        await tx.cmd(setPlugin(comp.instanceId, { sidechainSource: sourceId }));
        state.mixPumpInstanceId = comp.instanceId;
        return { commands: tx.count, note: `The whole mix now ducks with the kick (release ${Math.round(releaseMs)} ms).` };
      },
    },
    {
      id: "depth",
      title: "Depth",
      reveal: "mixer",
      summary: "Sets the pump size: Heartbeat (−2 dB), Classic (−4 dB), or Flagrant (−8 dB).",
      manual:
        "Lower the threshold until the master meter dips the amount you want per kick — " +
        "subtle glue at −2, the classic French pump around −4, full flagrance beyond.",
      params: [
        {
          key: "amount",
          label: "Pump",
          kind: "select",
          options: [
            { value: "heartbeat", label: "Heartbeat (−2 dB)" },
            { value: "classic", label: "Classic (−4 dB)" },
            { value: "flagrant", label: "Flagrant (−8 dB)" },
          ],
          default: () => "classic",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const instanceId =
          (state.mixPumpInstanceId as number | undefined) ??
          ctx.project.masterTrack.inserts.find(
            (i) => i.uid === "builtin:compressor" && (i.sidechainSource ?? 0) !== 0,
          )?.instanceId;
        if (instanceId === undefined) throw new Error("Run the Key stage first.");
        const presets: Record<string, { Threshold: number; Ratio: number; Makeup: number }> = {
          heartbeat: { Threshold: -22, Ratio: 3, Makeup: 1 },
          classic: { Threshold: -30, Ratio: 4, Makeup: 2 },
          flagrant: { Threshold: -40, Ratio: 8, Makeup: 4 },
        };
        const p = presets[(params.amount as string) ?? "classic"];
        for (const [name, value] of Object.entries(p)) {
          const id = await paramIdByName(instanceId, name);
          await tx.cmd(setPluginParam(instanceId, id, normFor("builtin:compressor", name, value)));
        }
        return { commands: tx.count, note: `Mix-bus pump set to “${params.amount}”.` };
      },
    },
  ],
};

export const masterTechniques: TechniqueDef[] = [
  masterGlue,
  parallelCrush,
  stemBuses,
  vcaGroups,
  headroomReset,
  drumBusGlue,
  monoCheck,
  mixBusPump,
];
