/**
 * Vocal production — Stereo Doubler, Delay Throw.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import {
  duplicateTrack,
  editNotes,
  moveClips,
  setPluginParam,
  setTrack,
  stretchClip,
} from "../../store/actions";
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
  paramIdByName,
  pitchRatio,
  ramp,
  resolveAudioClip,
  sendTo,
  setEqBands,
} from "../ops";
import { normFor } from "../norm";
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

/* ============================================================================
 * Slapback Echo
 * ========================================================================= */

const slapback: TechniqueDef = {
  id: "slapback",
  category: "vocal",
  title: "Slapback Echo",
  tagline: "One quick repeat — the 50s rock'n'roll vocal.",
  description:
    "A single short echo (80–120 ms, almost no feedback) glued right behind the voice — " +
    "Elvis, rockabilly, and half of modern indie. Insert, not send: the echo is part of " +
    "the voice, not a space around it.",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(audioLike), label: "A vocal track (audio or instrument)" },
  ],
  stages: [
    {
      id: "echo",
      title: "Echo",
      reveal: "mixer",
      summary:
        "Inserts the stock Delay on the vocal: one repeat at the chosen time, feedback 8%, " +
        "mix 20%, mono (no ping-pong).",
      manual:
        "Insert the stock Delay on the vocal track: Time ~90 ms (or a 1/16 at your tempo), " +
        "Feedback under 10% (ONE audible repeat), Mix ~20%, Ping-Pong off.",
      params: [
        {
          key: "trackId",
          label: "Vocal track",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
        {
          key: "time",
          label: "Timing",
          kind: "select",
          options: [
            { value: "classic", label: "90 ms (classic)" },
            { value: "s16", label: "1/16 at tempo" },
            { value: "s8", label: "1/8 at tempo" },
          ],
          default: () => "classic",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const trackId = params.trackId as number;
        if (!ctx.project.tracks.some((t) => t.id === trackId)) throw new Error("Pick the vocal track.");
        const beatMs = 60000 / ctx.bpm;
        const ms =
          params.time === "s16" ? beatMs / 4 : params.time === "s8" ? beatMs / 2 : 90;
        const d = await addInsert(tx, trackId, "builtin:delay", {
          Time: Math.min(2000, Math.max(1, ms)),
          Feedback: 8,
          Mix: 20,
          Tone: 5500,
          "Ping-Pong": 0,
        });
        state.slapInstanceId = d.instanceId;
        return { commands: tx.count, note: `Slapback at ${Math.round(ms)} ms.` };
      },
    },
    {
      id: "seat",
      title: "Seat it",
      reveal: "mixer",
      optional: true,
      summary: "Darkens and tucks the repeat (Tone 3.5 kHz, Mix 14%) so it thickens without smearing.",
      manual: "Pull the delay's Tone down (~3.5 kHz) and the Mix a notch — felt, not heard.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const instanceId =
          (state.slapInstanceId as number | undefined) ??
          ctx.project.tracks.flatMap((t) => t.inserts).find((i) => i.uid === "builtin:delay")
            ?.instanceId;
        if (instanceId === undefined) throw new Error("Run the Echo stage first.");
        for (const [name, value] of Object.entries({ Tone: 3500, Mix: 14 })) {
          const id = await paramIdByName(instanceId, name);
          await tx.cmd(setPluginParam(instanceId, id, normFor("builtin:delay", name, value)));
        }
        return { commands: tx.count, note: "Repeat darkened and tucked." };
      },
    },
  ],
};

/* ============================================================================
 * Harmony Stack
 * ========================================================================= */

const harmonyStack: TechniqueDef = {
  id: "harmony-stack",
  category: "vocal",
  title: "Harmony Stack",
  tagline: "A pitched copy sings along, tucked off to one side.",
  description:
    "A duplicate of the part is pitch-shifted to a harmony interval (fifth or octave — " +
    "the key-safe ones), panned aside and tucked under the lead. Audio clips shift via " +
    "constant-length pitch-shift; MIDI clips transpose their notes.",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some((t) => audioLike(t) && t.clips.length > 0),
      label: "A track with material to harmonize",
    },
  ],
  stages: [
    {
      id: "copy",
      title: "Copy",
      reveal: "timeline",
      summary: "Duplicates the track (deep copy) and names it “(harmony)”.",
      manual: "Duplicate the vocal track and name the copy “(harmony)”.",
      params: [
        {
          key: "trackId",
          label: "Harmonize this",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const src = ctx.project.tracks.find((t) => t.id === (params.trackId as number));
        if (!src) throw new Error("Pick the track to harmonize.");
        const copy = (await tx.cmd(duplicateTrack(src.id))).track;
        await tx.cmd(setTrack(copy.id, { name: `${src.name} (harmony)` }));
        state.harmonyCopyId = copy.id;
        return { commands: tx.count, note: "Harmony copy created." };
      },
    },
    {
      id: "pitch",
      title: "Pitch",
      reveal: "timeline",
      summary:
        "Shifts the copy to the chosen interval: audio clips via constant-length pitch-" +
        "shift, MIDI clips by transposing their notes.",
      manual:
        "Audio clips on the copy: right-click ▸ Time-Stretch with a transpose to the " +
        "interval (fifth = +7, octave = ±12). MIDI clips: select all notes, transpose.",
      params: [
        {
          key: "interval",
          label: "Interval",
          kind: "select",
          options: [
            { value: "7", label: "+7 — fifth up (safe)" },
            { value: "12", label: "+12 — octave up" },
            { value: "-12", label: "−12 — octave under" },
          ],
          default: () => "7",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const copy =
          ctx.project.tracks.find((t) => t.id === (state.harmonyCopyId as number)) ??
          ctx.project.tracks.find((t) => /\(harmony\)$/.test(t.name));
        if (!copy) throw new Error("Run the Copy stage first.");
        const semis = Number(params.interval);
        let shifted = 0;
        for (const clip of copy.clips) {
          if (clip.type === "audio") {
            await tx.cmd(stretchClip(clip.id, pitchRatio(semis), true));
            shifted++;
          } else {
            const updates = clip.notes.map((n) => ({
              noteId: n.id,
              patch: { pitch: Math.min(127, Math.max(0, n.pitch + semis)) },
            }));
            if (updates.length > 0) {
              await tx.cmd(editNotes(clip.id, { update: updates }));
              shifted++;
            }
          }
        }
        if (shifted === 0) throw new Error("The harmony copy has no clips to pitch.");
        return { commands: tx.count, note: `${shifted} clip(s) shifted ${semis > 0 ? "+" : ""}${semis} st.` };
      },
    },
    {
      id: "tuck",
      title: "Tuck",
      reveal: "mixer",
      summary: "Pans the harmony +30% and drops it −6 dB — company, not competition.",
      manual: "Pan the harmony a third off-center and pull it ~6 dB under the lead.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const copy =
          ctx.project.tracks.find((t) => t.id === (state.harmonyCopyId as number)) ??
          ctx.project.tracks.find((t) => /\(harmony\)$/.test(t.name));
        if (!copy) throw new Error("Run the Copy stage first.");
        await tx.cmd(setTrack(copy.id, { pan: 0.3, volume: copy.volume * dbToLin(-6) }));
        return { commands: tx.count, note: "Harmony tucked right-of-center, −6 dB." };
      },
    },
  ],
};

/* ============================================================================
 * Octave-Under Double
 * ========================================================================= */

const octaveUnder: TechniqueDef = {
  id: "octave-under",
  category: "vocal",
  title: "Octave-Under Double",
  tagline: "A dark whisper one octave down, dead center.",
  description:
    "The modern pop thickener: a copy pitched a full octave DOWN sits centered and " +
    "quiet under the lead — heard as weight and intimacy, not as a second voice.",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some((t) => audioLike(t) && t.clips.some((c) => c.type === "audio")),
      label: "A track with AUDIO material (the shift is an audio pitch-shift)",
    },
  ],
  stages: [
    {
      id: "copy",
      title: "Copy & drop",
      reveal: "timeline",
      summary: "Duplicates the track as “(octave)” and pitch-shifts every audio clip −12 st.",
      manual:
        "Duplicate the vocal track, then on each of the copy's clips: Time-Stretch ▸ " +
        "transpose one octave down (constant length).",
      params: [
        {
          key: "trackId",
          label: "Thicken this",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const src = ctx.project.tracks.find((t) => t.id === (params.trackId as number));
        if (!src) throw new Error("Pick the track to thicken.");
        const copy = (await tx.cmd(duplicateTrack(src.id))).track;
        await tx.cmd(setTrack(copy.id, { name: `${src.name} (octave)` }));
        let shifted = 0;
        for (const clip of copy.clips)
          if (clip.type === "audio") {
            await tx.cmd(stretchClip(clip.id, pitchRatio(-12), true));
            shifted++;
          }
        if (shifted === 0) throw new Error("No audio clips on the copy to shift.");
        state.octaveCopyId = copy.id;
        return { commands: tx.count, note: `${shifted} clip(s) dropped one octave.` };
      },
    },
    {
      id: "bury",
      title: "Bury it",
      reveal: "mixer",
      summary: "Center pan, −9 dB, high-passed at 120 Hz — felt more than heard.",
      manual:
        "Keep the octave copy dead center, pull it 8–10 dB under the lead, and low-cut it " +
        "~120 Hz so the sub range stays clean. If you can point at it, it's too loud.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const copy =
          ctx.project.tracks.find((t) => t.id === (state.octaveCopyId as number)) ??
          ctx.project.tracks.find((t) => /\(octave\)$/.test(t.name));
        if (!copy) throw new Error("Run the Copy & drop stage first.");
        await tx.cmd(setTrack(copy.id, { pan: 0, volume: copy.volume * dbToLin(-9) }));
        await setEqBands(tx, copy.id, [eqLowCut(120)]);
        return { commands: tx.count, note: "Octave buried — weight without a second voice." };
      },
    },
  ],
};

/* ============================================================================
 * Ad-Lib Placement
 * ========================================================================= */

const adLibPlace: TechniqueDef = {
  id: "adlib-space",
  category: "vocal",
  title: "Ad-Lib Placement",
  tagline: "Answers live off to the side, wetter than the lead.",
  description:
    "The hip-hop/pop convention: ad-libs and answer lines sit off-center and noticeably " +
    "WETTER than the lead — a different room, so the ear files them as commentary.",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(audioLike), label: "An ad-lib track (audio or instrument)" },
  ],
  stages: [
    {
      id: "place",
      title: "Place",
      reveal: "mixer",
      summary: "Pans the ad-lib track to the chosen side (±50%) and drops it −3 dB.",
      manual: "Pan the ad-lib track half-way to one side and pull it ~3 dB under the lead.",
      params: [
        {
          key: "trackId",
          label: "Ad-lib track",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
        {
          key: "side",
          label: "Side",
          kind: "select",
          options: [
            { value: "L", label: "Left" },
            { value: "R", label: "Right" },
          ],
          default: () => "R",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const track = ctx.project.tracks.find((t) => t.id === (params.trackId as number));
        if (!track) throw new Error("Pick the ad-lib track.");
        await tx.cmd(
          setTrack(track.id, {
            pan: params.side === "L" ? -0.5 : 0.5,
            volume: track.volume * dbToLin(-3),
          }),
        );
        state.adlibTrackId = track.id;
        return { commands: tx.count, note: `Ad-libs parked ${params.side === "L" ? "left" : "right"}.` };
      },
    },
    {
      id: "wet",
      title: "Wet",
      reveal: "mixer",
      summary:
        "Creates an “Ad-Lib FX” bus (1/8 delay into a roomy reverb, 100% wet) and sends the " +
        "ad-libs in at −8 dB — clearly wetter than the lead.",
      manual:
        "Add a bus with a delay (1/8 at tempo, feedback ~35%) into a reverb, both 100% wet. " +
        "Send the ad-lib track into it noticeably hotter than the lead's sends.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const trackId = (state.adlibTrackId as number | undefined) ??
          defaultSelectedTrack(ctx, audioLike);
        if (!ctx.project.tracks.some((t) => t.id === trackId))
          throw new Error("Run the Place stage first (it fixes which track gets wet).");
        const bus = await newTrack(tx, "bus", "Ad-Lib FX");
        await addInsert(tx, bus.id, "builtin:delay", {
          Time: Math.min(2000, 60000 / ctx.bpm / 2),
          Feedback: 35,
          Mix: 100,
          Tone: 5000,
          "Ping-Pong": 1,
        });
        await addInsert(tx, bus.id, "builtin:reverb", { Size: 0.7, Damp: 0.4, Mix: 100 });
        await sendTo(tx, ctx.project, trackId, bus.id, dbToLin(-8));
        return { commands: tx.count, note: "Ad-libs answer from their own wet room." };
      },
    },
  ],
};

/* ============================================================================
 * Noise Gate Cleanup
 * ========================================================================= */

const vocalGate: TechniqueDef = {
  id: "vocal-gate",
  category: "vocal",
  title: "Noise Gate Cleanup",
  tagline: "Room hiss and headphone bleed vanish between phrases.",
  description:
    "The unglamorous technique every produced vocal relies on: a gate set GENTLY — " +
    "partial range, soft release — so the track goes quiet between phrases without " +
    "chopping breaths and word tails.",
  requirements: (ctx) => [
    { ok: ctx.project.tracks.some(audioLike), label: "A vocal track (audio or instrument)" },
  ],
  stages: [
    {
      id: "gate",
      title: "Gate",
      reveal: "mixer",
      summary:
        "Stock Noise Gate on the vocal: threshold −45 dB, hold 90 ms, release 150 ms, and " +
        "Range only −18 dB — attenuation, not amputation.",
      manual:
        "Insert the stock Noise Gate: threshold just above the room noise (~−45 dB), hold " +
        "~90 ms, release ~150 ms, and set RANGE to −15…−20 dB instead of full cut — the " +
        "gaps get quieter, not surgically dead.",
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
        const g = await addInsert(tx, trackId, "builtin:gate", {
          Threshold: -45,
          Attack: 0.5,
          Hold: 90,
          Release: 150,
          Range: -18,
        });
        state.vgateInstanceId = g.instanceId;
        return { commands: tx.count, note: "Gentle gate on — gaps drop 18 dB." };
      },
    },
    {
      id: "breaths",
      title: "Breath safety",
      reveal: "mixer",
      optional: true,
      summary: "Slower timing (hold 140 ms, release 250 ms) if breaths or word tails clip off.",
      manual:
        "If you hear breaths cut in half or word tails vanish, lengthen Hold (~140 ms) and " +
        "Release (~250 ms) until the gate closes politely.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const instanceId =
          (state.vgateInstanceId as number | undefined) ??
          ctx.project.tracks.flatMap((t) => t.inserts).find((i) => i.uid === "builtin:gate")
            ?.instanceId;
        if (instanceId === undefined) throw new Error("Run the Gate stage first.");
        for (const [name, value] of Object.entries({ Hold: 140, Release: 250 })) {
          const id = await paramIdByName(instanceId, name);
          await tx.cmd(setPluginParam(instanceId, id, normFor("builtin:gate", name, value)));
        }
        return { commands: tx.count, note: "Gate timing relaxed for breaths." };
      },
    },
  ],
};

/* ============================================================================
 * ADT (fake double)
 * ========================================================================= */

const adtDouble: TechniqueDef = {
  id: "adt-double",
  category: "vocal",
  title: "ADT — Fake Double",
  tagline: "Abbey Road's tape trick: one take sounds like two.",
  description:
    "Artificial Double Tracking, invented for Lennon: a copy of the single take is " +
    "detuned ~30 cents and drifted ~14 ms so the ear accepts it as a second " +
    "performance. When there's no time for a real double, this is the double.",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some((t) => audioLike(t) && t.clips.some((c) => c.type === "audio")),
      label: "A track with AUDIO takes (the detune is an audio pitch-shift)",
    },
  ],
  stages: [
    {
      id: "copy",
      title: "Copy",
      reveal: "timeline",
      summary: "Duplicates the track as “(ADT)”, panned +25% and −5 dB.",
      manual: "Duplicate the vocal track, pan the copy slightly aside, drop it ~5 dB.",
      params: [
        {
          key: "trackId",
          label: "Double this",
          kind: "track",
          trackFilter: audioLike,
          default: (ctx) => defaultSelectedTrack(ctx, audioLike),
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const src = ctx.project.tracks.find((t) => t.id === (params.trackId as number));
        if (!src) throw new Error("Pick the track to double.");
        const copy = (await tx.cmd(duplicateTrack(src.id))).track;
        await tx.cmd(
          setTrack(copy.id, { name: `${src.name} (ADT)`, pan: 0.25, volume: src.volume * dbToLin(-5) }),
        );
        state.adtCopyId = copy.id;
        return { commands: tx.count, note: "ADT copy ready." };
      },
    },
    {
      id: "drift",
      title: "Detune & drift",
      reveal: "timeline",
      summary:
        "Detunes the copy's audio clips +30 cents (constant length) and drifts them 14 ms " +
        "late — the imperfections that read as a human double.",
      manual:
        "Pitch-shift the copy's clips by ~+30 CENTS (Time-Stretch transpose, tiny ratio) and " +
        "nudge them ~14 ms late. Perfect copies phase; imperfect ones double.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const copy =
          ctx.project.tracks.find((t) => t.id === (state.adtCopyId as number)) ??
          ctx.project.tracks.find((t) => /\(ADT\)$/.test(t.name));
        if (!copy) throw new Error("Run the Copy stage first.");
        let shifted = 0;
        for (const clip of copy.clips)
          if (clip.type === "audio") {
            await tx.cmd(stretchClip(clip.id, pitchRatio(0.3), true)); // +30 cents
            shifted++;
          }
        if (shifted === 0) throw new Error("No audio clips on the ADT copy.");
        const ids = copy.clips.filter((c) => c.type === "audio").map((c) => c.id);
        await tx.cmd(moveClips(ids, msToBeats(14, ctx.bpm)));
        return { commands: tx.count, note: "Copy detuned +30¢ and drifted 14 ms — instant double." };
      },
    },
  ],
};

export const vocalTechniques: TechniqueDef[] = [
  doubler,
  delayThrow,
  slapback,
  harmonyStack,
  octaveUnder,
  adLibPlace,
  vocalGate,
  adtDouble,
];
