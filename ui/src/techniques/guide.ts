/**
 * Production Guide (docs/PRODUCTION_TECHNIQUES_PLAN.md §0, step 2) — the
 * stage-of-work-first reframe of the techniques catalog.
 *
 * Omer, 2026-08-07: the 61-card catalog is jargon to someone who doesn't already
 * know the techniques — "unknown what should be used at what stage". So the guide
 * inverts it: the STAGES a song moves through (arrange → sound design → edit → mix
 * → transitions → master), each a checklist of plain-language GOALS, with
 * techniques appearing only as means-to-a-goal. Every goal carries a
 * project-aware `relevance(ctx)` rule that reads the ACTUAL song and answers
 * "does this matter here, right now?" with a grounded note — the same declarative
 * pattern as TechniqueDef.requirements(ctx).
 *
 * Honesty rules (SPEC §10):
 * - "suggested" only on a positive signal from the project (kick + bass present,
 *   no sidechain anywhere) — never as a default nudge.
 * - "done" only on a STRONG signal (the treatment is literally present); when we
 *   cannot tell, say "open" and say why the user must judge by ear.
 * - "na" when the material the goal is about does not exist (no vocal → vocal
 *   goals are not applicable, not nagging).
 * - Role detection is by track NAME — honest about being a guess: notes quote the
 *   matched track name so a wrong guess explains itself.
 */

import type { Clip, PluginInstance, Project, Track } from "../protocol/types";
import type { TechniqueCtx } from "./types";

/* ============================================================================
 * Relevance model
 * ========================================================================= */

export type GoalStatus = "suggested" | "open" | "done" | "na";

export interface GoalRelevance {
  status: GoalStatus;
  /** One line grounded in THIS project ("'Kick' and 'Bass 808' found, no sidechain anywhere"). */
  note: string;
}

export interface GoalMeans {
  /** Must resolve against the technique catalog — guide.test.ts enforces it. */
  techniqueId: string;
  /** When THIS technique is the right tool for the goal (one line, plain language). */
  when: string;
}

export interface GuideGoal {
  id: string;
  /** Plain language, outcome-shaped ("Kick and bass share the low end politely"). */
  title: string;
  /** Why this matters, in listener terms — shown up front (balanced emphasis). */
  why: string;
  /** What you'll hear when it's right — shown up front. */
  hear: string;
  relevance(ctx: TechniqueCtx): GoalRelevance;
  means: GoalMeans[];
  /** For goals whose simplest path is not a wizard — one honest by-hand line. */
  byHand?: string;
}

export interface GuideStage {
  id: string;
  title: string;
  /** What this stage of work IS — two sentences max. */
  intro: string;
  goals: GuideGoal[];
}

/* ============================================================================
 * Project signals (pure, name-based where noted)
 * ========================================================================= */

const ROLE_RE = {
  kick: /kick|bd\b|bassdrum/i,
  bass: /bass|sub\b|808/i,
  vocal: /voc|vox|voice|sing|choir|adlib|ad-lib|rap|spoken/i,
  drums: /drum|kick|snare|hat|perc|clap|cymbal|tom|beat\b/i,
  sustained: /pad|string|synth|keys|organ|chord|atmo|ambient/i,
  riser: /riser|sweep|uplifter|noise|fx\b|impact|downlifter/i,
} as const;

export type Role = keyof typeof ROLE_RE;

const isContentTrack = (t: Track) =>
  t.kind === "audio" || t.kind === "instrument" || t.kind === "midi";

export function tracksWithRole(p: Project, role: Role): Track[] {
  return p.tracks.filter((t) => isContentTrack(t) && ROLE_RE[role].test(t.name));
}

const q = (t: Track) => `“${t.name}”`;

function allInserts(p: Project): PluginInstance[] {
  return [...p.tracks, p.masterTrack].flatMap((t) => t.inserts);
}

const hasInsertAnywhere = (p: Project, uid: string) =>
  allInserts(p).some((i) => i.uid === uid);

/** A compressor keyed from ANOTHER track — the one strong "sidechain exists" signal. */
const hasSidechainAnywhere = (p: Project) =>
  allInserts(p).some((i) => i.uid === "builtin:compressor" && (i.sidechainSource ?? 0) > 0);

const mixerTracks = (p: Project) =>
  p.tracks.filter((t) => t.kind === "audio" || t.kind === "instrument" || t.kind === "bus");

const busTracks = (p: Project) => p.tracks.filter((t) => t.kind === "bus");

const hasAutomationAnywhere = (p: Project) =>
  [...p.tracks, p.masterTrack].some((t) =>
    (t.automation ?? []).some((l) => l.points.length > 0));

const clipEndBeat = (c: Clip, ctx: TechniqueCtx): number =>
  c.type === "midi"
    ? c.startBeat + c.lengthBeats
    : c.startBeat +
      (ctx.project.sampleRate > 0
        ? (c.lengthSamples / ctx.project.sampleRate) * (ctx.bpm / 60)
        : 0);

/** Rough extent of the song's material, in bars (0 when the project is empty). */
export function contentBars(ctx: TechniqueCtx): number {
  let end = 0;
  for (const t of ctx.project.tracks)
    for (const c of t.clips) end = Math.max(end, clipEndBeat(c, ctx));
  return Math.ceil(end / ctx.beatsPerBar);
}

const midiClipCount = (p: Project) =>
  p.tracks.reduce((n, t) => n + t.clips.filter((c) => c.type === "midi").length, 0);

const audioClipCount = (p: Project) =>
  p.tracks.reduce((n, t) => n + t.clips.filter((c) => c.type === "audio").length, 0);

const trackHasClips = (t: Track) => t.clips.length > 0;

/* ============================================================================
 * The stages
 * ========================================================================= */

export const GUIDE_STAGES: GuideStage[] = [
  {
    id: "arrange",
    title: "Write & arrange",
    intro:
      "Get the bones right before any polish: where sections start, where the harmony " +
      "lives, and how the hook comes back. Everything later leans on this.",
    goals: [
      {
        id: "sections-marked",
        title: "You can see the song's sections",
        why:
          "Every later decision — where a riser lands, what the mix emphasizes — is " +
          "about sections. If they only exist in your head, every tool is guessing.",
        hear: "Nothing yet — this one you SEE: named markers at every section boundary.",
        relevance: (ctx) => {
          const bars = contentBars(ctx);
          const markers = ctx.project.markers ?? [];
          if (bars < 8) return { status: "na", note: "Less than 8 bars of material so far — arrange first, mark later." };
          if (markers.length > 0)
            return { status: "done", note: `${markers.length} marker${markers.length === 1 ? "" : "s"} placed — the song has a visible shape.` };
          return { status: "suggested", note: `~${bars} bars of music and no section markers yet.` };
        },
        means: [],
        byHand:
          "Add a Marker track (right-click the track list ▸ Add Track ▸ Marker), then " +
          "double-click the marker lane at each section start and name it (Intro, Verse, Drop…).",
      },
      {
        id: "harmonic-bed",
        title: "The chords live somewhere the tools can read",
        why:
          "A chord track is the song's harmony written down. Once it exists, swells and " +
          "arps can follow the ACTUAL chords instead of guessing.",
        hear: "Parts that follow the song's harmony automatically — pads bloom on the right notes.",
        relevance: (ctx) => {
          const chords = ctx.project.chordEvents?.length ?? 0;
          if (chords > 0)
            return { status: "done", note: `Chord track has ${chords} chord${chords === 1 ? "" : "s"} — harmony-aware techniques can read it.` };
          if (midiClipCount(ctx.project) === 0)
            return { status: "na", note: "No MIDI material yet — nothing for a chord track to describe." };
          return { status: "suggested", note: "You have MIDI parts but no chord track — harmony-aware tools are flying blind." };
        },
        means: [
          { techniqueId: "chord-swell", when: "You want pads that bloom into downbeats on the song's actual chords." },
          { techniqueId: "arp-builder", when: "You want motion — the chord track becomes a running arpeggio." },
        ],
      },
      {
        id: "hook-returns",
        title: "The hook comes back — transformed, not copy-pasted",
        why:
          "Listeners wait for the hook's return; giving it back CHANGED (heavier, slower, " +
          "rearranged) is what makes a track feel produced rather than looped.",
        hear: "The second drop hits differently from the first — same material, new weight.",
        relevance: () => ({
          status: "open",
          note: "Only your ears can judge this — listen through and ask whether the hook returns at least twice, and whether the returns differ.",
        }),
        means: [
          { techniqueId: "half-time-drop", when: "Same notes at half speed — a whole new section from material you already have." },
          { techniqueId: "hook-factory", when: "One vocal phrase becomes a kit of chops, echoes and risers — a full alternate hook." },
        ],
      },
    ],
  },

  {
    id: "sound",
    title: "Sound design & texture",
    intro:
      "Make the sounds themselves interesting: width where it flatters, movement where " +
      "things are static, controlled dirt where clean is boring.",
    goals: [
      {
        id: "width",
        title: "Big parts are wide, important parts are centered",
        why:
          "Stereo width is contrast: if everything is centered the mix is a pillar; if " +
          "everything is wide there is no center to anchor the song.",
        hear: "Close your eyes: the pad is a wall, the vocal and kick stand in the middle of it.",
        relevance: (ctx) => {
          const melodic = ctx.project.tracks.filter(
            (t) => isContentTrack(t) && trackHasClips(t) && t.kind !== "midi",
          );
          if (melodic.length < 2) return { status: "na", note: "Fewer than two sounding tracks — width needs neighbors." };
          const centered = melodic.filter((t) => t.pan === 0);
          if (centered.length === melodic.length)
            return { status: "suggested", note: `All ${melodic.length} sounding tracks sit dead center — the mix is a single pillar.` };
          return { status: "open", note: `${melodic.length - centered.length} of ${melodic.length} sounding tracks are panned — judge the balance by ear.` };
        },
        means: [
          { techniqueId: "haas-widener", when: "ONE track should feel wide (a 15 ms trick — check it in mono after)." },
          { techniqueId: "lcr-spread", when: "You want the classic hard-left / center / hard-right stage, nothing in between." },
          { techniqueId: "vocal-doubler", when: "It's the VOCAL that should widen — doubles spread, lead stays centered." },
        ],
      },
      {
        id: "movement",
        title: "Static sounds learn to move",
        why:
          "A sound that never changes reads as wallpaper after four bars. Rhythmic or " +
          "spatial movement keeps long notes alive without new notes.",
        hear: "The pad swings, gates or drifts in tempo — motion you feel before you notice it.",
        relevance: (ctx) => {
          const sustained = tracksWithRole(ctx.project, "sustained").filter(trackHasClips);
          if (sustained.length === 0)
            return { status: "open", note: "No obviously sustained parts found by name — if something drones, it qualifies." };
          return { status: "suggested", note: `${q(sustained[0])} looks like a sustained part — give it motion.` };
        },
        means: [
          { techniqueId: "auto-pan", when: "Left–right motion in tempo — subtle drift or full swing." },
          { techniqueId: "trance-gate", when: "The pad should become a RHYTHM — chopped by a tempo-synced gate." },
          { techniqueId: "midi-echo", when: "Echoes as editable NOTES (not a delay insert) — motion you can then reshape." },
        ],
      },
      {
        id: "color",
        title: "Clean is boring — add controlled dirt",
        why:
          "Saturation is loudness's polite cousin: it adds density and presence without " +
          "adding level, and it's what makes 'produced' sounds feel expensive.",
        hear: "The part feels closer and warmer at the same fader level — not louder, thicker.",
        relevance: (ctx) => {
          if (hasInsertAnywhere(ctx.project, "builtin:saturator"))
            return { status: "done", note: "Saturation is already in use somewhere — extend it by ear." };
          const candidates = [...tracksWithRole(ctx.project, "vocal"), ...tracksWithRole(ctx.project, "drums")].filter(trackHasClips);
          if (candidates.length === 0) return { status: "open", note: "No obvious vocal/drum candidates by name — any thin-sounding part qualifies." };
          return { status: "suggested", note: `${q(candidates[0])} is a classic saturation customer, and no saturator is in the project.` };
        },
        means: [
          { techniqueId: "vocal-heat", when: "The vocal floats ON the track instead of sitting IN it." },
          { techniqueId: "parallel-crush", when: "Drums need weight but you don't want to squash the clean kit — crush a copy underneath." },
        ],
      },
      {
        id: "playable-material",
        title: "Your recordings become playable instruments",
        why:
          "A sampled phrase turned into a kit is the cheapest source of NEW material that " +
          "still sounds like YOUR song — chops, reverses, pitched runs.",
        hear: "A vocal syllable played as a melody; a chopped phrase as percussion.",
        relevance: (ctx) => {
          const n = audioClipCount(ctx.project);
          if (n === 0) return { status: "na", note: "No audio recordings yet — record or import something to chop." };
          return { status: "open", note: `${n} audio clip${n === 1 ? "" : "s"} that could be chopped into playable kits — worth trying on the hook.` };
        },
        means: [
          { techniqueId: "chop-sampler", when: "Slice the selected clip across keys and PLAY it." },
          { techniqueId: "reverse-chops", when: "Instant texture: every other slice plays backwards." },
        ],
      },
    ],
  },

  {
    id: "edit",
    title: "Edit & tighten",
    intro:
      "Timing and cleanliness. Tight where the groove demands it, human where a grid " +
      "would kill it, silent where nothing should sound.",
    goals: [
      {
        id: "timing-feel",
        title: "Tight where it matters, human where it counts",
        why:
          "Full quantize is a decision, not a default: grooves live in the few " +
          "milliseconds AROUND the grid. Machines play the grid; records breathe.",
        hear: "The part locks with the kick yet doesn't sound typed-in.",
        relevance: (ctx) => {
          const n = midiClipCount(ctx.project);
          if (n === 0) return { status: "na", note: "No MIDI parts to time-shape yet." };
          return { status: "open", note: `${n} MIDI clip${n === 1 ? "" : "s"} — listen for parts that are either sloppy or robotic.` };
        },
        means: [
          { techniqueId: "humanize-groove", when: "A fully-quantized part sounds typed-in — teach it to breathe." },
          { techniqueId: "ghost-notes", when: "The groove feels stiff — add the in-between hits you feel more than hear." },
          { techniqueId: "strum-humanizer", when: "Block chords should sound like a hand played them." },
        ],
      },
      {
        id: "clean-takes",
        title: "Recordings are silent between phrases",
        why:
          "Room hiss and headphone bleed between vocal phrases is inaudible solo'd — and " +
          "clearly audible the moment reverb and compression amplify it.",
        hear: "Between phrases: nothing. The reverb tail of the last word, then clean silence.",
        relevance: (ctx) => {
          const vox = tracksWithRole(ctx.project, "vocal").filter(
            (t) => t.clips.some((c) => c.type === "audio"),
          );
          if (vox.length === 0) return { status: "na", note: "No vocal recordings found (by track name) — nothing to gate." };
          const ungated = vox.filter((t) => !t.inserts.some((i) => i.uid === "builtin:gate"));
          if (ungated.length === 0) return { status: "done", note: "Every vocal track already carries a gate." };
          return { status: "suggested", note: `${q(ungated[0])} has recordings and no gate — bleed will surface once compression lands.` };
        },
        means: [{ techniqueId: "vocal-gate", when: "The standard cleanup: threshold just above the room, release long enough to keep breaths natural." }],
      },
      {
        id: "fills",
        title: "Bars 4 and 8 promise what comes next",
        why:
          "A fill is a promise: the last bar of a phrase telling the listener something " +
          "is about to change. Loops without fills feel like wallpaper.",
        hear: "The beat stumbles, doubles or reverses for one bar — then the new section pays it off.",
        relevance: (ctx) => {
          const drums = tracksWithRole(ctx.project, "drums").filter(trackHasClips);
          if (drums.length === 0) return { status: "open", note: "No drum tracks found by name — any rhythmic part can carry a fill." };
          return { status: "open", note: `${q(drums[0])} found — listen to phrase endings: do they announce the next section?` };
        },
        means: [
          { techniqueId: "stutter-fill", when: "The quickest win: the last beat becomes a 1/16 repeat." },
          { techniqueId: "beat-shuffle", when: "The last bar replays its own beats in reverse order — a fill from existing material." },
          { techniqueId: "glitch-ratchet", when: "Electronic styles: repeats that keep doubling, 1/8 → 1/16 → 1/32." },
          { techniqueId: "snare-roll", when: "Building INTO a drop — the accelerating roll." },
        ],
      },
    ],
  },

  {
    id: "mix",
    title: "Mix — balance, space & dynamics",
    intro:
      "Give the mix a skeleton, then make room: every element audible, the vocal IN the " +
      "track, kick and bass sharing the low end instead of fighting over it.",
    goals: [
      {
        id: "bus-skeleton",
        title: "The mix has a skeleton: buses",
        why:
          "Ten faders is a juggling act; four buses (drums, bass, music, vocals) is a " +
          "mix you can actually ride. Group processing also glues related parts.",
        hear: "Pull one fader and the whole drum kit moves together, already glued.",
        relevance: (ctx) => {
          const buses = busTracks(ctx.project);
          const n = mixerTracks(ctx.project).filter((t) => t.kind !== "bus").length;
          if (buses.length > 0) return { status: "done", note: `${buses.length} bus${buses.length === 1 ? "" : "es"} in place — route new tracks through them.` };
          if (n < 6) return { status: "open", note: `${n} tracks — manageable without buses for now; revisit as the count grows.` };
          return { status: "suggested", note: `${n} tracks all routing straight to the master — no buses anywhere.` };
        },
        means: [
          { techniqueId: "stem-buses", when: "The full four-bus architecture in one pass — the whole mix on four faders." },
          { techniqueId: "drum-bus-glue", when: "Just the drums first: one bus, one gentle compressor, one kit." },
          { techniqueId: "vca-groups", when: "You want one fader over many tracks WITHOUT changing audio routing." },
        ],
      },
      {
        id: "headroom",
        title: "Nothing clips, everything can breathe",
        why:
          "A mix pushed against 0 dB has nowhere to go — every later stage (glue, " +
          "saturation, limiting) needs headroom to work INTO.",
        hear: "The master meter peaks around −6 dB and the mix sounds no smaller — just safer.",
        relevance: (ctx) => {
          const hot = mixerTracks(ctx.project).filter((t) => t.volume > 1.0);
          if (hot.length > 0)
            return { status: "suggested", note: `${hot.length} fader${hot.length === 1 ? "" : "s"} above 0 dB (${q(hot[0])}${hot.length > 1 ? "…" : ""}) — the classic sign a reset is due.` };
          return { status: "open", note: "No faders above 0 dB — check the master meter while the full mix plays." };
        },
        means: [{ techniqueId: "headroom-reset", when: "Everything down 6 dB in one move — balance preserved, master breathing again." }],
      },
      {
        id: "vocal-sits",
        title: "The vocal sits IN the track, not on top of it",
        why:
          "The vocal is what listeners follow; 'produced' means it is controlled, present " +
          "and dimensional — connected to the music instead of floating over it.",
        hear: "Turn it up: it stays glued. Turn it down: you still hear every word.",
        relevance: (ctx) => {
          const vox = tracksWithRole(ctx.project, "vocal").filter(trackHasClips);
          if (vox.length === 0) return { status: "na", note: "No vocal tracks found (by name) — instrumental for now." };
          const bare = vox.filter((t) => t.inserts.length === 0 && t.sends.length === 0);
          if (bare.length > 0) return { status: "suggested", note: `${q(bare[0])} has no processing and no sends at all — raw take in the mix.` };
          return { status: "open", note: `${q(vox[0])} carries processing — judge presence and space by ear.` };
        },
        means: [
          { techniqueId: "vocal-presence", when: "The channel itself: clean → controlled → airy." },
          { techniqueId: "vocal-reverb-send", when: "Space that flatters without washing — EQ'd, ducked reverb on a send." },
          { techniqueId: "eq-slotting", when: "Something masks the vocal — cut that part where the vocal lives." },
          { techniqueId: "vocal-chain", when: "The full guided pass, raw take → produced lead." },
        ],
      },
      {
        id: "kick-bass",
        title: "Kick and bass share the low end politely",
        why:
          "Two heavyweights in the same octave: unmanaged they blur into mud. The classic " +
          "answer is to duck the bass a few dB for the milliseconds the kick needs.",
        hear: "Each kick hit punches CLEAN through the bass, and the low end never doubles up.",
        relevance: (ctx) => {
          const kick = tracksWithRole(ctx.project, "kick").filter(trackHasClips);
          const bass = tracksWithRole(ctx.project, "bass")
            .filter((t) => !ROLE_RE.kick.test(t.name))
            .filter(trackHasClips);
          if (kick.length === 0 || bass.length === 0)
            return { status: "na", note: "Need both a kick and a bass (found by track name) for this to matter." };
          if (hasSidechainAnywhere(ctx.project))
            return { status: "done", note: "A compressor keyed from another track is already pumping — the classic treatment is in place." };
          return { status: "suggested", note: `${q(kick[0])} and ${q(bass[0])} found — and no sidechain anywhere in the project.` };
        },
        means: [
          { techniqueId: "sidechain-pump", when: "The standard fix: bass (or music bus) ducks a few dB on every kick." },
          { techniqueId: "eq-slotting", when: "Static alternative: carve the kick's punch frequency out of the bass." },
        ],
      },
      {
        id: "depth",
        title: "The mix has front-to-back depth, not just left-right",
        why:
          "Reverb and delay are the mix's third dimension: they place sounds near or far. " +
          "A mix with none is a photograph with no background.",
        hear: "The lead is close and dry-ish; pads sit behind it; something echoes far away.",
        relevance: (ctx) => {
          const p = ctx.project;
          if (hasInsertAnywhere(p, "builtin:reverb") || hasInsertAnywhere(p, "builtin:delay"))
            return { status: "open", note: "Reverb/delay present — judge NEAR vs FAR placement by ear, element by element." };
          if (mixerTracks(p).filter(trackHasClips).length === 0)
            return { status: "na", note: "Nothing sounding yet." };
          return { status: "suggested", note: "Not a single reverb or delay in the project — everything stands at arm's length." };
        },
        means: [
          { techniqueId: "vocal-reverb-send", when: "Start with the vocal: lush but out of the way." },
          { techniqueId: "slapback", when: "Vintage intimacy: one quick repeat instead of a wash." },
          { techniqueId: "gated-reverb", when: "A huge space that stops dead — drama without mud (the 80s snare)." },
          { techniqueId: "ducking-bed", when: "Speech over music (podcast/VO): the bed steps aside when the voice speaks." },
        ],
      },
    ],
  },

  {
    id: "transitions",
    title: "Transitions & automation",
    intro:
      "Sections should announce themselves and the mix should be PLAYED, not set. This " +
      "is where a static arrangement starts sounding like a record.",
    goals: [
      {
        id: "sections-announce",
        title: "Section changes announce themselves",
        why:
          "A new section that just starts is a missed promise. Risers, swells and " +
          "builds tell the listener two bars early that something is coming.",
        hear: "Tension climbs into the boundary — and the new section feels EARNED.",
        relevance: (ctx) => {
          const bars = contentBars(ctx);
          if (bars < 16) return { status: "na", note: `~${bars} bars so far — transitions matter once there are sections to move between.` };
          const fx = tracksWithRole(ctx.project, "riser").length;
          if (fx > 0) return { status: "open", note: "Riser/FX material found — check every section boundary has its moment." };
          return { status: "suggested", note: `~${bars} bars of music and no riser/sweep/FX tracks found by name.` };
        },
        means: [
          { techniqueId: "riser-buildup", when: "The workhorse: a noise sweep ramping into the next section." },
          { techniqueId: "reverse-build", when: "The section arrives out of its own mirror image." },
          { techniqueId: "chord-swell", when: "Softer styles: a pad blooms into the downbeat on the song's chord." },
          { techniqueId: "the-drop", when: "The full arrival: riser, roll, sweep, silence, impact — one guided pass." },
        ],
      },
      {
        id: "land-the-drop",
        title: "The biggest moment actually lands",
        why:
          "Impact is mostly contrast: the half-beat of silence before, the sub boom on " +
          "the downbeat, the tail falling away after. The hit itself is the smallest part.",
        hear: "A breath of silence — then the downbeat arrives with physical weight.",
        relevance: () => ({
          status: "open",
          note: "Only you know where the drop is — play the two bars around it and ask: silence before? weight on it? fall-off after?",
        }),
        means: [
          { techniqueId: "predrop-silence", when: "The cheapest big win: half a beat of nothing right before the hit." },
          { techniqueId: "impact-rumble", when: "The downbeat needs physical weight — a sub boom with a tail." },
          { techniqueId: "downlifter", when: "AFTER the drop: the energy falls away instead of just stopping." },
          { techniqueId: "tape-stop", when: "Everything grinds to a halt — the theatrical exit into the drop." },
        ],
      },
      {
        id: "phrase-exits",
        title: "Phrases exit with ear candy",
        why:
          "The gap after a phrase is prime real estate: a throw, a tag or a swell keeps " +
          "the listener's ear occupied until the next entrance.",
        hear: "The last word echoes into the gap, or melts downward — the space never goes dead.",
        relevance: (ctx) => {
          const vox = tracksWithRole(ctx.project, "vocal").filter(trackHasClips);
          if (vox.length === 0) return { status: "na", note: "These are vocal moves — no vocal tracks found by name." };
          return { status: "open", note: `${q(vox[0])} found — listen to each phrase ending: does the gap after it work FOR you?` };
        },
        means: [
          { techniqueId: "delay-throw", when: "The last word of the phrase echoes into the gap — the classic." },
          { techniqueId: "pitch-drop-tag", when: "The last word melts downward — a signature, not just an echo." },
          { techniqueId: "reverse-reverb-swell", when: "The NEXT phrase announces itself — its reverb tail plays before it." },
        ],
      },
      {
        id: "played-not-set",
        title: "The mix is played, not set",
        why:
          "Static faders read as demo; records ride. A dB into the chorus, a filter " +
          "closing through the bridge — automation is the performance OF the mix.",
        hear: "The chorus is subtly bigger than the verse — and you can't point at why.",
        relevance: (ctx) => {
          if (hasAutomationAnywhere(ctx.project))
            return { status: "open", note: "Automation exists — the question is whether the BIG moments ride (chorus lift, filter moves)." };
          if (contentBars(ctx) < 8) return { status: "na", note: "Too early — automate once the arrangement stands." };
          return { status: "suggested", note: "No automation anywhere in the project — the whole mix is static." };
        },
        means: [
          { techniqueId: "telephone-section", when: "One section through a tiny speaker, then the mix opens up — automation as drama." },
          { techniqueId: "auto-pan", when: "Motion in tempo, drawn as automation you can reshape." },
        ],
        byHand:
          "Enable automation write (W), play the song and RIDE the faders — a dB up into " +
          "the chorus, back down for the verse. Your moves are recorded as editable lanes.",
      },
    ],
  },

  {
    id: "master",
    title: "Bus, glue & master",
    intro:
      "The last 10%: the mix becomes one record. Gentle glue, a deliberate overall " +
      "tone, and loudness that is measured — not guessed.",
    goals: [
      {
        id: "master-glue",
        title: "The mix gels into one record",
        why:
          "A good mix can still sound like tracks playing simultaneously. One gentle " +
          "compressor across everything makes them move together — that's 'glue'.",
        hear: "Nothing obviously changes — but bypass it and the mix falls apart into parts.",
        relevance: (ctx) => {
          const inserts = ctx.project.masterTrack.inserts;
          if (inserts.some((i) => i.uid === "builtin:compressor"))
            return { status: "done", note: "A compressor already sits on the master — glue is in place." };
          if (inserts.length > 0) return { status: "open", note: "The master has processing but no glue compressor — deliberate choice, or gap?" };
          return { status: "suggested", note: "Your master bus is empty — the mix has no shared movement at all." };
        },
        means: [
          { techniqueId: "master-glue", when: "The standard: gentle 2:1 glue into a −1 dB ceiling." },
          { techniqueId: "mixbus-color", when: "Add the 'console sound' — gentle drive across the whole mix." },
          { techniqueId: "mixbus-pump", when: "Genre move: the WHOLE mix breathes with the kick (French house)." },
        ],
      },
      {
        id: "tone-deliberate",
        title: "The record's overall tone is a decision",
        why:
          "Every record leans somewhere — darker, brighter, mid-forward. If yours " +
          "doesn't, it inherited the tone of your speakers by accident.",
        hear: "A/B against a reference track: yours holds its own tonal ground on purpose.",
        relevance: () => ({
          status: "open",
          note: "Compare against one reference track you love, at MATCHED volume — then decide if the tilt is yours or accidental.",
        }),
        means: [
          { techniqueId: "master-eq-tilt", when: "One gentle see-saw sets the whole record's tone." },
          { techniqueId: "mono-check", when: "Fold to mono before a club PA does it for you — width that vanishes was never yours." },
        ],
      },
      {
        id: "loudness",
        title: "Loud enough — measured, not guessed",
        why:
          "Streaming platforms normalize loudness: chasing numbers blind wrecks dynamics " +
          "for nothing. Measure, adjust, re-measure — and stop when it's right.",
        hear: "As loud as the reference on the same platform — with the drops still hitting.",
        relevance: (ctx) => {
          if (ctx.project.masterTrack.inserts.some((i) => i.uid === "builtin:limiter"))
            return { status: "open", note: "A ceiling is in place — verify the measured loudness against a reference before calling it done." };
          return { status: "suggested", note: "No limiter on the master — one stray peak currently decides your whole record's loudness." };
        },
        means: [
          { techniqueId: "loudness-ladder", when: "The honest loop: measure, adjust, re-measure." },
          { techniqueId: "radio-master", when: "The full guided pass: headroom → glue → color → ceiling, in the right order." },
        ],
      },
    ],
  },
];

/* ============================================================================
 * Evaluation
 * ========================================================================= */

export interface EvaluatedGoal {
  stage: GuideStage;
  goal: GuideGoal;
  relevance: GoalRelevance;
}

/** Evaluate every goal against the project (cheap: pure reads, no allocation churn). */
export function evaluateGuide(ctx: TechniqueCtx): EvaluatedGoal[] {
  const out: EvaluatedGoal[] = [];
  for (const stage of GUIDE_STAGES)
    for (const goal of stage.goals) out.push({ stage, goal, relevance: goal.relevance(ctx) });
  return out;
}

export const suggestedCount = (evaluated: EvaluatedGoal[]): number =>
  evaluated.filter((e) => e.relevance.status === "suggested").length;
