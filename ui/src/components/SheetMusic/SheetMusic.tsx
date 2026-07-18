/**
 * SheetMusic — a notation view of the MIDI you already have.
 *
 * It reads the active MIDI clip (or its whole track), engraves it through
 * notation.ts → layout.ts → Score.tsx, and gives it the things somebody preparing a part
 * actually needs: choice of clef, a real key signature (auto-detected or picked),
 * quantisation, transposition, bar numbers, paper size, printing, and MusicXML export.
 *
 * Performance note: the engraved SVG is expensive to build, so it is memoised on the
 * inputs and NEVER re-rendered by playback. The playhead is a separate absolutely
 * positioned element moved by ref, and the "currently sounding" highlight toggles a class
 * on the notehead nodes directly. Both run off transportBus at ~20 Hz without touching
 * React state — the same discipline the Piano Roll uses.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./sheetMusic.css";
import { transportBus, useStore } from "../../store/store";
import { locate } from "../../store/actions";
import { bpmAtBeat, timeSigAtBeat } from "../../lib/time";
import { isBool, isFiniteNumber, oneOf, usePrefState } from "../../lib/prefs";
import { followScrollX, shouldFollow } from "../../lib/followPlayhead";
import { noteManualScroll } from "../../lib/followSuspend";
import { registerKeyContext } from "../../lib/keyboard";
import { showToast } from "../common/ToastHost";
import { IconButton } from "../common/IconButton";
import { Select } from "../common/Select";
import Score, { HEADER_SPACES } from "./Score";
import {
  QUANTIZE_PRESETS,
  beatsToTicks,
  buildScore,
  detectKey,
  keyName,
  ticksToBeats,
  type SourceNote,
} from "./notation";
import { layoutScore, tickToPoint, type Clef, type ScoreLayout } from "./layout";
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

/** Track + clips the score is built from. */
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
    // No active clip — fall back to the first selected track with MIDI on it, then to
    // the first MIDI-bearing track, so the pane is useful before anything is opened.
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

  const [printing, setPrinting] = useState(false);
  const [viewW, setViewW] = useState(900);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const headRef = useRef<Map<number, Element[]>>(new Map());
  const soundingRef = useRef<Set<number>>(new Set());

  const transpose = Number(transposeStr) || 0;
  const splitPitch = clefMode === "grand" ? Number(splitStr) || 60 : null;
  const quantize = QUANTIZE_PRESETS[Math.max(0, Math.min(QUANTIZE_PRESETS.length - 1, quantIdx))].ticks;

  const { track, clips } = useMemo(
    () => resolveSource(project, activeMidiClipId, source),
    // selectionTrackIds participates: the no-active-clip fallback follows the selection.
    [project, activeMidiClipId, source, selectionTrackIds],
  );

  /* ---- gather notes in absolute ticks, with the score starting at a whole bar ---- */
  const gathered = useMemo(() => {
    const sigMap = project?.timeSigMap ?? [];
    const firstBeat = clips.reduce(
      (m, c) => (c.notes.length ? Math.min(m, c.startBeat + Math.min(...c.notes.map((n) => n.startBeat))) : m),
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
    return { notes, originBeat, barOffset: originBar, meter: { num: sig.num, den: sig.den } };
  }, [clips, project?.timeSigMap]);

  const detected = useMemo(
    () => detectKey(gathered.notes.map((n) => ({ pitch: n.pitch + transpose, ticks: n.ticks }))),
    [gathered.notes, transpose],
  );
  const fifths = keyPref === "auto" ? detected.fifths : Number(keyPref) || 0;

  /* ---- engrave ---- */
  const measures = useMemo(
    () =>
      buildScore(gathered.notes, {
        meter: gathered.meter,
        fifths,
        quantize,
        splitPitch,
        transpose,
        minMeasures: 1,
      }),
    [gathered.notes, gathered.meter, fifths, quantize, splitPitch, transpose],
  );

  const usePages = pageMode === "page" || printing;
  const paperDef = PAPER[paper];
  /** The brace hangs left of the staves; reserve room so it is not clipped. */
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

  /* ---- playhead + highlight + follow, all off transportBus ---- */
  const originBeatRef = useRef(gathered.originBeat);
  originBeatRef.current = gathered.originBeat;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const notesRef = useRef(gathered.notes);
  notesRef.current = gathered.notes;
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
    const h = pos.system.height + lay.sp * 2.4;
    ph.style.opacity = "1";
    ph.style.height = `${h}px`;
    ph.style.transform = `translate(${pos.x + marginRef.current + leftPadRef.current}px, ${
      y - lay.sp * 1.2
    }px)`;

    // sounding notes → class toggle on their noteheads (no React involved)
    const next = new Set<number>();
    if (playing) {
      for (const n of notesRef.current) {
        if (tick >= n.start && tick < n.start + n.ticks) next.add(n.id);
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

    // follow: keep the current system in view (vertical here — the score wraps)
    const sc = scrollRef.current;
    if (sc && shouldFollow(useStore.getState().followPlayhead)) {
      const next2 = followScrollX(
        { x: y, scrollX: sc.scrollTop, viewW: sc.clientHeight, contentW: sc.scrollHeight },
        { lead: 0.25, from: 0.05, to: 0.75 },
      );
      if (next2 !== null) sc.scrollTop = next2;
    }
  }, []);

  useEffect(() => {
    const last = transportBus.last;
    if (last) applyTransport(last.beat, last.state !== "stopped");
    return transportBus.subscribe((ev) => applyTransport(ev.beat, ev.state !== "stopped"));
  }, [applyTransport, layout]);

  /* ---- G/H zoom while this pane has focus ---- */
  useEffect(
    () =>
      registerKeyContext("sheetMusic", {
        zoomH: (f) => {
          setSp((prev) => Math.max(5, Math.min(16, Math.round(prev * (f > 1 ? 1.15 : 0.87)))));
          return true;
        },
        zoomV: (f) => {
          setSp((prev) => Math.max(5, Math.min(16, Math.round(prev * (f > 1 ? 1.15 : 0.87)))));
          return true;
        },
      }),
    [setSp],
  );

  /* ---- print ---- */
  const doPrint = useCallback(() => {
    setPrinting(true);
    // Let the paginated layout commit before handing the document to the printer.
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

  const onPickTick = useCallback(
    (tick: number) => {
      locate(ticksToBeats(tick) + originBeatRef.current).catch(() => {});
    },
    [],
  );

  const hasMusic = gathered.notes.length > 0;
  const tempo = project ? bpmAtBeat(gathered.originBeat, project.tempoMap) : 120;

  return (
    <div
      className="sm-root"
      onPointerDownCapture={() => useStore.getState().setFocusedPane("sheetMusic")}
    >
      <div className="sm-toolbar">
        <span className="sm-title-label" title={track ? `Track: ${track.name}` : "No MIDI track"}>
          {track?.name ?? "No MIDI"}
        </span>

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
          title="Round rhythms to this grid before engraving"
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

        <IconButton
          icon="zoomOut"
          tooltip="Smaller staff"
          onClick={() => setSp(Math.max(5, sp - 1))}
          disabled={sp <= 5}
        />
        <IconButton
          icon="zoomIn"
          tooltip="Larger staff"
          onClick={() => setSp(Math.min(16, sp + 1))}
          disabled={sp >= 16}
        />
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
        <IconButton
          icon="marker"
          active={barNumbers}
          tooltip="Bar numbers"
          onClick={() => setBarNumbers(!barNumbers)}
        />
        <IconButton
          icon="piano"
          active={noteNames}
          tooltip="Note names inside noteheads"
          onClick={() => setNoteNames(!noteNames)}
        />

        <div className="sm-spacer" />

        <IconButton icon="export" tooltip="Export MusicXML (MuseScore / Dorico / Sibelius)" onClick={doExport} disabled={!hasMusic} />
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
              Double-click a MIDI clip in the timeline (or select a MIDI track) and it will appear
              here as sheet music.
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
                  onPickTick={onPickTick}
                  pageWidth={usePages ? paperDef.w : undefined}
                  pageHeight={usePages ? paperDef.h : undefined}
                  margin={usePages ? PAGE_MARGIN : 0}
                  leftPad={leftPad}
                  header={
                    usePages
                      ? {
                          title: project?.name || "Untitled",
                          subtitle: track?.name,
                          part: undefined,
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
