/**
 * Track headers column (U1) — the 220px DOM column left of the arrangement canvas.
 *
 * Per row: color strip (click → 12-color popover), kind icon, name (dbl-click rename via
 * FloatingInput), M/S/R/monitor toggles + "A" automation-lane expansion toggle, folder
 * chevron + depth indent, frozen badge, bottom-edge height drag (local preview via
 * onHeightPreview, ONE cmd/track.set on mouse-up — SPEC §5.8), pointer drag reorder with
 * drop line / drop-into-folder highlight (cmd/track.reorder on drop), right-click context
 * menu (add track kinds, rename, color, duplicate, freeze/unfreeze/bounce, delete w/
 * confirmDialog). Lane rows render a DOM header too: param label, live value, "+" lane
 * picker (plugin params fetched lazily via automationUi.pluginParamsFor), "x" remove.
 * Rows are drop targets (lib/dnd): Browser plugins → addPlugin, Browser assets / OS
 * files → clip at the playhead beat (audio assets need an audio track — toast otherwise).
 */

import React, { useRef, useState } from "react";
import { transportBus, useStore } from "../../store/store";
import {
  addAudioClip,
  addPlugin,
  addSend,
  addTrack,
  bounceTrack,
  renderTrackInPlace,
  duplicateTrack,
  removePlugin,
  reorderTrack,
  setAutomation,
  setTrack,
  unfreezeTrack,
} from "../../store/actions";
import { groupPluginVariants } from "../../lib/pluginVariants";
import { isPluginFavorite, loadPluginFavorites, pluginKey } from "../../lib/ids";
import {
  assignInstrumentToFeeder,
  instrumentFeeders,
  openInstrumentDropChoices,
  replaceInstrumentOn,
  routeMidiToInstrument,
  useInstrumentBusyCheck,
} from "./instrumentAssign";
import {
  hasAssetDrag,
  hasPluginDrag,
  readAssetDrag,
  readPluginDrag,
  uploadFiles,
} from "../../lib/dnd";
import { extensionOf, projectOnlyExtensions } from "../Transport/projectFlows";
import { loadPref, numberIn, usePrefState } from "../../lib/prefs";
import { selectTrack } from "../../lib/trackSelection";
import { confirmRemoveTracks } from "../../lib/trackActions";
import { Resizer } from "../common/Resizer";
import { showToast } from "../common/ToastHost";
import { pluginParamsFor, useAutomationUi } from "./automationUi";
import { useTakesUi } from "./takesUi";
import { LANE_COLORS } from "../../lib/comping";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { openBestEditor } from "../PluginEditor/openEditor";
import { confirmDialog } from "../Dialogs/confirm";
import { Icon, type IconName } from "../common/icons";
import { Toggle } from "../common/Toggle";
import { IconButton } from "../common/IconButton";
import { ColorPopover, FloatingInput } from "./bits";
import {
  DEFAULT_TRACK_H,
  MIN_TRACK_H,
  MAX_TRACK_H,
  RULER_H,
  clamp,
  isDescendantOf,
  laneCurrentValue,
  paramSpecFor,
  trackAcceptsClip,
  trackKindIcon,
  type LaneRowL,
  type Row,
  type TakeLaneRowL,
  type TrackRowL,
} from "./layout";
import type { AddableTrackKind, PluginInfo, Track } from "../../protocol/types";
import { isViewRowKind } from "../../protocol/types";

export const HEADER_W = 220;
const DRAG_THRESHOLD_PX = 4;

const fire = (p: Promise<unknown>): void => {
  // The engine's rejection message is the only explanation the user can get (nothing
  // else surfaces it), so a refused command must not look like a dead affordance.
  p.catch((e) => {
    console.warn("[timeline] command failed:", e);
    showToast(e instanceof Error && e.message ? e.message : "Command failed", "error");
  });
};

/* ============================================================================
 * Add-track menu items (shared with the canvas empty-area context menu)
 * ========================================================================= */

const ADDABLE: Array<{ kind: AddableTrackKind; label: string; icon: IconName }> = [
  { kind: "audio", label: "Audio Track", icon: "audioWave" },
  { kind: "midi", label: "MIDI Track", icon: "midiNote" },
  { kind: "instrument", label: "Instrument Track", icon: "piano" },
  { kind: "bus", label: "Bus Track", icon: "mixer" },
  { kind: "folder", label: "Folder Track", icon: "folder" },
  // View-row lanes over project-level data (max one of each; the engine rejects dupes)
  { kind: "marker", label: "Marker Track", icon: "marker" },
  { kind: "arranger", label: "Arranger Track", icon: "layers" },
  { kind: "chord", label: "Chord Track", icon: "staff" },
  { kind: "transpose", label: "Transpose Track", icon: "chevronUp" },
];

export function addTrackMenuItems(index?: number): MenuEntry[] {
  // Menus are imperative (built once, at open time) so the track list is read from the
  // store, not a hook — the one-per-project kinds are greyed out instead of being
  // offered and then refused by the engine.
  const tracks = useStore.getState().project?.tracks ?? [];
  const items: MenuEntry[] = ADDABLE.map((a) => {
    const dupe = isViewRowKind(a.kind) && tracks.some((t) => t.kind === a.kind);
    return {
      label: `Add ${a.label}`,
      icon: a.icon,
      disabled: dupe,
      // "a arranger track" — the article has to follow the kind, and this tooltip is
      // generated here rather than coming from the engine's own refusal message.
      title: dupe
        ? `The project already has a${/^[aeiou]/i.test(a.label) ? "n" : ""} ${a.label.toLowerCase()}`
        : undefined,
      onClick: () => {
        // Audio tracks ask mono/stereo + which input first (Omer, 2026-08-07);
        // every other kind still adds immediately.
        if (a.kind === "audio") {
          useStore.getState().setDialogs({ addAudioTrack: index !== undefined ? { index } : {} });
          return;
        }
        fire(addTrack(a.kind, index !== undefined ? { index } : undefined));
      },
    };
  });
  // FX track (Omer, 2026-08-07: "we don't have FX tracks") — a Cubase FX channel is a
  // bus carrying an effect, fed by sends. This flow packages the existing primitives:
  // pick the effect, get a bus named after it with the effect loaded, and a send from
  // the selected track (if one is selected) already connected.
  items.splice(4, 0, {
    label: "Add FX Track (effect + send)…",
    icon: "sliders",
    submenu: fxTrackEffectItems(),
  });
  return items;
}

function fxTrackEffectItems(): MenuEntry[] {
  const s = useStore.getState();
  const effects = groupPluginVariants(
    s.registry
      .filter((p) => !p.isInstrument && !p.blacklisted)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  ).plugins;
  if (effects.length === 0) return [{ label: "No scanned effect plugins", disabled: true }];
  return effects.map((p) => ({
    label: p.name,
    onClick: () => {
      void (async () => {
        const src = s.project?.tracks.find(
          (t) =>
            s.selection.trackIds.includes(t.id) &&
            (t.kind === "audio" || t.kind === "instrument" || t.kind === "bus"),
        );
        const { track: fx } = await addTrack("bus", { name: `FX: ${p.name}` });
        await addPlugin(fx.id, p.uid);
        if (src) {
          await addSend(src.id, fx.id);
          showToast(`FX track ready — “${src.name}” sends into ${p.name}`, "success");
        } else {
          showToast(
            `FX track ready — add sends to it from any channel's Sends section`,
            "success",
          );
        }
      })().catch((e) =>
        showToast(e instanceof Error ? e.message : "FX track creation failed", "error"),
      );
    },
  }));
}

/* ============================================================================
 * Component
 * ========================================================================= */

export interface TrackHeadersProps {
  rows: Row[];
  scrollY: number;
  /** Height occupied above the ruler on the arrangement side (currently the minimap). */
  topSpacerHeight?: number;
  collapsedFolders: ReadonlySet<number>;
  onToggleFolder(trackId: number): void;
  /** Live height preview during a bottom-edge drag (display px); null = drag ended. */
  onHeightPreview(o: { trackId: number; height: number } | null): void;
  vScale: number;
}

interface PopoverState {
  kind: "color" | "rename";
  trackId: number;
  x: number;
  y: number;
  initial: string;
  current?: string;
}

interface ReorderVisual {
  name: string;
  ghostY: number;
  dropLineY: number | null;
  dropIntoId: number | null;
}

interface ReorderRef {
  trackId: number;
  startY: number;
  started: boolean;
  /** flat insertion index into project.tracks (pre-removal) */
  insertIndex: number;
  insertParentId: number | undefined;
  dropIntoId: number | null;
  /** folder with descendants — the drag is refused once the threshold is crossed */
  blocked: boolean;
}

interface HeightDragRef {
  trackId: number;
  startClientY: number;
  startH: number;
  h: number;
}

export default function TrackHeaders({
  rows,
  scrollY,
  topSpacerHeight = 0,
  collapsedFolders,
  onToggleFolder,
  onHeightPreview,
  vScale,
}: TrackHeadersProps) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const registry = useStore((s) => s.registry);
  const lanesExpanded = useAutomationUi((s) => s.expanded);
  const takesExpanded = useTakesUi((s) => s.expanded);
  // "Is this track's instrument loading right now" — one hook for every row.
  const instrumentBusy = useInstrumentBusyCheck();

  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [reorderVis, setReorderVis] = useState<ReorderVisual | null>(null);
  const [dropTrackId, setDropTrackId] = useState<number | null>(null);
  // Column width is user-resizable (right-edge drag; double-click resets) and persists.
  // Bounds mirror .tl-left min/max-width in timeline.css.
  const [headerW, setHeaderW] = usePrefState("ui.trackHeaderW", HEADER_W, numberIn(140, 420));

  const headersRef = useRef<HTMLDivElement | null>(null);
  const reorderRef = useRef<ReorderRef | null>(null);
  const heightRef = useRef<HeightDragRef | null>(null);
  const dropDepthRef = useRef(0);

  const trackRows = rows.filter((r): r is TrackRowL => r.kind === "track");

  /* ------------------------------------------------------------ reorder drag */

  const contentY = (clientY: number): number => {
    const el = headersRef.current;
    const top = el ? el.getBoundingClientRect().top : 0;
    return clientY - top + scrollY;
  };

  const updateReorderTarget = (clientY: number): void => {
    const d = reorderRef.current;
    if (!d || !project) return;
    const y = contentY(clientY);
    const draggedTrack = project.tracks.find((t) => t.id === d.trackId);
    const name = draggedTrack?.name ?? "Track";

    let dropIntoId: number | null = null;
    let dropLineY: number | null = null;
    let insertIndex = project.tracks.length;
    let insertParentId: number | undefined = undefined;

    const last = trackRows[trackRows.length - 1];
    if (last && y >= last.top + last.height) {
      dropLineY = last.top + last.height;
    } else {
      // last track row starting at or above y — covers y inside a row band AND y over an
      // automation lane band (lanes sit below the track row they belong to, so a lane hit
      // resolves to that track and the after-row branch below). Only when y is above the
      // first row does this fall back to trackRows[0].
      const row =
        trackRows.reduce<TrackRowL | null>((acc, r) => (r.top <= y ? r : acc), null) ??
        trackRows[0] ??
        null;
      if (row) {
        const t = row.track;
        const invalid = t.id === d.trackId || isDescendantOf(project, t.id, d.trackId);
        if (
          !invalid &&
          t.kind === "folder" &&
          y >= row.top + row.height * 0.3 &&
          y <= row.top + row.height * 0.7
        ) {
          dropIntoId = t.id;
        } else if (!invalid) {
          if (y < row.top + row.height / 2) {
            insertIndex = row.flatIndex;
            dropLineY = row.top;
          } else if (t.kind === "folder") {
            // Below a folder header "after" means after its whole SUBTREE: a track landing
            // between the header and its children would break the contiguity the indent
            // promises (and would survive a collapse of the folder, visibly stranded).
            let end = row.flatIndex + 1;
            while (
              end < project.tracks.length &&
              isDescendantOf(project, project.tracks[end].id, t.id)
            ) {
              end++;
            }
            insertIndex = end;
            // ...and the line under the last VISIBLE descendant — the folder's own bottom
            // edge when it is collapsed or empty
            const lastVisible = trackRows.reduce<TrackRowL>(
              (acc, r) => (isDescendantOf(project, r.track.id, t.id) ? r : acc),
              row,
            );
            dropLineY = lastVisible.top + lastVisible.height;
          } else {
            insertIndex = row.flatIndex + 1;
            dropLineY = row.top + row.height;
          }
          insertParentId = t.parentId;
        } else {
          // over self / own descendants — no valid target
          setReorderVis({ name, ghostY: y - scrollY - 11, dropLineY: null, dropIntoId: null });
          d.dropIntoId = null;
          d.insertIndex = -1;
          return;
        }
      }
    }

    d.dropIntoId = dropIntoId;
    d.insertIndex = dropIntoId !== null ? -1 : insertIndex;
    d.insertParentId = insertParentId;
    setReorderVis({
      name,
      ghostY: y - scrollY - 11,
      dropLineY: dropLineY !== null ? dropLineY - scrollY : null,
      dropIntoId,
    });
  };

  const onRowPointerDown = (e: React.PointerEvent<HTMLDivElement>, row: TrackRowL): void => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    reorderRef.current = {
      trackId: row.track.id,
      startY: e.clientY,
      started: false,
      insertIndex: -1,
      insertParentId: undefined,
      dropIntoId: null,
      // cmd/track.reorder erases and re-inserts exactly ONE track, so it cannot express
      // "move the folder with its subtree" — the children would stay put, stranded under a
      // folder that is no longer above them (and the contiguity the drop math assumes would
      // be broken). Faking it with one command per descendant is neither atomic nor one
      // undo step, so a populated folder simply refuses to be dragged.
      blocked:
        row.track.kind === "folder" &&
        !!project?.tracks.some((x) => isDescendantOf(project, x.id, row.track.id)),
    };
    // NO pointer capture yet: capture retargets the browser's click/dblclick to the
    // row, which silently killed double-click-to-rename on the name span. Capture is
    // taken only once the reorder drag actually starts (threshold crossed).
  };

  const onRowPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = reorderRef.current;
    if (!d) return;
    if (!d.started) {
      if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      if (d.blocked) {
        // Say why rather than showing a drop line for a move that would strand the children.
        reorderRef.current = null;
        showToast(
          "A folder that contains tracks can't be reordered — move its tracks out first.",
          "info",
        );
        return;
      }
      d.started = true;
      e.currentTarget.setPointerCapture(e.pointerId); // keep the drag alive off-row
    }
    updateReorderTarget(e.clientY);
  };

  const onRowPointerUp = (e: React.PointerEvent<HTMLDivElement>, row: TrackRowL): void => {
    const d = reorderRef.current;
    reorderRef.current = null;
    setReorderVis(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!d || !project) return;

    if (!d.started) {
      // Plain click selects one; Ctrl/Cmd toggles; Shift selects the visible range
      // from the stable anchor; Ctrl/Cmd+Shift adds that range.
      // setSelection MERGES: a surviving clip selection would send M/S-style keys down the
      // clip branch instead of the tracks just clicked, so BOTH branches replace the whole
      // selection — building a multi-track selection with ctrl is no different.
      const toggle = e.ctrlKey || e.metaKey;
      selectTrack(
        row.track.id,
        trackRows.map((r) => r.track.id),
        { toggle: toggle && !e.shiftKey, range: e.shiftKey, additiveRange: toggle && e.shiftKey },
      );
      return;
    }

    // The engine REMOVES the dragged track before inserting (cmd/track.reorder), so every
    // index computed against the current (pre-removal) list shifts down by one when the
    // source sat above it. Both branches below must compensate, or the same drop lands in
    // a different slot depending on which side the drag came from.
    const dragIdx = project.tracks.findIndex((t) => t.id === d.trackId);
    const compensate = (idx: number): number => (dragIdx >= 0 && idx > dragIdx ? idx - 1 : idx);

    if (d.dropIntoId !== null) {
      const folderRow = trackRows.find((r) => r.track.id === d.dropIntoId);
      if (folderRow) {
        fire(reorderTrack(d.trackId, compensate(folderRow.flatIndex + 1), d.dropIntoId));
        // A collapsed folder hides what it just accepted — the row would simply vanish,
        // so expand it and let the user see where the track went.
        if (collapsedFolders.has(d.dropIntoId)) onToggleFolder(d.dropIntoId);
      }
      return;
    }
    if (d.insertIndex < 0) return; // no valid target
    fire(reorderTrack(d.trackId, compensate(d.insertIndex), d.insertParentId));
  };

  /* ------------------------------------------------------------- height drag */

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>, row: TrackRowL): void => {
    if (e.button !== 0) return;
    if (isViewRowKind(row.track.kind)) return; // view rows are fixed height
    e.stopPropagation();
    heightRef.current = {
      trackId: row.track.id,
      startClientY: e.clientY,
      startH: row.height,
      h: row.height,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = heightRef.current;
    if (!d) return;
    // MIN/MAX_TRACK_H bound the STORED height; the preview is display px, so scale them
    // by vScale too — otherwise the row snaps at pointer-up to what the commit clamp allows.
    d.h = clamp(
      d.startH + (e.clientY - d.startClientY),
      Math.max(MIN_TRACK_H, Math.round(MIN_TRACK_H * vScale)),
      Math.min(MAX_TRACK_H, Math.round(MAX_TRACK_H * vScale)),
    );
    onHeightPreview({ trackId: d.trackId, height: d.h });
  };

  const onResizePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = heightRef.current;
    heightRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onHeightPreview(null);
    if (!d || d.h === d.startH) return;
    const stored = clamp(Math.round(d.h / Math.max(1e-6, vScale)), MIN_TRACK_H, MAX_TRACK_H);
    fire(setTrack(d.trackId, { height: stored }));
  };

  /* --------------------------------------------- browser / OS drops on rows */

  const playheadBeat = (): number => transportBus.last?.beat ?? 0;

  // Plugin drops respect frozen (inserts are locked while frozen, SPEC §5.5); asset/file
  // drags stay accepted on every kind so the drop can explain a mismatch via toast.
  const rowAcceptsDrag = (dt: DataTransfer, t: Track): boolean => {
    if (hasPluginDrag(dt)) return !t.frozen;
    return hasAssetDrag(dt) || Array.from(dt.types).includes("Files");
  };

  const onRowDragEnter = (e: React.DragEvent<HTMLDivElement>, t: Track): void => {
    if (!rowAcceptsDrag(e.dataTransfer, t)) return;
    e.preventDefault();
    // one shared depth counter: dragenter on the next row fires before dragleave
    // on the previous one, so the count stays balanced across rows and children
    dropDepthRef.current++;
    setDropTrackId(t.id);
  };

  const onRowDragOver = (e: React.DragEvent<HTMLDivElement>, t: Track): void => {
    if (!rowAcceptsDrag(e.dataTransfer, t)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onRowDragLeave = (): void => {
    if (dropDepthRef.current > 0) dropDepthRef.current--;
    if (dropDepthRef.current === 0) setDropTrackId(null);
  };

  const onRowDrop = (e: React.DragEvent<HTMLDivElement>, t: Track): void => {
    dropDepthRef.current = 0;
    setDropTrackId(null);
    const dt = e.dataTransfer;
    const plug = readPluginDrag(dt);
    if (plug) {
      e.preventDefault();
      e.stopPropagation();
      if (t.frozen) return;
      const info = registry.find((r) => r.uid === plug.uid);
      if (t.kind === "midi") {
        if (info?.isInstrument) {
          openInstrumentDropChoices(t.id, info, e.clientX, e.clientY);
        } else {
          showToast(
            "MIDI tracks can't host effect plugins — drop it on an instrument or audio track.",
            "info",
          );
        }
        return;
      }
      // Instrument onto an instrument track = REPLACE the loaded instrument, not stack.
      if (info?.isInstrument && t.kind === "instrument") {
        replaceInstrumentOn(t.id, info);
        return;
      }
      fire(addPlugin(t.id, plug.uid));
      return;
    }
    const asset = readAssetDrag(dt);
    if (asset) {
      e.preventDefault();
      e.stopPropagation();
      if (trackAcceptsClip(t, "audio")) {
        fire(addAudioClip(t.id, playheadBeat(), asset.assetId));
      } else {
        showToast("Audio files can only be dropped on audio tracks", "info");
      }
      return;
    }
    const files = Array.from(dt.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      // A dropped .cpr is a whole project, not media — a browser drop has no file path
      // for project/importForeign, so keep it away from the audio decoder (same rule as
      // the canvas drop path).
      const projExts = await projectOnlyExtensions();
      const media = files.filter((f) => !projExts.has(extensionOf(f.name)));
      if (media.length < files.length)
        showToast("To open a project file, use File → Import Project.", "info");
      if (media.length > 0) await uploadFiles(media, { trackId: t.id, atBeat: playheadBeat() });
    })().catch((err) => {
      console.warn("[timeline] header drop import failed:", err);
      showToast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    });
  };

  /* ------------------------------------------------------- automation lanes */

  const toggleLanes = (t: Track): void => {
    const ui = useAutomationUi.getState();
    const on = ui.expanded.has(t.id);
    // expansion must never be a no-op: with no automation at all, show a volume lane
    if (!on && t.automation.length === 0 && (ui.extraLanes.get(t.id) ?? []).length === 0) {
      ui.addExtraLane(t.id, "volume");
    }
    ui.setExpanded(t.id, !on);
  };

  const laneVisible = (t: Track, ref: string): boolean =>
    t.automation.some((l) => l.paramRef === ref) ||
    (useAutomationUi.getState().extraLanes.get(t.id) ?? []).includes(ref);

  const openLanePicker = (t: Track, x: number, y: number): void => {
    // resolve plugin params first (cached after the first ask), then open the menu
    void Promise.all(
      t.inserts.map((ins) => pluginParamsFor(ins).catch(() => null)),
    ).then((paramLists) => {
      const entry = (label: string, ref: string): MenuEntry => ({
        label,
        checked: laneVisible(t, ref),
        disabled: laneVisible(t, ref),
        onClick: () => {
          const ui = useAutomationUi.getState();
          ui.addExtraLane(t.id, ref);
          ui.setExpanded(t.id, true);
        },
      });
      const items: MenuEntry[] = [
        entry("Volume", "volume"),
        entry("Pan", "pan"),
        ...t.sends.map((_s, i) => entry(`Send ${i + 1}`, `send:${i}`)),
      ];
      if (t.inserts.length > 0) items.push("separator");
      t.inserts.forEach((ins, k) => {
        const params = paramLists[k];
        items.push({
          label: ins.name,
          icon: "plugin",
          submenu:
            params === null
              ? [{ label: "Parameters unavailable", disabled: true }]
              : params.length === 0
                ? [{ label: "No parameters", disabled: true }]
                : params.map((p) => entry(p.name, `plugin:${ins.instanceId}:${p.id}`)),
        });
      });
      openContextMenu(x, y, items);
    });
  };

  const removeLane = (row: LaneRowL): void => {
    const t = row.track;
    const ui = useAutomationUi.getState();
    const isEngineLane = t.automation.some((l) => l.paramRef === row.paramRef);
    const collapseIfEmpty = (): void => {
      if (
        !t.automation.some((l) => l.paramRef !== row.paramRef) &&
        (useAutomationUi.getState().extraLanes.get(t.id) ?? []).length === 0
      ) {
        ui.setExpanded(t.id, false); // nothing left — don't leave the toggle stuck on
      }
    };
    if (row.points.length === 0) {
      if (isEngineLane) {
        // legacy point-less lane in track.automation (older save) — an emptying set
        // makes the engine prune it (cmd/automation.set removes zero-point lanes)
        fire(setAutomation(t.id, row.paramRef, { remove: [] }));
      }
      // client-side extra lane (or a stale extra entry shadowed by the engine lane)
      ui.removeExtraLane(t.id, row.paramRef);
      collapseIfEmpty();
      return;
    }
    const spec = paramSpecFor(row.paramRef, t);
    const n = row.points.length;
    void confirmDialog({
      title: "Remove automation lane",
      message: `Remove ${spec.label} automation and its ${n} point${n === 1 ? "" : "s"}? This can be undone.`,
      confirmLabel: "Remove",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      // removing every point empties the lane → the engine prunes it from track.automation
      fire(setAutomation(t.id, row.paramRef, { remove: row.points.map((p) => p.id) }));
      ui.removeExtraLane(t.id, row.paramRef);
      collapseIfEmpty();
    });
  };

  /* ----------------------------------------------- instrument row (3rd row) */

  const isLiveInstrument = (uid: string): boolean => {
    const info = registry.find((p) => p.uid === uid);
    return info ? info.isInstrument : false;
  };

  /**
   * The track's instrument insert. Registry-confirmed instruments win; a dormant
   * imported insert (path "", uid unknown to the registry) in the FIRST slot counts
   * too on instrument tracks — otherwise picking from the menu would ADD a second
   * instrument in front of it instead of replacing it.
   */
  const instrumentInsertOf = (t: Track) => {
    const known = t.inserts.find((ins) => isLiveInstrument(ins.uid));
    if (known) return known;
    const first = t.inserts[0];
    if (first && !registry.some((p) => p.uid === first.uid)) return first;
    return undefined;
  };

  /** Favorite-instruments menu (falls back to all instruments); `pick` runs on click. */
  const instrumentMenuItems = (
    current: { uid: string; path: string } | undefined,
    pick: (p: PluginInfo) => void,
  ): MenuEntry[] => {
    // Favourites live in lib/ids alongside pluginKey. Reading the pref by hand here is
    // what made this picker go blank when the key format changed — four readers had each
    // spelled the rule themselves.
    const favKeys = new Set(loadPluginFavorites());
    const isFav = (p: PluginInfo): boolean => isPluginFavorite(favKeys, p);
    const instruments = registry.filter((p) => p.isInstrument && !p.blacklisted);
    const entryFor = (p: PluginInfo): MenuEntry => ({
      label: p.name,
      icon: "piano",
      // Cosmetic mark for the picker as opened; the CLICK path re-resolves fresh.
      checked: current?.uid === p.uid && (!current.path || current.path === p.path),
      onClick: () => pick(p),
    });
    const favs = instruments.filter(isFav).sort((a, b) => a.name.localeCompare(b.name));
    const items: MenuEntry[] = favs.map(entryFor);
    if (items.length === 0) {
      // Nothing starred yet — stay useful: offer the (deduped) instrument list instead.
      items.push({ label: "No favorite instruments — ★ some in Browser → Plugins", disabled: true });
      const all = groupPluginVariants(
        instruments.slice().sort((a, b) => a.name.localeCompare(b.name)),
      ).plugins.slice(0, 20);
      if (all.length > 0) items.push("separator", ...all.map(entryFor));
    }
    return items;
  };

  /**
   * The instrument row is click-to-pick / double-click-to-edit, so the picker opens on a
   * timer the second click cancels — same 230 ms split the mixer's insert slots use, and
   * the same "native window if it has one, else the in-app editor" resolution
   * (openBestEditor). A dormant or missing instrument has nothing to open: the double
   * click then just falls through to the picker.
   */
  const instClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelInstClick = (): void => {
    if (instClickTimer.current) {
      clearTimeout(instClickTimer.current);
      instClickTimer.current = null;
    }
  };
  const deferInstClick = (open: () => void): void => {
    cancelInstClick();
    instClickTimer.current = setTimeout(() => {
      instClickTimer.current = null;
      open();
    }, 230);
  };
  /** Double-click on an instrument dropdown: open the plugin's editor. */
  const openInstrumentEditor = (host: Track, fallback: () => void): void => {
    cancelInstClick();
    const ins = instrumentInsertOf(host);
    if (ins) void openBestEditor(ins);
    else fallback();
  };

  const openInstrumentPicker = (t: Track, x: number, y: number): void => {
    const current = instrumentInsertOf(t);
    // replaceInstrumentOn re-resolves live state at click time (menus are imperative —
    // a projectChanged between open and click must not double-apply).
    openContextMenu(x, y, instrumentMenuItems(current, (p) => replaceInstrumentOn(t.id, p)));
  };

  /**
   * Unrouted MIDI track (no midiTarget — e.g. an imported .cpr whose rack connection
   * is dead): picking an instrument CREATES an Instrument track hosting it and routes
   * this track's MIDI into it — "assign a VST to a midi channel" in one gesture.
   */
  const openFeederAssignPicker = (t: Track, x: number, y: number): void => {
    const liveProject = useStore.getState().project;
    if (!liveProject) return;
    const hosts = liveProject.tracks.filter((x) => x.kind === "instrument");
    const liveFeeder = liveProject.tracks.find((x) => x.id === t.id) ?? t;
    const currentTarget = liveProject.tracks.find((x) => x.id === liveFeeder.midiTarget);
    const existing: MenuEntry[] = hosts.map((host) => {
      const ins = instrumentInsertOf(host);
      const feeders = instrumentFeeders(liveProject, host.id).length;
      return {
        label: `${host.name}${ins ? ` · ${ins.name}` : " · no VST"} · ${feeders} track${feeders === 1 ? "" : "s"}`,
        icon: "piano",
        checked: currentTarget?.id === host.id,
        onClick: () => routeMidiToInstrument(t.id, host.id),
      };
    });
    openContextMenu(x, y, [
      {
        label: "None",
        checked: !currentTarget,
        onClick: () => routeMidiToInstrument(t.id, 0),
      },
      ...(existing.length > 0
        ? (["separator", { label: "Existing Instruments", submenu: existing }] as MenuEntry[])
        : []),
      "separator",
      {
        label: "New Instrument…",
        icon: "plus",
        submenu: instrumentMenuItems(undefined, (p) => assignInstrumentToFeeder(t.id, p)),
      },
      "separator",
      {
        label: `MIDI Channel · ${liveFeeder.midiOutChannel ? liveFeeder.midiOutChannel : "Any"}`,
        submenu: [
          {
            label: "Any (as played)",
            checked: !liveFeeder.midiOutChannel,
            onClick: () => void setTrack(t.id, { midiOutChannel: 0 }),
          },
          "separator",
          ...Array.from({ length: 16 }, (_, i): MenuEntry => ({
            label: `Channel ${i + 1}`,
            checked: liveFeeder.midiOutChannel === i + 1,
            onClick: () => void setTrack(t.id, { midiOutChannel: i + 1 }),
          })),
        ],
      },
    ]);
  };

  /* ------------------------------------------------------------ context menu */

  const openRename = (track: Track, x: number, y: number): void => {
    setPopover({ kind: "rename", trackId: track.id, x, y, initial: track.name });
  };

  const openColor = (track: Track, x: number, y: number): void => {
    setPopover({ kind: "color", trackId: track.id, x, y, initial: "", current: track.color });
  };

  const onRowContextMenu = (e: React.MouseEvent, row: TrackRowL): void => {
    e.preventDefault();
    e.stopPropagation();
    const t = row.track;
    const x = e.clientX;
    const y = e.clientY;
    const freezable = t.kind === "audio" || t.kind === "midi" || t.kind === "instrument";
    const viewRow = isViewRowKind(t.kind);
    const group = selection.trackIds.includes(t.id) && selection.trackIds.length > 1
      ? (project?.tracks.filter((x) => selection.trackIds.includes(x.id)) ?? [t])
      : [t];
    const items: MenuEntry[] = [
      { label: "Add Track", icon: "plus", submenu: addTrackMenuItems(row.flatIndex + 1) },
      "separator",
      { label: "Rename…", icon: "pencil", onClick: () => openRename(t, x, y) },
      { label: "Color…", onClick: () => openColor(t, x, y) },
      {
        label: group.length > 1 ? `Duplicate ${group.length} Selected Tracks` : "Duplicate Track",
        // one view row of each kind per project — the engine refuses a second one
        disabled: viewRow,
        title: viewRow ? "View-row tracks cannot be duplicated (max one per project)" : undefined,
        onClick: () => {
          for (const track of group)
            if (!isViewRowKind(track.kind)) fire(duplicateTrack(track.id));
        },
      },
    ];
    if (freezable) {
      items.push("separator");
      if (t.frozen) {
        items.push({
          label: "Unfreeze Track",
          icon: "snowflake",
          onClick: () => fire(unfreezeTrack(t.id)),
        });
      } else {
        items.push({
          label: "Freeze Track",
          icon: "snowflake",
          onClick: () => fire(bounceTrack(t.id, true)),
        });
      }
      items.push({
        label: "Bounce to Audio",
        icon: "export",
        onClick: () => fire(bounceTrack(t.id, false)),
      });
      items.push({
        label: "Render in Place",
        icon: "audioWave",
        title:
          "Render this track through its insert chain onto a new audio track below (source muted)",
        disabled: t.clips.length === 0,
        onClick: () => fire(renderTrackInPlace(t.id)),
      });
    }
    items.push("separator", {
      label: group.length > 1 ? `Delete ${group.length} Selected Tracks` : "Delete Track",
      icon: "trash",
      danger: true,
      onClick: () => void confirmRemoveTracks(group.map((x) => x.id)),
    });
    openContextMenu(x, y, items);
  };

  /* ------------------------------------------------------------------ render */

  const renderRow = (row: TrackRowL) => {
    const t = row.track;
    const selected = selection.trackIds.includes(t.id);
    const actionTracks = selected && selection.trackIds.length > 1
      ? (project?.tracks.filter((x) => selection.trackIds.includes(x.id)) ?? [t])
      : [t];
    const groupToggle = (
      key: "mute" | "solo" | "recordArm" | "monitor" | "automationWrite" | "keepTakes",
      tracks: Track[],
    ) => {
      const compatible = key === "mute" || key === "solo"
        ? tracks.filter((x) => !isViewRowKind(x.kind))
        : tracks;
      const next = compatible.some((x) => !Boolean(x[key]));
      for (const x of compatible)
        if (Boolean(x[key]) !== next) fire(setTrack(x.id, { [key]: next }));
    };
    const showControls = row.height >= 44;
    const indent = 6 + row.depth * 14;
    const armable = t.kind === "audio" || t.kind === "midi" || t.kind === "instrument";
    // 3rd row: instrument picker — instrument tracks own an instrument; MIDI tracks
    // edit their HOST's instrument (routed) or assign one by creating + routing an
    // instrument track (unrouted). Needs the extra height to exist at all.
    const midiHost =
      t.kind === "midi" && t.midiTarget
        ? project?.tracks.find((x) => x.id === t.midiTarget)
        : undefined;
    const showInstRow =
      row.height >= 62 && showControls && (t.kind === "instrument" || t.kind === "midi");
    const instrumentInsert = t.kind === "instrument" ? instrumentInsertOf(t) : undefined;
    // Heavy samplers take seconds to load; without feedback AT THE CONTROL the user
    // re-picks and stacks work (Omer, 2026-08-07).
    const instBusy = instrumentBusy(t.id) || (midiHost ? instrumentBusy(midiHost.id) : false);
    return (
      <div
        key={t.id}
        className="tlh-row"
        style={{ top: row.top, height: row.height }}
        data-kind={t.kind}
        data-selected={selected ? "true" : undefined}
        data-drop-into={reorderVis?.dropIntoId === t.id ? "true" : undefined}
        data-droppable={dropTrackId === t.id ? "true" : undefined}
        onPointerDown={(e) => onRowPointerDown(e, row)}
        onPointerMove={onRowPointerMove}
        onPointerUp={(e) => onRowPointerUp(e, row)}
        onPointerCancel={() => {
          reorderRef.current = null;
          setReorderVis(null);
        }}
        // Empty row area (not the name, not a control): double-click inspects the track.
        // Only the TAB switches — a collapsed Browser stays collapsed (switches "hiddenly").
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, .tlh-name")) return;
          useStore.getState().setPanels({ browserTab: "inspector" });
        }}
        onContextMenu={(e) => onRowContextMenu(e, row)}
        onDragEnter={(e) => onRowDragEnter(e, t)}
        onDragOver={(e) => onRowDragOver(e, t)}
        onDragLeave={onRowDragLeave}
        onDrop={(e) => onRowDrop(e, t)}
      >
        <button
          type="button"
          className="tlh-color-strip"
          style={{ background: t.color }}
          aria-label="Track color"
          title="Track color"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openColor(t, r.right + 4, r.top);
          }}
        />
        <div className="tlh-row-top" style={{ paddingLeft: indent }}>
          {t.kind === "folder" && (
            <button
              type="button"
              className="tlh-chevron"
              aria-label={collapsedFolders.has(t.id) ? "Expand folder" : "Collapse folder"}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFolder(t.id);
              }}
            >
              <Icon name={collapsedFolders.has(t.id) ? "chevronRight" : "chevronDown"} size={12} />
            </button>
          )}
          <span className="tlh-kind-icon">
            <Icon name={trackKindIcon(t.kind)} size={13} />
          </span>
          <span
            className={"tlh-name" + (t.mute ? " dim" : "")}
            title="Double-click to rename"
            onDoubleClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openRename(t, r.left, r.top - 2);
            }}
          >
            {t.name}
          </span>
          {t.frozen && (
            <span className="tlh-badges" title="Frozen">
              <Icon name="snowflake" size={12} />
            </span>
          )}
        </div>
        {showControls && (
          <div className="tlh-row-controls" style={{ paddingLeft: indent }}>
            <Toggle
              on={t.mute}
              onChange={() => groupToggle("mute", actionTracks)}
              variant="danger"
              className="tlh-btn"
              tooltip="Mute (M)"
            >
              M
            </Toggle>
            <Toggle
              on={t.solo}
              onChange={() => groupToggle("solo", actionTracks)}
              variant="warn"
              className="tlh-btn"
              tooltip="Solo (S)"
            >
              S
            </Toggle>
            {armable && (
              <Toggle
                on={t.recordArm}
                onChange={() =>
                  groupToggle(
                    "recordArm",
                    actionTracks.filter(
                      (x) => x.kind === "audio" || x.kind === "midi" || x.kind === "instrument",
                    ),
                  )
                }
                variant="danger"
                className="tlh-btn"
                tooltip="Record arm"
              >
                R
              </Toggle>
            )}
            {t.kind === "audio" && (
              <Toggle
                on={t.monitor === true}
                onChange={() => groupToggle("monitor", actionTracks.filter((x) => x.kind === "audio"))}
                variant="ok"
                className="tlh-btn"
                icon="headphones"
                tooltip="Input monitoring"
              />
            )}
            {!isViewRowKind(t.kind) && (
              <Toggle
                on={t.automationWrite === true}
                onChange={() =>
                  groupToggle("automationWrite", actionTracks.filter((x) => !isViewRowKind(x.kind)))
                }
                variant="danger"
                className="tlh-btn"
                tooltip="Write automation (W) — while the transport rolls, this track's fader, pan and plugin knobs (including the plugin's own editor window) record automation at the playhead"
              >
                W
              </Toggle>
            )}
            <Toggle
              on={lanesExpanded.has(t.id)}
              onChange={() => toggleLanes(t)}
              className="tlh-btn"
              tooltip="Show automation lanes (A) — this only reveals the lanes; use W to record into them"
            >
              A
            </Toggle>
            {armable && (
              <Toggle
                on={t.keepTakes === true}
                onChange={() => groupToggle("keepTakes", actionTracks.filter((x) => x.kind === "audio" || x.kind === "midi" || x.kind === "instrument"))}
                variant="ok"
                className="tlh-btn"
                icon="layers"
                tooltip="Versions — while on, recording over this track's existing material keeps BOTH: each pass becomes a version on its own sub-row (the newest plays). Off = one track, clips just overlap."
              />
            )}
            {(t.takeFolders?.length ?? 0) > 0 && (
              <Toggle
                on={takesExpanded.has(t.id)}
                onChange={(v) => useTakesUi.getState().setExpanded(t.id, v)}
                className="tlh-btn tlh-takes-toggle"
                tooltip="Versions (T) — show every recorded version as sub-rows. Click one to make it the version that plays; right-click a version for Play This Version Too, Mute, or Flatten to collapse them back into one clip"
              >
                T
              </Toggle>
            )}
          </div>
        )}
        {showInstRow && (
          <div className="tlh-row-inst" style={{ paddingLeft: indent }}>
            {t.kind === "instrument" ? (
              <button
                type="button"
                className={"tlh-inst-btn" + (instBusy ? " busy" : "")}
                disabled={!!t.frozen || instBusy}
                title={
                  instBusy
                    ? "Loading the instrument — large sample libraries can take a while"
                    : t.frozen
                      ? "Track is frozen — unfreeze to change the instrument"
                      : "Click: change instrument (favorites) · double-click: open its editor"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  deferInstClick(() => openInstrumentPicker(t, r.left, r.bottom + 2));
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openInstrumentEditor(t, () => openInstrumentPicker(t, r.left, r.bottom + 2));
                }}
              >
                {instBusy ? (
                  <span className="tlh-inst-spin">
                    <Icon name="refresh" size={11} />
                  </span>
                ) : (
                  <Icon name="piano" size={11} />
                )}
                <span className="tlh-inst-name">
                  {instBusy ? "Loading…" : (instrumentInsert?.name ?? "Choose instrument…")}
                </span>
                <Icon name="chevronDown" size={10} className="tlh-inst-caret" />
              </button>
            ) : midiHost ? (
              // Routed feeder: the dropdown edits the instrument ON THE HOST track —
              // "assign a VST to this midi channel" without leaving the channel.
              <button
                type="button"
                className={"tlh-inst-btn" + (instBusy ? " busy" : "")}
                disabled={instBusy}
                title={
                  instBusy
                    ? "Loading the instrument — large sample libraries can take a while"
                    : midiHost.frozen
                      ? `Plays through "${midiHost.name}" (frozen host)`
                      : `Plays through "${midiHost.name}" — click to choose a destination, double-click to open its editor`
                }
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  deferInstClick(() => openFeederAssignPicker(t, r.left, r.bottom + 2));
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openInstrumentEditor(midiHost, () =>
                    openFeederAssignPicker(t, r.left, r.bottom + 2),
                  );
                }}
              >
                {instBusy ? (
                  <span className="tlh-inst-spin">
                    <Icon name="refresh" size={11} />
                  </span>
                ) : (
                  <Icon name="piano" size={11} />
                )}
                <span className="tlh-inst-name">
                  {instBusy
                    ? "Loading…"
                    : `→ ${midiHost.name} · ${t.midiOutChannel ? `Ch ${t.midiOutChannel}` : "Any"}`}
                </span>
                <Icon name="chevronDown" size={10} className="tlh-inst-caret" />
              </button>
            ) : (
              // Unrouted MIDI track (dead import connection): assign = create an
              // instrument track with the picked VST and route into it.
              <button
                type="button"
                className={"tlh-inst-btn" + (instBusy ? " busy" : "")}
                disabled={instBusy}
                title={
                  instBusy
                    ? "Loading the instrument — large sample libraries can take a while"
                    : "Choose an existing instrument instance or create a new one"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openFeederAssignPicker(t, r.left, r.bottom + 2);
                }}
              >
                {instBusy ? (
                  <span className="tlh-inst-spin">
                    <Icon name="refresh" size={11} />
                  </span>
                ) : (
                  <Icon name="piano" size={11} />
                )}
                <span className="tlh-inst-name">
                  {instBusy ? "Loading…" : "Instrument destination…"}
                </span>
                <Icon name="chevronDown" size={10} className="tlh-inst-caret" />
              </button>
            )}
          </div>
        )}
        {/* fixed-height view rows get no handle at all — its row-resize cursor would
            advertise a drag the height logic refuses */}
        {!isViewRowKind(t.kind) && (
          <div
            className="tlh-resize"
            onPointerDown={(e) => onResizePointerDown(e, row)}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={() => {
              heightRef.current = null;
              onHeightPreview(null);
            }}
          />
        )}
      </div>
    );
  };

  const renderLane = (row: LaneRowL) => {
    const t = row.track;
    const spec = paramSpecFor(row.paramRef, t);
    return (
      <div
        key={`${t.id}:${row.paramRef}`}
        className="tlh-lane"
        style={{ top: row.top, height: row.height, paddingLeft: 10 + row.depth * 14 }}
      >
        <span className="tlh-lane-label" title={spec.label}>
          {spec.label}
        </span>
        <span className="tlh-lane-value">{spec.fmt(laneCurrentValue(t, row.paramRef))}</span>
        {/* Lane rows are a fixed height, so this is the only collapse affordance that
            survives a short track row (which hides the "A" toggle with the controls). */}
        <IconButton
          icon="chevronUp"
          size={18}
          tooltip="Collapse automation lanes"
          onClick={() => useAutomationUi.getState().setExpanded(t.id, false)}
        />
        <IconButton
          icon="plus"
          size={18}
          tooltip="Add automation lane"
          onClick={(e) => openLanePicker(t, e.clientX, e.clientY)}
        />
        <IconButton
          icon="x"
          size={18}
          tooltip={row.points.length > 0 ? "Remove lane (deletes its points)" : "Remove lane"}
          onClick={() => removeLane(row)}
        />
      </div>
    );
  };

  const renderTakeLane = (row: TakeLaneRowL) => {
    const t = row.track;
    // Label from the first folder that has this lane index ("Take N" fallback).
    const named = (t.takeFolders ?? []).find((f) => f.lanes[row.laneIndex]);
    const label = named?.lanes[row.laneIndex]?.name ?? `Take ${row.laneIndex + 1}`;
    return (
      <div
        key={`${t.id}:take:${row.laneIndex}`}
        className="tlh-lane tlh-takelane"
        style={{ top: row.top, height: row.height, paddingLeft: 10 + row.depth * 14 }}
      >
        <span
          className="tlh-takelane-chip"
          style={{ background: LANE_COLORS[row.laneIndex % LANE_COLORS.length] }}
        />
        <span className="tlh-lane-label" title={label}>
          {label}
        </span>
        <span className="grow" />
        {/* Fixed-height lane rows keep their own collapse — a short track row hides
            the "T" toggle with the controls (same rationale as automation lanes). */}
        {row.laneIndex === 0 && (
          <IconButton
            icon="chevronUp"
            size={18}
            tooltip="Collapse take lanes"
            onClick={() => useTakesUi.getState().setExpanded(t.id, false)}
          />
        )}
      </div>
    );
  };

  const popTrack = popover && project ? project.tracks.find((t) => t.id === popover.trackId) : null;

  return (
    <div className="tl-left" style={{ width: headerW, position: "relative" }}>
      {/* Keep the first track row aligned with the arrangement canvas when it has
          a strip above its ruler (such as the optional minimap). */}
      {topSpacerHeight > 0 && (
        <div className="tl-minimap-spacer" style={{ height: topSpacerHeight }} aria-hidden="true" />
      )}
      <div className="tl-corner" style={{ height: RULER_H }}>
        <span className="tl-corner-title">Tracks</span>
        <span className="grow" />
        {(() => {
          // Global M/S (group toggles, same semantics as the M/S keys): view rows have
          // no mixer strip and stay out of it. S doubles as the "clear all solos"
          // button — with solos active one click un-solos everything.
          const mixerTracks = (project?.tracks ?? []).filter((t) => !isViewRowKind(t.kind));
          const selectedIds = new Set(selection.trackIds);
          const heightTargets = selectedIds.size > 0
            ? mixerTracks.filter((t) => selectedIds.has(t.id))
            : mixerTracks;
          const folderTargets = (project?.tracks ?? []).filter(
            (t) => t.kind === "folder" && (selectedIds.size === 0 || selectedIds.has(t.id)),
          );
          const allFoldersCollapsed =
            folderTargets.length > 0 && folderTargets.every((t) => collapsedFolders.has(t.id));
          const allCompact =
            heightTargets.length > 0 &&
            heightTargets.every((t) => (t.height ?? DEFAULT_TRACK_H) <= MIN_TRACK_H);
          const anyUnmuted = mixerTracks.some((t) => !t.mute);
          const anySolo = mixerTracks.some((t) => t.solo);
          const muteAll = () => {
            for (const t of mixerTracks)
              if (t.mute !== anyUnmuted) fire(setTrack(t.id, { mute: anyUnmuted }));
          };
          const soloAll = () => {
            const solo = !anySolo;
            for (const t of mixerTracks)
              if (t.solo !== solo) fire(setTrack(t.id, { solo }));
          };
          const toggleCompact = () => {
            const height = allCompact ? DEFAULT_TRACK_H : MIN_TRACK_H;
            for (const t of heightTargets)
              if ((t.height ?? DEFAULT_TRACK_H) !== height) fire(setTrack(t.id, { height }));
          };
          const toggleFolders = () => {
            for (const t of folderTargets) {
              if (collapsedFolders.has(t.id) === allFoldersCollapsed) onToggleFolder(t.id);
            }
          };
          return (
            <>
              <IconButton
                icon="folder"
                size={20}
                active={allFoldersCollapsed}
                disabled={folderTargets.length === 0}
                tooltip={
                  selectedIds.size > 0
                    ? allFoldersCollapsed
                      ? "Expand selected group tracks"
                      : "Collapse selected group tracks"
                    : allFoldersCollapsed
                      ? "Expand all group tracks"
                      : "Collapse all group tracks"
                }
                onClick={toggleFolders}
              />
              <IconButton
                icon={allCompact ? "chevronDown" : "chevronUp"}
                size={20}
                active={allCompact}
                disabled={heightTargets.length === 0}
                tooltip={
                  selectedIds.size > 0
                    ? allCompact
                      ? "Restore selected tracks"
                      : "Make selected tracks thin"
                    : allCompact
                      ? "Restore all tracks"
                      : "Make all tracks thin"
                }
                onClick={toggleCompact}
              />
              <Toggle
                on={mixerTracks.length > 0 && !anyUnmuted}
                onChange={muteAll}
                variant="danger"
                className="tlh-btn"
                tooltip={anyUnmuted ? "Mute ALL tracks" : "Unmute ALL tracks"}
              >
                M
              </Toggle>
              <Toggle
                on={anySolo}
                onChange={soloAll}
                variant="warn"
                className="tlh-btn"
                tooltip={anySolo ? "Clear ALL solos" : "Solo ALL tracks"}
              >
                S
              </Toggle>
            </>
          );
        })()}
        <IconButton
          icon="plus"
          size={22}
          tooltip="Add track"
          disabled={!project}
          onClick={(e) => openContextMenu(e.clientX, e.clientY, addTrackMenuItems())}
        />
      </div>
      <div
        className="tl-headers"
        ref={headersRef}
        onPointerDown={(e) => {
          // Empty space in the TRACK LIST is the one place that clears the track
          // selection (2026-08-11, Omer). The arrangement canvas deliberately no longer
          // does it — clicking a clip or empty bar used to drop the selection, forcing a
          // re-select after almost every click mid-session. Rows/lanes handle their own
          // pointer-down and never reach here; Esc still clears everything.
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest?.(".tlh-row, .tlh-lane, .tlh-takelane")) return;
          if (useStore.getState().selection.trackIds.length === 0) return;
          setSelection({ trackIds: [], clipIds: [], noteIds: [], scope: "none" });
        }}
        onContextMenu={(e) => {
          // rows stopPropagation in their own handler — this is empty space / lane rows
          e.preventDefault();
          if (project) openContextMenu(e.clientX, e.clientY, addTrackMenuItems());
        }}
        onDoubleClick={(e) => {
          // double-click below the last track = quick add (rows/lanes handle their own)
          if (!project) return;
          if ((e.target as HTMLElement).closest?.(".tlh-row, .tlh-lane")) return;
          openContextMenu(e.clientX, e.clientY, addTrackMenuItems());
        }}
      >
        <div className="tl-headers-inner" style={{ transform: `translateY(${-scrollY}px)` }}>
          {rows.map((r) =>
            r.kind === "track" ? renderRow(r) : r.kind === "takelane" ? renderTakeLane(r) : renderLane(r),
          )}
        </div>
        {reorderVis && reorderVis.dropLineY !== null && (
          <div className="tlh-drop-line" style={{ top: reorderVis.dropLineY - 1 }} />
        )}
        {reorderVis && (
          <div className="tlh-drag-ghost" style={{ top: reorderVis.ghostY }}>
            <Icon name="dragHandle" size={12} />
            <span className="ellipsis" style={{ marginLeft: 6 }}>
              {reorderVis.name}
            </span>
          </div>
        )}
        {project && project.tracks.length === 0 && (
          <div className="tl-headers-hint">No tracks yet — right-click or use + to add one.</div>
        )}
        {!project && <div className="tl-headers-hint">No project loaded.</div>}
      </div>

      {popover && popover.kind === "color" && popTrack && (
        <ColorPopover
          x={popover.x}
          y={popover.y}
          current={popover.current}
          onPick={(color) => fire(setTrack(popover.trackId, { color }))}
          onClose={() => setPopover(null)}
        />
      )}
      {popover && popover.kind === "rename" && (
        <FloatingInput
          x={popover.x}
          y={popover.y}
          width={160}
          initial={popover.initial}
          placeholder="Track name"
          onCommit={(name) => {
            setPopover(null);
            const trimmed = name.trim();
            if (trimmed && trimmed !== popover.initial) {
              fire(setTrack(popover.trackId, { name: trimmed }));
            }
          }}
          onCancel={() => setPopover(null)}
        />
      )}

      {/* right-edge width drag (double-click resets to the default) */}
      <Resizer
        dir="v"
        style={{ position: "absolute", top: 0, bottom: 0, right: -2, margin: 0 }}
        onResize={(delta) => setHeaderW((w) => clamp(w + delta, 140, 420))}
        onReset={() => setHeaderW(HEADER_W)}
      />
    </div>
  );
}
