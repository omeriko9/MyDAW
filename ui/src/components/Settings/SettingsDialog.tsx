/**
 * SettingsDialog (U5) — Modal shown while store.dialogs.settings is true (SPEC §9).
 * Tabs: AUDIO / MIDI / PLUGINS / GENERAL. Each tab fetches its data on mount
 * (the Modal unmounts content when closed, so reopening re-syncs).
 */

import React, { useCallback, useEffect, useRef } from "react";
import "./settings.css";
import { loadPref, oneOf, usePrefState } from "../../lib/prefs";
import { useStore } from "../../store/store";
import { Modal } from "../common/Modal";
import { Tabs } from "../common/Tabs";
import { AudioTab } from "./AudioTab";
import { MidiTab } from "./MidiTab";
import { PluginsTab } from "./PluginsTab";
import { GeneralTab } from "./GeneralTab";
import { LlmTab } from "./LlmTab";

type TabId = "audio" | "midi" | "plugins" | "general" | "llm";

const isTabId = oneOf<TabId>("audio", "midi", "plugins", "general", "llm");

export default function SettingsDialog() {
  const open = useStore((s) => s.dialogs.settings);
  const setDialogs = useStore((s) => s.setDialogs);
  // Remember the last-visited tab across opens AND reloads (people usually return
  // to the same settings area repeatedly).
  const [tab, setTab] = usePrefState<TabId>("ui.settingsTab", "audio", isTabId);

  // Modal gives the initial focus to [data-autofocus], else to the first focusable control
  // — which here is the title-bar Close X (so Enter dismissed the dialog and the tab bar's
  // Left/Right arrows did nothing: they only fire while a tab has focus). Tabs takes no
  // per-button props, so stamp the marker on the active tab from the DOM; ref callbacks run
  // in the commit phase, i.e. before Modal's open effect reads the attribute.
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const markActiveTab = useCallback(
    (el: HTMLDivElement | null) => {
      tabBarRef.current = el;
      if (!el) return;
      el.querySelector("[data-autofocus]")?.removeAttribute("data-autofocus");
      el.querySelector(`[data-tab-id="${tab}"]`)?.setAttribute("data-autofocus", "");
    },
    [tab],
  );

  // This component is mounted for the whole session, so usePrefState's mount-time read
  // would pin the tab forever: re-read on every open, which is how entry points that name
  // a tab ("Audio Settings…", agent ui/dialog.set) hand it over — they write the pref first.
  useEffect(() => {
    if (!open) return;
    const next = loadPref<TabId>("ui.settingsTab", "audio", isTabId);
    setTab(next);
    // The tab bar mounted (and Modal took its initial focus off the marker) with the
    // PREVIOUS tab, so when the entry point named a different one, move focus over to the
    // tab that actually won. This effect is the parent's, so it runs after Modal's.
    tabBarRef.current?.querySelector<HTMLElement>(`[data-tab-id="${next}"]`)?.focus();
  }, [open, setTab]);

  return (
    <Modal
      open={open}
      onClose={() => setDialogs({ settings: false })}
      title="Settings"
      width={640}
    >
      <div ref={markActiveTab}>
        <Tabs
          tabs={[
            { id: "audio", label: "Audio", icon: "audioWave" },
            { id: "midi", label: "MIDI", icon: "midiNote" },
            { id: "plugins", label: "Plug-ins", icon: "plug" },
            { id: "general", label: "General", icon: "settings" },
            { id: "llm", label: "LLM", icon: "sliders" },
          ]}
          active={tab}
          onChange={(id) => setTab(id as TabId)}
        />
      </div>
      <div className="sett-body">
        {tab === "audio" ? <AudioTab /> : null}
        {tab === "midi" ? <MidiTab /> : null}
        {tab === "plugins" ? <PluginsTab /> : null}
        {tab === "general" ? <GeneralTab /> : null}
        {tab === "llm" ? <LlmTab /> : null}
      </div>
    </Modal>
  );
}
