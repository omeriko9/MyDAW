/**
 * PianoRoll (U4) — MIDI note editor for the clip in store.activeMidiClipId (SPEC §9).
 *
 * Layout: mini-toolbar (grid division / strength / swing / quantize / note-length /
 * audition toggle / lane toggle) · 56px keys column (octave-labeled Cs; pressing a key
 * auditions the pitch via midi/preview — injected into the track's live MIDI path) ·
 * canvas note grid (128 pitch rows, clip-local beats, ruler shows ABSOLUTE bars via
 * clip.startBeat) · bottom lane (velocity, or a CC / pitch-bend lane via the lane
 * selector left of the lane).
 *
 * All note edits are batched: ONE cmd/notes.edit per gesture (SPEC §5.3 / §9 drag rule);
 * all CC-lane edits likewise batch into ONE cmd/cc.edit per gesture. Gestures preview
 * locally (canvas only); the store is updated exclusively by the engine echo
 * (event/projectChanged, SPEC §5.8) — preview is dropped when the gesture commits.
 *
 * Local viewport (zoom/scroll) is independent of the timeline viewport. Wheel: scroll,
 * shift = h-scroll, ctrl = h-zoom, alt = v-zoom. Middle-drag pans.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CcUpdate, MidiCc, MidiClip, Note, NoteInput, NoteUpdate, Project, Track, TransportEvent } from "../../protocol/types";
import { transportBus, useStore } from "../../store/store";
import { addMidiClip, editCc, editNotes, locate, previewNote, quantizeNotes } from "../../store/actions";
import { paneVisible, registerKeyContext, zoomToFitPane } from "../../lib/keyboard";
import {
  isBool,
  loadBoolPref,
  loadPref,
  numberIn,
  oneOf,
  savePref,
  savePrefDebounced,
  shapeOf,
  usePrefState,
} from "../../lib/prefs";
import { useCanvas, useRafLoop } from "../../lib/canvas";
import { followScrollX, shouldFollow } from "../../lib/followPlayhead";
import { tempId } from "../../lib/ids";
import { barToBeat, beatToBar, beatToBarsBeats, bpmAtBeat, timeSigAtBeat } from "../../lib/time";
import { Icon } from "../common/icons";
import { IconButton } from "../common/IconButton";
import { NumberDrag } from "../common/NumberDrag";
import { Select } from "../common/Select";
import { Toggle } from "../common/Toggle";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { useIsKeyTarget } from "../common/paneFocus";
import { ZoomPill } from "../common/ZoomPill";
import { confirmDialog } from "../Dialogs/confirm";
import * as M from "./prMath";
import * as D from "./prDraw";
import * as MF from "../../lib/midiFunctions";
import "./pianoRoll.css";

/* ============================================================================
 * Active-clip lookup
 * ========================================================================= */

interface FoundClip {
  track: Track;
  clip: MidiClip;
}

function findActiveMidiClip(project: Project | null, id: number | null): FoundClip | null {
  if (!project || id === null) return null;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === id && clip.type === "midi") return { track, clip };
    }
  }
  return null;
}

/* ============================================================================
 * Gestures (local preview only — one cmd/notes.edit on commit)
 * ========================================================================= */

interface MoveGesture {
  kind: "move";
  ids: number[];
  idSet: Set<number>;
  /** alt-drag duplicate */
  copy: boolean;
  anchorId: number;
  anchorStart: number;
  /** anchor note pitch/velocity — audition of the drag target pitch */
  anchorPitch: number;
  anchorVel: number;
  startX: number;
  startY: number;
  startPitch: number;
  dBeat: number;
  dPitch: number;
  movedPx: number;
  /** plain click on an already-selected note collapses selection to it on release */
  collapseTo: number | null;
  prevSel: number[];
}

interface ResizeGesture {
  kind: "resize";
  ids: number[];
  idSet: Set<number>;
  anchorId: number;
  anchorStart: number;
  anchorLen: number;
  startX: number;
  dLen: number;
}

interface CreateGesture {
  kind: "create";
  note: { id: number; pitch: number; velocity: number; startBeat: number; lengthBeats: number };
}

interface EraseGesture {
  kind: "erase";
  ids: Set<number>;
}

interface MarqueeGesture {
  kind: "marquee";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: number[];
  mode: "replace" | "union" | "xor";
  prevSel: number[];
  lastKey: string;
}

interface VelGesture {
  kind: "velocity";
  overrides: Map<number, number>;
  mode: "selected" | "paint";
  selIds: Set<number>;
  lastX: number;
  lastVel: number;
}

interface PanGesture {
  kind: "pan";
  startX: number;
  startY: number;
  sx: number;
  sy: number;
}

/* CC-lane gestures (all commit as ONE cmd/cc.edit, mirroring the notes.edit pattern) */

interface CcMoveGesture {
  kind: "ccMove";
  ids: number[];
  idSet: Set<number>;
  anchorBeat: number;
  startX: number;
  startY: number;
  dBeat: number;
  dValue: number;
  movedPx: number;
  /** plain click on an already-selected point collapses selection to it on release */
  collapseTo: number | null;
}

interface CcMarqueeGesture {
  kind: "ccMarquee";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: number[];
  mode: "replace" | "union" | "xor";
  prevSel: number[];
  /** plain click (no drag) adds a point here on release */
  addAt: { beat: number; value: number };
  movedPx: number;
}

interface CcDrawGesture {
  kind: "ccDraw";
  controller: number;
  /** pencil stream granularity (grid/8), beats */
  qStep: number;
  /** quantized beat index → value */
  stream: Map<number, number>;
  lo: number;
  hi: number;
  lastBeat: number;
  lastValue: number;
}

interface CcEraseGesture {
  kind: "ccErase";
  ids: Set<number>;
}

type Gesture =
  | MoveGesture
  | ResizeGesture
  | CreateGesture
  | EraseGesture
  | MarqueeGesture
  | VelGesture
  | PanGesture
  | CcMoveGesture
  | CcMarqueeGesture
  | CcDrawGesture
  | CcEraseGesture;

function gestureToPreview(g: Gesture | null): M.NotePreview | null {
  if (!g) return null;
  switch (g.kind) {
    case "move":
      return { moveIds: g.idSet, dBeat: g.dBeat, dPitch: g.dPitch, copy: g.copy };
    case "resize":
      return { resizeIds: g.idSet, dLen: g.dLen };
    case "create":
      return { createNote: g.note };
    case "erase":
      return { eraseIds: g.ids };
    case "velocity":
      return { velocity: g.overrides };
    default:
      return null;
  }
}

function gestureToCcPreview(g: Gesture | null): M.CcPreview | null {
  if (!g) return null;
  switch (g.kind) {
    case "ccMove":
      return { moveIds: g.idSet, dBeat: g.dBeat, dValue: g.dValue };
    case "ccErase":
      return { eraseIds: g.ids };
    case "ccDraw":
      return {
        draw: {
          lo: g.lo,
          hi: g.hi,
          points: [...g.stream.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([k, value]) => ({ beat: Math.max(0, k * g.qStep), value })),
        },
      };
    default:
      return null;
  }
}

/* Lane selector — named CC lanes; "Other CC#" picks any controller via NumberDrag. */
const NAMED_LANES: Array<{ controller: number; label: string; short: string }> = [
  { controller: M.CC_PITCH_BEND, label: "Pitch Bend", short: "PB" },
  { controller: 1, label: "CC1 Mod", short: "CC1" },
  { controller: 2, label: "CC2 Breath", short: "CC2" },
  { controller: 7, label: "CC7 Volume", short: "CC7" },
  { controller: 10, label: "CC10 Pan", short: "CC10" },
  { controller: 11, label: "CC11 Expression", short: "CC11" },
  { controller: 64, label: "CC64 Sustain", short: "CC64" },
  { controller: 71, label: "CC71 Resonance", short: "CC71" },
  { controller: 74, label: "CC74 Cutoff", short: "CC74" },
  { controller: 91, label: "CC91 Reverb", short: "CC91" },
  { controller: 93, label: "CC93 Chorus", short: "CC93" },
];

// loadBoolPref also accepts the legacy raw "1"/"0" this key was written with.
const AUDITION_PREF = "pianoRoll.audition";

/* Zoom persists across clip switches/remounts (scroll is recomputed per clip) AND
   across reloads (lib/prefs — saved debounced from clampView). */
const persisted = loadPref(
  "pianoRoll.view",
  { zoomX: 28, rowH: 14 },
  shapeOf({ zoomX: numberIn(2, 512), rowH: numberIn(6, 40) }),
);

function localPt(e: { clientX: number; clientY: number; currentTarget: Element }): {
  x: number;
  y: number;
} {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/* ============================================================================
 * Zoom pill (UI_IMPROVE.md §1.1) — subscribes to the Editor's render-free view
 * ref via an external-store bridge (notified from clampView). 100% = the
 * persisted default 28 px/beat.
 * ========================================================================= */

const PR_DEFAULT_ZOOM_X = 28;
const PR_ZOOM_STEP = 1.3;

function PrZoomPill({
  listeners,
  getZoomX,
  zoomHBy,
}: {
  listeners: Set<() => void>;
  getZoomX: () => number;
  zoomHBy: (factor: number) => void;
}) {
  const zoomX = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getZoomX,
  );
  return (
    <ZoomPill
      title="Zoom — Ctrl+wheel (notes), Alt+wheel = row height, or G / H"
      fitTooltip="Fit the whole clip into view (F)"
      pct={(zoomX / PR_DEFAULT_ZOOM_X) * 100}
      minPct={(M.MIN_ZOOM_X / PR_DEFAULT_ZOOM_X) * 100}
      maxPct={(M.MAX_ZOOM_X / PR_DEFAULT_ZOOM_X) * 100}
      onPct={(p) => zoomHBy(((p / 100) * PR_DEFAULT_ZOOM_X) / getZoomX())}
      onFit={() => zoomToFitPane("pianoRoll")}
      onZoomOut={() => zoomHBy(1 / PR_ZOOM_STEP)}
      onZoomIn={() => zoomHBy(PR_ZOOM_STEP)}
    />
  );
}

/* ============================================================================
 * Entry component
 * ========================================================================= */

export default function PianoRoll() {
  const project = useStore((s) => s.project);
  const activeMidiClipId = useStore((s) => s.activeMidiClipId);
  const found = useMemo(
    () => findActiveMidiClip(project, activeMidiClipId),
    [project, activeMidiClipId],
  );
  if (!found) return <EmptyState hasProject={project !== null} />;
  // key = clip id → fresh local view (auto-scroll-to-content) when switching clips
  return <Editor key={found.clip.id} track={found.track} clip={found.clip} />;
}

function EmptyState({ hasProject }: { hasProject: boolean }) {
  const project = useStore((s) => s.project);
  const selTrackIds = useStore((s) => s.selection.trackIds);
  const isKeyTarget = useIsKeyTarget("pianoRoll");
  const midiTracks = project
    ? project.tracks.filter((t) => t.kind === "midi" || t.kind === "instrument")
    : [];
  // Prefer the selected midi/instrument track; else the first one in the project.
  const target = midiTracks.find((t) => selTrackIds.includes(t.id)) ?? midiTracks[0] ?? null;

  // One-bar clip at the playhead's bar start, opened here immediately.
  const create = () => {
    if (!project || !target) return;
    const beat = transportBus.last?.beat ?? 0;
    const start = barToBeat(beatToBar(beat, project.timeSigMap), project.timeSigMap);
    const len = timeSigAtBeat(start, project.timeSigMap).beatsPerBar;
    void addMidiClip(target.id, start, len)
      .then((r) => {
        const s = useStore.getState();
        s.setSelection({ clipIds: [r.clip.id], trackIds: [target.id], noteIds: [] });
        s.setActiveMidiClipId(r.clip.id);
      })
      .catch((err) => console.warn("[pianoroll] create midi clip failed:", err));
  };

  return (
    <div
      className="pr-root pr-empty"
      data-key-target={isKeyTarget || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          {
            label: "Create MIDI Clip at Playhead",
            icon: "midiNote",
            disabled: !target,
            title: target ? `On "${target.name}"` : "Add a MIDI or instrument track first",
            onClick: create,
          },
        ]);
      }}
    >
      <Icon name="piano" size={30} />
      <div className="pr-empty-title">No clip open</div>
      <div className="pr-empty-sub">
        {hasProject
          ? "Double-click a MIDI clip in the arrangement, or start a new one:"
          : "No project loaded — waiting for the engine connection."}
      </div>
      {hasProject && (
        <button
          type="button"
          className="btn primary"
          disabled={!target}
          title={target ? `One bar at the playhead on "${target.name}"` : "Add a MIDI or instrument track first"}
          onClick={create}
        >
          Create a MIDI clip{target ? ` on “${target.name}”` : ""}
        </button>
      )}
    </div>
  );
}

/* ============================================================================
 * Editor
 * ========================================================================= */

interface EditorProps {
  track: Track;
  clip: MidiClip;
}

function Editor({ track, clip }: EditorProps) {
  /* ---- store ---- */
  const tool = useStore((s) => s.tool);
  const selectedNoteIds = useStore((s) => s.selection.noteIds);
  const transportState = useStore((s) => s.transport.state);
  const isKeyTarget = useIsKeyTarget("pianoRoll");

  /* ---- latest-value refs for imperative handlers ---- */
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const colorRef = useRef(clip.color ?? track.color);
  colorRef.current = clip.color ?? track.color;

  /* ---- toolbar state (piano-roll-local grid; quantize per SPEC §5.3) ----
     Division/triplet/strength/lane choices are per-user prefs (survive reloads);
     swing deliberately seeds from the project grid. */
  const [divLabel, setDivLabel] = usePrefState(
    "pianoRoll.division",
    "1/16",
    oneOf(...M.DIVISIONS.map((d) => d.label)),
  );
  const [triplet, setTriplet] = usePrefState("pianoRoll.triplet", false, isBool);
  const [strengthPct, setStrengthPct] = usePrefState(
    "pianoRoll.strengthPct",
    100,
    numberIn(0, 100),
  );
  const [swingPct, setSwingPct] = useState(() =>
    Math.round((useStore.getState().project?.grid.swing ?? 0) * 100),
  );
  const [laneOn, setLaneOn] = usePrefState("pianoRoll.laneOn", true, isBool);
  /** bottom-lane content: null = velocity, else controller number (128 = pitch bend) */
  const [laneCtl, setLaneCtl] = usePrefState<number | null>("pianoRoll.laneCtl", null, (v) =>
    v === null || numberIn(0, 128)(v),
  );
  /** "Other CC#" mode — show the CC-number NumberDrag next to the lane */
  const [otherMode, setOtherMode] = usePrefState("pianoRoll.laneOther", false, isBool);
  const laneCtlRef = useRef(laneCtl);
  laneCtlRef.current = laneCtl;
  /** scale highlight + optional snap (drawn notes / ↑↓ transpose stay in scale) */
  const [scaleRoot, setScaleRoot] = usePrefState("pianoRoll.scaleRoot", 0, numberIn(0, 11));
  const [scaleId, setScaleId] = usePrefState(
    "pianoRoll.scale",
    "off",
    oneOf("off", ...M.SCALES.map((s) => s.id)),
  );
  const [scaleSnap, setScaleSnap] = usePrefState("pianoRoll.scaleSnap", false, isBool);
  const scalePcs = useMemo(
    () => (scaleId === "off" ? null : M.scalePitchClasses(scaleRoot, scaleId)),
    [scaleRoot, scaleId],
  );
  const scaleRef = useRef<{ pcs: Set<number> | null; snap: boolean }>({ pcs: null, snap: false });
  scaleRef.current = { pcs: scalePcs, snap: scaleSnap };
  /** y → pitch honoring snap-to-scale (used by note creation paths). */
  const pitchAt = (y: number): number => {
    const p = M.yToPitch(y, viewRef.current);
    const sc = scaleRef.current;
    return sc.snap && sc.pcs ? M.snapPitchToScale(p, sc.pcs, 0) : p;
  };
  /** audition notes while editing (keys column always auditions) */
  const [audition, setAudition] = useState(() => loadBoolPref(AUDITION_PREF, true));
  const auditionRef = useRef(audition);
  auditionRef.current = audition;
  /** length used for newly drawn notes; null → current grid step ("remembers last") */
  const [drawLen, setDrawLen] = useState<number | null>(null);

  const stepBeats = M.gridStep(M.divisionBeats(divLabel), triplet);
  const stepRef = useRef(stepBeats);
  stepRef.current = stepBeats;
  const drawLenRef = useRef(drawLen);
  drawLenRef.current = drawLen;
  const lastVelRef = useRef(96); // default velocity 96, remembers last (brief)

  /* ---- local viewport / gesture state ---- */
  const viewRef = useRef<M.PrView>({
    zoomX: persisted.zoomX,
    rowH: persisted.rowH,
    scrollX: 0,
    scrollY: (M.MAX_PITCH - 66) * persisted.rowH,
  });
  const gestureRef = useRef<Gesture | null>(null);
  const pressedKeyRef = useRef<number | null>(null);
  const lastClickRef = useRef<{ t: number; x: number; y: number } | null>(null);

  /* Drag HUD (UI_IMPROVE.md §2.2) — floating readout near the cursor while a note
     gesture runs ("C#3 · +3 st · 5.2"). Imperative DOM writes, no React state:
     gestures redraw via rAF and must stay render-free. */
  const hudElRef = useRef<HTMLDivElement | null>(null);
  const hudOnRef = useRef(false);
  const hideDragHud = (): void => {
    if (hudOnRef.current && hudElRef.current) {
      hudElRef.current.style.display = "none";
      hudOnRef.current = false;
    }
  };
  const showDragHud = (clientX: number, clientY: number, text: string): void => {
    const el = hudElRef.current;
    if (!el) return;
    el.textContent = text;
    el.style.display = "block";
    el.style.left = `${clientX + 14}px`;
    el.style.top = `${clientY - 18}px`;
    hudOnRef.current = true;
  };
  /** "5.2" (+ ticks only when off-grid) — drag-readout position label. */
  const barsBeatsShort = (absBeat: number): string => {
    const p = useStore.getState().project;
    if (!p) return "";
    const bb = beatToBarsBeats(absBeat, p.timeSigMap);
    return `${bb.bar}.${bb.beat}${bb.tick > 0 ? `.${String(bb.tick).padStart(3, "0")}` : ""}`;
  };
  // Palette cache keyed by the root document's theme (pop-outs have their own document;
  // a theme switch re-resolves on the next draw — useCanvas triggers one via THEME_EVENT).
  const palRef = useRef<{ theme: string; pal: D.Palette } | null>(null);
  const getPal = (root: HTMLElement): D.Palette => {
    const theme = root.ownerDocument.documentElement.dataset.theme ?? "dark";
    if (!palRef.current || palRef.current.theme !== theme) {
      palRef.current = { theme, pal: D.resolvePalette(root) };
    }
    return palRef.current.pal;
  };
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** CC-lane selection is piano-roll-local (canvas only — no store round trip) */
  const ccSelRef = useRef<number[]>([]);

  /* ---- audition (midi/preview — fire-and-forget, never undoable) ---- */
  const trackIdRef = useRef(track.id);
  trackIdRef.current = track.id;
  const liveNoteRef = useRef<{ pitch: number; velocity: number } | null>(null);

  const previewOff = () => {
    const ln = liveNoteRef.current;
    if (!ln) return;
    liveNoteRef.current = null;
    previewNote(trackIdRef.current, ln.pitch, ln.velocity, false).catch(() => undefined);
  };
  const previewOn = (pitch: number, velocity: number) => {
    const p = M.clamp(pitch, 0, M.MAX_PITCH);
    if (liveNoteRef.current?.pitch === p) return;
    previewOff();
    liveNoteRef.current = { pitch: p, velocity };
    previewNote(trackIdRef.current, p, M.clamp(velocity, 1, 127), true).catch(() => undefined);
  };
  const previewOffRef = useRef(previewOff);
  previewOffRef.current = previewOff;
  // note-off on unmount / clip switch (Editor remounts per clip id)
  useEffect(() => () => previewOffRef.current(), []);

  /* ---- canvases (dpr-aware via lib/canvas useCanvas) ---- */
  const drawNowRef = useRef<() => void>(() => {});
  const clampViewRef = useRef<() => void>(() => {});
  const drawPending = useRef(false);
  const requestDraw = useCallback(() => {
    if (drawPending.current) return;
    drawPending.current = true;
    requestAnimationFrame(() => {
      drawPending.current = false;
      drawNowRef.current();
    });
  }, []);

  const keysCv = useCanvas(() => requestDraw());
  const rulerCv = useCanvas(() => requestDraw());
  const notesCv = useCanvas(() => {
    clampViewRef.current();
    requestDraw();
  });
  const velCv = useCanvas(() => requestDraw());
  const overlayCv = useCanvas(() => requestDraw());

  /* ---- view clamping ---- */
  // Zoom-pill subscribers: the view lives in a ref (gestures are render-free), so the
  // pill re-renders via useSyncExternalStore — notified from clampView, the single
  // choke point every zoom/scroll write passes through. Snapshot = zoomX only, so
  // scroll-only notifications are free (unchanged snapshot → no re-render).
  const zoomListeners = useRef(new Set<() => void>()).current;
  const clampView = () => {
    const el = notesCv.canvasRef.current;
    const v = viewRef.current;
    v.zoomX = M.clamp(v.zoomX, M.MIN_ZOOM_X, M.MAX_ZOOM_X);
    v.rowH = M.clamp(Math.round(v.rowH), M.MIN_ROW_H, M.MAX_ROW_H);
    const w = el ? el.clientWidth : 0;
    const h = el ? el.clientHeight : 0;
    const contentW = (M.contentBeats(clipRef.current) + M.SCROLL_MARGIN_BEATS) * v.zoomX;
    v.scrollX = M.clamp(v.scrollX, 0, Math.max(0, contentW - w));
    v.scrollY = M.clamp(v.scrollY, 0, Math.max(0, M.NUM_PITCHES * v.rowH - h));
    persisted.zoomX = v.zoomX;
    persisted.rowH = v.rowH;
    savePrefDebounced("pianoRoll.view", persisted);
    for (const l of [...zoomListeners]) l();
  };
  clampViewRef.current = clampView;

  /* ---- playhead overlay (transportBus + raf while playing — never react state) ---- */
  const transportRef = useRef<{ ev: TransportEvent; at: number } | null>(
    transportBus.last ? { ev: transportBus.last, at: performance.now() } : null,
  );

  const drawOverlayNow = () => {
    const el = overlayCv.canvasRef.current;
    const ctx = overlayCv.ctxRef.current;
    const root = rootRef.current;
    if (!el || !ctx || !root) return;
    const pal = getPal(root);
    const w = el.clientWidth;
    const h = el.clientHeight;
    const lt = transportRef.current;
    if (!lt) {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    const playing = lt.ev.state !== "stopped";
    let beat = lt.ev.beat;
    const proj = useStore.getState().project;
    if (playing && proj) {
      // smooth between ~20 Hz transport events
      beat += ((performance.now() - lt.at) / 1000) * (bpmAtBeat(beat, proj.tempoMap) / 60);
    }
    const x = M.beatToX(beat - clipRef.current.startBeat, viewRef.current);
    D.drawPlayhead(ctx, w, h, x, playing, pal);
  };
  const drawOverlayRef = useRef(drawOverlayNow);
  drawOverlayRef.current = drawOverlayNow;

  useEffect(
    () =>
      transportBus.subscribe((ev) => {
        transportRef.current = { ev, at: performance.now() };
        if (ev.state === "stopped") drawOverlayRef.current();
      }),
    [],
  );

  /* ---- follow playhead ("J") — same page-jump rule as the timeline, but this pane's
     viewport is a REF (not store state), so scroll it directly and redraw. Registered
     after the subscription above, so transportRef is already current here. ---- */
  useEffect(
    () =>
      transportBus.subscribe((ev) => {
        if (!shouldFollow(useStore.getState().followPlayhead)) return;
        const el = notesCv.canvasRef.current;
        if (!el) return;
        const v = viewRef.current;
        const c = clipRef.current;
        const localBeat = ev.beat - c.startBeat;
        const contentBeats = M.contentBeats(c) + M.SCROLL_MARGIN_BEATS;
        // Playhead outside this clip entirely — leave the editor where the user put it.
        if (localBeat < 0 || localBeat > contentBeats) return;
        const next = followScrollX({
          x: localBeat * v.zoomX,
          scrollX: v.scrollX,
          viewW: el.clientWidth,
          contentW: contentBeats * v.zoomX,
        });
        if (next === null) return;
        v.scrollX = next;
        clampViewRef.current();
        requestDraw();
        drawOverlayRef.current();
      }),
    [notesCv.canvasRef, requestDraw],
  );
  // The overlay canvas may live in a popped-out window (portal) — animate on ITS rAF
  // clock so the playhead keeps moving while the MAIN tab is hidden. On the very first
  // render the ref is still null (→ main window); useCanvas's post-mount setState
  // re-renders with the real window and the hook re-subscribes.
  useRafLoop(
    () => drawOverlayRef.current(),
    transportState !== "stopped",
    overlayCv.canvasRef.current?.ownerDocument.defaultView ?? window,
  );

  /* ---- full redraw ---- */
  const drawAllNow = () => {
    const root = rootRef.current;
    if (!root) return;
    const pal = getPal(root);
    const v = viewRef.current;
    const c = clipRef.current;
    const st = useStore.getState();
    const selSet = new Set<number>(st.selection.noteIds);
    const g = gestureRef.current;
    const rNotes = M.buildRenderNotes(c.notes, selSet, gestureToPreview(g));
    const sigMap = st.project?.timeSigMap ?? [];
    const beatsPerBar = timeSigAtBeat(c.startBeat, sigMap).beatsPerBar;
    const marquee = g && g.kind === "marquee" ? g : null;

    const nEl = notesCv.canvasRef.current;
    const nCtx = notesCv.ctxRef.current;
    if (nEl && nCtx) {
      D.drawNotesArea(
        nCtx,
        nEl.clientWidth,
        nEl.clientHeight,
        v,
        c.lengthBeats,
        stepRef.current,
        beatsPerBar,
        rNotes,
        colorRef.current,
        pal,
        marquee,
        scaleRef.current.pcs,
      );
    }
    const kEl = keysCv.canvasRef.current;
    const kCtx = keysCv.ctxRef.current;
    if (kEl && kCtx) D.drawKeys(kCtx, kEl.clientWidth, kEl.clientHeight, v, pressedKeyRef.current, pal);
    const rEl = rulerCv.canvasRef.current;
    const rCtx = rulerCv.ctxRef.current;
    if (rEl && rCtx) {
      D.drawRuler(rCtx, rEl.clientWidth, rEl.clientHeight, v, c.startBeat, c.lengthBeats, sigMap, pal);
    }
    const vEl = velCv.canvasRef.current;
    const vCtx = velCv.ctxRef.current;
    if (vEl && vCtx) {
      const ctl = laneCtlRef.current;
      if (ctl === null) {
        D.drawVelLane(vCtx, vEl.clientWidth, vEl.clientHeight, v, c.lengthBeats, rNotes, colorRef.current, pal);
      } else {
        const rCc = M.buildRenderCc(
          M.ccLanePoints(c.cc, ctl),
          new Set(ccSelRef.current),
          gestureToCcPreview(g),
        );
        D.drawCcLane(
          vCtx,
          vEl.clientWidth,
          vEl.clientHeight,
          v,
          c.lengthBeats,
          rCc,
          ctl === M.CC_PITCH_BEND,
          colorRef.current,
          pal,
          g && g.kind === "ccMarquee" ? g : null,
        );
      }
    }
    drawOverlayNow();
  };
  drawNowRef.current = drawAllNow;

  /* redraw after every commit (selection changes, engine echoes, toolbar changes) */
  useEffect(() => {
    requestDraw();
  });

  /* ---- auto-scroll-to-content once per clip (component remounts per clip id) ---- */
  const autoScrolled = useRef(false);
  useEffect(() => {
    if (autoScrolled.current) return;
    const el = notesCv.canvasRef.current;
    if (!el || el.clientHeight === 0) return;
    autoScrolled.current = true;
    const v = viewRef.current;
    const ns = clipRef.current.notes;
    let center = 66; // around middle C when the clip is empty
    if (ns.length > 0) {
      let lo = M.MAX_PITCH;
      let hi = 0;
      for (const n of ns) {
        lo = Math.min(lo, n.pitch);
        hi = Math.max(hi, n.pitch);
      }
      center = (lo + hi) / 2;
    }
    v.scrollX = 0;
    v.scrollY = (M.MAX_PITCH - center) * v.rowH - el.clientHeight / 2;
    clampViewRef.current();
    requestDraw();
  });

  /* ---- selection helpers ---- */
  const setNoteSelection = (ids: number[]) => useStore.getState().setSelection({ noteIds: ids });

  const currentSelIn = (c: MidiClip): number[] => {
    const ids = new Set(c.notes.map((n) => n.id));
    return useStore.getState().selection.noteIds.filter((id) => ids.has(id));
  };

  /* ---- batched edits (each = ONE cmd/notes.edit = one undo entry, SPEC §5.3) ---- */

  const transposeSelected = (ids: number[], d: number) => {
    const c = clipRef.current;
    const byId = new Map(c.notes.map((n) => [n.id, n]));
    let minP = M.MAX_PITCH;
    let maxP = 0;
    for (const id of ids) {
      const n = byId.get(id);
      if (!n) continue;
      minP = Math.min(minP, n.pitch);
      maxP = Math.max(maxP, n.pitch);
    }
    const dd = d > 0 ? Math.min(d, M.MAX_PITCH - maxP) : Math.max(d, -minP);
    if (dd === 0) return;
    const update: NoteUpdate[] = [];
    for (const id of ids) {
      const n = byId.get(id);
      if (n) update.push({ noteId: id, patch: { pitch: n.pitch + dd } });
    }
    if (update.length > 0) void editNotes(c.id, { update });
  };

  /** Diatonic transpose: every note moves to the NEXT in-scale pitch above/below. */
  const transposeSelectedInScale = (ids: number[], dir: 1 | -1, pcs: ReadonlySet<number>) => {
    const c = clipRef.current;
    const byId = new Map(c.notes.map((n) => [n.id, n]));
    const update: NoteUpdate[] = [];
    for (const id of ids) {
      const n = byId.get(id);
      if (!n) continue;
      const pitch = M.snapPitchToScale(n.pitch, pcs, dir);
      if (pitch !== n.pitch) update.push({ noteId: id, patch: { pitch } });
    }
    if (update.length > 0) void editNotes(c.id, { update });
  };

  const nudgeSelected = (ids: number[], d: number) => {
    const c = clipRef.current;
    const byId = new Map(c.notes.map((n) => [n.id, n]));
    let minStart = Infinity;
    for (const id of ids) {
      const n = byId.get(id);
      if (n) minStart = Math.min(minStart, n.startBeat);
    }
    const dd = d < 0 && Number.isFinite(minStart) ? Math.max(d, -minStart) : d;
    if (dd === 0) return;
    const update: NoteUpdate[] = [];
    for (const id of ids) {
      const n = byId.get(id);
      if (n) update.push({ noteId: id, patch: { startBeat: n.startBeat + dd } });
    }
    if (update.length > 0) void editNotes(c.id, { update });
  };

  const deleteSelected = () => {
    const c = clipRef.current;
    const sel = currentSelIn(c);
    if (sel.length === 0) return;
    void editNotes(c.id, { remove: sel });
    setNoteSelection([]);
  };

  const duplicateSelected = () => {
    const c = clipRef.current;
    const sel = currentSelIn(c);
    if (sel.length === 0) return;
    const byId = new Map(c.notes.map((n) => [n.id, n]));
    const add: NoteInput[] = [];
    for (const id of sel) {
      const n = byId.get(id);
      if (!n) continue;
      add.push({
        id: tempId(),
        pitch: n.pitch,
        velocity: n.velocity,
        startBeat: n.startBeat + n.lengthBeats,
        lengthBeats: n.lengthBeats,
        ...(n.channel !== undefined ? { channel: n.channel } : {}),
      });
    }
    if (add.length > 0) void editNotes(c.id, { add });
  };

  const selectAll = () => {
    setNoteSelection(clipRef.current.notes.map((n) => n.id));
  };

  const doQuantize = () => {
    const c = clipRef.current;
    const sel = currentSelIn(c);
    void quantizeNotes(
      c.id,
      stepRef.current,
      strengthPct / 100,
      swingPct / 100,
      sel.length > 0 ? sel : undefined, // selected-or-all (brief)
    );
  };

  const quantizeAll = () => {
    void quantizeNotes(clipRef.current.id, stepRef.current, strengthPct / 100, swingPct / 100);
  };

  /* ---- gesture cancel (Esc during a drag) ---- */
  const cancelGesture = (): boolean => {
    const g = gestureRef.current;
    if (!g) return false;
    gestureRef.current = null;
    previewOff();
    hideDragHud();
    if (g.kind === "marquee") setNoteSelection(g.prevSel);
    else if (g.kind === "ccMarquee") ccSelRef.current = g.prevSel;
    requestDraw();
    return true;
  };

  /* stable api for []-effects (keyboard context, escape listener) */
  const apiRef = useRef({ cancelGesture, transposeSelected, transposeSelectedInScale, nudgeSelected, currentSelIn, deleteSelected });
  apiRef.current = { cancelGesture, transposeSelected, transposeSelectedInScale, nudgeSelected, currentSelIn, deleteSelected };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gestureRef.current) {
        e.preventDefault();
        e.stopPropagation();
        apiRef.current.cancelGesture();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /* ---- zoom (center-anchored) — shared by the G/H key context and the toolbar
   * buttons. Only stable refs are captured, so the once-registered key context can
   * safely call the first-render instances. ---- */
  const zoomHBy = (factor: number): void => {
    const el = notesCv.canvasRef.current;
    const v = viewRef.current;
    const cx = el ? el.clientWidth / 2 : 0;
    const beat = (v.scrollX + cx) / v.zoomX;
    v.zoomX = M.clamp(v.zoomX * factor, M.MIN_ZOOM_X, M.MAX_ZOOM_X);
    v.scrollX = beat * v.zoomX - cx;
    clampViewRef.current();
    requestDraw();
  };
  const zoomVBy = (factor: number): void => {
    const el = notesCv.canvasRef.current;
    const v = viewRef.current;
    const cy = el ? el.clientHeight / 2 : 0;
    const row = (v.scrollY + cy) / v.rowH;
    v.rowH = M.clamp(Math.round(v.rowH * factor), M.MIN_ROW_H, M.MAX_ROW_H);
    v.scrollY = row * v.rowH - cy;
    clampViewRef.current();
    requestDraw();
  };

  /* ---- keyboard context (lib/keyboard.ts, U2) ----
   * NOTE(spec): assumed contract — registerKeyContext(name, handler) registers a
   * bubble-phase handler consulted by the global shortcut manager (inert while inputs /
   * menus / modals are focused); handler returns true when it consumed the event; the
   * call returns an unsubscribe function. */
  useEffect(() => {
    const ctx = () => {
      const st = useStore.getState();
      // Visible = dock tab active OR popped out into its own window — a popped-out
      // piano roll must keep its note-level handlers even with the dock on Mixer.
      if (!paneVisible(st.panels, "pianoRoll")) return null;
      const api = apiRef.current;
      const c = clipRef.current;
      return { st, api, c, sel: api.currentSelIn(c) };
    };
    const unregister = registerKeyContext("pianoRoll", {
      selectAll: () => {
        const x = ctx();
        if (x) x.st.setSelection({ noteIds: x.c.notes.map((n) => n.id) });
      },
      escape: () => {
        const x = ctx();
        if (!x) return false;
        if (x.api.cancelGesture()) return true;
        if (x.st.selection.noteIds.length > 0) {
          x.st.setSelection({ noteIds: [] });
          return true;
        }
        return false;
      },
      deleteSelection: () => {
        const x = ctx();
        if (x && x.sel.length > 0) x.api.deleteSelected();
      },
      // G/H zoom, routed here while the piano roll is the focused pane. Mutates the
      // LOCAL viewRef (center-anchored); clampView persists module-level zoom.
      zoomH: (factor) => {
        if (!ctx()) return false;
        zoomHBy(factor);
        return true;
      },
      zoomV: (factor) => {
        if (!ctx()) return false;
        zoomVBy(factor);
        return true;
      },
      // Arrows: ↑/↓ transpose a semitone (Shift = octave), ←/→ move by the grid step
      // (Shift = fine ¼ step). Routed through the shared context so only ONE pane
      // ever edits per keypress (a timeline clip nudge can't also transpose notes).
      nudge: (dx, dy, big) => {
        const x = ctx();
        if (!x || x.sel.length === 0) return false;
        if (dy !== 0) {
          const sc = scaleRef.current;
          if (!big && sc.snap && sc.pcs) {
            x.api.transposeSelectedInScale(x.sel, -dy as 1 | -1, sc.pcs);
          } else {
            x.api.transposeSelected(x.sel, -dy * (big ? 12 : 1));
          }
          return true;
        }
        if (dx !== 0) {
          const step = big ? stepRef.current / 4 : stepRef.current;
          x.api.nudgeSelected(x.sel, dx * step);
          return true;
        }
        return false;
      },
      // F — fit the whole clip horizontally (vertical stays put; content scroll is
      // already handled per clip on open).
      zoomToFit: () => {
        if (!ctx()) return false;
        const el = notesCv.canvasRef.current;
        if (!el || el.clientWidth <= 0) return false;
        const v = viewRef.current;
        const span = Math.max(1, M.contentBeats(clipRef.current));
        v.zoomX = M.clamp(el.clientWidth / (span + M.SCROLL_MARGIN_BEATS), M.MIN_ZOOM_X, M.MAX_ZOOM_X);
        v.scrollX = 0;
        clampViewRef.current();
        requestDraw();
        return true;
      },
    });
    return unregister;
  }, []);

  /* ---- wheel (non-passive; ctrl=h-zoom, alt=v-zoom, shift=h-scroll, plain=v-scroll) ---- */
  useEffect(() => {
    const nEl = notesCv.canvasRef.current;
    const kEl = keysCv.canvasRef.current;
    const rEl = rulerCv.canvasRef.current;
    if (!nEl) return;

    const hZoom = (e: WheelEvent, el: HTMLElement) => {
      const v = viewRef.current;
      const px = e.clientX - el.getBoundingClientRect().left;
      const beat = (v.scrollX + px) / v.zoomX;
      v.zoomX = M.clamp(v.zoomX * Math.pow(1.25, -e.deltaY / 100), M.MIN_ZOOM_X, M.MAX_ZOOM_X);
      v.scrollX = beat * v.zoomX - px;
    };
    const vZoom = (e: WheelEvent, el: HTMLElement) => {
      const v = viewRef.current;
      const py = e.clientY - el.getBoundingClientRect().top;
      const row = (v.scrollY + py) / v.rowH;
      v.rowH = M.clamp(v.rowH + (e.deltaY < 0 ? 1 : -1), M.MIN_ROW_H, M.MAX_ROW_H);
      v.scrollY = row * v.rowH - py;
    };

    const onNotesWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) hZoom(e, nEl);
      else if (e.altKey) vZoom(e, nEl);
      else if (e.shiftKey) v.scrollX += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      else {
        v.scrollY += e.deltaY;
        v.scrollX += e.deltaX;
      }
      clampViewRef.current();
      requestDraw();
    };
    const onKeysWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.altKey && kEl) vZoom(e, kEl);
      else viewRef.current.scrollY += e.deltaY;
      clampViewRef.current();
      requestDraw();
    };
    const onRulerWheel = (e: WheelEvent) => {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && rEl) hZoom(e, rEl);
      else viewRef.current.scrollX += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      clampViewRef.current();
      requestDraw();
    };

    nEl.addEventListener("wheel", onNotesWheel, { passive: false });
    kEl?.addEventListener("wheel", onKeysWheel, { passive: false });
    rEl?.addEventListener("wheel", onRulerWheel, { passive: false });
    return () => {
      nEl.removeEventListener("wheel", onNotesWheel);
      kEl?.removeEventListener("wheel", onKeysWheel);
      rEl?.removeEventListener("wheel", onRulerWheel);
    };
  }, [requestDraw]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!laneOn) return;
    const el = velCv.canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const px = e.clientX - el.getBoundingClientRect().left;
        const beat = (v.scrollX + px) / v.zoomX;
        v.zoomX = M.clamp(v.zoomX * Math.pow(1.25, -e.deltaY / 100), M.MIN_ZOOM_X, M.MAX_ZOOM_X);
        v.scrollX = beat * v.zoomX - px;
      } else {
        v.scrollX += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      }
      clampViewRef.current();
      requestDraw();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [laneOn, requestDraw]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ====================================================================== *
   * Notes canvas interactions
   * ====================================================================== */

  /** One-shot note add (context menu) — same geometry/length/id rules as the create
   *  gesture (which also does not select the new note). */
  const addNoteAt = (x: number, y: number) => {
    const v = viewRef.current;
    const c = clipRef.current;
    const step = stepRef.current;
    void editNotes(c.id, {
      add: [
        {
          id: tempId(),
          pitch: pitchAt(y),
          velocity: lastVelRef.current,
          startBeat: Math.max(0, M.snapFloor(M.xToBeat(x, v), step)),
          lengthBeats: Math.max(M.MIN_NOTE_LEN, drawLenRef.current ?? step),
        },
      ],
    });
  };

  const startCreate = (x: number, y: number) => {
    const v = viewRef.current;
    const step = stepRef.current;
    const startBeat = Math.max(0, M.snapFloor(M.xToBeat(x, v), step));
    const len = Math.max(M.MIN_NOTE_LEN, drawLenRef.current ?? step);
    const pitch = pitchAt(y);
    gestureRef.current = {
      kind: "create",
      note: {
        id: tempId(),
        pitch,
        velocity: lastVelRef.current,
        startBeat,
        lengthBeats: len,
      },
    };
    if (auditionRef.current) previewOn(pitch, lastVelRef.current);
  };

  const beginNoteDrag = (hit: M.NoteHit, e: React.PointerEvent, x: number, y: number) => {
    const c = clipRef.current;
    const sel = currentSelIn(c);
    const prevSel = useStore.getState().selection.noteIds;
    const isSelected = sel.includes(hit.note.id);

    if (hit.edge) {
      const ids = isSelected ? sel : [hit.note.id];
      if (!isSelected) setNoteSelection([hit.note.id]);
      gestureRef.current = {
        kind: "resize",
        ids,
        idSet: new Set(ids),
        anchorId: hit.note.id,
        anchorStart: hit.note.startBeat,
        anchorLen: hit.note.lengthBeats,
        startX: x,
        dLen: 0,
      };
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // ctrl-click toggles membership; no drag follows
      setNoteSelection(
        isSelected ? sel.filter((id) => id !== hit.note.id) : [...sel, hit.note.id],
      );
      gestureRef.current = null;
      return;
    }
    let ids: number[];
    if (e.shiftKey) {
      ids = isSelected ? sel : [...sel, hit.note.id];
      setNoteSelection(ids);
    } else if (!isSelected) {
      ids = [hit.note.id];
      setNoteSelection(ids);
    } else {
      ids = sel;
    }
    gestureRef.current = {
      kind: "move",
      ids,
      idSet: new Set(ids),
      copy: e.altKey,
      anchorId: hit.note.id,
      anchorStart: hit.note.startBeat,
      anchorPitch: hit.note.pitch,
      anchorVel: hit.note.velocity,
      startX: x,
      startY: y,
      startPitch: M.yToPitch(y, viewRef.current),
      dBeat: 0,
      dPitch: 0,
      movedPx: 0,
      collapseTo: !e.shiftKey && isSelected && sel.length > 1 ? hit.note.id : null,
      prevSel,
    };
    if (auditionRef.current) previewOn(hit.note.pitch, hit.note.velocity);
  };

  const onNotesDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    if (e.button === 1) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const v = viewRef.current;
      gestureRef.current = { kind: "pan", startX: e.clientX, startY: e.clientY, sx: v.scrollX, sy: v.scrollY };
      el.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    const { x, y } = localPt(e);
    const c = clipRef.current;
    const t = toolRef.current;
    const hit = M.hitTestNote(c.notes, x, y, viewRef.current);

    if (t === "erase") {
      const ids = new Set<number>();
      if (hit) ids.add(hit.note.id);
      gestureRef.current = { kind: "erase", ids };
      requestDraw();
      return;
    }
    if (!hit && t === "draw") {
      startCreate(x, y);
      requestDraw();
      return;
    }
    if (hit) {
      // draw tool on an existing note behaves like select (move / edge-resize)
      beginNoteDrag(hit, e, x, y);
      requestDraw();
      return;
    }

    // empty space with select tool (split has no piano-roll role → treated as select)
    const now = performance.now();
    const lc = lastClickRef.current;
    if (lc && now - lc.t < 350 && Math.abs(x - lc.x) < 6 && Math.abs(y - lc.y) < 6) {
      // manual double-click: create + drag a new note (brief: dbl-click in select mode)
      lastClickRef.current = null;
      startCreate(x, y);
      requestDraw();
      return;
    }
    lastClickRef.current = { t: now, x, y };
    const prevSel = useStore.getState().selection.noteIds;
    const mode = e.ctrlKey || e.metaKey ? "xor" : e.shiftKey ? "union" : "replace";
    if (mode === "replace" && prevSel.length > 0) setNoteSelection([]);
    gestureRef.current = {
      kind: "marquee",
      x0: x,
      y0: y,
      x1: x,
      y1: y,
      base: mode === "replace" ? [] : currentSelIn(c),
      mode,
      prevSel,
      lastKey: "",
    };
    requestDraw();
  };

  const applyMarquee = (g: MarqueeGesture) => {
    const c = clipRef.current;
    const v = viewRef.current;
    const inside: number[] = [];
    for (const n of c.notes) {
      if (M.noteInRect(n, g.x0, g.y0, g.x1, g.y1, v)) inside.push(n.id);
    }
    let result: number[];
    if (g.mode === "union") {
      const set = new Set(g.base);
      for (const id of inside) set.add(id);
      result = [...set];
    } else if (g.mode === "xor") {
      const set = new Set(g.base);
      for (const id of inside) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      result = [...set];
    } else {
      result = inside;
    }
    const key = result
      .slice()
      .sort((a, b) => a - b)
      .join(",");
    if (key !== g.lastKey) {
      g.lastKey = key;
      setNoteSelection(result);
    }
  };

  const onNotesMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const { x, y } = localPt(e);
    const g = gestureRef.current;
    const v = viewRef.current;
    const c = clipRef.current;

    if (!g) {
      hideDragHud();
      const t = toolRef.current;
      let cursor = t === "draw" ? "crosshair" : "default";
      const hit = M.hitTestNote(c.notes, x, y, v);
      if (hit) cursor = t === "erase" ? "pointer" : hit.edge ? "ew-resize" : "move";
      el.style.cursor = cursor;
      return;
    }

    switch (g.kind) {
      case "pan": {
        v.scrollX = g.sx - (e.clientX - g.startX);
        v.scrollY = g.sy - (e.clientY - g.startY);
        clampViewRef.current();
        break;
      }
      case "marquee": {
        g.x1 = x;
        g.y1 = y;
        applyMarquee(g);
        break;
      }
      case "move": {
        const step = stepRef.current;
        const rawD = (x - g.startX) / v.zoomX;
        let dBeat = M.snapRound(g.anchorStart + rawD, step) - g.anchorStart;
        let dPitch = M.yToPitch(y, v) - g.startPitch;
        let minStart = Infinity;
        let minP = M.MAX_PITCH;
        let maxP = 0;
        for (const n of c.notes) {
          if (!g.idSet.has(n.id)) continue;
          minStart = Math.min(minStart, n.startBeat);
          minP = Math.min(minP, n.pitch);
          maxP = Math.max(maxP, n.pitch);
        }
        if (Number.isFinite(minStart)) dBeat = Math.max(dBeat, -minStart);
        dPitch = M.clamp(dPitch, -minP, M.MAX_PITCH - maxP);
        g.movedPx = Math.max(g.movedPx, Math.abs(x - g.startX), Math.abs(y - g.startY));
        g.dBeat = dBeat;
        g.dPitch = dPitch;
        if (auditionRef.current) previewOn(g.anchorPitch + dPitch, g.anchorVel);
        {
          const pitch = M.clamp(g.anchorPitch + dPitch, 0, M.MAX_PITCH);
          const pos = barsBeatsShort(c.startBeat + Math.max(0, g.anchorStart + dBeat));
          const st = dPitch !== 0 ? ` · ${dPitch > 0 ? "+" : ""}${dPitch} st` : "";
          showDragHud(
            e.clientX,
            e.clientY,
            `${M.pitchName(pitch)}${st}${pos ? ` · ${pos}` : ""}${g.copy ? " · copy" : ""}`,
          );
        }
        break;
      }
      case "resize": {
        const step = stepRef.current;
        const rawD = (x - g.startX) / v.zoomX;
        const end0 = g.anchorStart + g.anchorLen;
        let dLen = M.snapRound(end0 + rawD, step) - end0;
        dLen = Math.max(dLen, M.MIN_NOTE_LEN - g.anchorLen);
        g.dLen = dLen;
        showDragHud(e.clientX, e.clientY, M.lengthLabel(g.anchorLen + dLen));
        break;
      }
      case "create": {
        const step = stepRef.current;
        g.note.pitch = M.yToPitch(y, v);
        const end = M.snapCeil(M.xToBeat(x, v), step);
        g.note.lengthBeats = Math.max(step > 0 ? step : M.MIN_NOTE_LEN, end - g.note.startBeat);
        if (auditionRef.current) previewOn(g.note.pitch, g.note.velocity);
        showDragHud(
          e.clientX,
          e.clientY,
          `${M.pitchName(g.note.pitch)} · ${M.lengthLabel(g.note.lengthBeats)}`,
        );
        break;
      }
      case "erase": {
        const hit = M.hitTestNote(c.notes, x, y, v);
        if (hit) g.ids.add(hit.note.id);
        break;
      }
      case "velocity":
        break; // velocity gestures live on the velocity-lane canvas
    }
    requestDraw();
  };

  /** Commit = ONE cmd/notes.edit per gesture; store updates arrive via engine echo. */
  const commitGesture = (g: Gesture) => {
    const c = clipRef.current;
    const byId = new Map(c.notes.map((n) => [n.id, n]));
    switch (g.kind) {
      case "move": {
        if (g.dBeat === 0 && g.dPitch === 0) {
          if (g.collapseTo !== null && g.movedPx <= 3) setNoteSelection([g.collapseTo]);
          return;
        }
        if (g.copy) {
          const add: NoteInput[] = [];
          for (const id of g.ids) {
            const n = byId.get(id);
            if (!n) continue;
            add.push({
              id: tempId(),
              pitch: M.clamp(n.pitch + g.dPitch, 0, M.MAX_PITCH),
              velocity: n.velocity,
              startBeat: Math.max(0, n.startBeat + g.dBeat),
              lengthBeats: n.lengthBeats,
              ...(n.channel !== undefined ? { channel: n.channel } : {}),
            });
          }
          if (add.length > 0) void editNotes(c.id, { add });
        } else {
          const update: NoteUpdate[] = [];
          for (const id of g.ids) {
            const n = byId.get(id);
            if (!n) continue;
            const patch: { pitch?: number; startBeat?: number } = {};
            if (g.dPitch !== 0) patch.pitch = M.clamp(n.pitch + g.dPitch, 0, M.MAX_PITCH);
            if (g.dBeat !== 0) patch.startBeat = Math.max(0, n.startBeat + g.dBeat);
            update.push({ noteId: id, patch });
          }
          if (update.length > 0) void editNotes(c.id, { update });
        }
        return;
      }
      case "resize": {
        if (g.dLen === 0) return;
        const update: NoteUpdate[] = [];
        let anchorFinal = g.anchorLen;
        for (const id of g.ids) {
          const n = byId.get(id);
          if (!n) continue;
          const len = Math.max(M.MIN_NOTE_LEN, n.lengthBeats + g.dLen);
          if (id === g.anchorId) anchorFinal = len;
          if (len !== n.lengthBeats) update.push({ noteId: id, patch: { lengthBeats: len } });
        }
        if (update.length > 0) {
          void editNotes(c.id, { update });
          setDrawLen(anchorFinal); // resized length becomes the new draw length
        }
        return;
      }
      case "create": {
        const note = g.note;
        void editNotes(c.id, {
          add: [
            {
              id: note.id,
              pitch: note.pitch,
              velocity: note.velocity,
              startBeat: note.startBeat,
              lengthBeats: note.lengthBeats,
            },
          ],
        });
        setDrawLen(note.lengthBeats);
        return;
      }
      case "erase": {
        if (g.ids.size === 0) return;
        void editNotes(c.id, { remove: [...g.ids] });
        setNoteSelection(useStore.getState().selection.noteIds.filter((id) => !g.ids.has(id)));
        return;
      }
      case "velocity": {
        const update: NoteUpdate[] = [];
        for (const [id, vel] of g.overrides) {
          const n = byId.get(id);
          if (n && n.velocity !== vel) update.push({ noteId: id, patch: { velocity: vel } });
        }
        if (update.length > 0) void editNotes(c.id, { update });
        lastVelRef.current = g.lastVel;
        return;
      }

      /* ---- CC lane (each = ONE cmd/cc.edit = one undo entry) ---- */
      case "ccMove": {
        const ctl = laneCtlRef.current;
        if (ctl === null) return;
        if (g.dBeat === 0 && g.dValue === 0) {
          if (g.collapseTo !== null && g.movedPx <= 3) ccSelRef.current = [g.collapseTo];
          return;
        }
        const ccById = new Map(M.ccLanePoints(c.cc, ctl).map((p) => [p.id, p]));
        const update: CcUpdate[] = [];
        for (const id of g.ids) {
          const p = ccById.get(id);
          if (!p) continue;
          update.push({
            ccId: id,
            patch: {
              beat: Math.max(0, p.beat + g.dBeat),
              value: M.clamp(p.value + g.dValue, 0, 1),
            },
          });
        }
        if (update.length > 0) void editCc(c.id, { update });
        return;
      }
      case "ccMarquee": {
        const ctl = laneCtlRef.current;
        // plain click (no drag) on empty lane = add a point at the snapped beat
        if (ctl !== null && g.movedPx <= 3) {
          void editCc(c.id, {
            add: [{ controller: ctl, beat: g.addAt.beat, value: g.addAt.value }],
          });
        }
        return;
      }
      case "ccDraw": {
        if (g.stream.size === 0) return;
        const pts = M.ccLanePoints(c.cc, g.controller);
        const remove = pts
          .filter((p) => p.beat >= g.lo - 1e-9 && p.beat <= g.hi + 1e-9)
          .map((p) => p.id);
        const add = [...g.stream.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([k, value]) => ({ controller: g.controller, beat: Math.max(0, k * g.qStep), value }));
        void editCc(c.id, { add, ...(remove.length > 0 ? { remove } : {}) });
        return;
      }
      case "ccErase": {
        if (g.ids.size === 0) return;
        void editCc(c.id, { remove: [...g.ids] });
        ccSelRef.current = ccSelRef.current.filter((id) => !g.ids.has(id));
        return;
      }

      case "marquee":
      case "pan":
        return;
    }
  };

  const onNotesUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const g = gestureRef.current;
    if (!g) return;
    gestureRef.current = null;
    previewOff();
    hideDragHud();
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (g.kind === "pan") {
      el.style.cursor = "default";
    } else {
      commitGesture(g);
    }
    requestDraw();
  };

  const onNotesCancel = () => {
    cancelGesture();
  };

  const onNotesContext = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = localPt(e);
    const c = clipRef.current;
    const hit = M.hitTestNote(c.notes, x, y, viewRef.current);
    if (hit && !useStore.getState().selection.noteIds.includes(hit.note.id)) {
      setNoteSelection([hit.note.id]);
    }
    // Cubase-style toolbox on empty space (split has no piano-roll role — omitted).
    const s = useStore.getState();
    const tools: MenuEntry[] = (
      [
        { tool: "select", label: "Select", icon: "pointer", shortcut: "1" },
        { tool: "draw", label: "Draw", icon: "pencil", shortcut: "2" },
        { tool: "erase", label: "Erase", icon: "eraser", shortcut: "3" },
      ] as const
    ).map((t) => ({
      label: t.label,
      icon: t.icon,
      shortcut: t.shortcut,
      checked: s.tool === t.tool,
      onClick: () => useStore.getState().setTool(t.tool),
    }));
    // MIDI functions run on the selection AT CLICK TIME (the hit note was selected
    // above if it wasn't already) — pure math from lib/midiFunctions via editNotes.
    const applyFn = (fn: (notes: Note[]) => MF.NotesPatch): void => {
      const cc = clipRef.current;
      const ids = new Set(useStore.getState().selection.noteIds);
      const notes = cc.notes.filter((n) => ids.has(n.id));
      if (notes.length === 0) return;
      const patch = fn(notes);
      if ((patch.update?.length ?? 0) > 0 || (patch.remove?.length ?? 0) > 0) {
        void editNotes(cc.id, patch);
      }
    };
    const fnItems: MenuEntry[] = [
      { label: "Legato", title: "Extend each note to the next onset", onClick: () => applyFn(MF.legato) },
      {
        label: "Fixed Length (grid step)",
        onClick: () => applyFn((ns) => MF.fixedLength(ns, stepRef.current)),
      },
      { label: "Reverse", title: "Mirror the selection in time", onClick: () => applyFn(MF.reverse) },
      { label: "Delete Doubles", title: "Remove notes with identical pitch + position", onClick: () => applyFn(MF.deleteDoubles) },
      "separator",
      {
        label: "Humanize Timing",
        title: "Random start offsets within ±⅛ grid step",
        onClick: () => applyFn((ns) => MF.humanizeTiming(ns, stepRef.current / 8)),
      },
      {
        label: "Humanize Velocity",
        title: "Random velocity offsets within ±10",
        onClick: () => applyFn((ns) => MF.humanizeVelocity(ns, 10)),
      },
      "separator",
      { label: "Velocity +10", onClick: () => applyFn((ns) => MF.scaleVelocity(ns, 1, 10)) },
      { label: "Velocity −10", onClick: () => applyFn((ns) => MF.scaleVelocity(ns, 1, -10)) },
      "separator",
      { label: "Transpose +12", shortcut: "Shift+↑", onClick: () => applyFn((ns) => MF.transpose(ns, 12)) },
      { label: "Transpose −12", shortcut: "Shift+↓", onClick: () => applyFn((ns) => MF.transpose(ns, -12)) },
    ];
    const items: MenuEntry[] = hit
      ? [
          { label: "Duplicate", icon: "plus", onClick: duplicateSelected },
          { label: "Quantize", icon: "magnet", shortcut: "Q", onClick: doQuantize },
          { label: "Functions", icon: "sliders", submenu: fnItems },
          "separator",
          { label: "Delete", icon: "trash", danger: true, shortcut: "Del", onClick: deleteSelected },
        ]
      : [
          ...tools,
          "separator",
          {
            label: "Add Note Here",
            icon: "plus",
            title: "Draw tool (2) drags notes; select-tool double-click adds one too",
            onClick: () => addNoteAt(x, y),
          },
          "separator",
          {
            label: "Select All",
            shortcut: "Ctrl+A",
            disabled: c.notes.length === 0,
            onClick: selectAll,
          },
          {
            label: "Quantize All",
            icon: "magnet",
            disabled: c.notes.length === 0,
            onClick: quantizeAll,
          },
        ];
    openContextMenu(e.clientX, e.clientY, items);
  };

  /* ====================================================================== *
   * Keys column — press visual + note audition (midi/preview, velocity 100)
   * ====================================================================== */

  const onKeysDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = M.yToPitch(localPt(e).y, viewRef.current);
    pressedKeyRef.current = p;
    previewOn(p, 100);
    requestDraw();
  };
  const onKeysMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pressedKeyRef.current === null) return;
    const p = M.yToPitch(localPt(e).y, viewRef.current);
    if (p !== pressedKeyRef.current) {
      pressedKeyRef.current = p;
      previewOn(p, 100); // glissando: retrigger on the new key
      requestDraw();
    }
  };
  const onKeysUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pressedKeyRef.current === null) return;
    pressedKeyRef.current = null;
    previewOff();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    requestDraw();
  };

  /* ====================================================================== *
   * Ruler — click/drag seeks the transport (absolute beats)
   * ====================================================================== */

  const seekingRef = useRef(false);
  const lastSeekRef = useRef<number | null>(null);

  const rulerSeek = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x } = localPt(e);
    const c = clipRef.current;
    const local = Math.max(0, M.snapRound(M.xToBeat(x, viewRef.current), stepRef.current));
    const abs = Math.max(0, c.startBeat + local);
    if (abs !== lastSeekRef.current) {
      lastSeekRef.current = abs;
      void locate(abs);
    }
  };
  const onRulerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekingRef.current = true;
    lastSeekRef.current = null;
    rulerSeek(e);
  };
  const onRulerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (seekingRef.current) rulerSeek(e);
  };
  const onRulerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    seekingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  /* ====================================================================== *
   * Velocity lane — drag sets velocity; one update gesture per drag
   * ====================================================================== */

  // Exact inverse of drawVelLane's bar geometry (M.velToY) — clicking at a y maps to the
  // velocity whose bar top sits there, instead of an offset from the visual bar.
  const velFromY = (y: number, h: number) => M.velYToVel(y, h);

  const velHit = (notesArr: Note[], x: number): number | null => {
    const v = viewRef.current;
    const bw = M.velBarW(v.zoomX);
    const tol = Math.max(4, bw);
    let best: number | null = null;
    let bd = tol + 1;
    for (const n of notesArr) {
      const d = Math.abs(M.beatToX(n.startBeat, v) + bw / 2 - x);
      if (d < bd) {
        bd = d;
        best = n.id;
      }
    }
    return bd <= tol ? best : null;
  };

  const applyVelGesture = (g: VelGesture, x: number, y: number, h: number) => {
    const c = clipRef.current;
    const v = viewRef.current;
    const vel = velFromY(y, h);
    g.lastVel = vel;
    if (g.mode === "selected") {
      for (const id of g.selIds) g.overrides.set(id, vel);
    } else {
      // paint: every bar the pointer sweeps over takes the current value
      const tol = Math.max(4, M.velBarW(v.zoomX));
      const lo = Math.min(g.lastX, x) - tol;
      const hi = Math.max(g.lastX, x) + tol;
      for (const n of c.notes) {
        const nx = M.beatToX(n.startBeat, v);
        if (nx >= lo && nx <= hi) g.overrides.set(n.id, vel);
      }
    }
    g.lastX = x;
  };

  const onVelDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const { x, y } = localPt(e);
    const c = clipRef.current;
    const selIds = new Set(currentSelIn(c));
    const hitId = velHit(c.notes, x);
    const mode: VelGesture["mode"] = hitId !== null && selIds.has(hitId) ? "selected" : "paint";
    const g: VelGesture = {
      kind: "velocity",
      overrides: new Map(),
      mode,
      selIds,
      lastX: x,
      lastVel: lastVelRef.current,
    };
    gestureRef.current = g;
    applyVelGesture(g, x, y, el.clientHeight);
    requestDraw();
  };
  const onVelMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current;
    if (!g || g.kind !== "velocity") return;
    const { x, y } = localPt(e);
    applyVelGesture(g, x, y, e.currentTarget.clientHeight);
    requestDraw();
  };
  const onVelUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current;
    if (!g || g.kind !== "velocity") return;
    gestureRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    commitGesture(g);
    requestDraw();
  };

  /* ====================================================================== *
   * CC / pitch-bend lane — points + step-line; click adds, drag moves,
   * marquee multi-selects, pencil draws a dense stream, erase/right-click
   * deletes. Every gesture commits as ONE cmd/cc.edit.
   * ====================================================================== */

  const ccPointsNow = (): MidiCc[] =>
    M.ccLanePoints(clipRef.current.cc, laneCtlRef.current ?? -1);

  const currentCcSel = (pts: MidiCc[]): number[] => {
    const ids = new Set(pts.map((p) => p.id));
    return ccSelRef.current.filter((id) => ids.has(id));
  };

  const applyCcMarquee = (g: CcMarqueeGesture, laneH: number) => {
    const v = viewRef.current;
    const lx = Math.min(g.x0, g.x1);
    const hx = Math.max(g.x0, g.x1);
    const ly = Math.min(g.y0, g.y1);
    const hy = Math.max(g.y0, g.y1);
    const inside: number[] = [];
    for (const p of ccPointsNow()) {
      const px = M.beatToX(p.beat, v);
      const py = M.ccValueToY(p.value, laneH);
      if (px >= lx && px <= hx && py >= ly && py <= hy) inside.push(p.id);
    }
    if (g.mode === "union") {
      const set = new Set(g.base);
      for (const id of inside) set.add(id);
      ccSelRef.current = [...set];
    } else if (g.mode === "xor") {
      const set = new Set(g.base);
      for (const id of inside) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      ccSelRef.current = [...set];
    } else {
      ccSelRef.current = inside;
    }
  };

  const onCcDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const { x, y } = localPt(e);
    const h = el.clientHeight;
    const v = viewRef.current;
    const pts = ccPointsNow();
    const t = toolRef.current;

    if (t === "erase") {
      const hit = M.hitTestCcPoint(pts, x, y, v, h);
      const ids = new Set<number>();
      if (hit) ids.add(hit.id);
      gestureRef.current = { kind: "ccErase", ids };
      requestDraw();
      return;
    }
    if (t === "draw") {
      // pencil: dense stream at grid/8 granularity
      const qStep = Math.max(stepRef.current / 8, 1e-3);
      const beat = Math.max(0, M.xToBeat(x, v));
      const key = Math.round(beat / qStep);
      const value = M.ccYToValue(y, h);
      gestureRef.current = {
        kind: "ccDraw",
        controller: laneCtlRef.current ?? 0,
        qStep,
        stream: new Map([[key, value]]),
        lo: key * qStep,
        hi: key * qStep,
        lastBeat: beat,
        lastValue: value,
      };
      requestDraw();
      return;
    }

    const hit = M.hitTestCcPoint(pts, x, y, v, h);
    const sel = currentCcSel(pts);
    if (hit) {
      const isSelected = sel.includes(hit.id);
      let ids: number[];
      if (e.shiftKey) ids = isSelected ? sel : [...sel, hit.id];
      else if (!isSelected) ids = [hit.id];
      else ids = sel;
      ccSelRef.current = ids;
      gestureRef.current = {
        kind: "ccMove",
        ids,
        idSet: new Set(ids),
        anchorBeat: hit.beat,
        startX: x,
        startY: y,
        dBeat: 0,
        dValue: 0,
        movedPx: 0,
        collapseTo: !e.shiftKey && isSelected && sel.length > 1 ? hit.id : null,
      };
      requestDraw();
      return;
    }

    // empty lane: drag = marquee select; plain click (no drag) = add point on release
    const mode: CcMarqueeGesture["mode"] =
      e.ctrlKey || e.metaKey ? "xor" : e.shiftKey ? "union" : "replace";
    const prevSel = ccSelRef.current;
    if (mode === "replace") ccSelRef.current = [];
    gestureRef.current = {
      kind: "ccMarquee",
      x0: x,
      y0: y,
      x1: x,
      y1: y,
      base: mode === "replace" ? [] : sel,
      mode,
      prevSel,
      addAt: {
        beat: Math.max(0, M.snapRound(M.xToBeat(x, v), stepRef.current)),
        value: M.ccYToValue(y, h),
      },
      movedPx: 0,
    };
    requestDraw();
  };

  const onCcMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const { x, y } = localPt(e);
    const h = el.clientHeight;
    const v = viewRef.current;
    const g = gestureRef.current;

    if (!g) {
      const t = toolRef.current;
      const hit = M.hitTestCcPoint(ccPointsNow(), x, y, v, h);
      el.style.cursor = hit ? (t === "erase" ? "pointer" : "move") : "crosshair";
      return;
    }

    switch (g.kind) {
      case "ccMove": {
        const step = stepRef.current;
        const rawD = (x - g.startX) / v.zoomX;
        let dBeat = M.snapRound(g.anchorBeat + rawD, step) - g.anchorBeat;
        let minBeat = Infinity;
        for (const p of ccPointsNow()) {
          if (g.idSet.has(p.id)) minBeat = Math.min(minBeat, p.beat);
        }
        if (Number.isFinite(minBeat)) dBeat = Math.max(dBeat, -minBeat);
        g.dBeat = dBeat;
        g.dValue = (g.startY - y) / Math.max(1, h - 8);
        g.movedPx = Math.max(g.movedPx, Math.abs(x - g.startX), Math.abs(y - g.startY));
        break;
      }
      case "ccMarquee": {
        g.x1 = x;
        g.y1 = y;
        g.movedPx = Math.max(g.movedPx, Math.abs(x - g.x0), Math.abs(y - g.y0));
        applyCcMarquee(g, h);
        break;
      }
      case "ccDraw": {
        const beat = Math.max(0, M.xToBeat(x, v));
        const value = M.ccYToValue(y, h);
        const k0 = Math.round(g.lastBeat / g.qStep);
        const k1 = Math.round(beat / g.qStep);
        if (k0 === k1) {
          g.stream.set(k1, value);
        } else {
          const dir = k1 > k0 ? 1 : -1;
          for (let k = k0; k !== k1 + dir; k += dir) {
            const f = (k - k0) / (k1 - k0);
            g.stream.set(k, g.lastValue + (value - g.lastValue) * f);
          }
        }
        g.lo = Math.min(g.lo, k1 * g.qStep);
        g.hi = Math.max(g.hi, k1 * g.qStep);
        g.lastBeat = beat;
        g.lastValue = value;
        break;
      }
      case "ccErase": {
        const hit = M.hitTestCcPoint(ccPointsNow(), x, y, v, h);
        if (hit) g.ids.add(hit.id);
        break;
      }
      default:
        return;
    }
    requestDraw();
  };

  const onCcUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current;
    if (!g) return;
    gestureRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    commitGesture(g);
    requestDraw();
  };

  /* lane dispatcher: velocity behaves exactly as before; CC lanes get CC gestures */
  const onLaneDown = (e: React.PointerEvent<HTMLCanvasElement>) =>
    laneCtlRef.current === null ? onVelDown(e) : onCcDown(e);
  const onLaneMove = (e: React.PointerEvent<HTMLCanvasElement>) =>
    laneCtlRef.current === null ? onVelMove(e) : onCcMove(e);
  const onLaneUp = (e: React.PointerEvent<HTMLCanvasElement>) =>
    laneCtlRef.current === null ? onVelUp(e) : onCcUp(e);

  const onLaneContext = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const ctl = laneCtlRef.current;
    if (ctl === null) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { x, y } = localPt(e);
    const hit = M.hitTestCcPoint(ccPointsNow(), x, y, viewRef.current, el.clientHeight);
    if (!hit) return; // empty lane background: no menu
    const laneName = ctl === M.CC_PITCH_BEND ? "Pitch Bend" : `CC${ctl}`;
    openContextMenu(e.clientX, e.clientY, [
      {
        label: "Delete Point",
        icon: "trash",
        danger: true,
        onClick: () => {
          void editCc(clipRef.current.id, { remove: [hit.id] });
          ccSelRef.current = ccSelRef.current.filter((id) => id !== hit.id);
          requestDraw();
        },
      },
      {
        label: "Clear CC Lane…",
        title: `Delete every ${laneName} point in this clip`,
        onClick: () => {
          void (async () => {
            const pts = ccPointsNow();
            if (pts.length === 0) return;
            const ok = await confirmDialog({
              title: `Clear ${laneName} lane`,
              message: `Delete all ${pts.length} ${laneName} point${pts.length === 1 ? "" : "s"} in this clip?`,
              confirmLabel: "Delete",
              danger: true,
            });
            if (!ok) return;
            void editCc(clipRef.current.id, { remove: pts.map((p) => p.id) });
            ccSelRef.current = [];
            requestDraw();
          })();
        },
      },
    ]);
  };

  /* ---- lane selector (dropdown left of the lane; "•" marks lanes with data) ---- */
  const lastOtherRef = useRef(74);

  const pickLane = (ctl: number | null, other: boolean) => {
    setLaneCtl(ctl);
    setOtherMode(other);
    if (other && ctl !== null) lastOtherRef.current = ctl;
    ccSelRef.current = [];
  };

  const openLaneMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const c = clipRef.current;
    const has = new Set((c.cc ?? []).map((p) => p.controller));
    const named = new Set(NAMED_LANES.map((l) => l.controller));
    const dot = (d: boolean) => (d ? "  •" : "");
    const items: MenuEntry[] = [
      {
        label: `Velocity${dot(c.notes.length > 0)}`,
        checked: laneCtl === null,
        onClick: () => pickLane(null, false),
      },
      "separator",
      ...NAMED_LANES.map(
        (l): MenuEntry => ({
          label: `${l.label}${dot(has.has(l.controller))}`,
          checked: !otherMode && laneCtl === l.controller,
          onClick: () => pickLane(l.controller, false),
        }),
      ),
      "separator",
      {
        label: `Other CC#${dot([...has].some((n) => n < M.CC_PITCH_BEND && !named.has(n)))}`,
        checked: otherMode,
        onClick: () => {
          const firstOther = [...has]
            .filter((n) => n < M.CC_PITCH_BEND && !named.has(n))
            .sort((a, b) => a - b)[0];
          pickLane(firstOther ?? lastOtherRef.current, true);
        },
      },
    ];
    openContextMenu(r.left, r.top, items);
  };

  /* ====================================================================== *
   * Render
   * ====================================================================== */

  const selInClip = useMemo(() => {
    const ids = new Set(clip.notes.map((n) => n.id));
    return selectedNoteIds.filter((id) => ids.has(id));
  }, [clip, selectedNoteIds]);

  let lenText = M.lengthLabel(drawLen ?? stepBeats);
  if (selInClip.length === 1) {
    const n = clip.notes.find((nn) => nn.id === selInClip[0]);
    if (n) lenText = M.lengthLabel(n.lengthBeats);
  }

  return (
    <div
      className="pr-root"
      ref={rootRef}
      data-key-target={isKeyTarget || undefined}
      onPointerDownCapture={() => useStore.getState().setFocusedPane("pianoRoll")}
    >
      <div className="pr-toolbar">
        <span className="pr-clip-chip" style={{ background: colorRef.current }} />
        <span className="pr-clip-name ellipsis" title={clip.name}>
          {clip.name}
        </span>
        <span className="pr-track-name dim ellipsis" title={track.name}>
          {track.name}
        </span>
        <span className="pr-sep" />
        <span className="pr-lbl dim">Grid</span>
        <Select
          value={divLabel}
          onChange={(val) => {
            setDivLabel(val);
            setDrawLen(null);
          }}
          options={M.DIVISIONS.map((d) => ({ value: d.label, label: d.label }))}
          width={62}
          title="Grid division (snap + quantize grid)"
        />
        <Toggle on={triplet} onChange={(t) => { setTriplet(t); setDrawLen(null); }} tooltip="Triplet grid">
          T
        </Toggle>
        <span className="pr-sep" />
        <span className="pr-lbl dim">Strength</span>
        <NumberDrag
          value={strengthPct}
          min={0}
          max={100}
          step={1}
          precision={0}
          units="%"
          onChange={setStrengthPct}
          width={52}
          title="Quantize strength"
        />
        <span className="pr-lbl dim">Swing</span>
        <NumberDrag
          value={swingPct}
          min={0}
          max={100}
          step={1}
          precision={0}
          units="%"
          onChange={setSwingPct}
          width={52}
          title="Quantize swing"
        />
        <button
          type="button"
          className="btn"
          onClick={doQuantize}
          disabled={clip.notes.length === 0}
          title="Quantize selected notes (all when none selected)"
        >
          <Icon name="magnet" size={13} />
          Quantize
        </button>
        <span className="pr-sep" />
        <span className="pr-lbl dim">Len</span>
        <span className="pr-len mono" title="Note length (selected note, or length for newly drawn notes)">
          {lenText}
        </span>
        <span className="pr-sep" />
        <span className="pr-lbl dim">Scale</span>
        <Select
          value={String(scaleRoot)}
          onChange={(v) => setScaleRoot(Number(v))}
          options={M.SCALE_ROOTS.map((n, i) => ({ value: String(i), label: n }))}
          width={48}
          disabled={scaleId === "off"}
          title="Scale root"
        />
        <Select
          value={scaleId}
          onChange={(v) => setScaleId(v)}
          options={[
            { value: "off", label: "Off" },
            ...M.SCALES.map((s) => ({ value: s.id, label: s.label })),
          ]}
          width={92}
          title="Scale — lights up in-scale rows in the grid"
        />
        <Toggle
          on={scaleSnap}
          onChange={setScaleSnap}
          disabled={scaleId === "off"}
          tooltip="Snap to scale — drawn notes and ↑/↓ transpose stay in scale"
        >
          Snap
        </Toggle>
        <span className="grow" />
        <span className="pr-count dim mono">
          {selInClip.length > 0 ? `${selInClip.length}/${clip.notes.length}` : `${clip.notes.length}`} notes
        </span>
        <span className="pr-zoom">
          <IconButton icon="zoomOut" tooltip="Zoom out horizontally (G / Ctrl+wheel)" onClick={() => zoomHBy(1 / 1.3)} />
          <IconButton icon="zoomIn" tooltip="Zoom in horizontally (H / Ctrl+wheel)" onClick={() => zoomHBy(1.3)} />
          <IconButton icon="zoomOut" className="pr-zoom-v" tooltip="Zoom out vertically (Shift+G / Alt+wheel)" onClick={() => zoomVBy(1 / 1.25)} />
          <IconButton icon="zoomIn" className="pr-zoom-v" tooltip="Zoom in vertically (Shift+H / Alt+wheel)" onClick={() => zoomVBy(1.25)} />
        </span>
        <IconButton
          icon="headphones"
          tooltip="Audition notes while editing"
          active={audition}
          onClick={() => {
            const next = !audition;
            setAudition(next);
            savePref(AUDITION_PREF, next);
          }}
        />
        <IconButton
          icon="sliders"
          tooltip="Velocity / CC lane"
          active={laneOn}
          onClick={() => setLaneOn((on) => !on)}
        />
      </div>

      <div
        className="pr-body"
        style={{
          gridTemplateRows: laneOn
            ? `${M.RULER_H}px 1fr ${M.VEL_LANE_H}px`
            : `${M.RULER_H}px 1fr`,
        }}
      >
        <div className="pr-corner" />
        <div className="pr-ruler-wrap">
          <canvas
            ref={rulerCv.ref}
            onPointerDown={onRulerDown}
            onPointerMove={onRulerMove}
            onPointerUp={onRulerUp}
            onPointerCancel={onRulerUp}
          />
        </div>

        <div className="pr-keys-wrap" title="Piano keys — click to audition">
          <canvas
            ref={keysCv.ref}
            onPointerDown={onKeysDown}
            onPointerMove={onKeysMove}
            onPointerUp={onKeysUp}
            onPointerCancel={onKeysUp}
          />
        </div>
        <div className="pr-notes-wrap">
          <canvas
            ref={notesCv.ref}
            onPointerDown={onNotesDown}
            onPointerMove={onNotesMove}
            onPointerUp={onNotesUp}
            onPointerCancel={onNotesCancel}
            onContextMenu={onNotesContext}
          />
          <canvas ref={overlayCv.ref} className="pr-overlay-canvas" />
          <PrZoomPill
            listeners={zoomListeners}
            getZoomX={() => viewRef.current.zoomX}
            zoomHBy={zoomHBy}
          />
        </div>

        {laneOn && (
          <>
            <div className="pr-vel-corner pr-lane-corner">
              <button
                type="button"
                className="pr-lane-btn"
                title="Lane content — velocity, pitch bend or CC"
                onClick={openLaneMenu}
              >
                <span className="pr-vel-label">
                  {laneCtl === null
                    ? "VEL"
                    : laneCtl === M.CC_PITCH_BEND
                      ? "PB"
                      : `CC${laneCtl}`}
                </span>
                <Icon name="chevronDown" size={10} />
              </button>
              {otherMode && laneCtl !== null && (
                <NumberDrag
                  value={laneCtl}
                  min={0}
                  max={127}
                  step={1}
                  precision={0}
                  width={40}
                  title="CC number"
                  onChange={(n) => pickLane(Math.round(n), true)}
                />
              )}
            </div>
            <div className={"pr-vel-wrap" + (laneCtl !== null ? " pr-cc-lane" : "")}>
              <canvas
                ref={velCv.ref}
                onPointerDown={onLaneDown}
                onPointerMove={onLaneMove}
                onPointerUp={onLaneUp}
                onPointerCancel={onLaneUp}
                onContextMenu={onLaneContext}
              />
            </div>
          </>
        )}
      </div>
      <div className="pr-drag-hud" ref={hudElRef} />
    </div>
  );
}
