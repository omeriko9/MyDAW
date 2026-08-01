/**
 * Workspaces shell (docs/UI_ALTERNATIVES_PLAN.md §3) — named workspaces, each a
 * saved tiling arrangement of panes (recursive binary splits, max 4 leaves). The
 * strip above the work area lists them; Alt+1..9 switches (lib/keyboard). Every
 * tweak auto-persists (store → ui.shell.workspaces) — that is the difference from
 * classic layout presets, which are explicit snapshots. MenuBar and TransportBar
 * are kept verbatim; this shell replaces only the middle.
 */

import { useRef, useState } from "react";
import { useStore } from "../store/store";
import MenuBar from "../components/Transport/MenuBar";
import TransportBar from "../components/Transport/TransportBar";
import StatusBar from "../components/Transport/StatusBar";
import { contextMenuHandler } from "../components/common/ContextMenu";
import type { MenuEntry } from "../components/common/ContextMenu";
import { IconButton } from "../components/common/IconButton";
import { Resizer } from "../components/common/Resizer";
import { loadBoolPref } from "../lib/prefs";
import { showToast } from "../components/common/ToastHost";
import {
  PANE_IDS,
  WS_MAX_LEAVES,
  WS_MAX_WORKSPACES,
  WS_RATIO_MAX,
  WS_RATIO_MIN,
  freshWorkspaceId,
  removeLeafAt,
  replaceTilePane,
  splitLeafAt,
  swapTilePanes,
  tileLeaves,
  updateTileAt,
} from "./shellTypes";
import type { PaneId, TilePath, Workspace, WsTile } from "./shellTypes";
import { PANE_LABELS } from "./paneRegistry";
import { PaneHost } from "./PaneHost";
import { PanePicker } from "./PanePicker";
import { LeftBrowser, RightAgent } from "./flanks";
import { usePopouts } from "./popouts";
import type { PoppedOutTab } from "../store/store";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ============================================================================
 * Active-workspace helpers (all writes go through store.setWorkspaces)
 * ========================================================================= */

function useActiveWorkspace(): Workspace {
  const w = useStore((s) => s.workspaces);
  return w.list.find((x) => x.id === w.activeId) ?? w.list[0];
}

function patchActive(fn: (ws: Workspace) => Workspace): void {
  const s = useStore.getState();
  const w = s.workspaces;
  const list = w.list.map((x) => (x.id === w.activeId ? fn(x) : x));
  s.setWorkspaces({ ...w, list });
}

/* ============================================================================
 * Tiles
 * ========================================================================= */

function LeafView({ tile, path }: { tile: { pane: PaneId }; path: TilePath }) {
  const active = useActiveWorkspace();
  const leaves = tileLeaves(active.root);
  const poppedOut = useStore((s) => s.panels.poppedOut);
  const { popouts, popOut } = usePopouts();

  const unused = PANE_IDS.find((p) => !leaves.includes(p));
  const canSplit = leaves.length < WS_MAX_LEAVES && unused !== undefined;
  const splitTitle = canSplit
    ? undefined
    : leaves.length >= WS_MAX_LEAVES
      ? `A workspace holds at most ${WS_MAX_LEAVES} panes`
      : "Every pane is already in this workspace";

  const pick = (id: PaneId) => {
    if (id === tile.pane) return;
    patchActive((ws) => ({
      ...ws,
      root: leaves.includes(id)
        ? swapTilePanes(ws.root, tile.pane, id) // single-instance: swap the two leaves
        : replaceTilePane(ws.root, tile.pane, id),
    }));
  };

  const split = (dir: "row" | "col") => {
    if (!canSplit || unused === undefined) return;
    patchActive((ws) => ({ ...ws, root: splitLeafAt(ws.root, path, dir, unused) }));
  };

  const popBtn = () => {
    if (tile.pane === "timeline") return null;
    const tab = tile.pane as PoppedOutTab;
    return poppedOut[tab] ? (
      <IconButton
        icon="export"
        size={18}
        active
        tooltip="Dock back into the app"
        onClick={() => popouts[tab].close()}
      />
    ) : (
      <IconButton
        icon="export"
        size={18}
        tooltip="Pop out into a separate window"
        onClick={() => popOut(tab)}
      />
    );
  };

  return (
    <div className="ws-leaf">
      <div className="sp-head">
        <PanePicker value={tile.pane} others={leaves.filter((p) => p !== tile.pane)} onPick={pick} />
        <div className="grow" />
        {popBtn()}
        <IconButton
          icon="split"
          size={18}
          disabled={!canSplit}
          tooltip={splitTitle ?? "Split — new pane beside this one"}
          onClick={() => split("row")}
        />
        <IconButton
          icon="layers"
          size={18}
          disabled={!canSplit}
          tooltip={splitTitle ?? "Split — new pane below this one"}
          onClick={() => split("col")}
        />
        <IconButton
          icon="x"
          size={18}
          disabled={path.length === 0}
          tooltip={path.length === 0 ? "The last pane cannot close" : "Close this pane"}
          onClick={() => patchActive((ws) => ({ ...ws, root: removeLeafAt(ws.root, path) }))}
        />
      </div>
      <div className="sp-body">
        <PaneHost pane={tile.pane} />
      </div>
    </div>
  );
}

function TileView({ tile, path }: { tile: WsTile; path: TilePath }) {
  const ref = useRef<HTMLDivElement | null>(null);
  if ("pane" in tile) return <LeafView tile={tile} path={path} />;
  const row = tile.dir === "row";
  return (
    <div ref={ref} className={"ws-split " + (row ? "ws-row" : "ws-col")}>
      <div className="ws-cell" style={{ flex: `0 0 ${(tile.ratio * 100).toFixed(2)}%` }}>
        <TileView tile={tile.a} path={[...path, "a"]} />
      </div>
      <Resizer
        dir={row ? "v" : "h"}
        onResize={(delta) => {
          const el = ref.current;
          const size = el ? (row ? el.clientWidth : el.clientHeight) : 1;
          patchActive((ws) => ({
            ...ws,
            root: updateTileAt(ws.root, path, (t) =>
              "pane" in t
                ? t
                : { ...t, ratio: clamp(t.ratio + delta / Math.max(1, size), WS_RATIO_MIN, WS_RATIO_MAX) },
            ),
          }));
        }}
        onReset={() =>
          patchActive((ws) => ({
            ...ws,
            root: updateTileAt(ws.root, path, (t) => ("pane" in t ? t : { ...t, ratio: 0.5 })),
          }))
        }
      />
      <div className="ws-cell" style={{ flex: "1 1 0%" }}>
        <TileView tile={tile.b} path={[...path, "b"]} />
      </div>
    </div>
  );
}

/* ============================================================================
 * Workspace strip
 * ========================================================================= */

function WorkspaceStrip() {
  const w = useStore((s) => s.workspaces);
  const setWorkspaces = useStore((s) => s.setWorkspaces);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const commitRename = () => {
    if (renaming === null) return;
    const name = renaming.value.trim();
    if (name.length > 0) {
      setWorkspaces({
        ...w,
        list: w.list.map((x) => (x.id === renaming.id ? { ...x, name } : x)),
      });
    }
    setRenaming(null);
  };

  const add = () => {
    if (w.list.length >= WS_MAX_WORKSPACES) {
      showToast(`At most ${WS_MAX_WORKSPACES} workspaces (Alt+1..9)`, "info");
      return;
    }
    const id = freshWorkspaceId(w.list);
    const ws: Workspace = { id, name: "New", root: { pane: "timeline" } };
    setWorkspaces({ ...w, list: [...w.list, ws], activeId: id });
    setRenaming({ id, value: "New" });
  };

  const menuFor = (ws: Workspace): MenuEntry[] => [
    { label: "Rename", icon: "pencil", onClick: () => setRenaming({ id: ws.id, value: ws.name }) },
    {
      label: "Duplicate",
      icon: "plus",
      disabled: w.list.length >= WS_MAX_WORKSPACES,
      onClick: () => {
        const id = freshWorkspaceId(w.list);
        const copy: Workspace = { ...ws, id, name: `${ws.name} copy`, root: ws.root };
        setWorkspaces({ ...w, list: [...w.list, copy], activeId: id });
      },
    },
    {
      label: "Delete",
      icon: "trash",
      danger: true,
      disabled: w.list.length === 1,
      title: w.list.length === 1 ? "The last workspace cannot be deleted" : undefined,
      onClick: () => {
        const list = w.list.filter((x) => x.id !== ws.id);
        setWorkspaces({
          ...w,
          list,
          activeId: w.activeId === ws.id ? list[0].id : w.activeId,
        });
      },
    },
  ];

  return (
    <div className="ws-strip">
      {w.list.map((ws, i) => {
        if (renaming !== null && renaming.id === ws.id) {
          return (
            <input
              key={ws.id}
              className="ws-rename"
              value={renaming.value}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setRenaming({ id: ws.id, value: e.currentTarget.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenaming(null);
                e.stopPropagation();
              }}
            />
          );
        }
        return (
          <button
            key={ws.id}
            type="button"
            className="ws-tab"
            data-on={ws.id === w.activeId ? "true" : undefined}
            title={`${ws.name} — ${tileLeaves(ws.root).map((p) => PANE_LABELS[p]).join(" + ")}${i < 9 ? ` (Alt+${i + 1})` : ""}\nDouble-click to rename, right-click for more`}
            onClick={() => setWorkspaces({ ...w, activeId: ws.id })}
            onDoubleClick={() => setRenaming({ id: ws.id, value: ws.name })}
            onContextMenu={contextMenuHandler(() => menuFor(ws))}
          >
            {ws.name}
          </button>
        );
      })}
      <IconButton icon="plus" size={18} tooltip="New workspace" onClick={add} />
      <div className="grow" />
      <span className="ws-hint">Alt+1..9 switches · every change is saved</span>
    </div>
  );
}

/* ============================================================================
 * Shell
 * ========================================================================= */

export default function WorkspacesShell() {
  const active = useActiveWorkspace();
  const recording = useStore((s) => s.transport.state === "recording");
  const recordVisuals = recording && loadBoolPref("ui.recordVisuals", true);
  const { note: popoutNote } = usePopouts();

  return (
    <div className="app-frame" data-shell="workspaces">
      <MenuBar />
      <div className="app-root" data-recording={recordVisuals || undefined}>
        <TransportBar />
        <WorkspaceStrip />
        {popoutNote !== null && <div className="app-dock-note">{popoutNote}</div>}
        <div className="app-main">
          <LeftBrowser />
          <div className="app-center ws-area">
            {/* key on the workspace: switching remounts the tree cleanly */}
            <TileView key={active.id} tile={active.root} path={[]} />
          </div>
          <RightAgent />
        </div>
        <StatusBar />
      </div>
    </div>
  );
}
