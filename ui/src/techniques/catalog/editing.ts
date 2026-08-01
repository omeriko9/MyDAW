/**
 * Editing & sound design — Vocal Chop Kit, Stutter Fill.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import {
  createSamplerTrack,
  duplicateClips,
  deleteClips,
  moveClips,
  setClip,
  setPluginParam,
  splitClips,
} from "../../store/actions";
import type { NoteInput } from "../../protocol/types";
import { clipEndBeat } from "../../lib/keyboard";
import {
  Tx,
  addNotes,
  allAudioClips,
  focusMidiClip,
  newMidiClip,
  paramIdByName,
  resolveAudioClip,
} from "../ops";
import { normFor } from "../norm";
import type { ParamDef, TechniqueDef } from "../types";

/** Clip picker param — defaults to the selected audio clip. */
const clipParam = (label: string): ParamDef => ({
  key: "clipId",
  label,
  kind: "clip",
  default: (ctx) => resolveAudioClip(ctx, undefined)?.clip.id ?? 0,
});

/* ============================================================================
 * Vocal Chop Kit
 * ========================================================================= */

const chopKit: TechniqueDef = {
  id: "chop-sampler",
  category: "editing",
  title: "Vocal Chop Kit",
  tagline: "The phrase becomes a playable instrument.",
  description:
    "A vocal (or any audio) phrase is loaded into the stock Sampler and played " +
    "rhythmically, repitched to taste — the chopped-vocal hook sound. Slicing by " +
    "syllable and rearranging is exactly what playing the sampler with a pattern does.",
  requirements: (ctx) => [
    {
      ok: allAudioClips(ctx).length > 0,
      label: "An audio clip to chop (import or record the phrase first)",
    },
  ],
  stages: [
    {
      id: "sampler",
      title: "Sampler",
      reveal: "timeline",
      summary:
        "Creates a Sampler instrument track loaded with the chosen clip's audio " +
        "(the engine's Create Sampler Track — C3 plays the original pitch).",
      manual:
        "Right-click the audio clip ▸ Create Sampler Track (or add an instrument track with " +
        "the stock Sampler and load the clip's file into it). C3 plays the original pitch.",
      params: [clipParam("Chop this clip")],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the audio clip to chop.");
        const r = await tx.cmd(createSamplerTrack(found.clip.id));
        state.chopTrackId = r.trackId;
        state.chopInstanceId = r.instanceId;
        state.chopSourceStart = found.clip.startBeat;
        return { commands: tx.count, note: "Sampler track created from the clip — C3 = original." };
      },
    },
    {
      id: "pattern",
      title: "Pattern",
      reveal: "pianoRoll",
      summary:
        "Writes a one-bar chop pattern on the sampler track (root, fourth, fifth and octave " +
        "jumps — pentatonic-safe), starting at the source clip's position.",
      manual:
        "Add a 1-bar MIDI clip on the sampler track and draw a syncopated pattern around C3 — " +
        "octave (C4), fifth (G3) and fourth (F3) jumps stay safe in almost any key. Short " +
        "notes chop; long notes let the phrase speak.",
      params: [
        {
          key: "root",
          label: "Root (MIDI pitch)",
          kind: "number",
          min: 24,
          max: 96,
          step: 1,
          default: () => 60,
          help: "60 = C3 in the sampler's default mapping (original pitch).",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const trackId = state.chopTrackId as number | undefined;
        const track =
          ctx.project.tracks.find((t) => t.id === trackId) ??
          ctx.project.tracks.find(
            (t) => t.kind === "instrument" && t.inserts.some((i) => i.uid === "builtin:sampler"),
          );
        if (!track) throw new Error("No sampler track found — run the Sampler stage first.");
        const root = params.root as number;
        const start =
          (state.chopSourceStart as number | undefined) ??
          Math.floor(ctx.playheadBeat / ctx.beatsPerBar) * ctx.beatsPerBar;
        // Syncopated 1-bar chop: [beat, semitone offset, length, velocity]
        const steps: Array<[number, number, number, number]> = [
          [0, 0, 0.5, 112],
          [0.75, 12, 0.25, 96],
          [1, 7, 0.5, 104],
          [1.75, 0, 0.25, 88],
          [2, 5, 0.75, 108],
          [3, 0, 0.5, 100],
          [3.5, 7, 0.5, 92],
        ];
        const notes: NoteInput[] = steps.map(([b, semi, len, vel]) => ({
          pitch: root + semi,
          velocity: vel,
          startBeat: b,
          lengthBeats: len,
        }));
        const clip = await newMidiClip(tx, track.id, start, ctx.beatsPerBar);
        await addNotes(tx, clip.id, notes);
        focusMidiClip(clip.id); // reveal("pianoRoll") then shows the pattern
        return { commands: tx.count, note: "1-bar chop pattern written — edit it in the Piano Roll." };
      },
    },
    {
      id: "tighten",
      title: "Tighten",
      reveal: "mixer",
      optional: true,
      summary: "Makes the sampler chop-snappy: Loop off, 1 ms attack, 90 ms release.",
      manual:
        "In the sampler's editor: Loop off, Attack down to ~1 ms, Release ~90 ms — each note " +
        "becomes a clean slice instead of a smeared drone.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const instanceId =
          (state.chopInstanceId as number | undefined) ??
          ctx.project.tracks
            .flatMap((t) => t.inserts)
            .find((i) => i.uid === "builtin:sampler")?.instanceId;
        if (instanceId === undefined) throw new Error("No sampler found — run the Sampler stage first.");
        const uid = "builtin:sampler";
        for (const [name, value] of Object.entries({ Loop: 0, Attack: 1, Release: 90 })) {
          const id = await paramIdByName(instanceId, name);
          await tx.cmd(setPluginParam(instanceId, id, normFor(uid, name, value)));
        }
        return { commands: tx.count, note: "Sampler envelope tightened for chopping." };
      },
    },
  ],
};

/* ============================================================================
 * Stutter Fill
 * ========================================================================= */

const stutter: TechniqueDef = {
  id: "stutter-fill",
  category: "editing",
  title: "Stutter Fill",
  tagline: "The last beat becomes a 1/16 repeat.",
  description:
    "A fill from pure editing: the final beat of a phrase is replaced by its own first " +
    "sixteenth repeated four times — the glitch/stutter transition heard before drops " +
    "and section changes.",
  requirements: (ctx) => {
    const clips = allAudioClips(ctx);
    const anyLong = clips.some((f) => clipEndBeat(f.clip, ctx.project) - f.clip.startBeat >= 2);
    return [
      { ok: clips.length > 0, label: "An audio clip to stutter" },
      { ok: anyLong, label: "A clip at least 2 beats long (the last beat becomes the fill)" },
    ];
  },
  stages: [
    {
      id: "slice",
      title: "Slice",
      reveal: "timeline",
      summary:
        "Splits off the clip's last beat, keeps only its first 1/16, and repeats that " +
        "sixteenth four times in the beat's place.",
      manual:
        "Split the clip one beat before its end, then split that tail again a 1/16 in. Delete " +
        "the rest of the tail, and Alt-drag (copy) the 1/16 slice into the three empty 1/16 " +
        "slots so the same fragment plays four times.",
      params: [clipParam("Stutter this clip")],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the audio clip to stutter.");
        const end = clipEndBeat(found.clip, ctx.project);
        if (end - found.clip.startBeat < 2)
          throw new Error("The clip must be at least 2 beats long.");
        const lastBeat = end - 1;
        // head | tail(1 beat)
        const s1 = await tx.cmd(splitClips([found.clip.id], lastBeat));
        const tailId = s1.newClipIds[0];
        if (tailId === undefined) throw new Error("Split produced no tail — is the clip at least 2 beats?");
        // slice(1/16) | rest
        const s2 = await tx.cmd(splitClips([tailId], lastBeat + 0.25));
        const restId = s2.newClipIds[0];
        if (restId !== undefined) await tx.cmd(deleteClips([restId]));
        // repeat the 1/16 into the three empty slots
        const sliceIds: number[] = [tailId];
        for (let i = 1; i <= 3; i++) {
          const dup = await tx.cmd(duplicateClips([tailId], true)); // atSource: copy lands ON the original
          const copyId = dup.clips[0]?.id;
          if (copyId === undefined) throw new Error("Duplicate returned no clip.");
          await tx.cmd(moveClips([copyId], 0.25 * i));
          sliceIds.push(copyId);
        }
        state.stutterSliceIds = sliceIds;
        return { commands: tx.count, note: "Last beat replaced by four 1/16 repeats." };
      },
    },
    {
      id: "shape",
      title: "Shape",
      reveal: "timeline",
      optional: true,
      summary:
        "Fades each repeat's tail and steps their gains down (0 / −1.5 / −3 / −4.5 dB) so the " +
        "stutter pumps instead of clicking.",
      manual:
        "Give each repeat a short fade-out (a few ms kills the click at the cut), and pull " +
        "each successive repeat down ~1.5 dB — the decay makes it feel performed.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const ids = state.stutterSliceIds as number[] | undefined;
        if (!ids || ids.length === 0)
          throw new Error("No stutter slices recorded — run the Slice stage first (in this wizard).");
        for (let i = 0; i < ids.length; i++) {
          // clip gain is LINEAR; fades are in seconds (AudioClip contract)
          await tx.cmd(setClip(ids[i], { fadeOutSec: 0.008, gain: Math.pow(10, (-1.5 * i) / 20) }));
        }
        return { commands: tx.count, note: "Repeats faded and stepped down in gain." };
      },
    },
  ],
};

export const editingTechniques: TechniqueDef[] = [chopKit, stutter];
