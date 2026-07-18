/**
 * SheetMusic — a notation view of the MIDI you already have, and an editor for it.
 *
 * Reads the active MIDI clip (or its whole track), engraves it through
 * notation.ts → layout.ts → Score.tsx, and gives it what somebody preparing a part needs:
 * choice of clef, a real key signature (auto-detected or picked), quantisation,
 * transposition, bar numbers, paper size, printing, and MusicXML export — plus direct
 * editing: click/marquee selection, right-click insert with a length submenu, delete,
 * join, split and transpose.
 *
 * Performance: the engraved SVG is expensive to build, so it is memoised on its inputs and
 * NEVER re-rendered by playback. The playhead is an absolutely positioned element moved by
 * ref, and the "currently sounding" highlight toggles a class on notehead nodes directly.
 * Both run off transportBus at ~20 Hz without touching React state — the same discipline
 * the Piano Roll uses. Live recording is the one thing that DOES re-engrave, throttled,
 * because new notes genuinely change the score.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./sheetMusic.css";
import { recordingBus, transportBus, useStore } from "../../store/store";
import { editNotes, locate, previewNote, quantizeNotes } from "../../store/actions";
import { bpmAtBeat, timeSigAtBeat } from "../../lib/time";
import { isBool, isFiniteNumber, oneOf, usePrefState } from "../../lib/prefs";
import { followScrollX, shouldFollow } from "../../lib/followPlayhead";
import { noteManualScroll } from "../../lib/followSuspend";
import { registerKeyContext } from "../../lib/keyboard";
import { showToast } from "../common/ToastHost";
import { IconButton } from "../common/IconButton";
import { Select } from "../common/Select";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import Score, { HEADER_SPACES, type ScorePoint } from "./Score";
import { noteheadHalfWidth } from "./glyphs";
import {
  QUANTIZE_PRESETS,
  TPQ,
  beatsToTicks,
  buildScore,
  detectKey,
  durTicks,
  keyName,
  keySignatureAccidentals,
  ticksToBeats,
  type SourceNote,
} from "./notation";
import { layoutScore, tickToPoint, type Clef, type ScoreLayout } from "./layout";
import {
  deleteNotes,
  joinNotes,
  legatoNotes,
  prunePatches,
  resolveNotes,
  setLength,
  setVelocity,
  splitAtBeat,
  splitNotes,
  transposeNotes,
  type ClipPatch,
} from "./editing";
import { downloadMusicXml, toMusicXml } from "./musicxml";
import type { MidiClip, Project, Track } from "../../protocol/types";
import { isMidiClip } from "../../protocol/types";

type Source = "clip" | "track";
type ClefMode = "grand" | "treble" | "bass" | "alto";
type PageMode = "continuous" | "page";
type Paper = "a4" | "letter";

const PAPER: Record<Paper, { w: number; h: number; label: string }> = {
  a4: { w: 794, h: 1123, label: "A4" }, // 210 × 297 mm at 96 dpi
  letter: { w: 816, h: 1056, label: "Letter" },
};
const PAGE_MARGIN = 56; // ~15 mm

const CLEFS_FOR: Record<ClefMode, Clef[]> = {
  grand: ["treble", "bass"],
  treble: ["treble"],
  bass: ["bass"],
  alto: ["alto"],
};

const KEY_OPTIONS = Array.from({ length: 15 }, (_, i) => {
  const fifths = i - 7;
  return { value: String(fifths), label: keyName(fifths) };
});

/** Note values offered for insertion and for "set length", longest first. */
const LENGTHS: { label: string; value: 1 | 2 | 4 | 8 | 16 | 32; dots: 0 | 1 }[] = [
  { label: "Whole", value: 1, dots: 0 },
  { label: "Dotted half", value: 2, dots: 1 },
  { label: "Half", value: 2, dots: 0 },
  { label: "Dotted quarter", value: 4, dots: 1 },
  { label: "Quarter", value: 4, dots: 0 },
  { label: "Dotted eighth", value: 8, dots: 1 },
  { label: "Eighth", value: 8, dots: 0 },
  { label: "Sixteenth", value: 16, dots: 0 },
  { label: "Thirty-second", value: 32, dots: 0 },
];
const lengthKey = (l: { value: number; dots: number }) => `${l.value}.${l.dots}`;

const SEMITONE = [0, 2, 4, 5, 7, 9, 11];

/** Which MIDI pitch a staff position means, given the key (so F in D major is F#). */
function pitchFromStep(step: number, fifths: number, transpose: number): number {
  const li = ((step % 7) + 7) % 7;
  const octave = Math.floor(step / 7);
  const letter = "CDEFGAB"[li];
  const acc = keySignatureAccidentals(fifths).find((a) => a.letter === letter);
  const written = (octave + 1) * 12 + SEMITONE[li] + (acc?.alter ?? 0);
  return Math.max(0, Math.min(127, written - transpose));
}

interface Sourced {
  track: Track | null;
  clips: MidiClip[];
}

function resolveSource(project: Project | null, activeId: number | null, mode: Source): Sourced {
  if (!project) return { track: null, clips: [] };
  let found: { track: Track; clip: MidiClip } | null = null;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === activeId && isMidiClip(clip)) found = { track, clip };
    }
  }
  if (!found) {
    // No active clip — fall back to the selected MIDI track, else the first one, so the
    // pane is useful before anything has been opened in an editor.
    const sel = new Set(useStore.getState().selection.trackIds);
    const candidates = project.tracks.filter(
      (t) => (t.kind === "midi" || t.kind === "instrument") && t.clips.some(isMidiClip),
    );
    const track = candidates.find((t) => sel.has(t.id)) ?? candidates[0] ?? null;
    return { track, clips: track ? track.clips.filter(isMidiClip) : [] };
  }
  return mode === "clip"
    ? { track: found.track, clips: [found.clip] }
    : { track: found.track, clips: found.track.clips.filter(isMidiClip) };
}

export default function SheetMusic() {
  const project = useStore((s) => s.project);
  const activeMidiClipId = useStore((s) => s.activeMidiClipId);
  const selectionTrackIds = useStore((s) => s.selection.trackIds);
  const selectedNoteIds = useStore((s) => s.selection.noteIds);
  const setSelection = useStore((s) => s.setSelection);

  const [source, setSource] = usePrefState<Source>("sheetMusic.source", "track", oneOf("clip", "track"));
  const [clefMode, setClefMode] = usePrefState<ClefMode>(
    "sheetMusic.clefs",
    "grand",
    oneOf("grand", "treble", "bass", "alto"),
  );
  const [keyPref, setKeyPref] = usePrefState<string>(
    "sheetMusic.key",
    "auto",
    (v) => v === "auto" || (typeof v === "string" && Number.isInteger(Number(v))),
  );
  const [quantIdx, setQuantIdx] = usePrefState<number>("sheetMusic.quantize", 4, isFiniteNumber);
  const [transposeStr, setTranspose] = usePrefState<string>("sheetMusic.transpose", "0", (v) => typeof v === "string");
  const [sp, setSp] = usePrefState<number>("sheetMusic.sp", 8, isFiniteNumber);
  const [pageMode, setPageMode] = usePrefState<PageMode>(
    "sheetMusic.pageMode",
    "continuous",
    oneOf("continuous", "page"),
  );
  const [paper, setPaper] = usePrefState<Paper>("sheetMusic.paper", "a4", oneOf("a4", "letter"));
  const [barNumbers, setBarNumbers] = usePrefState<boolean>("sheetMusic.barNumbers", true, isBool);
  const [noteNames, setNoteNames] = usePrefState<boolean>("sheetMusic.noteNames", false, isBool);
  const [splitStr, setSplit] = usePrefState<string>("sheetMusic.split", "60", (v) => typeof v === "string");
  const [editing, setEditing] = usePrefState<boolean>("sheetMusic.editing", false, isBool);
  const [insertKey, setInsertKey] = usePrefState<string>("sheetMusic.insertLen", "4.0", (v) => typeof v === "string");

  const [printing, setPrinting] = useState(false);
  const [viewW, setViewW] = useState(900);
  const [marquee, setMarquee] = useState<{ page: number; x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [liveNotes, setLiveNotes] = useState<SourceNote[]>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const headRef = useRef<Map<number, Element[]>>(new Map());
  const soundingRef = useRef<Set<number>>(new Set());
  const dragRef = useRef<{ page: number; x: number; y: number; moved: boolean; pt: ScorePoint } | null>(null);

  const transpose = Number(transposeStr) || 0;
  const splitPitch = clefMode === "grand" ? Number(splitStr) || 60 : null;
  const quantize = QUANTIZE_PRESETS[Math.max(0, Math.min(QUANTIZE_PRESETS.length - 1, quantIdx))].ticks;
  const insertLen = LENGTHS.find((l) => lengthKey(l) === insertKey) ?? LENGTHS[4];

  const { track, clips } = useMemo(
    () => resolveSource(project, activeMidiClipId, source),
    [project, activeMidiClipId, source, selectionTrackIds],
  );

  /* ---- gather notes in absolute ticks, with the score starting at a whole bar ---- */
  const gathered = useMemo(() => {
    const sigMap = project?.timeSigMap ?? [];
    const firstBeat = clips.reduce(
      (m, c) => (c.notes.length ? Math.min(m, c.startBeat + Math.min(...c.notes.map((nt) => nt.startBeat))) : m),
      Infinity,
    );
    const sig = timeSigAtBeat(Number.isFinite(firstBeat) ? firstBeat : 0, sigMap);
    const beatsPerBar = sig.beatsPerBar > 0 ? sig.beatsPerBar : 4;
    const originBar = Number.isFinite(firstBeat) ? Math.max(0, Math.floor(firstBeat / beatsPerBar)) : 0;
    const originBeat = originBar * beatsPerBar;

    const notes: SourceNote[] = [];
    for (const clip of clips) {
      for (const nt of clip.notes) {
        const abs = clip.startBeat + nt.startBeat - originBeat;
        if (abs < 0) continue;
        notes.push({
          id: nt.id,
          start: beatsToTicks(abs),
          ticks: Math.max(1, beatsToTicks(nt.lengthBeats)),
          pitch: nt.pitch,
          velocity: nt.velocity,
        });
      }
    }
    // Engrave the whole extent of the clips, not just up to the last note — the empty
    // bars are where you write the next ones, so they have to exist on the page.
    const lastClipEnd = clips.reduce((m, c) => Math.max(m, c.startBeat + c.lengthBeats), originBeat);
    const barsInClips = Math.ceil(Math.max(0, lastClipEnd - originBeat) / beatsPerBar);

    return {
      notes,
      originBeat,
      barOffset: originBar,
      meter: { num: sig.num, den: sig.den },
      minMeasures: Math.max(1, barsInClips),
    };
  }, [clips, project?.timeSigMap]);

  /** Live recording notes shown alongside the committed ones (negative ids = not editable). */
  const allNotes = useMemo(
    () => (liveNotes.length ? [...gathered.notes, ...liveNotes] : gathered.notes),
    [gathered.notes, liveNotes],
  );

  const detected = useMemo(
    () => detectKey(allNotes.map((nt) => ({ pitch: nt.pitch + transpose, ticks: nt.ticks }))),
    [allNotes, transpose],
  );
  const fifths = keyPref === "auto" ? detected.fifths : Number(keyPref) || 0;

  const measures = useMemo(
    () =>
      buildScore(allNotes, {
        meter: gathered.meter,
        fifths,
        quantize,
        splitPitch,
        transpose,
        minMeasures: gathered.minMeasures,
      }),
    [allNotes, gathered.meter, gathered.minMeasures, fifths, quantize, splitPitch, transpose],
  );

  const usePages = pageMode === "page" || printing;
  const paperDef = PAPER[paper];
  const leftPad = clefMode === "grand" ? sp * 2 : 0;
  const contentWidth =
    (usePages ? paperDef.w - PAGE_MARGIN * 2 : Math.max(320, viewW - 48)) - leftPad;

  const layout: ScoreLayout = useMemo(
    () =>
      layoutScore(measures, {
        sp,
        width: contentWidth,
        clefs: CLEFS_FOR[clefMode],
        fifths,
        pageHeight: usePages ? paperDef.h - PAGE_MARGIN * 2 - sp * HEADER_SPACES : null,
        firstPageOffset: usePages ? 0 : sp * 2,
        dynamics: true,
      }),
    [measures, sp, contentWidth, clefMode, fifths, usePages, paperDef.h],
  );

  /* ---- responsive width ---- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /* ---- index noteheads for highlighting, after every re-engrave ---- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const map = new Map<number, Element[]>();
    el.querySelectorAll<SVGElement>("[data-nid]").forEach((node) => {
      const id = Number(node.dataset.nid);
      const list = map.get(id);
      if (list) list.push(node);
      else map.set(id, [node]);
    });
    headRef.current = map;
    soundingRef.current = new Set();
  }, [layout]);

  /* ---- live recording: re-engrave as notes arrive, throttled ---- */
  const trackIdRef = useRef<number | null>(null);
  trackIdRef.current = track?.id ?? null;
  const originForLive = useRef(gathered.originBeat);
  originForLive.current = gathered.originBeat;

  useEffect(() => {
    let pending: SourceNote[] | null = null;
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      if (pending) {
        setLiveNotes(pending);
        pending = null;
      }
    };
    const unsub = recordingBus.subscribe((ev) => {
      const tid = trackIdRef.current;
      // Only mirror the take when it is being recorded onto the track on show.
      if (tid === null || !ev.trackIds.includes(tid)) {
        if (pending || liveNotesRef.current.length) {
          pending = [];
          if (timer === null) timer = window.setTimeout(flush, 60);
        }
        return;
      }
      pending = ev.notes.map((nt, i) => ({
        id: -1000000 - i, // negative: live, not a real note id — never editable
        start: beatsToTicks(ev.startBeat + nt.startBeat - originForLive.current),
        ticks: Math.max(1, beatsToTicks(Math.max(0.03, nt.lengthBeats))),
        pitch: nt.pitch,
        velocity: nt.velocity,
      })).filter((nt) => nt.start >= 0);
      // Throttle: engraving is not cheap and takes arrive at ~15 Hz.
      if (timer === null) timer = window.setTimeout(flush, 220);
    });
    return () => {
      unsub();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const liveNotesRef = useRef(liveNotes);
  liveNotesRef.current = liveNotes;

  // When the transport stops, the take is committed to the project — drop the preview so
  // the engraved notes come from the real clip (and become editable).
  useEffect(
    () =>
      transportBus.subscribe((ev) => {
        if (ev.state !== "recording" && liveNotesRef.current.length > 0) setLiveNotes([]);
      }),
    [],
  );

  /* ---- playhead + highlight + follow, all off transportBus ---- */
  const originBeatRef = useRef(gathered.originBeat);
  originBeatRef.current = gathered.originBeat;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const notesRef = useRef(allNotes);
  notesRef.current = allNotes;
  const marginRef = useRef(usePages ? PAGE_MARGIN : 0);
  marginRef.current = usePages ? PAGE_MARGIN : 0;
  const headerRef = useRef(usePages ? sp * HEADER_SPACES : 0);
  headerRef.current = usePages ? sp * HEADER_SPACES : 0;
  const leftPadRef = useRef(leftPad);
  leftPadRef.current = leftPad;

  const applyTransport = useCallback((beat: number, playing: boolean) => {
    const lay = layoutRef.current;
    const tick = beatsToTicks(beat - originBeatRef.current);
    const pos = tickToPoint(lay, tick);
    const ph = playheadRef.current;

    if (!pos || !ph) {
      if (ph) ph.style.opacity = "0";
      return;
    }
    const wrap = pageRefs.current[pos.page];
    const top = wrap ? wrap.offsetTop : 0;
    const y = top + marginRef.current + (pos.page === 0 ? headerRef.current : 0) + pos.system.y;
    ph.style.opacity = "1";
    ph.style.height = `${pos.system.height + lay.sp * 2.4}px`;
    ph.style.transform = `translate(${pos.x + marginRef.current + leftPadRef.current}px, ${
      y - lay.sp * 1.2
    }px)`;

    const next = new Set<number>();
    if (playing) {
      for (const nt of notesRef.current) {
        if (tick >= nt.start && tick < nt.start + nt.ticks) next.add(nt.id);
      }
    }
    const prev = soundingRef.current;
    for (const id of prev) {
      if (!next.has(id)) headRef.current.get(id)?.forEach((el) => el.classList.remove("playing"));
    }
    for (const id of next) {
      if (!prev.has(id)) headRef.current.get(id)?.forEach((el) => el.classList.add("playing"));
    }
    soundingRef.current = next;

    const sc = scrollRef.current;
    if (sc && shouldFollow(useStore.getState().followPlayhead)) {
      const nextTop = followScrollX(
        { x: y, scrollX: sc.scrollTop, viewW: sc.clientHeight, contentW: sc.scrollHeight },
        { lead: 0.25, from: 0.05, to: 0.75 },
      );
      if (nextTop !== null) sc.scrollTop = nextTop;
    }
  }, []);

  useEffect(() => {
    const last = transportBus.last;
    if (last) applyTransport(last.beat, last.state !== "stopped");
    return transportBus.subscribe((ev) => applyTransport(ev.beat, ev.state !== "stopped"));
  }, [applyTransport, layout]);

  /* ============================================================================
   * Editing
   * ========================================================================= */

  const selectedSet = useMemo(() => new Set(selectedNoteIds), [selectedNoteIds]);

  const apply = useCallback(async (patches: ClipPatch[], what: string, quiet = false) => {
    const pruned = prunePatches(patches);
    if (pruned.length === 0) {
      if (!quiet) showToast(`Nothing to ${what.toLowerCase()}.`, "info");
      return;
    }
    try {
      for (const p of pruned) {
        await editNotes(p.clipId, { add: p.add, remove: p.remove, update: p.update });
      }
    } catch (e) {
      showToast(`${what} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, []);

  const refsFor = useCallback(
    (ids: Iterable<number>) => resolveNotes(clips, ids),
    [clips],
  );

  const selectedRefs = useCallback(() => refsFor(selectedNoteIds), [refsFor, selectedNoteIds]);

  const clipAtBeat = useCallback(
    (beat: number): MidiClip | null => {
      for (const c of clips) {
        if (beat >= c.startBeat && beat < c.startBeat + c.lengthBeats) return c;
      }
      return null;
    },
    [clips],
  );

  const insertNote = useCallback(
    async (pt: ScorePoint, len: { value: number; dots: number }) => {
      const snap = quantize > 0 ? quantize : TPQ / 4;
      const tick = Math.max(0, Math.round(pt.tick / snap) * snap);
      const absBeat = ticksToBeats(tick) + gathered.originBeat;
      const clip = clipAtBeat(absBeat);
      if (!clip) {
        showToast("No MIDI clip at that position — add one on the timeline first.", "info");
        return;
      }
      const pitch = pitchFromStep(pt.step, fifths, transpose);
      const lengthBeats = ticksToBeats(durTicks(len.value as 1 | 2 | 4 | 8 | 16 | 32, len.dots as 0 | 1 | 2));
      if (track) void previewNote(track.id, pitch, 90, true).catch(() => {});
      await apply(
        [
          {
            clipId: clip.id,
            add: [{ pitch, velocity: 90, startBeat: absBeat - clip.startBeat, lengthBeats }],
          },
        ],
        "Insert note",
        true,
      );
      if (track) {
        window.setTimeout(() => void previewNote(track.id, pitch, 0, false).catch(() => {}), 220);
      }
    },
    [apply, clipAtBeat, fifths, gathered.originBeat, quantize, track, transpose],
  );

  /** Notes whose noteheads fall inside a marquee rectangle on `page`. */
  const notesInRect = useCallback(
    (page: number, r: { x1: number; y1: number; x2: number; y2: number }): number[] => {
      const pg = layout.pages[page];
      if (!pg) return [];
      const x1 = Math.min(r.x1, r.x2);
      const x2 = Math.max(r.x1, r.x2);
      const y1 = Math.min(r.y1, r.y2);
      const y2 = Math.max(r.y1, r.y2);
      const out = new Set<number>();
      for (const sys of pg.systems) {
        for (const m of sys.measures) {
          for (const el of m.elements) {
            if (el.source.kind !== "note") continue;
            const staffY = sys.y + (sys.staffY[el.staff] ?? 0);
            for (const h of el.heads) {
              if (h.noteId < 0) continue; // live recording preview
              const hx = el.x + h.dx;
              const hy = staffY + h.y;
              const half = noteheadHalfWidth(h.value) * layout.sp;
              if (hx + half >= x1 && hx - half <= x2 && hy + layout.sp * 0.5 >= y1 && hy - layout.sp * 0.5 <= y2) {
                out.add(h.noteId);
              }
            }
          }
        }
      }
      return [...out];
    },
    [layout],
  );

  const selectNotes = useCallback(
    (ids: number[], additive: boolean) => {
      const cur = useStore.getState().selection;
      const next = additive ? new Set([...cur.noteIds, ...ids]) : new Set(ids);
      setSelection({ noteIds: [...next], clipIds: cur.clipIds, trackIds: cur.trackIds });
    },
    [setSelection],
  );

  /* ---- pointer handling: click = select / insert / locate, drag = marquee ---- */

  const onNoteDown = useCallback(
    (noteId: number, e: React.PointerEvent) => {
      if (noteId < 0) return; // live preview note
      e.stopPropagation();
      // Right-click must NOT collapse a multi-selection — the context menu acts on it.
      if (e.button !== 0) return;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const cur = useStore.getState().selection.noteIds;
      if (additive && cur.includes(noteId)) {
        setSelection({
          noteIds: cur.filter((n) => n !== noteId),
          clipIds: useStore.getState().selection.clipIds,
          trackIds: useStore.getState().selection.trackIds,
        });
      } else {
        selectNotes([noteId], additive);
      }
    },
    [selectNotes, setSelection],
  );

  const onStaffDown = useCallback((pt: ScorePoint, e: React.PointerEvent) => {
    dragRef.current = { page: pt.page, x: pt.x, y: pt.y, moved: false, pt };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const wrap = pageRefs.current[d.page];
      const svg = wrap?.querySelector("svg.sm-page");
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scale = (svg as SVGSVGElement).viewBox.baseVal.width / Math.max(1, rect.width);
      const x = (e.clientX - rect.left) * scale - marginRef.current - leftPadRef.current;
      const y = (e.clientY - rect.top) * scale - marginRef.current - (d.page === 0 ? headerRef.current : 0);
      if (!d.moved && Math.abs(x - d.x) + Math.abs(y - d.y) < 4) return;
      d.moved = true;
      setMarquee({ page: d.page, x1: d.x, y1: d.y, x2: x, y2: y });
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (d.moved) {
        const m = marqueeRef.current;
        if (m) selectNotes(notesInRect(m.page, m), e.shiftKey || e.ctrlKey);
        setMarquee(null);
        return;
      }
      // A plain click: insert in edit mode, otherwise move the playhead.
      if (editingRef.current) void insertNote(d.pt, insertLenRef.current);
      else {
        selectNotes([], false);
        void locate(ticksToBeats(d.pt.tick) + originBeatRef.current).catch(() => {});
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [insertNote, notesInRect, selectNotes]);

  const marqueeRef = useRef(marquee);
  marqueeRef.current = marquee;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const insertLenRef = useRef(insertLen);
  insertLenRef.current = insertLen;

  /* ---- operations ---- */

  const doDelete = useCallback(() => {
    const refs = selectedRefs();
    if (!refs.length) return;
    void apply(deleteNotes(refs), "Delete");
    selectNotes([], false);
  }, [apply, selectNotes, selectedRefs]);

  const doSetLength = useCallback(
    (l: { value: number; dots: number }) => {
      const refs = selectedRefs();
      if (!refs.length) return;
      void apply(setLength(refs, ticksToBeats(durTicks(l.value as 4, l.dots as 0))), "Set length");
    },
    [apply, selectedRefs],
  );

  const doJoin = useCallback(() => {
    const refs = selectedRefs();
    const { patches, merged } = joinNotes(refs);
    if (merged === 0) {
      showToast("Select two or more notes at the SAME pitch to join them.", "info");
      return;
    }
    void apply(patches, "Join");
  }, [apply, selectedRefs]);

  const doSplit = useCallback(
    (parts: number) => {
      const refs = selectedRefs();
      const { patches, split } = splitNotes(refs, parts);
      if (split === 0) {
        showToast("Selected notes are too short to split.", "info");
        return;
      }
      void apply(patches, "Split");
    },
    [apply, selectedRefs],
  );

  const doSplitAtPlayhead = useCallback(() => {
    const refs = selectedRefs();
    const beat = transportBus.last?.beat ?? 0;
    const { patches, split } = splitAtBeat(refs, beat);
    if (split === 0) {
      showToast("The playhead is not inside any selected note.", "info");
      return;
    }
    void apply(patches, "Split");
  }, [apply, selectedRefs]);

  const doTranspose = useCallback(
    (semis: number) => {
      const refs = selectedRefs();
      if (!refs.length) return;
      void apply(transposeNotes(refs, semis), "Transpose");
    },
    [apply, selectedRefs],
  );

  const doVelocity = useCallback(
    (v: number) => {
      const refs = selectedRefs();
      if (!refs.length) return;
      void apply(setVelocity(refs, v), "Set velocity");
    },
    [apply, selectedRefs],
  );

  const doLegato = useCallback(() => {
    const refs = selectedRefs();
    if (refs.length < 2) {
      showToast("Select two or more notes.", "info");
      return;
    }
    void apply(legatoNotes(refs), "Legato");
  }, [apply, selectedRefs]);

  const doQuantize = useCallback(() => {
    const refs = selectedRefs();
    if (!refs.length) return;
    const step = ticksToBeats(quantize > 0 ? quantize : TPQ / 4);
    const byClipId = new Map<number, number[]>();
    for (const r of refs) {
      const l = byClipId.get(r.clip.id) ?? [];
      l.push(r.note.id);
      byClipId.set(r.clip.id, l);
    }
    for (const [clipId, ids] of byClipId) {
      void quantizeNotes(clipId, step, 1, 0, ids).catch((err) =>
        showToast(`Quantise failed: ${err instanceof Error ? err.message : String(err)}`, "error"),
      );
    }
  }, [quantize, selectedRefs]);

  const selectAll = useCallback(() => {
    selectNotes(
      gathered.notes.map((nt) => nt.id).filter((id) => id >= 0),
      false,
    );
  }, [gathered.notes, selectNotes]);

  /* ---- context menus ---- */

  const lengthSubmenu = (onPick: (l: (typeof LENGTHS)[number]) => void, mark?: string): MenuEntry[] =>
    LENGTHS.map((l) => ({
      label: l.label,
      checked: mark === lengthKey(l),
      onClick: () => onPick(l),
    }));

  const openNoteMenu = useCallback(
    (noteId: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Right-clicking outside the selection selects that note first (Cubase behaviour).
      const cur = useStore.getState().selection.noteIds;
      if (!cur.includes(noteId)) selectNotes([noteId], false);
      const count = cur.includes(noteId) ? cur.length : 1;
      const many = count > 1;

      openContextMenu(e.clientX, e.clientY, [
        { label: many ? `${count} notes selected` : "1 note selected", disabled: true },
        "separator",
        { label: "Set Length", icon: "midiNote", submenu: lengthSubmenu(doSetLength) },
        {
          label: "Split",
          icon: "scissors",
          submenu: [
            { label: "In Half", onClick: () => doSplit(2) },
            { label: "Into 3", onClick: () => doSplit(3) },
            { label: "Into 4", onClick: () => doSplit(4) },
            "separator",
            { label: "At Playhead", onClick: doSplitAtPlayhead },
          ],
        },
        {
          label: "Join",
          icon: "glue",
          title: "Merge selected notes of the same pitch into one (ties them in the score)",
          disabled: !many,
          onClick: doJoin,
        },
        { label: "Legato", disabled: !many, title: "Extend each note to the next", onClick: doLegato },
        "separator",
        {
          label: "Transpose",
          submenu: [
            { label: "Octave Up", onClick: () => doTranspose(12) },
            { label: "Semitone Up", onClick: () => doTranspose(1) },
            { label: "Semitone Down", onClick: () => doTranspose(-1) },
            { label: "Octave Down", onClick: () => doTranspose(-12) },
          ],
        },
        {
          label: "Velocity",
          submenu: [
            { label: "pp — 24", onClick: () => doVelocity(24) },
            { label: "p — 45", onClick: () => doVelocity(45) },
            { label: "mf — 70", onClick: () => doVelocity(70) },
            { label: "f — 95", onClick: () => doVelocity(95) },
            { label: "ff — 115", onClick: () => doVelocity(115) },
          ],
        },
        { label: "Quantise to Grid", onClick: doQuantize },
        "separator",
        { label: "Delete", icon: "trash", danger: true, shortcut: "Del", onClick: doDelete },
      ]);
    },
    [
      doDelete,
      doJoin,
      doLegato,
      doQuantize,
      doSetLength,
      doSplit,
      doSplitAtPlayhead,
      doTranspose,
      doVelocity,
      selectNotes,
    ],
  );

  const openStaffMenu = useCallback(
    (pt: ScorePoint, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, [
        {
          label: "Insert Note",
          icon: "pencil",
          submenu: lengthSubmenu((l) => void insertNote(pt, l), insertKey),
        },
        {
          label: editing ? "Leave Edit Mode" : "Enter Edit Mode",
          icon: "pencil",
          checked: editing,
          title: "In edit mode a click on the staff writes a note",
          onClick: () => setEditing(!editing),
        },
        "separator",
        { label: "Select All", shortcut: "Ctrl+A", onClick: selectAll },
        {
          label: "Clear Selection",
          disabled: selectedNoteIds.length === 0,
          onClick: () => selectNotes([], false),
        },
        "separator",
        {
          label: "Move Playhead Here",
          onClick: () => void locate(ticksToBeats(pt.tick) + gathered.originBeat).catch(() => {}),
        },
      ]);
    },
    [editing, gathered.originBeat, insertKey, insertNote, selectAll, selectNotes, selectedNoteIds.length, setEditing],
  );

  /* ---- keyboard context ---- */
  useEffect(
    () =>
      registerKeyContext("sheetMusic", {
        deleteSelection: doDelete,
        selectAll,
        escape: () => {
          if (useStore.getState().selection.noteIds.length === 0) return false;
          selectNotes([], false);
          return true;
        },
        zoomH: (f) => {
          setSp((prev) => Math.max(5, Math.min(16, Math.round(prev * (f > 1 ? 1.15 : 0.87)))));
          return true;
        },
        zoomV: (f) => {
          setSp((prev) => Math.max(5, Math.min(16, Math.round(prev * (f > 1 ? 1.15 : 0.87)))));
          return true;
        },
      }),
    [doDelete, selectAll, selectNotes, setSp],
  );

  /* ---- print / export ---- */

  const doPrint = useCallback(() => {
    setPrinting(true);
    window.setTimeout(() => {
      window.print();
      window.setTimeout(() => setPrinting(false), 300);
    }, 120);
  }, []);

  const doExport = useCallback(() => {
    const xml = toMusicXml(measures, {
      title: project?.name || "Untitled",
      partName: track?.name || "Music",
      clefs: CLEFS_FOR[clefMode],
      fifths,
      tempo: project ? bpmAtBeat(gathered.originBeat, project.tempoMap) : undefined,
    });
    const base = `${project?.name || "score"}${track ? ` - ${track.name}` : ""}`.replace(/[\\/:*?"<>|]/g, "_");
    downloadMusicXml(xml, base);
    showToast("MusicXML exported — open it in MuseScore, Dorico or Sibelius.", "success");
  }, [measures, project, track, clefMode, fifths, gathered.originBeat]);

  const hasMusic = allNotes.length > 0;
  const tempo = project ? bpmAtBeat(gathered.originBeat, project.tempoMap) : 120;

  return (
    <div className="sm-root" onPointerDownCapture={() => useStore.getState().setFocusedPane("sheetMusic")}>
      <div className="sm-toolbar">
        <span className="sm-title-label" title={track ? `Track: ${track.name}` : "No MIDI track"}>
          {track?.name ?? "No MIDI"}
        </span>

        <IconButton
          icon="pencil"
          active={editing}
          tooltip={
            editing
              ? "Edit mode ON — click the staff to write a note (right-click for more)"
              : "Edit mode — click the staff to write notes"
          }
          onClick={() => setEditing(!editing)}
        />
        {editing ? (
          <Select
            value={insertKey}
            onChange={setInsertKey}
            options={LENGTHS.map((l) => ({ value: lengthKey(l), label: l.label }))}
            width={128}
            title="Length of notes written by clicking"
          />
        ) : null}

        <div className="sm-sep" />

        <Select
          value={source}
          onChange={(v) => setSource(v as Source)}
          options={[
            { value: "track", label: "Whole track" },
            { value: "clip", label: "Active clip" },
          ]}
          width={112}
          title="What to engrave"
        />
        <Select
          value={clefMode}
          onChange={(v) => setClefMode(v as ClefMode)}
          options={[
            { value: "grand", label: "Grand staff" },
            { value: "treble", label: "Treble (G)" },
            { value: "bass", label: "Bass (F)" },
            { value: "alto", label: "Alto (C)" },
          ]}
          width={118}
          title="Clef"
        />
        {clefMode === "grand" ? (
          <Select
            value={splitStr}
            onChange={setSplit}
            options={[
              { value: "55", label: "Split G3" },
              { value: "60", label: "Split C4" },
              { value: "65", label: "Split F4" },
            ]}
            width={96}
            title="Where the hands divide between staves"
          />
        ) : null}
        <Select
          value={keyPref}
          onChange={setKeyPref}
          options={[{ value: "auto", label: `Auto — ${keyName(detected.fifths, detected.minor)}` }, ...KEY_OPTIONS]}
          width={168}
          title="Key signature (auto reads it from the notes)"
        />
        <Select
          value={String(quantIdx)}
          onChange={(v) => setQuantIdx(Number(v))}
          options={QUANTIZE_PRESETS.map((p, i) => ({ value: String(i), label: `Quantise ${p.label}` }))}
          width={140}
          title="Round rhythms to this grid when engraving, and snap inserted notes to it"
        />
        <Select
          value={transposeStr}
          onChange={setTranspose}
          options={[
            { value: "-12", label: "8vb" },
            { value: "-5", label: "−5" },
            { value: "-2", label: "B♭ inst." },
            { value: "0", label: "Concert" },
            { value: "3", label: "E♭ inst." },
            { value: "12", label: "8va" },
          ]}
          width={104}
          title="Written pitch relative to concert pitch"
        />

        <div className="sm-sep" />

        <IconButton icon="zoomOut" tooltip="Smaller staff" onClick={() => setSp(Math.max(5, sp - 1))} disabled={sp <= 5} />
        <IconButton icon="zoomIn" tooltip="Larger staff" onClick={() => setSp(Math.min(16, sp + 1))} disabled={sp >= 16} />
        <IconButton
          icon="layers"
          active={pageMode === "page"}
          tooltip={pageMode === "page" ? "Page view — click for continuous" : "Continuous — click for page view"}
          onClick={() => setPageMode(pageMode === "page" ? "continuous" : "page")}
        />
        {pageMode === "page" ? (
          <Select
            value={paper}
            onChange={(v) => setPaper(v as Paper)}
            options={[
              { value: "a4", label: "A4" },
              { value: "letter", label: "Letter" },
            ]}
            width={78}
            title="Paper size"
          />
        ) : null}
        <IconButton icon="marker" active={barNumbers} tooltip="Bar numbers" onClick={() => setBarNumbers(!barNumbers)} />
        <IconButton
          icon="piano"
          active={noteNames}
          tooltip="Note names inside noteheads"
          onClick={() => setNoteNames(!noteNames)}
        />

        <div className="sm-spacer" />

        {selectedNoteIds.length > 0 ? (
          <span className="sm-selcount" title="Selected notes — right-click one for actions">
            {selectedNoteIds.length} selected
          </span>
        ) : null}
        <IconButton
          icon="export"
          tooltip="Export MusicXML (MuseScore / Dorico / Sibelius)"
          onClick={doExport}
          disabled={!hasMusic}
        />
        <IconButton icon="scriptList" tooltip="Print / save as PDF" onClick={doPrint} disabled={!hasMusic} />
      </div>

      <div
        className={"sm-scroll" + (usePages ? " paged" : "") + (printing ? " printing" : "")}
        ref={scrollRef}
        onWheel={() => noteManualScroll()}
      >
        {!hasMusic ? (
          <div className="sm-empty">
            <div className="sm-empty-title">No notes to engrave</div>
            <div className="sm-empty-hint">
              Double-click a MIDI clip in the timeline (or select a MIDI track) and it will appear here as
              sheet music. Turn on edit mode to write notes straight onto the staff.
            </div>
          </div>
        ) : (
          <div className="sm-print-root">
            {layout.pages.map((_, i) => (
              <div
                className="sm-page-wrap"
                key={i}
                ref={(el) => {
                  pageRefs.current[i] = el;
                }}
                style={usePages ? { width: paperDef.w, height: paperDef.h } : undefined}
              >
                <Score
                  layout={layout}
                  page={i}
                  barOffset={gathered.barOffset}
                  showBarNumbers={barNumbers}
                  noteNames={noteNames}
                  editing={editing}
                  selected={selectedSet}
                  marquee={marquee && marquee.page === i ? marquee : null}
                  onStaffDown={onStaffDown}
                  onNoteDown={onNoteDown}
                  onNoteContext={openNoteMenu}
                  onStaffContext={openStaffMenu}
                  pageWidth={usePages ? paperDef.w : undefined}
                  pageHeight={usePages ? paperDef.h : undefined}
                  margin={usePages ? PAGE_MARGIN : 0}
                  leftPad={leftPad}
                  header={
                    usePages
                      ? {
                          title: project?.name || "Untitled",
                          subtitle: track?.name,
                          tempo,
                          pageNo: i,
                          pages: layout.pages.length,
                        }
                      : undefined
                  }
                />
              </div>
            ))}
            <div className="sm-playhead-bar" ref={playheadRef} />
          </div>
        )}
      </div>
    </div>
  );
}
