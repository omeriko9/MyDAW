/** Instrument Rack — one row per loaded Instrument track / shared VST host. */

import type React from "react";
import { useStore } from "../../store/store";
import {
  addRackInstrument,
  removePlugin,
  removeRackInstrument,
  removeTrack,
  setRackInstrument,
  setTrack,
} from "../../store/actions";
import { groupPluginVariants } from "../../lib/pluginVariants";
import { openBestEditor } from "../PluginEditor/openEditor";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { Icon } from "../common/icons";
import { Select, type SelectOption } from "../common/Select";
import { showToast } from "../common/ToastHost";
import { confirmDialog } from "../Dialogs/confirm";
import {
  createInstrumentHost,
  instrumentFeeders,
  instrumentInsertOfTrack,
} from "../Timeline/instrumentAssign";
import type {
  PluginInfo,
  PluginInstance,
  Project,
  RackInstrument,
  Track,
} from "../../protocol/types";
import { selectTrack } from "../../lib/trackSelection";
import "./instrumentRack.css";

/**
 * Remove semantics (Omer, 2026-08-07 — "the rack should also allow removing"):
 * two distinct intents, both offered per row.
 * - Remove instrument: unload the VSTi, KEEP the rack slot and its MIDI routings
 *   (the row shows "No instrument loaded"; feeders stay pointed here).
 * - Remove from rack: delete the host track entirely. Feeders' midiTarget is
 *   cleared FIRST — the engine does not clean dangling targets on track.remove,
 *   it degrades them with a warning.
 */
const fireIR = (pr: Promise<unknown>): void =>
  void pr.catch((e) =>
    showToast(e instanceof Error ? e.message : "Rack command failed", "error"),
  );

/* ============================================================================
 * Shared routing menus (SPEC §5.9) — identical for BOTH destination kinds, a
 * rack-owned instance and an instrument host TRACK: Track.midiTarget addresses
 * either, so the rack surface must route to either. (First shipped on rack rows
 * only; Omer's restarted session held a track-hosted Orchestral and had no way
 * to route at it — 2026-08-13.)
 * ========================================================================= */

/** "Route MIDI tracks…": every MIDI track, checked = routed at destId. */
function routeMenuFor(project: Project, destId: number): MenuEntry[] {
  const midiTracks = project.tracks.filter((t) => t.kind === "midi");
  if (midiTracks.length === 0)
    return [{ label: "No MIDI tracks in the project", disabled: true }];
  const items: MenuEntry[] = midiTracks.map((t) => {
    const here = t.midiTarget === destId;
    const elsewhere =
      !here && t.midiTarget
        ? (project.rack?.find((x) => x.id === t.midiTarget)?.name ??
          project.tracks.find((x) => x.id === t.midiTarget)?.name)
        : undefined;
    return {
      label: `${t.name}${elsewhere ? ` · now → ${elsewhere}` : ""}`,
      checked: here,
      onClick: () => fireIR(setTrack(t.id, { midiTarget: here ? 0 : destId })),
    };
  });
  const unrouted = midiTracks.filter((t) => !t.midiTarget);
  if (unrouted.length > 1) {
    items.push("separator", {
      label: `Route all ${unrouted.length} unrouted MIDI tracks here`,
      icon: "link",
      onClick: () => {
        for (const t of unrouted) fireIR(setTrack(t.id, { midiTarget: destId }));
      },
    });
  }
  return items;
}

/** Per-feeder channel: "Any" keeps each note's own channel (imported SMFs carry
 *  them); 1-16 re-stamps — how one Orchestral/Kontakt serves 16 parts. */
function channelsMenuFor(project: Project, destId: number): MenuEntry[] {
  const feeders = project.tracks.filter((t) => t.kind === "midi" && t.midiTarget === destId);
  if (feeders.length === 0)
    return [{ label: "No MIDI tracks routed here", disabled: true }];
  return feeders.map(
    (t): MenuEntry => ({
      label: `${t.name} · ${t.midiOutChannel ? `Ch ${t.midiOutChannel}` : "Any"}`,
      submenu: [
        {
          label: "Any (as recorded)",
          checked: !t.midiOutChannel,
          onClick: () => fireIR(setTrack(t.id, { midiOutChannel: 0 })),
        },
        "separator",
        ...Array.from(
          { length: 16 },
          (_, i): MenuEntry => ({
            label: `Channel ${i + 1}`,
            checked: t.midiOutChannel === i + 1,
            onClick: () => fireIR(setTrack(t.id, { midiOutChannel: i + 1 })),
          }),
        ),
      ],
    }),
  );
}

function removeInstrumentOnly(host: Track, ins: PluginInstance): void {
  void removePlugin(host.id, ins.instanceId).catch((e) =>
    showToast(e instanceof Error ? e.message : "Could not remove instrument", "error"),
  );
}

function removeFromRack(host: Track, feederIds: number[]): void {
  void confirmDialog({
    title: "Remove from rack",
    message:
      `Remove “${host.name}” and its instrument entirely?` +
      (feederIds.length > 0
        ? ` ${feederIds.length} MIDI track${feederIds.length === 1 ? "" : "s"} routed here will be disconnected (they keep their clips).`
        : ""),
    confirmLabel: "Remove",
    danger: true,
  }).then(async (ok) => {
    if (!ok) return;
    try {
      for (const id of feederIds) await setTrack(id, { midiTarget: 0 });
      await removeTrack(host.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not remove rack slot", "error");
    }
  });
}

export default function InstrumentRack() {
  const project = useStore((s) => s.project);
  const registry = useStore((s) => s.registry);
  const selected = useStore((s) => s.selection.trackIds);

  // SPEC §5.9: the rack's Add button creates a PROJECT-owned instance — no track is
  // minted, hidden or otherwise. (createInstrumentHost remains the track-flow helper.)
  const addHost = (p: PluginInfo) => {
    void addRackInstrument(p.uid).catch((e) => {
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

  const rack = project.rack ?? [];
  // Instrument TRACKS shown in the rack: only ones that actually host an instrument or
  // have MIDI routed at them. A converted track holding neither is a husk from the old
  // convert-in-place flow (Omer, 2026-08-13: "what are the first two?!") — it is just a
  // track, and the track list is where it lives.
  const hosts = project.tracks.filter(
    (t) =>
      t.kind === "instrument" &&
      (instrumentInsertOfTrack(t) !== undefined ||
        instrumentFeeders(project, t.id).length > 0),
  );
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
          <span className="ir-count">{rack.length + hosts.length}</span>
        </div>
        <button type="button" className="btn primary ir-add" onClick={openAddMenu}>
          <Icon name="plus" size={13} /> Add Instrument
        </button>
      </div>

      <div className="ir-head" aria-hidden="true">
        <span>Host / VST</span><span>MIDI tracks</span><span>Channels</span><span>Audio output</span><span />
      </div>
      <div className="ir-list">
        {rack.map((ri) => (
          <RackRow
            key={`rack:${ri.id}`}
            ri={ri}
            project={project}
            registry={registry}
            outputOptions={outputOptions}
          />
        ))}
        {rack.length === 0 && hosts.length === 0 ? (
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
            const rowMenu = (): MenuEntry[] => [
              {
                label: "Route MIDI tracks…",
                icon: "link",
                submenu: routeMenuFor(project, host.id),
              },
              {
                label: "Feeder channels",
                icon: "midiNote",
                submenu: channelsMenuFor(project, host.id),
              },
              "separator",
              {
                label: "Remove instrument (keep rack slot)",
                icon: "x",
                disabled: !ins || !!host.frozen,
                title: "Unload the VSTi; MIDI routings stay for the next instrument",
                onClick: () => ins && removeInstrumentOnly(host, ins),
              },
              {
                label: "Remove from rack…",
                icon: "trash",
                danger: true,
                disabled: !!host.frozen,
                onClick: () => removeFromRack(host, feeders.map((t) => t.id)),
              },
            ];
            return (
              <div
                key={host.id}
                className={`ir-row${selected.includes(host.id) ? " selected" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openContextMenu(e.clientX, e.clientY, rowMenu());
                }}
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
                <button
                  type="button"
                  className="btn ir-route"
                  title={feeders.map((t) => t.name).join("\n") || "Route MIDI tracks at this instrument"}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    openContextMenu(r.left, r.bottom + 2, routeMenuFor(project, host.id));
                  }}
                >
                  {feeders.length} routed <Icon name="chevronDown" size={10} />
                </button>
                <button
                  type="button"
                  className="btn ir-route"
                  title="Per-track MIDI channel into this instrument"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    openContextMenu(r.left, r.bottom + 2, channelsMenuFor(project, host.id));
                  }}
                >
                  {channelLabel} <Icon name="chevronDown" size={10} />
                </button>
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
                <div className="ir-actions">
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
                  <button
                    type="button"
                    className="btn ir-more"
                    title="Remove instrument / remove from rack"
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      openContextMenu(r.left, r.bottom + 2, rowMenu());
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ============================================================================
 * Rack-owned instrument row (SPEC §5.9) — the first-class instance. Unlike the
 * host-track rows, this row IS the routing surface: it routes MIDI tracks here
 * (multi-toggle) and sets each feeder's channel, so a 14-track MIDI import is
 * "Add Instrument, route them, done" instead of a drag per track.
 * ========================================================================= */

function RackRow({
  ri,
  project,
  registry,
  outputOptions,
}: {
  ri: RackInstrument;
  project: Project;
  registry: PluginInfo[];
  outputOptions: SelectOption[];
}) {
  const feeders = project.tracks.filter((t) => t.kind === "midi" && t.midiTarget === ri.id);
  const channels = Array.from(new Set(feeders.map((t) => t.midiOutChannel ?? 0))).sort(
    (a, b) => a - b,
  );
  const channelLabel =
    channels.length === 0 ? "—" : channels.map((c) => (c === 0 ? "Any" : String(c))).join(", ");

  const routeMenu = () => routeMenuFor(project, ri.id);
  const channelsMenu = () => channelsMenuFor(project, ri.id);

  const rowMenu = (): MenuEntry[] => [
    { label: "Route MIDI tracks…", icon: "link", submenu: routeMenu() },
    { label: "Feeder channels", icon: "midiNote", submenu: channelsMenu() },
    "separator",
    {
      label: "Replace instrument…",
      icon: "refresh",
      title: "Swap the VSTi under the same rack slot — every routing survives",
      submenu: groupPluginVariants(
        registry
          .filter((p) => p.isInstrument && !p.blacklisted)
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).plugins.map((p) => ({
        label: p.name,
        checked: p.uid === ri.plugin.uid,
        onClick: () => fireIR(setRackInstrument(ri.id, { uid: p.uid })),
      })),
    },
    "separator",
    {
      label: "Remove from rack…",
      icon: "trash",
      danger: true,
      onClick: () => {
        void confirmDialog({
          title: "Remove rack instrument",
          message:
            `Remove "${ri.name}"? ${feeders.length} MIDI track${feeders.length === 1 ? "" : "s"} ` +
            `routed here will play unrouted. This can be undone.`,
          confirmLabel: "Remove",
          danger: true,
        }).then((ok) => {
          if (ok) fireIR(removeRackInstrument(ri.id));
        });
      },
    },
  ];

  return (
    <div
      className="ir-row ir-rack-row"
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, rowMenu());
      }}
    >
      <div className="ir-host">
        <Icon name="layers" size={16} />
        <span className="ir-host-text">
          <strong>{ri.name}</strong>
          <small>{ri.plugin.name} · rack</small>
        </span>
      </div>
      <button
        type="button"
        className="btn ir-route"
        title={feeders.map((t) => t.name).join("\n") || "Route MIDI tracks at this instrument"}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openContextMenu(r.left, r.bottom + 2, routeMenu());
        }}
      >
        {feeders.length} routed <Icon name="chevronDown" size={10} />
      </button>
      <button
        type="button"
        className="btn ir-route"
        title="Per-track MIDI channel into this instrument"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openContextMenu(r.left, r.bottom + 2, channelsMenu());
        }}
      >
        {channelLabel} <Icon name="chevronDown" size={10} />
      </button>
      <Select
        value={ri.outputTarget === 0 ? "master" : String(ri.outputTarget)}
        options={outputOptions.filter((o) => o.value !== "none")}
        title="Audio return destination"
        onChange={(v) =>
          fireIR(setRackInstrument(ri.id, { outputTarget: v === "master" ? 0 : Number(v) }))
        }
      />
      <div className="ir-actions">
        <button
          type="button"
          className="btn ir-open"
          title={`Open ${ri.plugin.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void openBestEditor(ri.plugin);
          }}
        >
          Open Editor
        </button>
        <button
          type="button"
          className="btn ir-more"
          title="Route / replace / remove"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu(r.left, r.bottom + 2, rowMenu());
          }}
        >
          <Icon name="chevronDown" size={13} />
        </button>
      </div>
    </div>
  );
}
