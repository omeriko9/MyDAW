/**
 * Layout presets (UI_IMPROVE.md §6.3, owned by F4) — four snapshot slots of the
 * workspace shape: panel visibility (browser/agent/minimap/dock tabs incl. the
 * split-dock second slot) plus panel sizes. Apply with Ctrl+Alt+1..4, save with
 * Ctrl+Alt+Shift+1..4, both also in View → Layouts (and thereby the palette).
 *
 * Panels apply through the store; sizes live in App-local pref state, so they
 * travel via LAYOUT_SIZES_EVENT — App owns the clamps and setters.
 */

import { loadPref, savePref } from "./prefs";
import { useStore } from "../store/store";
import type { BottomTab, BrowserTab } from "../store/store";

export interface LayoutSizes {
  browserW: number;
  dockH: number;
  agentW: number;
  dockSplit: number;
}

export interface LayoutSnapshot {
  name: string;
  panels: {
    browser: boolean;
    browserTab: BrowserTab;
    minimap: boolean;
    agent: boolean;
    bottomTab: BottomTab;
    bottomTab2: BottomTab;
  };
  sizes: LayoutSizes;
}

export type LayoutSlotIndex = 1 | 2 | 3 | 4;

/** window CustomEvent<LayoutSizes> — App.tsx applies the sizes (it owns the clamps). */
export const LAYOUT_SIZES_EVENT = "mydaw:layoutsizes";

const PREF = "layouts.slots";

type Slots = [
  LayoutSnapshot | null,
  LayoutSnapshot | null,
  LayoutSnapshot | null,
  LayoutSnapshot | null,
];

const EMPTY: Slots = [null, null, null, null];

/** Loose shape check — malformed storage falls back to empty slots. */
function validSlots(v: unknown): boolean {
  if (!Array.isArray(v) || v.length !== 4) return false;
  return v.every(
    (s) =>
      s === null ||
      (typeof s === "object" &&
        typeof (s as LayoutSnapshot).name === "string" &&
        typeof (s as LayoutSnapshot).panels === "object" &&
        typeof (s as LayoutSnapshot).sizes === "object"),
  );
}

export function getLayoutSlots(): Slots {
  return loadPref<Slots>(PREF, EMPTY, validSlots);
}

const TAB_LABEL: Record<Exclude<BottomTab, null>, string> = {
  mixer: "Mixer",
  pianoRoll: "Piano Roll",
  clipEditor: "Clip Editor",
  sheetMusic: "Sheet Music",
  visualizer: "Visualizer",
};

function defaultName(p: LayoutSnapshot["panels"]): string {
  if (p.bottomTab === null) return "Arrange";
  const first = TAB_LABEL[p.bottomTab];
  return p.bottomTab2 !== null ? `${first} + ${TAB_LABEL[p.bottomTab2]}` : first;
}

export function saveLayoutSlot(i: LayoutSlotIndex): LayoutSnapshot {
  const p = useStore.getState().panels;
  const panels: LayoutSnapshot["panels"] = {
    browser: p.browser,
    browserTab: p.browserTab,
    minimap: p.minimap,
    agent: p.agent,
    bottomTab: p.bottomTab,
    bottomTab2: p.bottomTab2,
  };
  const snap: LayoutSnapshot = {
    name: defaultName(panels),
    panels,
    // Sizes are read from prefs (App saves them there, drag-debounced 300ms —
    // stale only if saved mid-drag, which the menu/shortcut path never is).
    sizes: {
      browserW: loadPref("ui.browserW", 280),
      dockH: loadPref("ui.dockH", 260),
      agentW: loadPref("ui.agentW", 420),
      dockSplit: loadPref("ui.dockSplit", 0.5),
    },
  };
  const slots = getLayoutSlots();
  slots[i - 1] = snap;
  savePref(PREF, slots);
  return snap;
}

export function applyLayoutSlot(i: LayoutSlotIndex): LayoutSnapshot | null {
  const snap = getLayoutSlots()[i - 1];
  if (!snap) return null;
  useStore.getState().setPanels({ ...snap.panels });
  window.dispatchEvent(new CustomEvent<LayoutSizes>(LAYOUT_SIZES_EVENT, { detail: snap.sizes }));
  return snap;
}
