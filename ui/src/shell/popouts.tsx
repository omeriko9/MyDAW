/**
 * Pop-out hosting (U3, moved out of App.tsx) — any dock-capable pane can move into
 * its own browser window via same-JS-context portals; store / ws / buses keep
 * working transparently. Mounted ONCE in App around whichever shell is active, so
 * pop-outs survive shell switches: the portals render regardless of the shell, and
 * a shell showing a popped-out pane shows the DockPlaceholder instead (PaneHost).
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store/store";
import type { PoppedOutTab } from "../store/store";
import { Icon } from "../components/common/icons";
import { usePopoutWindow } from "../components/common/usePopoutWindow";
import type { PopoutWindow } from "../components/common/usePopoutWindow";
import { PanelBoundary } from "./PanelBoundary";
import { renderPane } from "./paneRegistry";

export const POPOUT_DEFS: Record<
  PoppedOutTab,
  { label: string; title: string; width: number; height: number }
> = {
  mixer: { label: "Mixer", title: "MyDAW — Mixer", width: 1100, height: 420 },
  instrumentRack: { label: "Instrument Rack", title: "MyDAW — Instrument Rack", width: 1000, height: 480 },
  pianoRoll: { label: "Piano Roll", title: "MyDAW — Piano Roll", width: 1100, height: 560 },
  clipEditor: { label: "Clip Editor", title: "MyDAW — Clip Editor", width: 1100, height: 420 },
  sheetMusic: { label: "Sheet Music", title: "MyDAW — Sheet Music", width: 1000, height: 700 },
  visualizer: { label: "Visualizer", title: "MyDAW — Visualizer", width: 1100, height: 560 },
};

export const POPOUT_TABS = Object.keys(POPOUT_DEFS) as PoppedOutTab[];

export interface PopoutApi {
  popouts: Record<PoppedOutTab, PopoutWindow>;
  /** Open the pane in its own window (popup-blocker fallback keeps it docked). */
  popOut(tab: PoppedOutTab): void;
  /** Transient popup-blocked notice, shown by whichever shell hosts the pane. */
  note: string | null;
}

const Ctx = createContext<PopoutApi | null>(null);

export function usePopouts(): PopoutApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("usePopouts outside PopoutProvider");
  return api;
}

/** Shown in a pane slot while the pane lives in its own window. */
export function DockPlaceholder({ label, pop }: { label: string; pop: PopoutWindow }) {
  return (
    <div
      style={{
        flex: "1 1 auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        color: "var(--text-dim)",
      }}
    >
      <Icon name="export" size={20} />
      <div>{label} is open in a separate window.</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn" onClick={pop.focus}>
          Show window
        </button>
        <button type="button" className="btn primary" onClick={pop.close}>
          Dock back
        </button>
      </div>
    </div>
  );
}

export function PopoutProvider({ children }: { children: React.ReactNode }) {
  const setPanels = useStore((s) => s.setPanels);
  const poppedOut = useStore((s) => s.panels.poppedOut);

  const setPoppedOut = useCallback(
    (tab: PoppedOutTab, on: boolean) => {
      // read fresh state — onClosed can fire from window lifecycle events
      const cur = useStore.getState().panels.poppedOut;
      setPanels({ poppedOut: { ...cur, [tab]: on } });
    },
    [setPanels],
  );

  const popouts: Record<PoppedOutTab, PopoutWindow> = {
    mixer: usePopoutWindow({
      name: "MyDAW-mixer",
      ...POPOUT_DEFS.mixer,
      onClosed: () => setPoppedOut("mixer", false),
    }),
    instrumentRack: usePopoutWindow({
      name: "MyDAW-instrumentRack",
      ...POPOUT_DEFS.instrumentRack,
      onClosed: () => setPoppedOut("instrumentRack", false),
    }),
    pianoRoll: usePopoutWindow({
      name: "MyDAW-pianoRoll",
      ...POPOUT_DEFS.pianoRoll,
      onClosed: () => setPoppedOut("pianoRoll", false),
    }),
    clipEditor: usePopoutWindow({
      name: "MyDAW-clipEditor",
      ...POPOUT_DEFS.clipEditor,
      onClosed: () => setPoppedOut("clipEditor", false),
    }),
    sheetMusic: usePopoutWindow({
      name: "MyDAW-sheetMusic",
      ...POPOUT_DEFS.sheetMusic,
      onClosed: () => setPoppedOut("sheetMusic", false),
    }),
    visualizer: usePopoutWindow({
      name: "MyDAW-visualizer",
      ...POPOUT_DEFS.visualizer,
      onClosed: () => setPoppedOut("visualizer", false),
    }),
  };

  // Popup-blocker fallback: keep the pane docked and show a transient notice.
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (note === null) return;
    const t = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [note]);

  const popOut = (tab: PoppedOutTab) => {
    if (popouts[tab].open()) {
      setPoppedOut(tab, true);
    } else {
      setNote(
        `Pop-out was blocked by the browser — allow popups for this site, then try again. ${POPOUT_DEFS[tab].label} stays docked.`,
      );
    }
  };

  return (
    <Ctx.Provider value={{ popouts, popOut, note }}>
      {children}
      {/* popped-out panes — portal into their own browser windows; rendered
          regardless of the active shell or its arrangement */}
      {POPOUT_TABS.map((tab) => {
        const pop = popouts[tab];
        if (!poppedOut[tab] || pop.container === null) return null;
        return createPortal(
          <PanelBoundary name={POPOUT_DEFS[tab].label}>{renderPane(tab)}</PanelBoundary>,
          pop.container,
          `popout-${tab}`,
        );
      })}
    </Ctx.Provider>
  );
}
