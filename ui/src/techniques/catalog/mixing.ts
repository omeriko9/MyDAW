/**
 * Mixing — space & dynamics: Sidechain Pump, Polished Vocal Reverb.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import {
  duplicateTrack,
  moveClips,
  setPlugin,
  setPluginParam,
  setTrack,
} from "../../store/actions";
import type { Track } from "../../protocol/types";
import { clipEndBeat } from "../../lib/keyboard";
import {
  Tx,
  addInsert,
  allAudioClips,
  dbToLin,
  eqHighCut,
  eqLowCut,
  isMixerTrack,
  msToBeats,
  newTrack,
  paramIdByName,
  ramp,
  resolveAudioClip,
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

/* ============================================================================
 * Haas Widener
 * ========================================================================= */

const haasWidener: TechniqueDef = {
  id: "haas-widener",
  category: "mixing",
  title: "Haas Widener",
  tagline: "One track becomes a wall — via 15 milliseconds.",
  description:
    "The Haas effect: a copy delayed under ~30 ms is heard as WIDTH, not an echo. " +
    "Original hard-ish left, copy hard-ish right and 15 ms late — instant size on pads, " +
    "guitars and synths. (Caveat honesty: it partially cancels in mono.)",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some((t) => audioLike(t) && t.clips.length > 0),
      label: "An audio or instrument track with material to widen",
    },
  ],
  stages: [
    {
      id: "copy",
      title: "Copy",
      reveal: "timeline",
      summary: "Duplicates the track (deep copy) and names it “(width)”.",
      manual: "Duplicate the track (right-click ▸ Duplicate) and name the copy “(width)”.",
      params: [
        {
          key: "trackId",
          label: "Widen this",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const src = ctx.project.tracks.find((t) => t.id === (params.trackId as number));
        if (!src) throw new Error("Pick the track to widen.");
        const copy = (await tx.cmd(duplicateTrack(src.id))).track;
        await tx.cmd(setTrack(copy.id, { name: `${src.name} (width)` }));
        state.haasSrcId = src.id;
        state.haasCopyId = copy.id;
        return { commands: tx.count, note: `“${src.name}” copied for the right side.` };
      },
    },
    {
      id: "offset",
      title: "Offset & pan",
      reveal: "mixer",
      summary:
        "Pans the original 70% left, the copy 70% right, and delays the copy's clips 15 ms — " +
        "the Haas window where late = wide, not echo.",
      manual:
        "Pan the original left (~70%) and the copy right (~70%), then nudge the COPY's clips " +
        "about 15 ms late. Under ~30 ms the ear fuses them into one wide image.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const src = ctx.project.tracks.find((t) => t.id === (state.haasSrcId as number));
        const copy = ctx.project.tracks.find((t) => t.id === (state.haasCopyId as number));
        if (!src || !copy) throw new Error("Run the Copy stage first.");
        await tx.cmd(setTrack(src.id, { pan: -0.7 }));
        await tx.cmd(setTrack(copy.id, { pan: 0.7 }));
        const ids = copy.clips.map((c) => c.id);
        if (ids.length > 0) await tx.cmd(moveClips(ids, msToBeats(15, ctx.bpm)));
        return { commands: tx.count, note: "±70% pans, right side 15 ms late — instant width." };
      },
    },
    {
      id: "safety",
      title: "Mono safety",
      reveal: "mixer",
      optional: true,
      summary: "Tucks the delayed side −2 dB — softens the comb-filtering when the mix folds to mono.",
      manual:
        "Pull the delayed copy a couple of dB down. Haas width partially comb-filters in " +
        "mono — check the mix in mono (Utility ▸ Mono on the master) before shipping it.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const copy = ctx.project.tracks.find((t) => t.id === (state.haasCopyId as number));
        if (!copy) throw new Error("Run the Copy stage first.");
        await tx.cmd(setTrack(copy.id, { volume: copy.volume * dbToLin(-2) }));
        return { commands: tx.count, note: "Delayed side tucked −2 dB for mono safety." };
      },
    },
  ],
};

/* ============================================================================
 * Telephone Section
 * ========================================================================= */

const telephoneSection: TechniqueDef = {
  id: "telephone-section",
  category: "mixing",
  title: "Telephone Section",
  tagline: "One phrase through a tiny speaker — then the mix opens up.",
  description:
    "The lo-fi contrast move: a phrase (intro line, pre-chorus) is band-passed to " +
    "telephone width and crunched, so the full-range chorus after it feels enormous. " +
    "Done DAW-style: the clip moves to its own FX track that carries the sound.",
  requirements: (ctx) => [
    { ok: allAudioClips(ctx).length > 0, label: "An audio clip to lo-fi (the phrase)" },
  ],
  stages: [
    {
      id: "isolate",
      title: "Isolate",
      reveal: "timeline",
      summary: "Adds a “(telephone)” track and moves the chosen clip onto it (same position).",
      manual:
        "Add an audio track named “(telephone)” and drag the phrase clip straight down onto " +
        "it — same bars, new channel. Section-FX-via-track beats automation you can't see.",
      params: [
        {
          key: "clipId",
          label: "Phrase clip",
          kind: "clip",
          default: (ctx) => resolveAudioClip(ctx, undefined)?.clip.id ?? 0,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the phrase clip.");
        const fx = await newTrack(tx, "audio", `${found.track.name} (telephone)`);
        await tx.cmd(moveClips([found.clip.id], 0, fx.id));
        state.telTrackId = fx.id;
        return { commands: tx.count, note: "Phrase moved to its own telephone track." };
      },
    },
    {
      id: "squash",
      title: "Telephone",
      reveal: "mixer",
      summary:
        "Band-passes the track to 700 Hz–3.2 kHz with a +4 dB honk at 1.8 kHz, then crunches " +
        "it with a fast 8:1 compressor.",
      manual:
        "Channel EQ: low cut ~700 Hz, high cut ~3.2 kHz, a +4 dB peak around 1.8 kHz. Then a " +
        "compressor set nasty — 8:1, fastest attack, slammed a few dB — for the crunch.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const track =
          ctx.project.tracks.find((t) => t.id === (state.telTrackId as number)) ??
          ctx.project.tracks.find((t) => /\(telephone\)$/.test(t.name));
        if (!track) throw new Error("Run the Isolate stage first.");
        await setEqBands(tx, track.id, [
          eqLowCut(700, 1.0),
          eqHighCut(3200, 1.0),
          { enabled: true, type: 0, freqHz: 1800, gainDb: 4, q: 1.8 },
        ]);
        await addInsert(tx, track.id, "builtin:compressor", {
          Threshold: -30,
          Ratio: 8,
          Attack: 0.3,
          Release: 90,
          Knee: 0,
          Makeup: 5,
        });
        return { commands: tx.count, note: "Telephone tone + crunch on the section track." };
      },
    },
  ],
};

/* ============================================================================
 * Ducking Bed (VO / podcast)
 * ========================================================================= */

const duckingBed: TechniqueDef = {
  id: "ducking-bed",
  category: "mixing",
  title: "Ducking Bed",
  tagline: "The music steps aside whenever the voice speaks.",
  description:
    "Broadcast auto-ducking: a compressor on the music is KEYED from the voice track " +
    "with slow, transparent timing — music dips a few dB under speech and swells back " +
    "in the pauses. The podcast/voiceover staple (the pump's calm sibling).",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.filter(isMixerTrack).length >= 2,
      label: "Two tracks — the voice, and the music (track or bus) to duck",
    },
  ],
  stages: [
    {
      id: "key",
      title: "Key",
      reveal: "mixer",
      summary:
        "Compressor on the music, sidechained from the voice: 4:1, slow 15 ms attack, " +
        "long 500 ms release — movement you hear as courtesy, not pumping.",
      manual:
        "Add the stock Compressor to the music track/bus, set its Sidechain source to the " +
        "voice. Slow-ish attack (~15 ms), LONG release (~500 ms), ratio ~4:1 — it should " +
        "breathe with sentences, not syllables.",
      params: [
        {
          key: "musicId",
          label: "Duck this (music)",
          kind: "track",
          trackFilter: isMixerTrack,
          default: (ctx) =>
            ctx.project.tracks.find((t) => t.kind === "bus")?.id ??
            defaultSelectedTrack(ctx, isMixerTrack),
        },
        {
          key: "voiceId",
          label: "Keyed from (voice)",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) =>
            ctx.project.tracks.find((t) => audioLike(t) && /voc|voice|vo\b/i.test(t.name))?.id ??
            defaultSelectedTrack(ctx, audioLike),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const musicId = params.musicId as number;
        const voiceId = params.voiceId as number;
        if (musicId === voiceId) throw new Error("Voice and music must be different tracks.");
        if (!ctx.project.tracks.some((t) => t.id === musicId))
          throw new Error("Pick the music track/bus to duck.");
        const comp = await addInsert(tx, musicId, "builtin:compressor", {
          Threshold: -35,
          Ratio: 4,
          Attack: 15,
          Release: 500,
          Knee: 9,
        });
        await tx.cmd(setPlugin(comp.instanceId, { sidechainSource: voiceId }));
        state.duckInstanceId = comp.instanceId;
        return { commands: tx.count, note: "Music now steps aside for the voice." };
      },
    },
    {
      id: "amount",
      title: "Amount",
      reveal: "mixer",
      summary: "Sets how far the bed drops: Radio (−4 dB), Podcast (−8 dB), or Documentary (−14 dB).",
      manual:
        "Lower the threshold until the music dips the amount you want under speech — around " +
        "−4 dB for music-forward, −8 for a podcast bed, −14 when the words are everything.",
      params: [
        {
          key: "amount",
          label: "Duck depth",
          kind: "select",
          options: [
            { value: "radio", label: "Radio (−4 dB)" },
            { value: "podcast", label: "Podcast (−8 dB)" },
            { value: "docu", label: "Documentary (−14 dB)" },
          ],
          default: () => "podcast",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const instanceId =
          (state.duckInstanceId as number | undefined) ??
          ctx.project.tracks
            .flatMap((t) => t.inserts)
            .find((i) => i.uid === "builtin:compressor" && (i.sidechainSource ?? 0) !== 0)?.instanceId;
        if (instanceId === undefined) throw new Error("Run the Key stage first.");
        const presets: Record<string, { Threshold: number; Ratio: number }> = {
          radio: { Threshold: -28, Ratio: 3 },
          podcast: { Threshold: -38, Ratio: 4 },
          docu: { Threshold: -46, Ratio: 8 },
        };
        const p = presets[(params.amount as string) ?? "podcast"];
        for (const [name, value] of Object.entries(p)) {
          const id = await paramIdByName(instanceId, name);
          await tx.cmd(setPluginParam(instanceId, id, normFor("builtin:compressor", name, value)));
        }
        return { commands: tx.count, note: `Duck depth set — “${params.amount}”.` };
      },
    },
  ],
};

/* ============================================================================
 * Auto-Pan Motion
 * ========================================================================= */

const autoPan: TechniqueDef = {
  id: "auto-pan",
  category: "mixing",
  title: "Auto-Pan Motion",
  tagline: "The part swings left–right in tempo.",
  description:
    "Movement instead of level: pan automation cycles the part across the field in time " +
    "(the classic autopan/tremolo family). Great on hats, arps, background synths — " +
    "written as visible automation points you can reshape.",
  requirements: (ctx) => [
    { ok: allAudioClips(ctx).length > 0, label: "An audio clip to move (hats, arp, pad)" },
  ],
  stages: [
    {
      id: "cycle",
      title: "Pan cycle",
      reveal: "timeline",
      summary: "Writes a ±60% triangle pan cycle across the chosen clip at the chosen rate.",
      manual:
        "Open the track's PAN automation lane and draw a triangle: hard-ish left on one " +
        "beat, hard-ish right on the next, repeating across the clip.",
      params: [
        {
          key: "clipId",
          label: "Move this clip",
          kind: "clip",
          default: (ctx) => resolveAudioClip(ctx, undefined)?.clip.id ?? 0,
        },
        {
          key: "rate",
          label: "Rate",
          kind: "select",
          options: [
            { value: "0.5", label: "1/8 — shimmer" },
            { value: "1", label: "1/4 — classic" },
            { value: "2", label: "1/2 — slow swing" },
            { value: "4", label: "1 bar — drift" },
          ],
          default: () => "1",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the clip to move.");
        const step = Number(params.rate);
        const start = found.clip.startBeat;
        const end = clipEndBeat(found.clip, ctx.project);
        const points: Array<{ t: number; v: number }> = [];
        let side = -0.6;
        for (let b = start; b <= end + 1e-9 && points.length < 128; b += step) {
          points.push({ t: b, v: side });
          side = -side;
        }
        points.push({ t: end + 0.01, v: 0 }); // come home after the clip
        await ramp(tx, found.track.id, "pan", points);
        state.autoPanTrackId = found.track.id;
        state.autoPanStart = start;
        state.autoPanEnd = end;
        state.autoPanStep = step;
        return { commands: tx.count, note: `Pan cycles every ${step} beat(s) across the clip.` };
      },
    },
    {
      id: "tremolo",
      title: "Tremolo",
      reveal: "timeline",
      optional: true,
      summary: "Adds a matching subtle volume wobble (0 ↔ −2.5 dB) at the same rate.",
      manual:
        "On the volume automation lane, draw a small dip on every other pan turn — pan plus " +
        "a little tremolo reads as one rotating motion.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const trackId = state.autoPanTrackId as number | undefined;
        if (trackId === undefined) throw new Error("Run the Pan cycle stage first.");
        const start = state.autoPanStart as number;
        const end = state.autoPanEnd as number;
        const step = state.autoPanStep as number;
        const points: Array<{ t: number; v: number }> = [];
        let dip = false;
        for (let b = start; b <= end + 1e-9 && points.length < 128; b += step) {
          points.push({ t: b, v: dip ? dbToLin(-2.5) : 1 });
          dip = !dip;
        }
        points.push({ t: end + 0.01, v: 1 });
        await ramp(tx, trackId, "volume", points);
        return { commands: tx.count, note: "Gentle tremolo matched to the pan cycle." };
      },
    },
  ],
};

/* ============================================================================
 * Gated Reverb (80s)
 * ========================================================================= */

const gatedReverb: TechniqueDef = {
  id: "gated-reverb",
  category: "mixing",
  title: "Gated Reverb",
  tagline: "A huge room that stops dead — the 80s snare sound.",
  description:
    "Reverb into a noise gate: the tail blooms enormous for a moment, then the gate " +
    "chops it off mid-air. THE 80s snare (and a great modern vocal/clap thickener).",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(isMixerTrack), label: "A track to send (snare, clap, vocal)" },
  ],
  stages: [
    {
      id: "bus",
      title: "Bus",
      reveal: "mixer",
      summary:
        "Creates a “Gate Verb” bus: big bright reverb at 100% wet, then the stock Noise Gate " +
        "cutting the tail dead (full range, ~120 ms hold).",
      manual:
        "Add a bus: stock Reverb (Size big, Damp low, Mix 100%) followed by the stock Noise " +
        "Gate — threshold high enough that only the loud bloom opens it, hold ~120 ms, fast " +
        "release, Range at full cut. The gate slamming shut IS the sound.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const bus = await newTrack(tx, "bus", "Gate Verb");
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.85, Damp: 0.15, Mix: 100 });
        await addInsert(tx, bus.id, "builtin:gate", {
          Threshold: -35,
          Attack: 0.3,
          Hold: 120,
          Release: 60,
          Range: -80,
        });
        state.gateVerbBusId = bus.id;
        return { commands: tx.count, note: "Gate Verb bus ready — bloom, then a hard stop." };
      },
    },
    {
      id: "send",
      title: "Send",
      reveal: "mixer",
      summary: "Sends the chosen track into the bus at −6 dB — hits open the gate, tails get chopped.",
      manual: "On the snare/clap/vocal track, add a send to the Gate Verb bus around −6 dB.",
      params: [
        {
          key: "trackId",
          label: "Send from",
          kind: "track",
          trackFilter: isMixerTrack,
          default: (ctx) =>
            ctx.project.tracks.find((t) => isMixerTrack(t) && /snare|clap|drum/i.test(t.name))?.id ??
            defaultSelectedTrack(ctx, isMixerTrack),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const trackId = params.trackId as number;
        if (!ctx.project.tracks.some((t) => t.id === trackId)) throw new Error("Pick the source track.");
        const bus =
          ctx.project.tracks.find((t) => t.id === (state.gateVerbBusId as number)) ??
          ctx.project.tracks.find((t) => t.kind === "bus" && /gate/i.test(t.name));
        if (!bus) throw new Error("Run the Bus stage first.");
        await sendTo(tx, ctx.project, trackId, bus.id, dbToLin(-6));
        return { commands: tx.count, note: "Hits now bloom huge and stop dead." };
      },
    },
  ],
};

/* ============================================================================
 * Vocal Presence Chain
 * ========================================================================= */

const vocalPresence: TechniqueDef = {
  id: "vocal-presence",
  category: "mixing",
  title: "Vocal Presence Chain",
  tagline: "Clean → controlled → airy: the standard vocal channel.",
  description:
    "The three moves nearly every produced vocal gets: a high-pass plus mud dip (clean), " +
    "a 3:1 compressor riding a few dB (control), and a high shelf for air. Each stage is " +
    "one link of the chain.",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(audioLike), label: "A vocal track (audio or instrument)" },
  ],
  stages: [
    {
      id: "clean",
      title: "Clean",
      reveal: "mixer",
      summary: "Channel EQ: low cut at 90 Hz + a −2.5 dB dip around 300 Hz (the mud shelf).",
      manual:
        "On the vocal's channel EQ: low cut ~90 Hz (rumble, plosives), and a gentle −2–3 dB " +
        "peak dip around 250–350 Hz where closeness reads as mud.",
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
        await setEqBands(tx, trackId, [
          eqLowCut(90),
          { enabled: true, type: 0, freqHz: 300, gainDb: -2.5, q: 1.3 },
        ]);
        state.presenceTrackId = trackId;
        return { commands: tx.count, note: "Rumble cut, mud dipped." };
      },
    },
    {
      id: "control",
      title: "Control",
      reveal: "mixer",
      summary: "Stock Compressor: 3:1, 8 ms attack, 120 ms release, ~4 dB working, +2.5 makeup.",
      manual:
        "Insert the stock Compressor: ratio 3:1, attack ~8 ms (keeps consonants), release " +
        "~120 ms, threshold down until the loud lines lose ~4 dB. Makeup back up.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const trackId = state.presenceTrackId as number | undefined;
        if (trackId === undefined || !ctx.project.tracks.some((t) => t.id === trackId))
          throw new Error("Run the Clean stage first (it fixes which track the chain builds on).");
        await addInsert(tx, trackId, "builtin:compressor", {
          Threshold: -22,
          Ratio: 3,
          Attack: 8,
          Release: 120,
          Knee: 9,
          Makeup: 2.5,
        });
        return { commands: tx.count, note: "Level ride tamed — ~4 dB on the loud lines." };
      },
    },
    {
      id: "air",
      title: "Air",
      reveal: "mixer",
      optional: true,
      summary: "Adds a +3 dB high shelf at 10 kHz on top of the Clean bands.",
      manual: "Back on the channel EQ, add a high shelf around 10–12 kHz, +2–4 dB — the “expensive” top.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const trackId = state.presenceTrackId as number | undefined;
        const track = ctx.project.tracks.find((t) => t.id === trackId);
        if (!track) throw new Error("Run the Clean stage first.");
        // setEq REPLACES the band list — keep whatever is there and add the shelf
        await setEqBands(tx, track.id, [
          ...(track.eq?.bands ?? []),
          { enabled: true, type: 2, freqHz: 10000, gainDb: 3, q: 0.7 },
        ]);
        return { commands: tx.count, note: "Air shelf on — the vocal sits in front." };
      },
    },
  ],
};

export const mixingTechniques: TechniqueDef[] = [
  sidechainPump,
  vocalReverb,
  haasWidener,
  telephoneSection,
  duckingBed,
  autoPan,
  gatedReverb,
  vocalPresence,
];
