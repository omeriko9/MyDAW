/**
 * App shell (owned by U2) — composes the pinned entry components (SPEC §9 layout):
 *
 *   ┌──────────────────────── TransportBar ────────────────────────┐
 *   │ Browser │           Timeline (center)            │   Agent   │
 *   ├───────────── bottom dock: Mixer / PianoRoll / ClipEditor ────┤
 *   └───────────────────────── StatusBar ──────────────────────────┘
 *
 * The Browser (left) hosts Plugins / Files / Inspector tabs (panels.browserTab). Side
 * panels collapse via store.panels and resize via Resizer (browser 160–520 px); the
 * bottom dock (160–640 px) hosts Tabs bound to panels.bottomTab. The right side hosts
 * the optional Agent panel. DialogsHost / SettingsDialog / PluginEditorHost are
 * always mounted. When the engine is offline a dim overlay covers the (still mounted)
 * UI. Each sibling panel is wrapped in an error boundary so one crash cannot take
 * down the shell.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./lib/theme.css";
import "./components/Transport/transport.css";
import { ws } from "./protocol/ws";
import { useStore } from "./store/store";
import type { PoppedOutTab } from "./store/store";
import { windowTitle } from "./lib/appTitle";
import { initKeyboard } from "./lib/keyboard";
import { LAYOUT_SIZES_EVENT, type LayoutSizes } from "./lib/layouts";
import { numberIn, usePrefState } from "./lib/prefs";
import { checkRecoveryOnce } from "./components/Transport/projectFlows";

import TransportBar from "./components/Transport/TransportBar";
import MenuBar from "./components/Transport/MenuBar";
import StatusBar from "./components/Transport/StatusBar";
import Timeline from "./components/Timeline/Timeline";
import Mixer from "./components/Mixer/Mixer";
import PianoRoll from "./components/PianoRoll/PianoRoll";
import ClipEditor from "./components/ClipEditor/ClipEditor";
import SheetMusic from "./components/SheetMusic/SheetMusic";
import Visualizer from "./components/Visualizer/Visualizer";
import { AgentPanel } from "./components/Agent/AgentPanel";
import Browser from "./components/Browser/Browser";
import SettingsDialog from "./components/Settings/SettingsDialog";
import DialogsHost from "./components/Dialogs/DialogsHost";
import PluginEditorHost from "./components/PluginEditor/PluginEditorHost";

import { Tabs } from "./components/common/Tabs";
import { IconButton } from "./components/common/IconButton";
import { Resizer } from "./components/common/Resizer";
import { Icon } from "./components/common/icons";
import { usePopoutWindow } from "./components/common/usePopoutWindow";
import type { PopoutWindow } from "./components/common/usePopoutWindow";

/* ============================================================================
 * Panel error boundary — a crashing panel must not kill the shell
 * ========================================================================= */

interface BoundaryProps {
  name: string;
  children: React.ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

class PanelBoundary extends React.Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[shell] ${this.props.name} panel crashed:`, error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="app-panel-error">
          <span className="icon-warn">
            <Icon name="warning" size={22} />
          </span>
          <div>{this.props.name} crashed</div>
          <div className="faint" style={{ fontSize: 11, maxWidth: 360 }}>
            {this.state.error.message}
          </div>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Reload panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ============================================================================
 * Layout constants
 * ========================================================================= */

/* Wide ranges on purpose: at high browser zoom the CSS viewport shrinks, and the
   lower minimums let the side panels give the arrangement its width back. */
const BROWSER_MIN = 160;
const BROWSER_MAX = 520;
const BROWSER_DEFAULT = 280;
const DOCK_MIN = 160;
const DOCK_MAX = 640;
const DOCK_DEFAULT = 260;
const AGENT_MIN = 320;
const AGENT_MAX = 560;
const AGENT_DEFAULT = 420;
/* Split dock (UI_IMPROVE.md §6.1): slot 1's width as a fraction of the dock. */
const DOCK_SPLIT_MIN = 0.15;
const DOCK_SPLIT_MAX = 0.85;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const DOCK_TABS = [
  { id: "mixer", label: "Mixer", icon: "mixer" as const },
  { id: "pianoRoll", label: "Piano Roll", icon: "piano" as const },
  { id: "clipEditor", label: "Clip Editor", icon: "audioWave" as const },
  { id: "sheetMusic", label: "Sheet Music", icon: "staff" as const },
  { id: "visualizer", label: "Visualizer", icon: "power" as const },
];

/* ============================================================================
 * Pop-out dock tabs (U3) — each tab can move into its own browser window.
 * Same-JS-context portals: store / ws / buses keep working transparently.
 * ========================================================================= */

const POPOUT_DEFS: Record<PoppedOutTab, { label: string; title: string; width: number; height: number }> = {
  mixer: { label: "Mixer", title: "MyDAW — Mixer", width: 1100, height: 420 },
  pianoRoll: { label: "Piano Roll", title: "MyDAW — Piano Roll", width: 1100, height: 560 },
  clipEditor: { label: "Clip Editor", title: "MyDAW — Clip Editor", width: 1100, height: 420 },
  sheetMusic: { label: "Sheet Music", title: "MyDAW — Sheet Music", width: 1000, height: 700 },
  visualizer: { label: "Visualizer", title: "MyDAW — Visualizer", width: 1100, height: 560 },
};

const POPOUT_TABS = Object.keys(POPOUT_DEFS) as PoppedOutTab[];

/** Shown in the dock while the pane lives in its own window. */
function DockPlaceholder({ label, pop }: { label: string; pop: PopoutWindow }) {
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

/* ============================================================================
 * App
 * ========================================================================= */

export default function App() {
  const connected = useStore((s) => s.connected);
  const panels = useStore((s) => s.panels);
  const setPanels = useStore((s) => s.setPanels);
  const projectName = useStore((s) => s.project?.name ?? null);
  const dirty = useStore((s) => s.dirty);

  const [browserW, setBrowserW] = usePrefState(
    "ui.browserW",
    BROWSER_DEFAULT,
    numberIn(BROWSER_MIN, BROWSER_MAX),
  );
  const [dockH, setDockH] = usePrefState("ui.dockH", DOCK_DEFAULT, numberIn(DOCK_MIN, DOCK_MAX));
  const [dockSplit, setDockSplit] = usePrefState(
    "ui.dockSplit",
    0.5,
    numberIn(DOCK_SPLIT_MIN, DOCK_SPLIT_MAX),
  );
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [agentW, setAgentW] = usePrefState(
    "ui.agentW",
    AGENT_DEFAULT,
    numberIn(AGENT_MIN, AGENT_MAX),
  );

  useEffect(() => {
    ws.connect(); // idempotent (StrictMode-safe); store wiring handles session/hello
  }, []);

  useEffect(() => initKeyboard(), []);

  // Layout presets (lib/layouts): panel sizes arrive via event — App owns the clamps.
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<LayoutSizes>).detail;
      setBrowserW(clamp(d.browserW, BROWSER_MIN, BROWSER_MAX));
      setDockH(clamp(d.dockH, DOCK_MIN, DOCK_MAX));
      setAgentW(clamp(d.agentW, AGENT_MIN, AGENT_MAX));
      setDockSplit(clamp(d.dockSplit, DOCK_SPLIT_MIN, DOCK_SPLIT_MAX));
    };
    window.addEventListener(LAYOUT_SIZES_EVENT, on);
    return () => window.removeEventListener(LAYOUT_SIZES_EVENT, on);
  }, [setBrowserW, setDockH, setAgentW, setDockSplit]);

  // Tab / taskbar title mirrors the open project and its unsaved-changes state.
  useEffect(() => {
    document.title = windowTitle(projectName, dirty);
  }, [projectName, dirty]);

  // Stray OS-file drops must not let the browser navigate away and lose the session.
  // Real drop zones handle + stopPropagation in the bubble phase first, so anything
  // still reaching window is unhandled — swallow it.
  useEffect(() => {
    const onWindowDragOver = (e: DragEvent) => e.preventDefault();
    const onWindowDrop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, []);

  // Suppress the native browser context menu on bare surfaces — a DAW right-click
  // should never show "Back / Reload". Surfaces with their own menu preventDefault
  // before this bubble-phase listener runs; text inputs keep the native menu
  // (clipboard / spellcheck).
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      // Keep the native menu (copy/paste/spellcheck) on inputs and the selectable agent chat.
      if (el?.closest?.('input, textarea, [contenteditable="true"], .agent-transcript')) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Offer crash recovery once per app load, after the first successful connection.
  useEffect(() => {
    if (connected) void checkRecoveryOnce();
  }, [connected]);

  /* ---- pop-out dock tabs ---- */

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
  const [popoutNote, setPopoutNote] = useState<string | null>(null);
  useEffect(() => {
    if (popoutNote === null) return;
    const t = window.setTimeout(() => setPopoutNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [popoutNote]);

  const popOut = (tab: PoppedOutTab) => {
    if (popouts[tab].open()) {
      setPoppedOut(tab, true);
    } else {
      setPopoutNote(
        `Pop-out was blocked by the browser — allow popups for this site, then try again. ${POPOUT_DEFS[tab].label} stays docked.`,
      );
    }
  };

  /** Docked pane content for a tab (used both in the dock and inside popout portals). */
  const renderPane = (tab: PoppedOutTab) =>
    tab === "mixer" ? (
      <Mixer />
    ) : tab === "pianoRoll" ? (
      <PianoRoll />
    ) : tab === "clipEditor" ? (
      <ClipEditor />
    ) : tab === "sheetMusic" ? (
      <SheetMusic />
    ) : (
      <Visualizer />
    );

  /* ---- split dock (UI_IMPROVE.md §6.1) ---- */

  // Normalize a stale pref state where both slots hold the same tab (invariant:
  // bottomTab2 never equals bottomTab).
  useEffect(() => {
    if (panels.bottomTab2 !== null && panels.bottomTab2 === panels.bottomTab)
      setPanels({ bottomTab2: null });
  }, [panels.bottomTab, panels.bottomTab2, setPanels]);

  const splitDock = () => {
    const cur = useStore.getState().panels;
    const next = DOCK_TABS.find((t) => t.id !== cur.bottomTab)?.id as PoppedOutTab | undefined;
    if (next) setPanels({ bottomTab2: next });
  };

  /** Selecting the OTHER half's tab swaps the halves (each pane is single-instance). */
  const setHalfTab = (slot: 1 | 2, id: PoppedOutTab) => {
    const cur = useStore.getState().panels;
    if (slot === 1) {
      if (cur.bottomTab2 === id) setPanels({ bottomTab: id, bottomTab2: cur.bottomTab });
      else setPanels({ bottomTab: id });
    } else {
      if (cur.bottomTab === id) setPanels({ bottomTab: cur.bottomTab2, bottomTab2: id });
      else setPanels({ bottomTab2: id });
    }
  };

  const renderDockHalf = (slot: 1 | 2) => {
    const tab = (slot === 1 ? panels.bottomTab : panels.bottomTab2) as PoppedOutTab;
    const split = panels.bottomTab2 !== null;
    return (
      <div
        className="app-dock-half"
        style={
          split && slot === 1
            ? { flex: `0 0 ${(dockSplit * 100).toFixed(2)}%` }
            : { flex: "1 1 0%" }
        }
      >
        <Tabs
          className="app-dock-tabs"
          tabs={DOCK_TABS}
          active={tab}
          onChange={(id) => setHalfTab(slot, id as PoppedOutTab)}
          right={
            <>
              {panels.poppedOut[tab] ? (
                <IconButton
                  icon="export"
                  size={20}
                  active
                  tooltip="Dock back into the app"
                  onClick={() => popouts[tab].close()}
                />
              ) : (
                <IconButton
                  icon="export"
                  size={20}
                  tooltip="Pop out into a separate window"
                  onClick={() => popOut(tab)}
                />
              )}
              {slot === 1 && !split && (
                <IconButton
                  icon="split"
                  size={20}
                  tooltip="Split the dock — two panes side by side"
                  onClick={splitDock}
                />
              )}
              <IconButton
                icon="x"
                size={20}
                tooltip={slot === 1 ? "Close dock" : "Close this half"}
                onClick={() =>
                  setPanels(slot === 1 ? { bottomTab: null } : { bottomTab2: null })
                }
              />
            </>
          }
        />
        <div className="app-dock-body">
          {panels.poppedOut[tab] ? (
            <DockPlaceholder label={POPOUT_DEFS[tab].label} pop={popouts[tab]} />
          ) : (
            <PanelBoundary key={tab} name={POPOUT_DEFS[tab].label}>
              {renderPane(tab)}
            </PanelBoundary>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="app-frame">
      <MenuBar />
      <div className="app-root">
        <TransportBar />

        <div className="app-main">
        {panels.browser ? (
          <>
            <div className="app-side left" style={{ width: browserW }}>
              <PanelBoundary name="Browser">
                <Browser />
              </PanelBoundary>
            </div>
            <Resizer
              dir="v"
              onResize={(delta) => setBrowserW((w) => clamp(w + delta, BROWSER_MIN, BROWSER_MAX))}
              onReset={() => setBrowserW(BROWSER_DEFAULT)}
            />
          </>
        ) : (
          /* collapsed: slim rail — the panel stays one click away (Browser's own
             collapse chevron leads here; these reopen straight onto a tab) */
          <div className="app-rail left">
            <IconButton
              icon="chevronRight"
              size={22}
              tooltip="Expand panel"
              onClick={() => setPanels({ browser: true })}
            />
            <IconButton
              icon="plug"
              size={22}
              tooltip="Plugins"
              onClick={() => setPanels({ browser: true, browserTab: "plugins" })}
            />
            <IconButton
              icon="folder"
              size={22}
              tooltip="Files"
              onClick={() => setPanels({ browser: true, browserTab: "files" })}
            />
            <IconButton
              icon="sliders"
              size={22}
              tooltip="Inspector"
              onClick={() => setPanels({ browser: true, browserTab: "inspector" })}
            />
          </div>
        )}

        <div className="app-center">
          <PanelBoundary name="Timeline">
            <Timeline />
          </PanelBoundary>
        </div>


        {panels.agent && (
          <>
            <Resizer
              dir="v"
              onResize={(delta) => setAgentW((w) => clamp(w - delta, AGENT_MIN, AGENT_MAX))}
              onReset={() => setAgentW(AGENT_DEFAULT)}
            />
            <div className="app-side right" style={{ width: agentW }}>
              <PanelBoundary name="Agent">
                <AgentPanel />
              </PanelBoundary>
            </div>
          </>
        )}
      </div>

      {panels.bottomTab !== null && (
        <>
          <Resizer
            dir="h"
            onResize={(delta) => setDockH((h) => clamp(h - delta, DOCK_MIN, DOCK_MAX))}
            onReset={() => setDockH(DOCK_DEFAULT)}
          />
          <div className="app-dock" style={{ height: dockH }} ref={dockRef}>
            {popoutNote !== null && <div className="app-dock-note">{popoutNote}</div>}
            <div className="app-dock-halves">
              {renderDockHalf(1)}
              {panels.bottomTab2 !== null && (
                <>
                  <Resizer
                    dir="v"
                    onResize={(delta) => {
                      const w = dockRef.current?.clientWidth ?? 1;
                      setDockSplit((f) => clamp(f + delta / w, DOCK_SPLIT_MIN, DOCK_SPLIT_MAX));
                    }}
                    onReset={() => setDockSplit(0.5)}
                  />
                  {renderDockHalf(2)}
                </>
              )}
            </div>
          </div>
        </>
      )}

      <StatusBar />

      {/* popped-out dock panes — portal into their own browser windows; rendered
          regardless of the active bottom tab (and even with the dock closed) */}
      {POPOUT_TABS.map((tab) => {
        const pop = popouts[tab];
        if (!panels.poppedOut[tab] || pop.container === null) return null;
        return createPortal(
          <PanelBoundary name={POPOUT_DEFS[tab].label}>{renderPane(tab)}</PanelBoundary>,
          pop.container,
          `popout-${tab}`,
        );
      })}

      {/* always-mounted hosts */}
      <DialogsHost />
      <SettingsDialog />
      <PluginEditorHost />

      {/* engine-offline overlay — UI stays mounted underneath */}
      {!connected && (
        <div className="app-offline">
          <div className="app-offline-card">
            <span className="spin">
              <Icon name="refresh" size={16} />
            </span>
            Engine offline — reconnecting…
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
