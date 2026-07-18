/**
 * InsertSlots (U3) — the INSERTS section of a channel strip (SPEC §9 / §5.6).
 *
 * Each slot: bypass dot (cmd/plugin.set), truncated name (click → generic editor via
 * openPluginEditorWindow), crash/timeout badge from store.pluginStates with the reason in
 * a tooltip. Right-click opens the plugin's native GUI directly when it has one, else falls
 * back to the options menu (Open Editor / Open Native UI / Bypass / Remove / Move Up/Down /
 * Replace ▸); Alt/Ctrl-right-click always shows that menu. The '+' slot opens a PluginPicker.
 * Accepts plugin drags from the Browser (lib/dnd PLUGIN_MIME). Slots themselves drag
 * Cubase-style (lib/dnd INSERT_MIME): within the channel = reorder; onto another channel =
 * MOVE with state (Alt at drop = COPY with settings); dropped on nothing = REMOVE, Escape
 * cancels. Frozen tracks render the slots visually disabled (engine bypasses inserts while
 * frozen, SPEC §5.5) and reject insert drops without treating them as "nothing".
 */

import React, { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PluginInstance, PluginStateEvent, Track } from "../../protocol/types";
import { useStore } from "../../store/store";
import * as actions from "../../store/actions";
import {
  clearInsertDrag,
  endInsertDrag,
  hasInsertDrag,
  hasPluginDrag,
  insertDropEffectFor,
  readInsertDrag,
  readPluginDrag,
  reorderTargetIndex,
  setInsertDrag,
} from "../../lib/dnd";
import { groupPluginVariants } from "../../lib/pluginVariants";
import { openContextMenu, MenuEntry } from "../common/ContextMenu";
import { Icon } from "../common/icons";
import { Tooltip } from "../common/Tooltip";
import { PluginPicker } from "./popups";

/**
 * Shared executor for a drop on a channel's insert area (used here and by the whole-strip
 * target in ChannelStrip). `before` is the insertion boundary in the CURRENT list
 * (0..inserts.length); `alt` is the Alt state AT DROP TIME (Alt = copy, default = move).
 */
export async function applyInsertAreaDrop(
  track: Track,
  dt: DataTransfer,
  before: number,
  alt: boolean,
): Promise<void> {
  const moved = hasInsertDrag(dt) ? readInsertDrag(dt) : null;
  if (moved) {
    clearInsertDrag(); // consumed — the source slot's dragend must not remove anything
    if (moved.trackId === track.id) {
      const target = reorderTargetIndex(before, moved.index, track.inserts.length);
      if (target === null) return; // dropped back where it started
      await actions.movePlugin(track.id, moved.instanceId, target);
    } else if (alt) {
      // Alt+drag: COPY to this channel at the drop position, cloning the source's
      // current settings/state (cmd/plugin.add + copyFrom).
      await actions.addPlugin(track.id, moved.uid, before, moved.instanceId);
    } else {
      // Default: MOVE the insert here — same live instance, state preserved, gone from
      // the source channel (cmd/plugin.move + destTrackId, one undo step).
      await actions.movePlugin(moved.trackId, moved.instanceId, before, track.id);
    }
    return;
  }
  const fromBrowser = readPluginDrag(dt);
  if (fromBrowser) await actions.addPlugin(track.id, fromBrowser.uid, before);
}

function StateBadge({ st }: { st: PluginStateEvent }) {
  if (st.state === "ok") return null;
  const bad = st.state === "crashed" || st.state === "timeout" || st.state === "failed";
  const tip =
    `Plugin ${st.state}` +
    (st.message ? `: ${st.message}` : "") +
    (st.restartCount > 0 ? ` (restarts: ${st.restartCount})` : "");
  return (
    <Tooltip content={tip}>
      <span className={"mxslot-state " + (bad ? "bad" : "busy")}>{bad ? "!" : "…"}</span>
    </Tooltip>
  );
}

export function InsertSlots({ track }: { track: Track }) {
  // Select only THIS track's insert states (shallow) so an event/pluginState for an unrelated
  // plugin doesn't re-render every strip's insert section (the whole-record selector did).
  const insertStates = useStore(
    useShallow((s) => track.inserts.map((ins) => s.pluginStates[ins.instanceId])),
  );
  const registry = useStore((s) => s.registry);
  const openEditor = useStore((s) => s.openPluginEditorWindow);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // Slot boundary the drop would land on (0..inserts.length), for the insertion indicator.
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const dragDepth = useRef(0);
  const frozen = !!track.frozen;

  const replaceWith = async (idx: number, oldInstanceId: number, uid: string) => {
    // No replace command in SPEC §5.6 — add at the same index, then remove the old one
    // (the old instance shifts to idx+1 after the insert, so position is preserved).
    await actions.addPlugin(track.id, uid, idx);
    await actions.removePlugin(track.id, oldInstanceId);
  };

  const replaceSubmenu = (idx: number, ins: PluginInstance): MenuEntry[] => {
    // Offer like-for-like where we can tell: instrument↔instrument, effect↔effect.
    // Shell channel-routing/bitness twins collapse to one entry (lib/pluginVariants).
    const old = registry.find((p) => p.uid === ins.uid);
    const top = groupPluginVariants(
      registry
        .filter((p) => !p.blacklisted && (old ? p.isInstrument === old.isInstrument : true))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).plugins.slice(0, 20);
    const items: MenuEntry[] = top.map((p) => ({
      label: p.name,
      onClick: () => void replaceWith(idx, ins.instanceId, p.uid),
    }));
    if (items.length === 0) items.push({ label: "No plugins in registry", disabled: true });
    items.push("separator", { label: "More: search in the Browser panel", disabled: true });
    return items;
  };

  const buildSlotMenu = (ins: PluginInstance, idx: number): MenuEntry[] => [
    ...(ins.path === "" && ins.format !== "builtin"
      ? ([
          {
            label: "Load (Recreate Plugins…)",
            icon: "plug",
            title: "This imported insert has no live plugin instance yet",
            onClick: () => useStore.getState().setDialogs({ recreatePlugins: true }),
          },
          "separator",
        ] as MenuEntry[])
      : []),
    {
      label: "Open Editor",
      icon: "sliders",
      onClick: () => openEditor(ins.instanceId),
    },
    {
      label: "Open Native UI",
      icon: "plug",
      onClick: () => void actions.openPluginEditor(ins.instanceId),
    },
    "separator",
      {
        label: "Bypass",
        icon: "power",
        checked: ins.bypass,
        onClick: () => void actions.setPlugin(ins.instanceId, { bypass: !ins.bypass }),
      },
      {
        label: "Move Up",
        icon: "chevronUp",
        disabled: idx === 0,
        onClick: () => void actions.movePlugin(track.id, ins.instanceId, idx - 1),
      },
      {
        label: "Move Down",
        icon: "chevronDown",
        disabled: idx >= track.inserts.length - 1,
        onClick: () => void actions.movePlugin(track.id, ins.instanceId, idx + 1),
      },
      { label: "Replace", icon: "refresh", submenu: replaceSubmenu(idx, ins) },
      "separator",
      {
        label: "Remove",
        icon: "trash",
        danger: true,
        onClick: () => void actions.removePlugin(track.id, ins.instanceId),
      },
    ];

  // Right-click opens the plugin's native GUI directly when it has one; otherwise (built-in
  // effects, or a VST with no editor) it falls back to the options menu. Alt/Ctrl-right-click
  // always shows the options menu, so a native-GUI plugin still exposes bypass/remove/move.
  const slotContext = (ins: PluginInstance, idx: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { clientX, clientY, altKey, ctrlKey, metaKey } = e;
    const showMenu = () => openContextMenu(clientX, clientY, buildSlotMenu(ins, idx));
    if (altKey || ctrlKey || metaKey || ins.format === "builtin") {
      showMenu();
      return;
    }
    // VST/VST3 — try the native editor; openEditor rejects when the plugin has none.
    actions.openPluginEditor(ins.instanceId).catch(showMenu);
  };

  /* ---- drag & drop -----------------------------------------------------------
   * Accepts two payloads: a plugin dragged from the Browser (adds a new insert), and an
   * EXISTING insert dragged from any channel (Cubase-style) — dropped on its own channel
   * it REORDERS (cmd/plugin.move), dropped on another channel it MOVES there with its
   * state (cmd/plugin.move + destTrackId), or COPIES with settings when Alt is held at
   * drop time (cmd/plugin.add + copyFrom). Dropped on "nothing" (no mixer target consumed
   * it) the source slot's dragend removes it; Escape cancels — both via lib/dnd's
   * endInsertDrag(). `dropIdx` is the slot boundary being targeted.
   */
  const accepts = (dt: DataTransfer) => hasPluginDrag(dt) || hasInsertDrag(dt);

  // Reorder in this channel = move; from another channel: Alt = copy, default = move.
  const effectFor = (e: React.DragEvent): "move" | "copy" =>
    hasInsertDrag(e.dataTransfer) ? insertDropEffectFor(track.id, e.altKey) : "copy";

  const beginDrag = (ins: PluginInstance, idx: number) => (e: React.DragEvent) => {
    if (frozen) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    setInsertDrag(e.dataTransfer, {
      trackId: track.id,
      instanceId: ins.instanceId,
      uid: ins.uid,
      index: idx,
    });
  };

  /** Source slot's dragend: an unconsumed in-document drop means "dropped on nothing". */
  const endDrag = (ins: PluginInstance) => () => {
    setDropIdx(null);
    if (endInsertDrag() === "remove")
      void actions.removePlugin(track.id, ins.instanceId);
  };

  // Frozen strips must read as invalid targets, not as "nothing" (which would remove the
  // dragged insert): swallow the insert-drag drop so it neither drops here nor bubbles to
  // lib/dnd's document-level drop-on-nothing listener.
  const swallowFrozenInsertDrop = (e: React.DragEvent): boolean => {
    if (frozen && hasInsertDrag(e.dataTransfer)) {
      e.stopPropagation();
      return true;
    }
    return frozen;
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (frozen || !accepts(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current++;
    setDropActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (frozen || !accepts(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = effectFor(e);
  };
  const onDragLeave = () => {
    if (dragDepth.current > 0) dragDepth.current--;
    if (dragDepth.current === 0) {
      setDropActive(false);
      setDropIdx(null);
    }
  };

  /** Drop anywhere in the section that isn't a slot → append at the end. */
  const onDrop = (e: React.DragEvent) => {
    dragDepth.current = 0;
    setDropActive(false);
    setDropIdx(null);
    if (swallowFrozenInsertDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    void applyInsertAreaDrop(track, e.dataTransfer, track.inserts.length, e.altKey);
  };

  /** Hovering a slot: target the boundary before or after it (whichever half we're over). */
  const slotDragOver = (idx: number) => (e: React.DragEvent) => {
    if (frozen || !accepts(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = effectFor(e);
    const r = e.currentTarget.getBoundingClientRect();
    setDropIdx(e.clientY < r.top + r.height / 2 ? idx : idx + 1);
  };

  const slotDrop = (idx: number) => (e: React.DragEvent) => {
    if (frozen || !accepts(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2 ? idx : idx + 1;
    dragDepth.current = 0;
    setDropActive(false);
    setDropIdx(null);
    void applyInsertAreaDrop(track, e.dataTransfer, before, e.altKey);
  };

  const openPicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPicker({ x: r.left - 4, y: r.bottom + 4 });
  };

  return (
    <div
      className={"mxsec mxsec-inserts" + (dropActive ? " drop-active" : "") + (frozen ? " frozen" : "")}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mxsec-label">
        <span>Inserts</span>
      </div>
      {frozen && (
        <div className="mxsec-frozen-note" title="Track is frozen — inserts are bypassed">
          <Icon name="snowflake" size={9} />
          <span>frozen</span>
        </div>
      )}
      <div className="mxsec-body">
        {track.inserts.map((ins, idx) => {
          const st = insertStates[idx];
          // Dormant: in the model but no live plugin instance (typical right after a
          // foreign import when the plugin isn't installed / not recreated yet).
          const dormant = ins.path === "" && ins.format !== "builtin";
          return (
            <div
              key={ins.instanceId}
              className={
                "mxslot" +
                (ins.bypass ? " bypassed" : "") +
                (dropIdx === idx ? " drop-before" : "") +
                (dropIdx === idx + 1 && idx === track.inserts.length - 1 ? " drop-after" : "")
              }
              draggable={!frozen}
              onDragStart={beginDrag(ins, idx)}
              onDragEnd={endDrag(ins)}
              onDragOver={slotDragOver(idx)}
              onDrop={slotDrop(idx)}
              onClick={() => openEditor(ins.instanceId)}
              onContextMenu={slotContext(ins, idx)}
              title={
                dormant
                  ? `${ins.name} — NOT LOADED (imported plugin without a live instance). Click the badge or use File ▸ Recreate Plugins to load or substitute it.`
                  : `${ins.name} — click: editor · right-click: native UI · Alt+right-click: options · drag: reorder, or move to another channel · Alt+drag: copy (with settings) · drop outside: remove`
              }
            >
              <button
                type="button"
                className="mxslot-dot"
                data-on={!ins.bypass ? "true" : undefined}
                title={ins.bypass ? "Bypassed — click to enable" : "Active — click to bypass"}
                onClick={(e) => {
                  e.stopPropagation();
                  void actions.setPlugin(ins.instanceId, { bypass: !ins.bypass });
                }}
              />
              <span className="mxslot-name">{ins.name}</span>
              {dormant ? (
                <Tooltip content={"Plugin not loaded — open Recreate Plugins"}>
                  <span
                    className="mxslot-state bad"
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      useStore.getState().setDialogs({ recreatePlugins: true });
                    }}
                  >
                    !
                  </span>
                </Tooltip>
              ) : st ? (
                <StateBadge st={st} />
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className="mxslot-add"
          disabled={frozen}
          onClick={openPicker}
          title="Add insert plugin"
        >
          <Icon name="plus" size={10} />
        </button>
      </div>
      {picker && (
        <PluginPicker
          x={picker.x}
          y={picker.y}
          onClose={() => setPicker(null)}
          onPick={(p) => void actions.addPlugin(track.id, p.uid)}
        />
      )}
    </div>
  );
}
