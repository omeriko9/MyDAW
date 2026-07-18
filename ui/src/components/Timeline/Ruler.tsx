/**
 * Ruler (U1): bars/beats strip with click/drag seek, loop region editing in the
 * upper strip (drag creates/moves, edge-drag resizes, dbl-click toggles enabled,
 * Ctrl+click sets loop start / Alt+click sets loop end à la Cubase — also on the
 * bars strip), and a marker lane (dbl-click adds via inline input, drag moves,
 * right-click rename/remove). Loop drags stream transient cmd/loop.set and commit
 * once on mouse-up (SPEC §5 transient pattern).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../store/store";
import {
  addMarker,
  locate,
  removeMarker,
  setLoop,
  setMarker,
} from "../../store/actions";
import { transientParam, commitParam } from "../../store/actions";
import { barToBeat, beatToPx, pxToBeat, type HViewport } from "../../lib/time";
import { useCanvas, lineV } from "../../lib/canvas";
import { openContextMenu } from "../common/ContextMenu";
import { FloatingInput } from "./bits";
import {
  RULER_H,
  RULER_LOOP_H,
  RULER_MARKER_H,
  RULER_BARS_Y,
  clamp,
  gridLines,
  snapB,
  themeVar,
  withAlpha,
} from "./layout";
import { tlColors } from "./clipRender";

const LOOP_EDGE_PX = 5;
const SEEK_THROTTLE_MS = 60;

type RulerDrag =
  | { kind: "seek" }
  | {
      kind: "loop";
      mode: "create" | "move" | "l" | "r";
      anchorBeat: number;
      origStart: number;
      origEnd: number;
      start: number;
      end: number;
      moved: boolean;
    }
  | { kind: "marker"; markerId: number; beat: number; grabOffsetBeats: number; moved: boolean };

interface MarkerHit {
  id: number;
  x0: number;
  x1: number;
  beat: number;
}

interface InputState {
  x: number;
  y: number;
  beat: number;
  mode: "add" | "rename";
  markerId?: number;
  initial: string;
}

export default function Ruler() {
  const project = useStore((s) => s.project);
  const viewport = useStore((s) => s.viewport);
  const transportLoop = useStore((s) => s.transport.loop);

  const loop = project?.loop ?? transportLoop;
  const vp: HViewport = { zoomX: viewport.zoomX, scrollX: viewport.scrollX };

  const dragRef = useRef<RulerDrag | null>(null);
  const markerHitsRef = useRef<MarkerHit[]>([]);
  const lastSeekRef = useRef(0);
  const [input, setInput] = useState<InputState | null>(null);

  const stateRef = useRef({ project, loop, vp });
  stateRef.current = { project, loop, vp };

  /* ---------------------------------------------------------------- draw */

  const drawRef = useRef<() => void>(() => undefined);

  const { ref, ctxRef, size } = useCanvas(() => drawRef.current());

  const draw = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { project: proj, loop: lp, vp: v } = stateRef.current;
    const w = size.width;
    if (w <= 0) return;
    const colors = tlColors();
    const d = dragRef.current;

    ctx.clearRect(0, 0, w, RULER_H);

    // strip backgrounds
    ctx.fillStyle = colors.panel;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, w, RULER_LOOP_H);
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    ctx.fillRect(0, RULER_LOOP_H, w, RULER_MARKER_H);

    const timeSigMap = proj?.timeSigMap ?? [];
    const startBeat = pxToBeat(0, v);
    const endBeat = pxToBeat(w, v);

    // bars/beats ticks + labels
    const lines = gridLines(startBeat, endBeat, v.zoomX, timeSigMap, null);
    ctx.font = "500 10px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const ln of lines) {
      const x = beatToPx(ln.beat, v);
      if (x < -40 || x > w + 2) continue;
      if (ln.level === 0) {
        ctx.strokeStyle = colors.borderLight;
        lineV(ctx, x, RULER_BARS_Y, RULER_H);
        if (ln.label && ln.bar !== undefined) {
          ctx.fillStyle = colors.textDim;
          ctx.fillText(String(ln.bar), x + 4, RULER_BARS_Y + (RULER_H - RULER_BARS_Y) / 2 + 0.5);
        }
      } else if (ln.level === 1) {
        ctx.strokeStyle = colors.border;
        lineV(ctx, x, RULER_H - 6, RULER_H);
      }
    }

    // loop region (preview while dragging)
    let ls = lp.startBeat;
    let le = lp.endBeat;
    let enabled = lp.enabled;
    if (d && d.kind === "loop") {
      ls = d.start;
      le = d.end;
      if (d.mode === "create") enabled = true;
    }
    if (le > ls) {
      const x0 = beatToPx(ls, v);
      const x1 = beatToPx(le, v);
      if (x1 > 0 && x0 < w) {
        ctx.fillStyle = enabled ? withAlpha(colors.accent, 0.4) : withAlpha(colors.textFaint, 0.25);
        ctx.fillRect(x0, 1, x1 - x0, RULER_LOOP_H - 2);
        ctx.strokeStyle = enabled ? colors.accent : colors.textFaint;
        lineV(ctx, x0, 0, RULER_LOOP_H);
        lineV(ctx, x1, 0, RULER_LOOP_H);
      }
    }

    // markers
    const hits: MarkerHit[] = [];
    if (proj) {
      const my = RULER_LOOP_H + RULER_MARKER_H / 2;
      ctx.font = "500 9.5px Inter, system-ui, sans-serif";
      for (const m of proj.markers) {
        let beat = m.beat;
        if (d && d.kind === "marker" && d.markerId === m.id) beat = d.beat;
        const x = beatToPx(beat, v);
        const name = m.name || "Marker";
        const tw = Math.min(120, ctx.measureText(name).width);
        if (x + tw + 12 < 0 || x > w + 4) {
          hits.push({ id: m.id, x0: x, x1: x + tw + 12, beat });
          continue;
        }
        const mcol = m.color || themeVar("--warn");
        // flag pole + pennant
        ctx.strokeStyle = mcol;
        lineV(ctx, x, RULER_LOOP_H + 2, RULER_LOOP_H + RULER_MARKER_H - 2);
        ctx.fillStyle = mcol;
        ctx.beginPath();
        ctx.moveTo(x + 1, RULER_LOOP_H + 2.5);
        ctx.lineTo(x + 8, RULER_LOOP_H + 5.5);
        ctx.lineTo(x + 1, RULER_LOOP_H + 8.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = colors.textDim;
        ctx.fillText(name, x + 11, my + 0.5, 120);
        hits.push({ id: m.id, x0: x - 3, x1: x + tw + 12, beat });
      }
    }
    markerHitsRef.current = hits;

    // tempo / time-signature change markers — only once the maps have >1 entry
    // (small accent triangle + "128" / "3/4" text along the marker-lane floor)
    if (proj && (proj.tempoMap.length > 1 || proj.timeSigMap.length > 1)) {
      const marks: Array<{ beat: number; text: string }> = [];
      if (proj.tempoMap.length > 1) {
        for (const t of proj.tempoMap) {
          marks.push({ beat: t.beat, text: String(Math.round(t.bpm * 10) / 10) });
        }
      }
      if (proj.timeSigMap.length > 1) {
        for (const sg of proj.timeSigMap) {
          marks.push({ beat: barToBeat(sg.bar, proj.timeSigMap), text: `${sg.num}/${sg.den}` });
        }
      }
      marks.sort((a, b) => a.beat - b.beat);
      ctx.font = "600 9px Inter, system-ui, sans-serif";
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      const yBase = RULER_BARS_Y - 2;
      let lastEnd = -Infinity;
      for (const mk of marks) {
        const x = beatToPx(mk.beat, v);
        if (x < -40 || x > w + 4) continue;
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.moveTo(x, yBase - 5);
        ctx.lineTo(x + 3.5, yBase);
        ctx.lineTo(x - 3.5, yBase);
        ctx.closePath();
        ctx.fill();
        const tx = Math.max(x + 6, lastEnd + 6);
        ctx.fillStyle = colors.textDim;
        ctx.fillText(mk.text, tx, yBase);
        lastEnd = tx + ctx.measureText(mk.text).width;
      }
      ctx.textBaseline = "middle";
    }

    // strip separators
    ctx.strokeStyle = colors.border;
    ctx.beginPath();
    ctx.moveTo(0, RULER_LOOP_H - 0.5);
    ctx.lineTo(w, RULER_LOOP_H - 0.5);
    ctx.moveTo(0, RULER_BARS_Y - 0.5);
    ctx.lineTo(w, RULER_BARS_Y - 0.5);
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(w, RULER_H - 0.5);
    ctx.stroke();
  }, [ctxRef, size.width]);

  drawRef.current = draw;

  useEffect(() => {
    draw();
  });

  /* ---------------------------------------------------------- interactions */

  const seekTo = useCallback((beat: number, force: boolean) => {
    const now = performance.now();
    if (!force && now - lastSeekRef.current < SEEK_THROTTLE_MS) return;
    lastSeekRef.current = now;
    locate(Math.max(0, beat)).catch(() => undefined);
  }, []);

  const beatAt = (clientX: number, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    return pxToBeat(clientX - rect.left, stateRef.current.vp);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 1) return;
    const el = e.currentTarget;
    const { project: proj, loop: lp, vp: v } = stateRef.current;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const rawBeat = pxToBeat(x, v);
    const grid = proj?.grid ?? null;

    if (e.button === 2) {
      // context menu handled in onContextMenu
      return;
    }

    // Cubase-style locator clicks on the loop + bars strips: Ctrl+click sets the loop
    // start, Alt+click the loop end (Shift still bypasses snap; marker lane keeps its
    // own gestures). Same collapse semantics as the context-menu Set Loop Start/End.
    if (e.button === 0 && (e.ctrlKey || e.altKey) && (y < RULER_LOOP_H || y >= RULER_BARS_Y)) {
      const beat = Math.max(0, snapB(rawBeat, grid, e.shiftKey));
      if (e.ctrlKey) {
        setLoop(beat, Math.max(beat, lp.endBeat), lp.enabled).catch(() => undefined);
      } else {
        setLoop(Math.min(lp.startBeat, beat), beat, lp.enabled).catch(() => undefined);
      }
      return;
    }

    if (y < RULER_LOOP_H) {
      // loop strip
      const x0 = beatToPx(lp.startBeat, v);
      const x1 = beatToPx(lp.endBeat, v);
      const hasLoop = lp.endBeat > lp.startBeat;
      let mode: "create" | "move" | "l" | "r" = "create";
      if (hasLoop && Math.abs(x - x0) <= LOOP_EDGE_PX) mode = "l";
      else if (hasLoop && Math.abs(x - x1) <= LOOP_EDGE_PX) mode = "r";
      else if (hasLoop && x > x0 && x < x1) mode = "move";
      const anchor = snapB(rawBeat, grid, e.shiftKey);
      dragRef.current = {
        kind: "loop",
        mode,
        anchorBeat: anchor,
        origStart: lp.startBeat,
        origEnd: lp.endBeat,
        start: mode === "create" ? anchor : lp.startBeat,
        end: mode === "create" ? anchor : lp.endBeat,
        moved: false,
      };
      el.setPointerCapture(e.pointerId);
      return;
    }

    if (y < RULER_BARS_Y) {
      // marker lane
      const hit = markerHitsRef.current.find((m) => x >= m.x0 && x <= m.x1);
      if (hit) {
        dragRef.current = {
          kind: "marker",
          markerId: hit.id,
          beat: hit.beat,
          grabOffsetBeats: rawBeat - hit.beat,
          moved: false,
        };
        el.setPointerCapture(e.pointerId);
      }
      return;
    }

    // bars strip → seek
    dragRef.current = { kind: "seek" };
    el.setPointerCapture(e.pointerId);
    seekTo(snapB(rawBeat, grid, e.shiftKey), true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    const el = e.currentTarget;
    const { project: proj, loop: lp } = stateRef.current;
    const grid = proj?.grid ?? null;

    if (!d) {
      // hover cursor
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let cursor = "default";
      if (y < RULER_LOOP_H) {
        const x0 = beatToPx(lp.startBeat, stateRef.current.vp);
        const x1 = beatToPx(lp.endBeat, stateRef.current.vp);
        if (lp.endBeat > lp.startBeat && (Math.abs(x - x0) <= LOOP_EDGE_PX || Math.abs(x - x1) <= LOOP_EDGE_PX)) {
          cursor = "ew-resize";
        } else {
          cursor = "crosshair";
        }
      } else if (y >= RULER_BARS_Y) {
        cursor = "pointer";
      }
      el.style.cursor = cursor;
      return;
    }

    const rawBeat = beatAt(e.clientX, el);

    if (d.kind === "seek") {
      seekTo(snapB(rawBeat, grid, e.shiftKey), false);
      return;
    }

    if (d.kind === "loop") {
      d.moved = true;
      const snapped = snapB(rawBeat, grid, e.shiftKey);
      if (d.mode === "create") {
        d.start = Math.min(d.anchorBeat, snapped);
        d.end = Math.max(d.anchorBeat, snapped);
      } else if (d.mode === "move") {
        const delta = snapB(d.origStart + (rawBeat - d.anchorBeat), grid, e.shiftKey) - d.origStart;
        const len = d.origEnd - d.origStart;
        d.start = Math.max(0, d.origStart + delta);
        d.end = d.start + len;
      } else if (d.mode === "l") {
        d.start = Math.min(snapped, d.origEnd);
        d.end = d.origEnd;
      } else {
        d.start = d.origStart;
        d.end = Math.max(snapped, d.origStart);
      }
      transientParam("cmd/loop.set", {
        startBeat: d.start,
        endBeat: d.end,
        enabled: d.mode === "create" ? true : lp.enabled,
      });
      draw();
      return;
    }

    if (d.kind === "marker") {
      d.moved = true;
      d.beat = snapB(rawBeat - d.grabOffsetBeats, grid, e.shiftKey);
      draw();
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    const el = e.currentTarget;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!d) return;
    const { project: proj, loop: lp } = stateRef.current;
    const grid = proj?.grid ?? null;

    if (d.kind === "seek") {
      seekTo(snapB(beatAt(e.clientX, el), grid, e.shiftKey), true);
      return;
    }

    if (d.kind === "loop") {
      if (!d.moved) {
        draw();
        return;
      }
      const minLen = grid && grid.division > 0 ? grid.division : 0.25;
      if (d.end - d.start < minLen / 2) {
        // too small to be a loop — restore previous region
        commitParam("cmd/loop.set", {
          startBeat: d.origStart,
          endBeat: d.origEnd,
          enabled: lp.enabled,
        }).catch(() => undefined);
      } else {
        commitParam("cmd/loop.set", {
          startBeat: d.start,
          endBeat: d.end,
          enabled: d.mode === "create" ? true : lp.enabled,
        }).catch(() => undefined);
      }
      draw();
      return;
    }

    if (d.kind === "marker" && d.moved) {
      setMarker(d.markerId, { beat: Math.max(0, d.beat) }).catch(() => undefined);
      draw();
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const { project: proj, loop: lp, vp: v } = stateRef.current;
    if (!proj) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (y < RULER_LOOP_H) {
      if (lp.endBeat > lp.startBeat) {
        commitParam("cmd/loop.set", {
          startBeat: lp.startBeat,
          endBeat: lp.endBeat,
          enabled: !lp.enabled,
        }).catch(() => undefined);
      }
      return;
    }

    if (y < RULER_BARS_Y) {
      const hit = markerHitsRef.current.find((m) => x >= m.x0 && x <= m.x1);
      if (hit) {
        const marker = proj.markers.find((m) => m.id === hit.id);
        setInput({
          x: e.clientX,
          y: rect.top + RULER_LOOP_H,
          beat: hit.beat,
          mode: "rename",
          markerId: hit.id,
          initial: marker?.name ?? "",
        });
      } else {
        const beat = snapB(pxToBeat(x, v), proj.grid, e.shiftKey);
        setInput({
          x: e.clientX,
          y: rect.top + RULER_LOOP_H,
          beat,
          mode: "add",
          initial: "",
        });
      }
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const { project: proj, loop: lp, vp: v } = stateRef.current;
    if (!proj) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // marker lane hit → marker menu
    if (y >= RULER_LOOP_H && y < RULER_BARS_Y) {
      const hit = markerHitsRef.current.find((m) => x >= m.x0 && x <= m.x1);
      if (hit) {
        const marker = proj.markers.find((m) => m.id === hit.id);
        openContextMenu(e.clientX, e.clientY, [
          {
            label: "Rename Marker…",
            icon: "pencil",
            onClick: () =>
              setInput({
                x: e.clientX,
                y: rect.top + RULER_LOOP_H,
                beat: hit.beat,
                mode: "rename",
                markerId: hit.id,
                initial: marker?.name ?? "",
              }),
          },
          "separator",
          {
            label: "Remove Marker",
            icon: "trash",
            danger: true,
            onClick: () => removeMarker(hit.id).catch(() => undefined),
          },
        ]);
        return;
      }
    }

    // empty ruler (any strip) → beat-targeted menu; snap like other ruler clicks
    const beat = Math.max(0, snapB(pxToBeat(x, v), proj.grid, e.shiftKey));
    openContextMenu(e.clientX, e.clientY, [
      {
        label: "Add Marker Here…",
        icon: "marker",
        onClick: () =>
          setInput({
            x: e.clientX,
            y: rect.top + RULER_LOOP_H,
            beat,
            mode: "add",
            initial: "",
          }),
      },
      "separator",
      {
        label: "Set Loop Start Here",
        onClick: () =>
          setLoop(beat, Math.max(beat, lp.endBeat), lp.enabled).catch(() => undefined),
      },
      {
        label: "Set Loop End Here",
        onClick: () =>
          setLoop(Math.min(lp.startBeat, beat), beat, lp.enabled).catch(() => undefined),
      },
      {
        label: "Clear Loop",
        disabled: !lp.enabled,
        title: lp.enabled ? "Turn looping off (keeps the region)" : "Loop is already off",
        onClick: () => setLoop(lp.startBeat, lp.endBeat, false).catch(() => undefined),
      },
      "separator",
      {
        label: "Locate Here",
        icon: "play",
        onClick: () => locate(beat).catch(() => undefined),
      },
    ]);
  };

  return (
    <>
      <canvas
        ref={ref}
        className="tl-ruler"
        style={{ height: RULER_H }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
          draw();
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {input && (
        <FloatingInput
          x={input.x}
          y={input.y}
          initial={input.initial}
          placeholder="Marker name"
          onCommit={(name) => {
            setInput(null);
            const trimmed = name.trim();
            if (input.mode === "add") {
              addMarker(clamp(input.beat, 0, Number.MAX_SAFE_INTEGER), trimmed || "Marker").catch(
                () => undefined,
              );
            } else if (input.markerId !== undefined && trimmed) {
              setMarker(input.markerId, { name: trimmed }).catch(() => undefined);
            }
          }}
          onCancel={() => setInput(null)}
        />
      )}
    </>
  );
}
