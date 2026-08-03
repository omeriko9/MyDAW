/**
 * revealPane — make a dock-capable pane visible in WHATEVER shell is active. The
 * one place flows like "open the take in the Piano Roll" or the agent's
 * ui/layout.set go through, so they keep working when the user is not in the
 * classic shell (plan §3.5 mapping):
 *
 *   classic     open the dock on that tab (as before)
 *   ribbon      select the pane's category (primary) — clipEditor has no category,
 *               so it becomes the secondary slot
 *   workspaces  switch to a workspace containing the pane; if none has it, add a
 *               single-pane workspace for it (deterministic, never rewrites an
 *               existing arrangement behind the user's back)
 */

import { useStore } from "../store/store";
import { paneVisible } from "../lib/keyboard";
import {
  RIBBON_PANE_CATEGORY,
  WS_MAX_WORKSPACES,
  freshWorkspaceId,
  tileLeaves,
} from "./shellTypes";
import type { DockPaneId, PaneId, Workspace } from "./shellTypes";
import { PANE_LABELS } from "./shellTypes";

export function revealPane(pane: PaneId): void {
  const s = useStore.getState();

  // The arrangement: pinned-center in classic (always visible); a category/tile
  // elsewhere. DockPaneIds continue below.
  if (pane === "timeline") {
    if (s.shellMode === "ribbon") {
      if (s.ribbon.primary !== "timeline" && s.ribbon.secondary !== "timeline")
        s.setRibbon({ category: "arrange", primary: "timeline" });
    } else if (s.shellMode === "workspaces") {
      const w = s.workspaces;
      const active = w.list.find((x) => x.id === w.activeId);
      if (active && !tileLeaves(active.root).includes("timeline")) {
        const holder = w.list.find((x) => tileLeaves(x.root).includes("timeline"));
        if (holder) s.setWorkspaces({ ...w, activeId: holder.id });
      }
    }
    return;
  }

  const tab: DockPaneId = pane;
  if (paneVisible(s.panels, tab)) return; // on screen (or in its own window) already

  if (s.shellMode === "classic") {
    s.setPanels({ bottomTab: tab });
    return;
  }

  if (s.shellMode === "ribbon") {
    const cat = RIBBON_PANE_CATEGORY[tab];
    if (cat !== undefined) s.setRibbon({ category: cat, primary: tab });
    else s.setRibbon({ secondary: tab }); // clipEditor: reveal beside the current view
    return;
  }

  // workspaces
  const w = s.workspaces;
  const holder = w.list.find((x) => tileLeaves(x.root).includes(tab));
  if (holder) {
    s.setWorkspaces({ ...w, activeId: holder.id });
    return;
  }
  if (w.list.length >= WS_MAX_WORKSPACES) {
    // Full house and none holds the pane — reuse the active workspace's slot by
    // NOT mutating it; fall back to switching nothing rather than destroying a
    // user arrangement. (Reaching this needs 9 hand-built workspaces, none with
    // the pane — accept the no-op.)
    return;
  }
  const ws: Workspace = {
    id: freshWorkspaceId(w.list),
    name: PANE_LABELS[tab],
    root: { pane: tab },
  };
  useStore.getState().setWorkspaces({ ...w, list: [...w.list, ws], activeId: ws.id });
}

/** F3 semantics: toggle the Mixer dock in Classic; switch to/from it in other shells. */
export function toggleMixerPane(): void {
  const s = useStore.getState();
  if (s.shellMode === "classic") {
    const p = s.panels;
    if (p.bottomTab === "mixer") {
      if (p.bottomTab2 !== null)
        s.setPanels({ bottomTab: p.bottomTab2, bottomTab2: null });
      else s.setPanels({ bottomTab: null });
    } else if (p.bottomTab2 === "mixer") {
      s.setPanels({ bottomTab2: null });
    } else {
      s.setPanels({ bottomTab: "mixer" });
    }
    return;
  }

  if (s.shellMode === "ribbon") {
    const r = s.ribbon;
    if (r.primary === "mixer") {
      if (r.secondary !== null) {
        const next = r.secondary;
        s.setRibbon({
          category: RIBBON_PANE_CATEGORY[next] ?? "view",
          primary: next,
          secondary: null,
        });
      } else {
        s.setRibbon({ category: "arrange", primary: "timeline", secondary: null });
      }
    } else if (r.secondary === "mixer") {
      s.setRibbon({ secondary: null });
    } else {
      revealPane("mixer");
    }
    return;
  }

  const w = s.workspaces;
  const active = w.list.find((x) => x.id === w.activeId);
  if (active && tileLeaves(active.root).includes("mixer")) {
    const fallback =
      w.list.find((x) => x.id !== active.id && tileLeaves(x.root).includes("timeline")) ??
      w.list.find((x) => x.id !== active.id && !tileLeaves(x.root).includes("mixer"));
    if (fallback) s.setWorkspaces({ ...w, activeId: fallback.id });
  } else {
    revealPane("mixer");
  }
}
