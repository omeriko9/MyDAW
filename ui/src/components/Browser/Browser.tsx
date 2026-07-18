/**
 * Browser — left sidebar panel (U6, SPEC §9 "Browser").
 *
 * Tabs: Plugins (registry: search / group / drag / add / blacklist / rescan) and
 * Files (project assets: drag to timeline, import, relink, OS-file drop zone).
 * Renders sanely with project === null (engine disconnected).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../store/store";
import type { BrowserTab } from "../../store/store";
import { IconButton } from "../common/IconButton";
import { Tabs } from "../common/Tabs";
import PluginsTab from "./PluginsTab";
import FilesTab from "./FilesTab";
import Inspector from "../Inspector/Inspector";
import "./browser.css";

export type BrowserTabId = BrowserTab;

/** Format an unknown error (WsRequestError / Error / other) for hint display. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Last path segment of a file path (handles both separators). */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const HINT_MS = 3500;

export default function Browser() {
  const tab = useStore((s) => s.panels.browserTab);
  const setPanelsTab = useStore((s) => s.setPanels);
  const setTab = useCallback((id: BrowserTab) => setPanelsTab({ browserTab: id }), [setPanelsTab]);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current !== null) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => {
      hintTimer.current = null;
      setHint(null);
    }, HINT_MS);
  }, []);

  useEffect(
    () => () => {
      if (hintTimer.current !== null) clearTimeout(hintTimer.current);
    },
    [],
  );

  const setPanels = useStore((s) => s.setPanels);

  return (
    <div className="browser col">
      <div className="browser-tabbar">
        <Tabs
          tabs={[
            { id: "plugins", label: "Plugins", icon: "plug" },
            { id: "files", label: "Files", icon: "folder" },
            { id: "inspector", label: "Inspector", icon: "sliders" },
          ]}
          active={tab}
          onChange={(id) => setTab(id as BrowserTabId)}
        />
        <span className="grow" />
        <IconButton
          icon="chevronLeft"
          size={20}
          tooltip="Collapse panel (reopen from the left rail)"
          onClick={() => setPanels({ browser: false })}
        />
      </div>
      <div className="browser-content col grow">
        {tab === "plugins" ? (
          <PluginsTab showHint={showHint} />
        ) : tab === "files" ? (
          <FilesTab showHint={showHint} />
        ) : (
          <Inspector />
        )}
        {hint !== null && <div className="browser-hint">{hint}</div>}
      </div>
    </div>
  );
}
