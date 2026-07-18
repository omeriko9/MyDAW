/**
 * SettingsDialog (U5) — Modal shown while store.dialogs.settings is true (SPEC §9).
 * Tabs: AUDIO / MIDI / PLUGINS / GENERAL. Each tab fetches its data on mount
 * (the Modal unmounts content when closed, so reopening re-syncs).
 */

import React from "react";
import "./settings.css";
import { oneOf, usePrefState } from "../../lib/prefs";
import { useStore } from "../../store/store";
import { Modal } from "../common/Modal";
import { Tabs } from "../common/Tabs";
import { AudioTab } from "./AudioTab";
import { MidiTab } from "./MidiTab";
import { PluginsTab } from "./PluginsTab";
import { GeneralTab } from "./GeneralTab";
import { LlmTab } from "./LlmTab";

type TabId = "audio" | "midi" | "plugins" | "general" | "llm";

export default function SettingsDialog() {
  const open = useStore((s) => s.dialogs.settings);
  const setDialogs = useStore((s) => s.setDialogs);
  // Remember the last-visited tab across opens AND reloads (people usually return
  // to the same settings area repeatedly).
  const [tab, setTab] = usePrefState<TabId>(
    "ui.settingsTab",
    "audio",
    oneOf<TabId>("audio", "midi", "plugins", "general", "llm"),
  );

  return (
    <Modal
      open={open}
      onClose={() => setDialogs({ settings: false })}
      title="Settings"
      width={640}
    >
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
