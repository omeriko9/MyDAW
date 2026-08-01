/**
 * Side flanks for the non-classic shells — the same Browser (left) and Agent
 * (right) panels the Classic shell composes inline in ClassicShell.tsx, sharing the
 * SAME size pref keys (ui.browserW / ui.agentW), so panel widths carry across shell
 * switches. Toggled by the same panels.browser / panels.agent flags (View menu,
 * Ctrl+Shift+I) in every shell.
 */

import { useStore } from "../store/store";
import Browser from "../components/Browser/Browser";
import { AgentPanel } from "../components/Agent/AgentPanel";
import { IconButton } from "../components/common/IconButton";
import { Resizer } from "../components/common/Resizer";
import { numberIn, usePrefState } from "../lib/prefs";
import { PanelBoundary } from "./PanelBoundary";

export const BROWSER_MIN = 160;
export const BROWSER_MAX = 520;
export const BROWSER_DEFAULT = 280;
export const AGENT_MIN = 320;
export const AGENT_MAX = 560;
export const AGENT_DEFAULT = 420;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function LeftBrowser() {
  const open = useStore((s) => s.panels.browser);
  const setPanels = useStore((s) => s.setPanels);
  const [browserW, setBrowserW] = usePrefState(
    "ui.browserW",
    BROWSER_DEFAULT,
    numberIn(BROWSER_MIN, BROWSER_MAX),
  );

  if (!open) {
    // collapsed: slim rail — the panel stays one click away (same as ClassicShell)
    return (
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
    );
  }

  return (
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
  );
}

export function RightAgent() {
  const open = useStore((s) => s.panels.agent);
  const [agentW, setAgentW] = usePrefState("ui.agentW", AGENT_DEFAULT, numberIn(AGENT_MIN, AGENT_MAX));

  if (!open) return null;
  return (
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
  );
}
