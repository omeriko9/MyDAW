/**
 * Editing & sound design — Vocal Chop Kit, Stutter Fill.
 * (docs/PRODUCTION_TECHNIQUES_PLAN.md §4; queue: PRODUCTION_TECHNIQUES_BACKLOG.md)
 */

import {
  createSamplerTrack,
  duplicateClips,
  deleteClips,
  editNotes,
  moveClips,
  processAudioClip,
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
  msToBeats,
  newMidiClip,
  paramIdByName,
  resolveAudioClip,
  resolveMidiClip,
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

/* ============================================================================
 * Glitch Ratchet
 * ========================================================================= */

const glitchRatchet: TechniqueDef = {
  id: "glitch-ratchet",
  category: "editing",
  title: "Glitch Ratchet",
  tagline: "Repeats that keep doubling: 1/8 → 1/16 → 1/32.",
  description:
    "The stutter's aggressive sibling: the last two beats become repeats of one fragment " +
    "whose rate keeps doubling — the ratcheting glitch that spins into a drop.",
  requirements: (ctx) => {
    const clips = allAudioClips(ctx);
    return [
      {
        ok: clips.some((f) => clipEndBeat(f.clip, ctx.project) - f.clip.startBeat >= 3),
        label: "An audio clip at least 3 beats long (the last 2 beats become the ratchet)",
      },
    ];
  },
  stages: [
    {
      id: "ratchet",
      title: "Ratchet",
      reveal: "timeline",
      summary:
        "Rebuilds the clip's last two beats from its own first 1/8: two 1/8 hits, two 1/16 " +
        "doubles, then a 1/32 blur into the downbeat.",
      manual:
        "Split off the last two beats, keep only the first 1/8, and copy it into a " +
        "densifying grid: 1/8s in the first beat, 1/16s then 1/32s through the second. " +
        "Each repeat is the SAME fragment — the acceleration is the effect.",
      params: [clipParam("Ratchet this clip")],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the audio clip to ratchet.");
        const end = clipEndBeat(found.clip, ctx.project);
        if (end - found.clip.startBeat < 3) throw new Error("The clip must be at least 3 beats long.");
        const zone = end - 2;
        // head | zone(2 beats)
        const s1 = await tx.cmd(splitClips([found.clip.id], zone));
        const zoneId = s1.newClipIds[0];
        if (zoneId === undefined) throw new Error("Split produced no tail.");
        // fragment(1/8) | rest — delete the rest
        const s2 = await tx.cmd(splitClips([zoneId], zone + 0.5));
        if (s2.newClipIds[0] !== undefined) await tx.cmd(deleteClips([s2.newClipIds[0]]));
        // fragment plays at: 0, .5 (1/8s) · 1, 1.25, 1.5 (1/16 pair + start of blur) · 1.75, 1.875 (1/32s)
        const offsets = [0.5, 1, 1.25, 1.5, 1.75, 1.875];
        const ids: number[] = [zoneId];
        for (const off of offsets) {
          const dup = await tx.cmd(duplicateClips([zoneId], true));
          const copyId = dup.clips[0]?.id;
          if (copyId === undefined) throw new Error("Duplicate returned no clip.");
          await tx.cmd(moveClips([copyId], off));
          ids.push(copyId);
        }
        state.ratchetIds = ids;
        return { commands: tx.count, note: "Ratchet built — same fragment, doubling rate." };
      },
    },
    {
      id: "shape",
      title: "Shape",
      reveal: "timeline",
      optional: true,
      summary: "Short fades on every repeat + a rising gain staircase into the downbeat.",
      manual:
        "Give every repeat a few-ms fade-out (kills clicks) and STEP THE GAIN UP toward the " +
        "end — a ratchet that gets louder as it accelerates hits harder.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const ids = state.ratchetIds as number[] | undefined;
        if (!ids || ids.length === 0) throw new Error("Run the Ratchet stage first (in this wizard).");
        for (let i = 0; i < ids.length; i++) {
          const db = -4 + (4 * i) / Math.max(1, ids.length - 1); // −4 dB rising to 0
          await tx.cmd(setClip(ids[i], { fadeOutSec: 0.006, gain: Math.pow(10, db / 20) }));
        }
        return { commands: tx.count, note: "Repeats de-clicked, gain climbing into the hit." };
      },
    },
  ],
};

/* ============================================================================
 * Reverse Chop Tails
 * ========================================================================= */

const reverseChops: TechniqueDef = {
  id: "reverse-chops",
  category: "editing",
  title: "Reverse Chop Tails",
  tagline: "Every other slice plays backwards.",
  description:
    "Chop a phrase on the beat grid and reverse alternating slices — forward, backward, " +
    "forward. The sucking-breathing texture of chopped edits, from IDM to lo-fi beats.",
  requirements: (ctx) => [
    {
      ok: allAudioClips(ctx).some((f) => clipEndBeat(f.clip, ctx.project) - f.clip.startBeat >= 2),
      label: "An audio clip at least 2 beats long",
    },
  ],
  stages: [
    {
      id: "slice",
      title: "Slice & flip",
      reveal: "timeline",
      summary:
        "Splits the clip at every beat (up to 8) and REVERSES every second slice in place.",
      manual:
        "Split the clip on each beat line, then right-click every second slice ▸ Process ▸ " +
        "Reverse. The grid stays; the direction alternates.",
      params: [clipParam("Chop & flip this clip")],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the audio clip.");
        const start = found.clip.startBeat;
        const end = Math.min(clipEndBeat(found.clip, ctx.project), start + 8);
        if (end - start < 2) throw new Error("The clip must be at least 2 beats long.");
        // split at each interior beat line — each split's tail carries the rest
        let currentId = found.clip.id;
        const slices: number[] = [currentId];
        for (let b = Math.floor(start) + 1; b < end - 1e-9; b++) {
          if (b <= start) continue;
          const s = await tx.cmd(splitClips([currentId], b));
          const tail = s.newClipIds[0];
          if (tail === undefined) break;
          slices.push(tail);
          currentId = tail;
        }
        let flipped = 0;
        for (let i = 1; i < slices.length; i += 2) {
          await tx.cmd(processAudioClip(slices[i], "reverse"));
          flipped++;
        }
        if (flipped === 0) throw new Error("Nothing to flip — is the clip on a beat boundary?");
        state.revChopIds = slices;
        return { commands: tx.count, note: `${slices.length} slices, ${flipped} reversed.` };
      },
    },
    {
      id: "smooth",
      title: "Smooth",
      reveal: "timeline",
      optional: true,
      summary: "5 ms fades on both ends of every slice — the cuts stop clicking.",
      manual: "Tiny fade-in and fade-out on each slice (a few ms) removes the edit clicks.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const ids = state.revChopIds as number[] | undefined;
        if (!ids || ids.length === 0) throw new Error("Run the Slice & flip stage first.");
        for (const id of ids) await tx.cmd(setClip(id, { fadeInSec: 0.005, fadeOutSec: 0.005 }));
        return { commands: tx.count, note: "Slice boundaries de-clicked." };
      },
    },
  ],
};

/* ============================================================================
 * Humanize Groove (MIDI)
 * ========================================================================= */

const humanize: TechniqueDef = {
  id: "humanize-groove",
  category: "editing",
  title: "Humanize Groove",
  tagline: "The quantized part learns to breathe.",
  description:
    "Two edits that turn a grid-perfect MIDI part human: off-beats pushed late (swing " +
    "plus a whisper of drift), and velocities re-accented so downbeats lead. Pure note " +
    "surgery — one undo entry per pass.",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some((t) => t.clips.some((c) => c.type === "midi" && c.notes.length > 0)),
      label: "A MIDI clip with notes",
    },
  ],
  stages: [
    {
      id: "swing",
      title: "Swing & drift",
      reveal: "pianoRoll",
      summary:
        "Pushes every off-beat 8th late by the chosen feel (plus alternating ±4 ms drift " +
        "on all notes). One undo entry.",
      manual:
        "Select the off-beat 8ths and nudge them late (10–25 ms worth). Then drag random " +
        "notes a hair early/late — the imperfection IS the groove.",
      params: [
        {
          key: "clipId",
          label: "MIDI clip",
          kind: "clip",
          clipKind: "midi",
          default: (ctx) => resolveMidiClip(ctx, undefined)?.clip.id ?? 0,
        },
        {
          key: "feel",
          label: "Feel",
          kind: "select",
          options: [
            { value: "8", label: "Subtle (8 ms)" },
            { value: "16", label: "Swung (16 ms)" },
            { value: "26", label: "Drunk (26 ms)" },
          ],
          default: () => "16",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveMidiClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick a MIDI clip.");
        if (found.clip.notes.length === 0) throw new Error("The clip has no notes.");
        const lateBeats = msToBeats(Number(params.feel), ctx.bpm);
        const driftBeats = msToBeats(4, ctx.bpm);
        const updates = found.clip.notes.map((n, i) => {
          const phase = n.startBeat % 1;
          const offbeat8 = Math.abs(phase - 0.5) < 0.06; // the "and" of each beat
          const drift = (i % 2 === 0 ? 1 : -1) * driftBeats;
          return {
            noteId: n.id,
            patch: { startBeat: Math.max(0, n.startBeat + (offbeat8 ? lateBeats : 0) + drift) },
          };
        });
        await tx.cmd(editNotes(found.clip.id, { update: updates }));
        focusMidiClip(found.clip.id);
        state.humanClipId = found.clip.id;
        return { commands: tx.count, note: `Off-beats pushed ${params.feel} ms late, all notes drifting ±4 ms.` };
      },
    },
    {
      id: "accents",
      title: "Accents",
      reveal: "pianoRoll",
      summary: "Velocity re-accenting: downbeats +14, off-beats −10 (clamped 1–127). One undo entry.",
      manual:
        "Raise the velocities of notes ON the beat and lower the in-between ones — the " +
        "loud-soft alternation is what a human hand does unasked.",
      run: async (ctx, _params, state) => {
        const tx = new Tx();
        const clipId = state.humanClipId as number | undefined;
        const found = resolveMidiClip(ctx, clipId);
        if (!found) throw new Error("Run Swing & drift first (or pick the clip there).");
        const updates = found.clip.notes.map((n) => {
          const onBeat = Math.abs(n.startBeat - Math.round(n.startBeat)) < 0.1;
          const v = Math.min(127, Math.max(1, n.velocity + (onBeat ? 14 : -10)));
          return { noteId: n.id, patch: { velocity: v } };
        });
        await tx.cmd(editNotes(found.clip.id, { update: updates }));
        return { commands: tx.count, note: "Downbeats lead, off-beats sit back." };
      },
    },
  ],
};

/* ============================================================================
 * MIDI Note Echo
 * ========================================================================= */

const midiEcho: TechniqueDef = {
  id: "midi-echo",
  category: "editing",
  title: "MIDI Note Echo",
  tagline: "Echoes as NOTES you can edit — not a delay plugin.",
  description:
    "Every note gets quieter copies at a rhythmic interval — a delay effect made of " +
    "editable MIDI. The echoes re-trigger the instrument (they decay in TONE, not just " +
    "level) and can be reshaped note by note afterwards.",
  requirements: (ctx) => [
    {
      ok: ctx.project.tracks.some((t) => t.clips.some((c) => c.type === "midi" && c.notes.length > 0)),
      label: "A MIDI clip with notes",
    },
  ],
  stages: [
    {
      id: "echo",
      title: "Echo taps",
      reveal: "pianoRoll",
      summary: "Adds two echo copies of every note at the chosen interval, at 65% and 40% velocity.",
      manual:
        "Copy all notes, paste at +interval with lower velocities, repeat once more quieter. " +
        "Dotted-eighth echoes are the classic (The Edge's guitar rig, in MIDI).",
      params: [
        {
          key: "clipId",
          label: "MIDI clip",
          kind: "clip",
          clipKind: "midi",
          default: (ctx) => resolveMidiClip(ctx, undefined)?.clip.id ?? 0,
        },
        {
          key: "interval",
          label: "Interval",
          kind: "select",
          options: [
            { value: "0.5", label: "1/8" },
            { value: "0.75", label: "Dotted 1/8 (classic)" },
            { value: "1", label: "1/4" },
          ],
          default: () => "0.75",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveMidiClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick a MIDI clip.");
        const src = found.clip.notes;
        if (src.length === 0) throw new Error("The clip has no notes.");
        if (src.length > 300) throw new Error("Over 300 notes — echoing would flood the clip.");
        const step = Number(params.interval);
        const add: NoteInput[] = [];
        for (const tap of [1, 2]) {
          const vel = tap === 1 ? 0.65 : 0.4;
          for (const n of src) {
            const startBeat = n.startBeat + step * tap;
            if (startBeat >= found.clip.lengthBeats) continue; // echoes stay inside the clip
            add.push({
              pitch: n.pitch,
              velocity: Math.max(1, Math.round(n.velocity * vel)),
              startBeat,
              lengthBeats: Math.min(n.lengthBeats, step * 0.9),
            });
          }
        }
        if (add.length === 0) throw new Error("No room for echoes inside the clip — lengthen it first.");
        await tx.cmd(editNotes(found.clip.id, { add }));
        focusMidiClip(found.clip.id);
        state.echoClipId = found.clip.id;
        return { commands: tx.count, note: `${add.length} echo notes added (65% / 40%).` };
      },
    },
    {
      id: "tail",
      title: "Longer tail",
      reveal: "pianoRoll",
      optional: true,
      summary: "A third, whisper-level tap (25%) one more interval out.",
      manual: "One more copy, one more interval late, barely audible — the echo dissolves.",
      params: [
        {
          key: "interval",
          label: "Interval",
          kind: "select",
          options: [
            { value: "0.5", label: "1/8" },
            { value: "0.75", label: "Dotted 1/8 (classic)" },
            { value: "1", label: "1/4" },
          ],
          default: () => "0.75",
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveMidiClip(ctx, state.echoClipId as number | undefined);
        if (!found) throw new Error("Run the Echo taps stage first.");
        const step = Number(params.interval);
        // the quietest notes present are the 40% second taps — echo those once more
        const velCeil = Math.max(...found.clip.notes.map((n) => n.velocity)) * 0.45;
        const add: NoteInput[] = found.clip.notes
          .filter((n) => n.velocity <= velCeil)
          .map((n) => ({
            pitch: n.pitch,
            velocity: Math.max(1, Math.round(n.velocity * 0.6)),
            startBeat: n.startBeat + step,
            lengthBeats: n.lengthBeats,
          }))
          .filter((n) => n.startBeat < found.clip.lengthBeats);
        if (add.length === 0) throw new Error("No room for a third tap inside the clip.");
        await tx.cmd(editNotes(found.clip.id, { add }));
        return { commands: tx.count, note: `${add.length} whisper taps close the tail.` };
      },
    },
  ],
};

/* ============================================================================
 * Beat Shuffle Fill
 * ========================================================================= */

const beatShuffle: TechniqueDef = {
  id: "beat-shuffle",
  category: "editing",
  title: "Beat Shuffle Fill",
  tagline: "The last bar plays its own beats in reverse order.",
  description:
    "A fill with zero new material: the final bar's four beats are re-ordered 4-3-2-1. " +
    "Same sounds, scrambled time — the ear knows something turned around and leans into " +
    "the downbeat.",
  requirements: (ctx) => [
    {
      ok: allAudioClips(ctx).some(
        (f) => clipEndBeat(f.clip, ctx.project) - f.clip.startBeat >= ctx.beatsPerBar + 1,
      ),
      label: "An audio clip longer than one bar (the last bar gets shuffled)",
    },
  ],
  stages: [
    {
      id: "shuffle",
      title: "Shuffle",
      reveal: "timeline",
      summary: "Splits the last bar into beats and swaps their order end-to-front (4-3-2-1).",
      manual:
        "Split the clip's last bar at each beat, then drag the slices into reverse order — " +
        "beat 4 first, beat 1 last. Snap does the aligning for you.",
      params: [clipParam("Shuffle this clip's last bar")],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the audio clip.");
        const end = clipEndBeat(found.clip, ctx.project);
        const bar = ctx.beatsPerBar;
        if (end - found.clip.startBeat < bar + 1)
          throw new Error("The clip must be longer than one bar.");
        const barStart = end - bar;
        // isolate the last bar, then its beats
        let currentId = found.clip.id;
        const s0 = await tx.cmd(splitClips([currentId], barStart));
        let sliceId = s0.newClipIds[0];
        if (sliceId === undefined) throw new Error("Split produced no last bar.");
        const slices: number[] = [sliceId];
        for (let b = 1; b < bar; b++) {
          const s = await tx.cmd(splitClips([sliceId], barStart + b));
          const tail = s.newClipIds[0];
          if (tail === undefined) break;
          slices.push(tail);
          sliceId = tail;
        }
        // reverse order: slice i (0-based) moves to position (n-1-i)
        const n = slices.length;
        for (let i = 0; i < n; i++) {
          const delta = (n - 1 - i) - i;
          if (delta !== 0) await tx.cmd(moveClips([slices[i]], delta));
        }
        state.shuffleIds = slices;
        return { commands: tx.count, note: `Last ${n} beats now play ${Array.from({ length: n }, (_, i) => n - i).join("-")}.` };
      },
    },
    {
      id: "smooth",
      title: "Smooth",
      reveal: "timeline",
      optional: true,
      summary: "5 ms fades on every shuffled slice so the seams don't click.",
      manual: "Tiny fades on both ends of each slice.",
      run: async (_ctx, _params, state) => {
        const tx = new Tx();
        const ids = state.shuffleIds as number[] | undefined;
        if (!ids || ids.length === 0) throw new Error("Run the Shuffle stage first.");
        for (const id of ids) await tx.cmd(setClip(id, { fadeInSec: 0.005, fadeOutSec: 0.005 }));
        return { commands: tx.count, note: "Shuffle seams de-clicked." };
      },
    },
  ],
};

/* ============================================================================
 * Chop Pitch Riser
 * ========================================================================= */

const pitchChopRiser: TechniqueDef = {
  id: "pitch-chop-riser",
  category: "editing",
  title: "Chop Pitch Riser",
  tagline: "The vocal chop climbs a scale into the drop.",
  description:
    "Chop-kit meets riser: the sampled phrase plays ascending pitches on straight 8ths " +
    "through the bar before the drop, velocities climbing — the pitched vocal-chop " +
    "build heard everywhere in pop-EDM.",
  requirements: (ctx) => [
    { ok: allAudioClips(ctx).length > 0, label: "An audio clip to sample (the phrase)" },
  ],
  stages: [
    {
      id: "kit",
      title: "Kit",
      reveal: "timeline",
      summary: "Creates a Sampler track from the chosen clip (engine Create Sampler Track).",
      manual: "Right-click the clip ▸ Create Sampler Track — C3 plays the original pitch.",
      params: [clipParam("Sample this clip")],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const found = resolveAudioClip(ctx, params.clipId as number);
        if (!found) throw new Error("Pick the audio clip to sample.");
        const r = await tx.cmd(createSamplerTrack(found.clip.id));
        state.pcrTrackId = r.trackId;
        state.pcrInstanceId = r.instanceId;
        return { commands: tx.count, note: "Sampler kit ready." };
      },
    },
    {
      id: "climb",
      title: "Climb",
      reveal: "pianoRoll",
      summary:
        "Writes ascending 8ths through the bar before the drop — root rising to the octave, " +
        "velocities 80 → 127 — and tightens the sampler envelope for chopping.",
      manual:
        "One bar before the drop, draw straight 8ths climbing: root, +2, +4, +5, +7, +9, " +
        "+11, +12 (or just chromatic), velocities rising. Sampler: Loop off, fast attack, " +
        "short release.",
      params: [
        {
          key: "dropBar",
          label: "Drop at bar",
          kind: "number",
          min: 2,
          max: 999,
          step: 1,
          default: (ctx) => Math.max(Math.round((ctx.playheadBeat / ctx.beatsPerBar + 1)) + 1, 3),
        },
        {
          key: "root",
          label: "Root (MIDI pitch)",
          kind: "number",
          min: 24,
          max: 96,
          step: 1,
          default: () => 60,
        },
      ],
      run: async (ctx, params, state) => {
        const tx = new Tx();
        const track =
          ctx.project.tracks.find((t) => t.id === (state.pcrTrackId as number)) ??
          ctx.project.tracks.find(
            (t) => t.kind === "instrument" && t.inserts.some((i) => i.uid === "builtin:sampler"),
          );
        if (!track) throw new Error("Run the Kit stage first.");
        const instanceId =
          (state.pcrInstanceId as number | undefined) ??
          track.inserts.find((i) => i.uid === "builtin:sampler")?.instanceId;
        const bar = ctx.beatsPerBar;
        const drop = Math.max(bar, ((params.dropBar as number) - 1) * bar);
        const start = drop - bar;
        const root = params.root as number;
        const scaleUp = [0, 2, 4, 5, 7, 9, 11, 12]; // major climb — swap notes in the roll to taste
        const steps = Math.max(4, Math.floor(bar * 2)); // straight 8ths across the bar
        const notes: NoteInput[] = Array.from({ length: steps }, (_, i) => ({
          pitch: root + scaleUp[Math.min(scaleUp.length - 1, Math.floor((i * scaleUp.length) / steps))],
          velocity: Math.round(80 + (47 * i) / Math.max(1, steps - 1)),
          startBeat: i * 0.5,
          lengthBeats: 0.4,
        }));
        const clip = await newMidiClip(tx, track.id, start, bar);
        await addNotes(tx, clip.id, notes);
        focusMidiClip(clip.id);
        if (instanceId !== undefined) {
          for (const [name, value] of Object.entries({ Loop: 0, Attack: 1, Release: 100 })) {
            const id = await paramIdByName(instanceId, name);
            await tx.cmd(setPluginParam(instanceId, id, normFor("builtin:sampler", name, value)));
          }
        }
        return { commands: tx.count, note: `Chops climb the scale into bar ${params.dropBar}.` };
      },
    },
  ],
};

export const editingTechniques: TechniqueDef[] = [
  chopKit,
  stutter,
  glitchRatchet,
  reverseChops,
  humanize,
  midiEcho,
  beatShuffle,
  pitchChopRiser,
];
