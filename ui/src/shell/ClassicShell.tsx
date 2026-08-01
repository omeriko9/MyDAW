/**
 * Classic shell (SPEC §9 layout) — the original App.tsx composition, moved here
 * verbatim when shellMode arrived (docs/UI_ALTERNATIVES_PLAN.md M0):
 *
 *   ┌──────────────────────── TransportBar ────────────────────────┐
 *   │ Browser │           Timeline (center)            │   Agent   │
 *   ├───────────── bottom dock: Mixer / PianoRoll / ClipEditor ────┤
 *   └───────────────────────── StatusBar ──────────────────────────┘
 *
 * The Browser (left) hosts Plugins / Files / Inspector tabs (panels.browserTab).
 * Side panels collapse via store.panels and resize via Resizer (browser 160–520 px);
 * the bottom dock (160–640 px) hosts Tabs bound to panels.bottomTab. Pop-out
 * plumbing lives in shell/popouts (mounted once in App around every shell).
 */

import { useEffect, useRef } from "react";
import { useStore } from "../store/store";
import type { PoppedOutTab } from "../store/store";
import { LAYOUT_SIZES_EVENT, type LayoutSizes } from "../lib/layouts";
import { loadBoolPref, numberIn, usePrefState } from "../lib/prefs";

import TransportBar from "../components/Transport/TransportBar";
import MenuBar from "../components/Transport/MenuBar";
import StatusBar from "../components/Transport/StatusBar";
import Timeline from "../components/Timeline/Timeline";
import Browser from "../components/Browser/Browser";
import { AgentPanel } from "../components/Agent/AgentPanel";

import { Tabs } from "../components/common/Tabs";
import { IconButton } from "../components/common/IconButton";
import { Resizer } from "../components/common/Resizer";

import { PanelBoundary } from "./PanelBoundary";
import { DockPlaceholder, POPOUT_DEFS, usePopouts } from "./popouts";
import { PANE_ICONS, PANE_LABELS, DOCK_PANES, renderPane } from "./paneRegistry";

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

const DOCK_TABS = DOCK_PANES.map((id) => ({
  id,
  label: PANE_LABELS[id],
  icon: PANE_ICONS[id],
}));

/* ============================================================================
 * Classic shell
 * ========================================================================= */

export default function ClassicShell() {
  const panels = useStore((s) => s.panels);
  const setPanels = useStore((s) => s.setPanels);
  // Performance-mode record visuals (UI_IMPROVE.md §4.1): pref read fresh on each
  // recording transition so the Settings toggle applies from the next take on.
  const recording = useStore((s) => s.transport.state === "recording");
  const recordVisuals = recording && loadBoolPref("ui.recordVisuals", true);

  const { popouts, popOut, note: popoutNote } = usePopouts();

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

  // Layout presets (lib/layouts): panel sizes arrive via event — this shell owns the clamps.
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
    <div className="app-frame" data-shell="classic">
      <MenuBar />
      <div className="app-root" data-recording={recordVisuals || undefined}>
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
      </div>
    </div>
  );
}
