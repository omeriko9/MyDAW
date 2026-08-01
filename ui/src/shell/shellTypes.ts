/**
 * Shell types + pure helpers (docs/UI_ALTERNATIVES_PLAN.md) — shared by the three
 * UI shells (Classic / Ribbon / Workspaces) and the store.
 *
 * PURE module by contract: no store / component imports (store.ts imports THIS at
 * init time for pref restore, and importing anything with side effects here would
 * reorder module init — the store.ts lazy-import trap).
 */

/* ============================================================================
 * Modes + panes
 * ========================================================================= */

export type ShellMode = "classic" | "ribbon" | "workspaces";

export const SHELL_MODES: Array<{ value: ShellMode; label: string }> = [
  { value: "classic", label: "Classic" },
  { value: "ribbon", label: "Ribbon" },
  { value: "workspaces", label: "Workspaces" },
];

/** Every pane the shells can place. The panes themselves are unchanged components;
 *  "timeline" is only pinned-center in the CLASSIC shell — the other shells tile it
 *  like any other pane. */
export type PaneId =
  | "timeline"
  | "mixer"
  | "pianoRoll"
  | "clipEditor"
  | "sheetMusic"
  | "visualizer";

/** Panes that can live in the classic dock / pop out into their own window
 *  (structurally identical to the store's PoppedOutTab). */
export type DockPaneId = Exclude<PaneId, "timeline">;

export const PANE_IDS: PaneId[] = [
  "timeline",
  "mixer",
  "pianoRoll",
  "clipEditor",
  "sheetMusic",
  "visualizer",
];

export const PANE_LABELS: Record<PaneId, string> = {
  timeline: "Arrangement",
  mixer: "Mixer",
  pianoRoll: "Piano Roll",
  clipEditor: "Clip Editor",
  sheetMusic: "Sheet Music",
  visualizer: "Visualizer",
};

const isPaneId = (v: unknown): v is PaneId => PANE_IDS.includes(v as PaneId);

/* ============================================================================
 * Ribbon shell state (plan §2)
 * ========================================================================= */

export type RibbonCategory = "arrange" | "edit" | "mix" | "score" | "visualize" | "view";

export const RIBBON_CATEGORIES: RibbonCategory[] = [
  "arrange",
  "edit",
  "mix",
  "score",
  "visualize",
  "view",
];

/** Selecting a category makes this pane the primary slot ("view" keeps the current). */
export const RIBBON_CATEGORY_PANE: Partial<Record<RibbonCategory, PaneId>> = {
  arrange: "timeline",
  edit: "pianoRoll",
  mix: "mixer",
  score: "sheetMusic",
  visualize: "visualizer",
};

/** Reverse map for revealPane: which category "means" this pane. clipEditor has no
 *  category on purpose (plan §2.1) — it is revealed as the secondary slot. */
export const RIBBON_PANE_CATEGORY: Partial<Record<PaneId, RibbonCategory>> = {
  timeline: "arrange",
  pianoRoll: "edit",
  mixer: "mix",
  sheetMusic: "score",
  visualizer: "visualize",
};

export interface RibbonState {
  category: RibbonCategory;
  primary: PaneId;
  /** Second work-area slot; null = single pane. Never equals primary. */
  secondary: PaneId | null;
  /** "v" = vertical splitter (side by side), "h" = horizontal splitter (stacked). */
  orientation: "v" | "h";
  /** Primary slot's share of the split area. */
  split: number;
}

export const RIBBON_SPLIT_MIN = 0.15;
export const RIBBON_SPLIT_MAX = 0.85;

export const DEFAULT_RIBBON: RibbonState = {
  category: "arrange",
  primary: "timeline",
  secondary: null,
  orientation: "v",
  split: 0.5,
};

export function validRibbon(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const r = v as RibbonState;
  return (
    RIBBON_CATEGORIES.includes(r.category) &&
    isPaneId(r.primary) &&
    (r.secondary === null || (isPaneId(r.secondary) && r.secondary !== r.primary)) &&
    (r.orientation === "v" || r.orientation === "h") &&
    typeof r.split === "number" &&
    r.split >= RIBBON_SPLIT_MIN &&
    r.split <= RIBBON_SPLIT_MAX
  );
}

/* ============================================================================
 * Workspaces shell state (plan §3): named tiling trees
 * ========================================================================= */

/** Recursive binary split. "row" = children side by side, "col" = stacked. */
export type WsTile =
  | { pane: PaneId }
  | { dir: "row" | "col"; ratio: number; a: WsTile; b: WsTile };

export interface Workspace {
  id: string;
  name: string;
  root: WsTile;
}

export interface WorkspacesState {
  list: Workspace[];
  activeId: string;
}

/** Leaf cap — beyond 4 panes a DAW turns into a cockpit, and it bounds remount cost. */
export const WS_MAX_LEAVES = 4;
export const WS_MAX_WORKSPACES = 9; // Alt+1..9 switching

export const WS_RATIO_MIN = 0.1;
export const WS_RATIO_MAX = 0.9;

export function stockWorkspaces(): WorkspacesState {
  return {
    list: [
      { id: "ws-1", name: "Arrange", root: { pane: "timeline" } },
      { id: "ws-2", name: "Mix", root: { pane: "mixer" } },
      {
        id: "ws-3",
        name: "Edit",
        root: { dir: "col", ratio: 0.55, a: { pane: "timeline" }, b: { pane: "pianoRoll" } },
      },
      { id: "ws-4", name: "Score", root: { pane: "sheetMusic" } },
    ],
    activeId: "ws-1",
  };
}

/* ---- pure tree helpers ---- */

export function tileLeaves(t: WsTile): PaneId[] {
  return "pane" in t ? [t.pane] : [...tileLeaves(t.a), ...tileLeaves(t.b)];
}

/** Path from the root: which child to descend into at each split. [] = the root. */
export type TilePath = Array<"a" | "b">;

export function updateTileAt(root: WsTile, path: TilePath, fn: (t: WsTile) => WsTile): WsTile {
  if (path.length === 0) return fn(root);
  if ("pane" in root) return root; // stale path — tree changed under the caller
  const [head, ...rest] = path;
  return { ...root, [head]: updateTileAt(root[head], rest, fn) };
}

/** Split a leaf in two; the new pane takes the second half. */
export function splitLeafAt(
  root: WsTile,
  path: TilePath,
  dir: "row" | "col",
  pane: PaneId,
): WsTile {
  return updateTileAt(root, path, (t) =>
    "pane" in t ? { dir, ratio: 0.5, a: t, b: { pane } } : t,
  );
}

/** Remove a leaf — its sibling absorbs the space. Removing the only leaf is a no-op. */
export function removeLeafAt(root: WsTile, path: TilePath): WsTile {
  if (path.length === 0) return root;
  const side = path[path.length - 1];
  return updateTileAt(root, path.slice(0, -1), (t) =>
    "pane" in t ? t : side === "a" ? t.b : t.a,
  );
}

/** Swap two panes in place (single-instance invariant: picking an already-tiled pane
 *  in a picker swaps the two leaves instead of duplicating). */
export function swapTilePanes(root: WsTile, x: PaneId, y: PaneId): WsTile {
  if ("pane" in root)
    return root.pane === x ? { pane: y } : root.pane === y ? { pane: x } : root;
  return {
    ...root,
    a: swapTilePanes(root.a, x, y),
    b: swapTilePanes(root.b, x, y),
  };
}

/** Replace one pane with another (target must not already be in the tree). */
export function replaceTilePane(root: WsTile, from: PaneId, to: PaneId): WsTile {
  if ("pane" in root) return root.pane === from ? { pane: to } : root;
  return { ...root, a: replaceTilePane(root.a, from, to), b: replaceTilePane(root.b, from, to) };
}

function validTile(v: unknown, depth: number): boolean {
  if (v === null || typeof v !== "object" || depth > 6) return false;
  const t = v as WsTile;
  if ("pane" in t) return isPaneId(t.pane);
  return (
    (t.dir === "row" || t.dir === "col") &&
    typeof t.ratio === "number" &&
    t.ratio >= WS_RATIO_MIN &&
    t.ratio <= WS_RATIO_MAX &&
    validTile(t.a, depth + 1) &&
    validTile(t.b, depth + 1)
  );
}

export function validWorkspaces(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const w = v as WorkspacesState;
  if (!Array.isArray(w.list) || w.list.length === 0 || w.list.length > WS_MAX_WORKSPACES)
    return false;
  for (const ws of w.list) {
    if (ws === null || typeof ws !== "object") return false;
    if (typeof ws.id !== "string" || typeof ws.name !== "string") return false;
    if (!validTile(ws.root, 0)) return false;
    const leaves = tileLeaves(ws.root);
    if (leaves.length > WS_MAX_LEAVES) return false;
    if (new Set(leaves).size !== leaves.length) return false; // single-instance per workspace
  }
  return w.list.some((ws) => ws.id === w.activeId);
}

export function freshWorkspaceId(list: Workspace[]): string {
  let n = 0;
  for (const w of list) {
    const m = /^ws-(\d+)$/.exec(w.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `ws-${n + 1}`;
}

/* ============================================================================
 * Shell → keyboard-routing bridge
 * ========================================================================= */

/**
 * The dock-capable panes visible in the ACTIVE shell — published on
 * panels.shellPanes so lib/keyboard's paneVisible() follows the shell that is
 * actually on screen. undefined = classic shell (the dock fields rule as before).
 */
export function shellVisiblePanes(
  mode: ShellMode,
  ribbon: RibbonState,
  workspaces: WorkspacesState,
): DockPaneId[] | undefined {
  if (mode === "classic") return undefined;
  const panes: PaneId[] =
    mode === "ribbon"
      ? [ribbon.primary, ...(ribbon.secondary !== null ? [ribbon.secondary] : [])]
      : tileLeaves(
          (workspaces.list.find((w) => w.id === workspaces.activeId) ?? workspaces.list[0]).root,
        );
  return panes.filter((p): p is DockPaneId => p !== "timeline");
}
