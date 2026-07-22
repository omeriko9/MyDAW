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
  addTrack,
  addTrackVersion,
  bounceTrack,
  deleteTrackVersion,
  duplicateTrack,
  removePlugin,
  removeTrack,
  renameTrackVersion,
  reorderTrack,
  setAutomation,
  setTrack,
  switchTrackVersion,
  unfreezeTrack,
} from "../../store/actions";
import { groupPluginVariants } from "../../lib/pluginVariants";
import {
  hasAssetDrag,
  hasPluginDrag,
  readAssetDrag,
  readPluginDrag,
  uploadFiles,
} from "../../lib/dnd";
import { extensionOf, projectOnlyExtensions } from "../Transport/projectFlows";
import { loadPref, numberIn, usePrefState } from "../../lib/prefs";
import { Resizer } from "../common/Resizer";
import { showToast } from "../common/ToastHost";
import { pluginParamsFor, useAutomationUi } from "./automationUi";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { confirmDialog } from "../Dialogs/confirm";
import { Icon, type IconName } from "../common/icons";
import { Toggle } from "../common/Toggle";
import { IconButton } from "../common/IconButton";
import { ColorPopover, FloatingInput } from "./bits";
import {
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
  type TrackRowL,
} from "./layout";
import type { AddableTrackKind, PluginInfo, Track } from "../../protocol/types";

export const HEADER_W = 220;
const DRAG_THRESHOLD_PX = 4;

const fire = (p: Promise<unknown>): void => {
  p.catch((e) => console.warn("[timeline] command failed:", e));
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
];

export function addTrackMenuItems(index?: number): MenuEntry[] {
  return ADDABLE.map((a) => ({
    label: `Add ${a.label}`,
    icon: a.icon,
    onClick: () => fire(addTrack(a.kind, index !== undefined ? { index } : undefined)),
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
  kind: "color" | "rename" | "renameVersion";
  trackId: number;
  x: number;
  y: number;
  initial: string;
  current?: string;
  /** renameVersion only */
  versionId?: number;
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
      // plain click → select track (ctrl toggles)
      if (e.ctrlKey || e.metaKey) {
        const ids = selection.trackIds.includes(row.track.id)
          ? selection.trackIds.filter((id) => id !== row.track.id)
          : [...selection.trackIds, row.track.id];
        setSelection({ trackIds: ids });
      } else {
        setSelection({ trackIds: [row.track.id] });
      }
      return;
    }

    if (d.dropIntoId !== null) {
      const folderRow = trackRows.find((r) => r.track.id === d.dropIntoId);
      if (folderRow) {
        fire(reorderTrack(d.trackId, folderRow.flatIndex + 1, d.dropIntoId));
      }
      return;
    }
    if (d.insertIndex < 0) return; // no valid target
    const dragIdx = project.tracks.findIndex((t) => t.id === d.trackId);
    let newIndex = d.insertIndex;
    if (dragIdx >= 0 && newIndex > dragIdx) newIndex -= 1;
    fire(reorderTrack(d.trackId, newIndex, d.insertParentId));
  };

  /* ------------------------------------------------------------- height drag */

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>, row: TrackRowL): void => {
    if (e.button !== 0) return;
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
    d.h = clamp(d.startH + (e.clientY - d.startClientY), MIN_TRACK_H, MAX_TRACK_H);
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
      if (!t.frozen) fire(addPlugin(t.id, plug.uid));
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

  /* ------------------------------------------------------------ track versions */

  const versionable = (t: Track): boolean =>
    t.kind === "audio" || t.kind === "midi" || t.kind === "instrument";

  const switchVersion = (t: Track, versionId: number): void => {
    if (versionId === t.activeVersionId) return;
    // the visible clips are about to be replaced by the parked set — a lingering
    // clip/note selection would point at material that no longer exists on screen
    setSelection({ clipIds: [], noteIds: [] });
    fire(switchTrackVersion(t.id, versionId));
  };

  const versionMenuItems = (t: Track, x: number, y: number): MenuEntry[] => {
    const versions = t.versions ?? [];
    const frozen = !!t.frozen;
    const items: MenuEntry[] = versions.map((v) => ({
      label: v.name,
      checked: v.id === t.activeVersionId,
      disabled: frozen,
      onClick: () => switchVersion(t, v.id),
    }));
    if (items.length > 0) items.push("separator");
    items.push(
      {
        label: "New Version",
        icon: "plus",
        disabled: frozen,
        title: frozen ? "Unfreeze the track to work with versions" : "Start an empty alternative version of this track",
        onClick: () => {
          setSelection({ clipIds: [], noteIds: [] });
          fire(addTrackVersion(t.id));
        },
      },
      {
        label: "Duplicate Version",
        disabled: frozen,
        title: "New version starting as a copy of the current one",
        onClick: () => {
          setSelection({ clipIds: [], noteIds: [] });
          fire(addTrackVersion(t.id, { copy: true }));
        },
      },
    );
    const active = versions.find((v) => v.id === t.activeVersionId);
    if (active)
      items.push({
        label: "Rename Version…",
        icon: "pencil",
        onClick: () =>
          setPopover({ kind: "renameVersion", trackId: t.id, versionId: active.id, x, y, initial: active.name }),
      });
    const inactive = versions.filter((v) => v.id !== t.activeVersionId);
    if (inactive.length > 0)
      items.push({
        label: "Delete Version",
        icon: "trash",
        danger: true,
        submenu: inactive.map((v) => ({
          label: v.name,
          danger: true,
          onClick: () => {
            const n = v.clips.length;
            void confirmDialog({
              title: "Delete track version",
              message: `Delete version "${v.name}"${n > 0 ? ` and its ${n} clip${n === 1 ? "" : "s"}` : ""}? This can be undone.`,
              confirmLabel: "Delete",
              danger: true,
            }).then((ok) => {
              if (ok) fire(deleteTrackVersion(t.id, v.id));
            });
          },
        })),
      });
    return items;
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
    const favUids = loadPref<string[]>(
      "browser.pluginFavorites",
      [],
      (v) => Array.isArray(v) && v.every((e) => typeof e === "string"),
    );
    const instruments = registry.filter((p) => p.isInstrument && !p.blacklisted);
    const entryFor = (p: PluginInfo): MenuEntry => ({
      label: p.name,
      icon: "piano",
      // Cosmetic mark for the picker as opened; the CLICK path re-resolves fresh.
      checked: current?.uid === p.uid && (!current.path || current.path === p.path),
      onClick: () => pick(p),
    });
    const favs = instruments
      .filter((p) => favUids.includes(p.uid))
      .sort((a, b) => a.name.localeCompare(b.name));
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

  const openInstrumentPicker = (t: Track, x: number, y: number): void => {
    const current = instrumentInsertOf(t);
    openContextMenu(x, y, instrumentMenuItems(current, (p) => {
      // Menus are imperative — this runs later. Re-resolve the track and its
      // instrument from the live store so a projectChanged between open and click
      // (or a double-invoke) can't produce a duplicate add/remove pair.
      const proj = useStore.getState().project;
      const live = proj?.tracks.find((x2) => x2.id === t.id);
      if (!live || live.frozen) return;
      const cur = (() => {
        const known = live.inserts.find((ins) => isLiveInstrument(ins.uid));
        if (known) return known;
        const first = live.inserts[0];
        return first && !registry.some((r) => r.uid === first.uid) ? first : undefined;
      })();
      if (cur?.uid === p.uid) return; // already this instrument
      void (async () => {
        // No replace command in SPEC §5.6 — add at the same index, then remove the
        // old instance (which shifted to idx+1), exactly like the mixer's replace.
        const idx = cur ? live.inserts.findIndex((i) => i.instanceId === cur.instanceId) : 0;
        await addPlugin(live.id, p.uid, Math.max(0, idx));
        if (cur) await removePlugin(live.id, cur.instanceId);
      })().catch((e) => console.warn("[timeline] instrument replace failed:", e));
    }));
  };

  /**
   * Unrouted MIDI track (no midiTarget — e.g. an imported .cpr whose rack connection
   * is dead): picking an instrument CREATES an Instrument track hosting it and routes
   * this track's MIDI into it — "assign a VST to a midi channel" in one gesture.
   */
  const openFeederAssignPicker = (t: Track, x: number, y: number): void => {
    openContextMenu(x, y, instrumentMenuItems(undefined, (p) => {
      void (async () => {
        const { track: inst } = await addTrack("instrument");
        await setTrack(inst.id, { name: p.name });
        await addPlugin(inst.id, p.uid);
        await setTrack(t.id, { midiTarget: inst.id });
      })().catch((e) => console.warn("[timeline] assign instrument failed:", e));
    }));
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
    const items: MenuEntry[] = [
      { label: "Add Track", icon: "plus", submenu: addTrackMenuItems(row.flatIndex + 1) },
      "separator",
      { label: "Rename…", icon: "pencil", onClick: () => openRename(t, x, y) },
      { label: "Color…", onClick: () => openColor(t, x, y) },
      { label: "Duplicate Track", onClick: () => fire(duplicateTrack(t.id)) },
    ];
    if (versionable(t))
      items.push({ label: "Track Versions", icon: "layers", submenu: versionMenuItems(t, x, y) });
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
    }
    items.push("separator", {
      label: "Delete Track",
      icon: "trash",
      danger: true,
      onClick: () => {
        void confirmDialog({
          title: "Delete track",
          message: `Delete "${t.name}"${t.clips.length > 0 ? ` and its ${t.clips.length} clip${t.clips.length === 1 ? "" : "s"}` : ""}? This can be undone.`,
          confirmLabel: "Delete",
          danger: true,
        }).then((ok) => {
          if (ok) fire(removeTrack(t.id));
        });
      },
    });
    openContextMenu(x, y, items);
  };

  /* ------------------------------------------------------------------ render */

  const renderRow = (row: TrackRowL) => {
    const t = row.track;
    const selected = selection.trackIds.includes(t.id);
    const showControls = row.height >= 44;
    const indent = 6 + row.depth * 14;
    const armable = t.kind === "audio" || t.kind === "midi" || t.kind === "instrument";
    const activeVersion = t.versions?.find((v) => v.id === t.activeVersionId);
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
    return (
      <div
        key={t.id}
        className="tlh-row"
        style={{ top: row.top, height: row.height }}
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
          {activeVersion && (
            <button
              type="button"
              className="tlh-version-chip"
              title={`Track version: ${activeVersion.name} (${t.versions?.length ?? 0} total) — click to switch`}
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openContextMenu(r.left, r.bottom + 3, versionMenuItems(t, r.left, r.bottom + 3));
              }}
            >
              <Icon name="layers" size={10} />
              <span className="tlh-version-chip-name">{activeVersion.name}</span>
            </button>
          )}
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
              onChange={(v) => fire(setTrack(t.id, { mute: v }))}
              variant="danger"
              className="tlh-btn"
              tooltip="Mute (M)"
            >
              M
            </Toggle>
            <Toggle
              on={t.solo}
              onChange={(v) => fire(setTrack(t.id, { solo: v }))}
              variant="warn"
              className="tlh-btn"
              tooltip="Solo (S)"
            >
              S
            </Toggle>
            {armable && (
              <Toggle
                on={t.recordArm}
                onChange={(v) => fire(setTrack(t.id, { recordArm: v }))}
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
                onChange={(v) => fire(setTrack(t.id, { monitor: v }))}
                variant="ok"
                className="tlh-btn"
                icon="headphones"
                tooltip="Input monitoring"
              />
            )}
            <Toggle
              on={lanesExpanded.has(t.id)}
              onChange={() => toggleLanes(t)}
              className="tlh-btn"
              tooltip="Automation lanes"
            >
              A
            </Toggle>
          </div>
        )}
        {showInstRow && (
          <div className="tlh-row-inst" style={{ paddingLeft: indent }}>
            {t.kind === "instrument" ? (
              <button
                type="button"
                className="tlh-inst-btn"
                disabled={!!t.frozen}
                title={
                  t.frozen
                    ? "Track is frozen — unfreeze to change the instrument"
                    : "Change instrument (favorite instruments)"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openInstrumentPicker(t, r.left, r.bottom + 2);
                }}
              >
                <Icon name="piano" size={11} />
                <span className="tlh-inst-name">
                  {instrumentInsert?.name ?? "Choose instrument…"}
                </span>
                <Icon name="chevronDown" size={10} className="tlh-inst-caret" />
              </button>
            ) : midiHost ? (
              // Routed feeder: the dropdown edits the instrument ON THE HOST track —
              // "assign a VST to this midi channel" without leaving the channel.
              <button
                type="button"
                className="tlh-inst-btn"
                disabled={!!midiHost.frozen}
                title={
                  midiHost.frozen
                    ? `Plays through "${midiHost.name}" (frozen — unfreeze to change)`
                    : `Plays through "${midiHost.name}" — click to change its instrument`
                }
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openInstrumentPicker(midiHost, r.left, r.bottom + 2);
                }}
              >
                <Icon name="piano" size={11} />
                <span className="tlh-inst-name">
                  {`→ ${midiHost.name}${(() => {
                    const ins = instrumentInsertOf(midiHost);
                    return ins ? `: ${ins.name}` : "";
                  })()}`}
                </span>
                <Icon name="chevronDown" size={10} className="tlh-inst-caret" />
              </button>
            ) : (
              // Unrouted MIDI track (dead import connection): assign = create an
              // instrument track with the picked VST and route into it.
              <button
                type="button"
                className="tlh-inst-btn"
                title="This MIDI track has no instrument — pick one to create and route it"
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openFeederAssignPicker(t, r.left, r.bottom + 2);
                }}
              >
                <Icon name="piano" size={11} />
                <span className="tlh-inst-name">Assign instrument…</span>
                <Icon name="chevronDown" size={10} className="tlh-inst-caret" />
              </button>
            )}
          </div>
        )}
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
          {rows.map((r) => (r.kind === "track" ? renderRow(r) : renderLane(r)))}
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
      {popover && popover.kind === "renameVersion" && popover.versionId !== undefined && (
        <FloatingInput
          x={popover.x}
          y={popover.y}
          width={160}
          initial={popover.initial}
          placeholder="Version name"
          onCommit={(name) => {
            setPopover(null);
            const trimmed = name.trim();
            if (trimmed && trimmed !== popover.initial) {
              fire(renameTrackVersion(popover.trackId, popover.versionId!, trimmed));
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
