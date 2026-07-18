/**
 * RoomView — "place the band in the room" spatial panner (mixer toolbar button,
 * store.dialogs.roomView).
 *
 * A one-point-perspective room seen from the listener at the front edge. Dragging a
 * channel token sets both mix dimensions at once: left/right = pan, near/far = fader
 * level on the SPEC §9 taper (front edge +12 dB, back wall -60 dB, pressed against the
 * wall = -inf; the 0 dB grid line is highlighted). Tokens shrink with distance
 * (roomMath.tokenScale), glow with their channel's live RMS (metersBus), dim when
 * muted, and fan out sideways when several share the exact same spot (fresh projects:
 * everything at C / 0 dB). Double-click resets a token to C / 0 dB, wheel = ±1 dB
 * (Shift ±0.2). Escape cancels an active drag first; only then closes the modal.
 */

import React, { useMemo, useRef, useState } from "react";
import type { Track } from "../../protocol/types";
import { metersBus, useStore } from "../../store/store";
import * as actions from "../../store/actions";
import { useRafLoop } from "../../lib/canvas";
import { Icon } from "../common/icons";
import { Modal } from "../common/Modal";
import {
  FADER_DB_MAX,
  FADER_DB_MIN,
  dbToGain,
  gainToDb,
  gainToDbText,
} from "../common/Fader";
import { KIND_ICONS } from "./ChannelStrip";
import { useGestureValue } from "./useGestureValue";
import {
  type RoomGeom,
  dbToDepth,
  depthToGain,
  gainToDepth,
  project,
  tokenScale,
  unproject,
} from "./roomMath";
import "./roomview.css";

const GEOM: RoomGeom = { width: 920, height: 540, padX: 52, padTop: 46, padBottom: 68 };
const WALL_H = 26;

/* grid = the fader tick dBs, so the room and the fader speak the same taper */
const DEPTH_GRID_DBS = [12, 6, 0, -6, -12, -24, -36, -48, -60];
const DEPTH_LABEL_DBS = new Set([12, 0, -12, -24, -60]);
const PAN_GRID = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];

function panLabel(v: number): string {
  const n = Math.round(Math.abs(v) * 100);
  if (n === 0) return "C";
  return v < 0 ? `L${n}` : `R${n}`;
}

interface LiveReadout {
  id: number;
  name: string;
  pan: number;
  gain: number;
}

/* ============================================================================
 * Perspective floor grid (static SVG)
 * ========================================================================= */

function RoomGrid() {
  const g = GEOM;
  const fl = project(-1, 0, g);
  const fr = project(1, 0, g);
  const bl = project(-1, 1, g);
  const br = project(1, 1, g);
  const floorPts = `${fl.x},${fl.y} ${fr.x},${fr.y} ${br.x},${br.y} ${bl.x},${bl.y}`;

  return (
    <svg className="rv-svg" width={g.width} height={g.height} aria-hidden>
      <defs>
        <linearGradient id="rvFog" x1="0" y1={bl.y} x2="0" y2={fl.y} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--bg)" stopOpacity="0.8" />
          <stop offset="0.6" stopColor="var(--bg)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--bg)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="rvWall" x1="0" y1={bl.y - WALL_H} x2="0" y2={bl.y} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--bg)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--bg)" stopOpacity="0.35" />
        </linearGradient>
      </defs>

      {/* back wall */}
      <rect
        className="rv-wall"
        x={bl.x}
        y={bl.y - WALL_H}
        width={br.x - bl.x}
        height={WALL_H}
        fill="url(#rvWall)"
      />

      {/* floor */}
      <polygon className="rv-floor" points={floorPts} />

      {/* pan lines: front edge → back wall, converging on the vanishing point */}
      {PAN_GRID.map((p) => {
        const a = project(p, 0, g);
        const b = project(p, 1, g);
        return (
          <line
            key={`p${p}`}
            className={"rv-grid" + (p === 0 ? " center" : "")}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
          />
        );
      })}

      {/* depth lines at the fader tick dBs (nearer lines drawn stronger) */}
      {DEPTH_GRID_DBS.map((db) => {
        const z = dbToDepth(db);
        const l = project(-1, z, g);
        const r = project(1, z, g);
        return (
          <g key={`d${db}`}>
            <line
              className={"rv-grid" + (db === 0 ? " zero" : "")}
              x1={l.x}
              y1={l.y}
              x2={r.x}
              y2={r.y}
              style={{ opacity: db === 0 ? 1 : 0.35 + 0.55 * l.s }}
            />
            {DEPTH_LABEL_DBS.has(db) && (
              <text
                className={"rv-lab" + (db === 0 ? " zero" : "")}
                x={l.x - 8}
                y={l.y + 3}
                textAnchor="end"
              >
                {db > 0 ? `+${db}` : db}
                {db === 12 ? " dB" : ""}
              </text>
            )}
          </g>
        );
      })}

      {/* distance fog on top of the grid */}
      <polygon points={floorPts} fill="url(#rvFog)" pointerEvents="none" />
      <polygon className="rv-outline" points={floorPts} />

      {/* pan labels on the front corners */}
      <text className="rv-lab side" x={fl.x} y={fl.y + 16} textAnchor="middle">
        L
      </text>
      <text className="rv-lab side" x={fr.x} y={fr.y + 16} textAnchor="middle">
        R
      </text>
    </svg>
  );
}

/* ============================================================================
 * Draggable channel token
 * ========================================================================= */

interface RoomTokenProps {
  track: Track;
  /** Sideways fan-out (room px at scale 1) when tokens share the exact same spot. */
  spreadDx: number;
  selected: boolean;
  roomRef: React.RefObject<HTMLDivElement | null>;
  /** Registered while a drag is active so Escape cancels the drag, not the modal. */
  dragRef: React.MutableRefObject<{ cancel: () => void } | null>;
  onLive: (live: LiveReadout | null) => void;
}

function RoomToken({ track, spreadDx, selected, roomRef, dragRef, onLive }: RoomTokenProps) {
  const setSelection = useStore((s) => s.setSelection);
  const vol = useGestureValue(track.volume);
  const pan = useGestureValue(track.pan);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{
    grabDx: number;
    grabDy: number;
    startPan: number;
    startGain: number;
    lastPan: number;
    lastGain: number;
  } | null>(null);

  const z = gainToDepth(vol.value);
  const pt = project(pan.value, z, GEOM);
  const k = tokenScale(pt.s);
  const x = pt.x + (dragging ? 0 : spreadDx * pt.s);
  // effective on-screen name size ≥ ~9.5px even at the back wall
  const nameFs = Math.max(10, 9.5 / k);
  const nameW = Math.max(120, 150 / k);

  const toRoom = (e: React.PointerEvent) => {
    const r = roomRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const finish = () => {
    gesture.current = null;
    setDragging(false);
    dragRef.current = null;
    onLive(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Select FIRST (clicking a circle shows its values in the footer readout even
    // without a drag) — setPointerCapture can throw on exotic pointer ids.
    if (!selected) setSelection({ trackIds: [track.id] });
    e.currentTarget.setPointerCapture(e.pointerId);
    const m = toRoom(e);
    gesture.current = {
      grabDx: m.x - x,
      grabDy: m.y - pt.y,
      startPan: pan.value,
      startGain: vol.value,
      lastPan: pan.value,
      lastGain: vol.value,
    };
    setDragging(true);
    dragRef.current = {
      cancel: () => {
        const d = gesture.current;
        if (!d) return;
        pan.end(d.startPan);
        vol.end(d.startGain);
        void actions.commitTrack(track.id, { pan: d.startPan, volume: d.startGain });
        finish();
      },
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = gesture.current;
    if (!d) return;
    const m = toRoom(e);
    const w = unproject(m.x - d.grabDx, m.y - d.grabDy, GEOM);
    const gain = depthToGain(w.z);
    d.lastPan = w.pan;
    d.lastGain = gain;
    pan.drag(w.pan);
    vol.drag(gain);
    actions.dragTrack(track.id, { pan: w.pan, volume: gain });
    onLive({ id: track.id, name: track.name, pan: w.pan, gain });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = gesture.current;
    if (!d) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    pan.end(d.lastPan);
    vol.end(d.lastGain);
    void actions.commitTrack(track.id, { pan: d.lastPan, volume: d.lastGain });
    finish();
  };

  const onDoubleClick = () => {
    pan.end(0);
    vol.end(1);
    void actions.commitTrack(track.id, { pan: 0, volume: 1 });
  };

  /* wheel = walk the token nearer/farther by ±1 dB (Shift ±0.2), like the fader */
  const onWheel = (e: React.WheelEvent) => {
    const dir = e.deltaY < 0 ? 1 : -1;
    const stepDb = e.shiftKey ? 0.2 : 1;
    const curDb = vol.value > 0 ? gainToDb(vol.value) : FADER_DB_MIN;
    const db = Math.min(FADER_DB_MAX, Math.max(FADER_DB_MIN, curDb + dir * stepDb));
    const gain = db <= FADER_DB_MIN ? 0 : dbToGain(db);
    vol.end(gain);
    void actions.commitTrack(track.id, { volume: gain });
  };

  return (
    <div
      className={
        "rv-token" +
        (dragging ? " dragging" : "") +
        (selected ? " selected" : "") +
        (track.mute ? " muted" : "")
      }
      style={
        {
          left: x,
          top: pt.y,
          zIndex: (dragging ? 1000 : 100) + Math.round((1 - z) * 99),
          transform: `scale(${k})`,
          "--tk-color": track.color || "var(--accent)",
        } as React.CSSProperties
      }
      title={`${track.name} — ${panLabel(pan.value)} · ${gainToDbText(vol.value)} dB\nDrag to place · double-click: center at 0 dB · wheel: ±1 dB`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
    >
      <div className="rv-glow" data-rv-id={track.id} />
      <div className="rv-shadow" />
      <div className="rv-disc">
        <Icon name={KIND_ICONS[track.kind]} size={16} />
      </div>
      {/* Counter-scale the label so names stay readable at the back of the room:
          the whole token scales by k, so 1px here renders as k px on screen. */}
      <div className="rv-name" style={{ fontSize: nameFs, width: nameW, left: -nameW / 2 }}>
        {track.name}
      </div>
    </div>
  );
}

/* ============================================================================
 * The modal
 * ========================================================================= */

export default function RoomView() {
  const open = useStore((s) => s.dialogs.roomView);
  const setDialogs = useStore((s) => s.setDialogs);
  const project_ = useStore((s) => s.project);
  const selectedIds = useStore((s) => s.selection.trackIds);
  const roomRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ cancel: () => void } | null>(null);
  const [live, setLive] = useState<LiveReadout | null>(null);
  const glowLevels = useRef(new Map<string, number>());

  /* same channel set as the mixer rail: regular tracks then buses (no folders/master;
     MIDI tracks carry no audio — their sound lives on the routed instrument) */
  const tracks = useMemo(() => {
    if (!project_) return [];
    const regular = project_.tracks.filter(
      (t) =>
        t.kind !== "folder" && t.kind !== "bus" && t.kind !== "master" && t.kind !== "midi",
    );
    const buses = project_.tracks.filter((t) => t.kind === "bus");
    return [...regular, ...buses];
  }, [project_]);

  /* fan out tokens that sit on the exact same spot (dragged token drops out) */
  const spread = useMemo(() => {
    const groups = new Map<string, Track[]>();
    for (const t of tracks) {
      if (t.id === live?.id) continue;
      const p = project(t.pan, gainToDepth(t.volume), GEOM);
      const key = `${Math.round(p.x / 8)}:${Math.round(p.y / 8)}`;
      const g = groups.get(key);
      if (g) g.push(t);
      else groups.set(key, [t]);
    }
    const dx = new Map<number, number>();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => a.id - b.id);
      g.forEach((t, i) => dx.set(t.id, (i - (g.length - 1) / 2) * 46));
    }
    return dx;
  }, [tracks, live?.id]);

  /* live RMS → per-token glow (fast attack, slow decay), off React's render path */
  useRafLoop(() => {
    const root = roomRef.current;
    if (!root) return;
    const meters = metersBus.last;
    const smoothed = glowLevels.current;
    for (const el of root.querySelectorAll<HTMLElement>("[data-rv-id]")) {
      const id = el.dataset.rvId!;
      const lv = meters?.tracks[id];
      const rms = lv ? ((lv[2] ?? 0) + (lv[3] ?? lv[2] ?? 0)) / 2 : 0;
      const target = Math.min(1, rms * 2.6);
      let cur = Math.max(target, (smoothed.get(id) ?? 0) * 0.9);
      if (cur < 0.004) cur = 0;
      smoothed.set(id, cur);
      el.style.setProperty("--lv", cur.toFixed(3));
    }
  }, open);

  const onClose = () => {
    if (dragRef.current) {
      dragRef.current.cancel(); // Escape mid-drag cancels the drag, not the modal
      return;
    }
    setDialogs({ roomView: false });
  };

  /* readout: an active drag wins; otherwise the (most recently) selected channel */
  const selTrack = useMemo(() => {
    for (let i = selectedIds.length - 1; i >= 0; i--) {
      const t = tracks.find((tr) => tr.id === selectedIds[i]);
      if (t) return t;
    }
    return null;
  }, [selectedIds, tracks]);
  const readout = live ?? (selTrack
    ? { id: selTrack.id, name: selTrack.name, pan: selTrack.pan, gain: selTrack.volume }
    : null);

  return (
    <Modal
      open={open && project_ !== null}
      onClose={onClose}
      title="Room View"
      width={GEOM.width + 26}
      draggable
      transportKeys
      footer={
        <>
          <span className="rv-legend grow">
            Left ↔ right = pan · near ↔ far = level (front +12 dB, back wall −60 dB /
            silence) · double-click resets to C / 0 dB
          </span>
          <span className="rv-live">
            {readout
              ? `${readout.name} — ${panLabel(readout.pan)} · ${gainToDbText(readout.gain)} dB`
              : "Select a channel to see its values"}
          </span>
        </>
      }
    >
      <div ref={roomRef} className="rv-room" style={{ width: GEOM.width, height: GEOM.height }}>
        <RoomGrid />
        {tracks.map((t) => (
          <RoomToken
            key={t.id}
            track={t}
            spreadDx={spread.get(t.id) ?? 0}
            selected={selectedIds.includes(t.id)}
            roomRef={roomRef}
            dragRef={dragRef}
            onLive={setLive}
          />
        ))}
        <div className="rv-listener" style={{ top: GEOM.height - GEOM.padBottom + 14 }}>
          <Icon name="headphones" size={16} />
          <span>Listener</span>
        </div>
        {tracks.length === 0 && (
          <div className="rv-empty">Add tracks in the arrangement to place them in the room.</div>
        )}
      </div>
    </Modal>
  );
}
