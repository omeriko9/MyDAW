/** Instrument Rack — one row per loaded Instrument track / shared VST host. */

import type React from "react";
import { useStore } from "../../store/store";
import { setTrack } from "../../store/actions";
import { groupPluginVariants } from "../../lib/pluginVariants";
import { openBestEditor } from "../PluginEditor/openEditor";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { Icon } from "../common/icons";
import { Select, type SelectOption } from "../common/Select";
import { showToast } from "../common/ToastHost";
import {
  createInstrumentHost,
  instrumentFeeders,
  instrumentInsertOfTrack,
} from "../Timeline/instrumentAssign";
import type { PluginInfo } from "../../protocol/types";
import { selectTrack } from "../../lib/trackSelection";
import "./instrumentRack.css";

export default function InstrumentRack() {
  const project = useStore((s) => s.project);
  const registry = useStore((s) => s.registry);
  const selected = useStore((s) => s.selection.trackIds);

  const addHost = (p: PluginInfo) => {
    void createInstrumentHost(p).catch((e) => {
      console.warn("[instrument-rack] add failed:", e);
      showToast(e instanceof Error ? e.message : "Could not load instrument", "error");
    });
  };

  const openAddMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const instruments = groupPluginVariants(
      registry
        .filter((p) => p.isInstrument && !p.blacklisted)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).plugins;
    const items: MenuEntry[] = instruments.map((p) => ({
      label: p.name,
      icon: "piano",
      onClick: () => addHost(p),
    }));
    openContextMenu(
      r.left,
      r.bottom + 2,
      items.length > 0 ? items : [{ label: "No scanned instruments", disabled: true }],
    );
  };

  if (!project) {
    return <div className="ir-empty">Open a project to view its instruments.</div>;
  }

  const hosts = project.tracks.filter((t) => t.kind === "instrument");
  const outputOptions: SelectOption[] = [
    { value: "master", label: "Master" },
    ...project.tracks
      .filter((t) => t.kind === "bus")
      .map((t) => ({ value: String(t.id), label: t.name, group: "Buses" })),
    { value: "none", label: "No output" },
  ];

  return (
    <div className="ir-root">
      <div className="ir-toolbar">
        <div className="ir-title">
          <Icon name="piano" size={15} />
          Instrument Rack
          <span className="ir-count">{hosts.length}</span>
        </div>
        <button type="button" className="btn primary ir-add" onClick={openAddMenu}>
          <Icon name="plus" size={13} /> Add Instrument
        </button>
      </div>

      <div className="ir-head" aria-hidden="true">
        <span>Host / VST</span><span>MIDI tracks</span><span>Channels</span><span>Audio output</span><span />
      </div>
      <div className="ir-list">
        {hosts.length === 0 ? (
          <div className="ir-empty">
            No instrument instances loaded. Add one here, or drag a VST onto a MIDI track.
          </div>
        ) : (
          hosts.map((host) => {
            const ins = instrumentInsertOfTrack(host);
            const feeders = instrumentFeeders(project, host.id);
            const channels = Array.from(
              new Set(feeders.map((t) => t.midiOutChannel ?? 0)),
            ).sort((a, b) => a - b);
            const channelLabel = channels.length === 0
              ? "—"
              : channels.map((ch) => (ch === 0 ? "Any" : String(ch))).join(", ");
            const out = host.outputTarget;
            return (
              <div
                key={host.id}
                className={`ir-row${selected.includes(host.id) ? " selected" : ""}`}
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).closest("button, input, select")) return;
                  const toggle = e.ctrlKey || e.metaKey;
                  selectTrack(host.id, hosts.map((x) => x.id), {
                    toggle: toggle && !e.shiftKey,
                    range: e.shiftKey,
                    additiveRange: toggle && e.shiftKey,
                  });
                }}
              >
                <div className="ir-host">
                  <span className="ir-color" style={{ background: host.color }} />
                  <Icon name="piano" size={16} />
                  <span className="ir-host-text">
                    <strong>{host.name}</strong>
                    <small>{ins?.name ?? "No instrument loaded"}</small>
                  </span>
                  {host.frozen && <span className="ir-badge">Frozen</span>}
                </div>
                <div className="ir-feeders" title={feeders.map((t) => t.name).join("\n") || "No MIDI tracks routed here"}>
                  {feeders.length} routed
                </div>
                <div className="ir-channels">{channelLabel}</div>
                <Select
                  value={typeof out === "number" ? String(out) : out}
                  options={outputOptions}
                  disabled={!!host.frozen}
                  title="Audio return destination"
                  onChange={(v) =>
                    void setTrack(host.id, {
                      outputTarget: v === "master" || v === "none" ? v : Number(v),
                    })
                  }
                />
                <button
                  type="button"
                  className="btn ir-open"
                  disabled={!ins}
                  title={ins ? `Open ${ins.name}` : "No instrument to open"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (ins) void openBestEditor(ins);
                  }}
                >
                  Open Editor
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
