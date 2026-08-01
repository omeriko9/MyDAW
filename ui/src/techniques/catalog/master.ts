/**
 * Bus, glue & master — Master Glue Chain, Parallel Drum Crush.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import { setTrack } from "../../store/actions";
import { useStore } from "../../store/store";
import type { Track } from "../../protocol/types";
import { Tx, addInsert, dbToLin, newTrack, sendTo } from "../ops";
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

export const masterTechniques: TechniqueDef[] = [masterGlue, parallelCrush];
