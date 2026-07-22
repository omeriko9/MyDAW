/**
 * Browser → Plugins tab (U6, SPEC §9).
 *
 * - search box filtering name + vendor
 * - group-by select (Vendor / Category / Flat) with collapsible groups
 * - VirtualList rows: name, format badge, 32-bit chip, instrument icon,
 *   blacklisted rows danger-tinted with reason tooltip + inline [unblacklist]
 * - rows are drag sources (lib/dnd setPluginDrag {uid})
 * - double-click adds the plugin to the FIRST selected track (hint when none)
 * - "★ Favorites" + "Recent" pseudo-groups pinned above the real groups (prefs
 *   browser.pluginFavorites / browser.pluginRecent); hover star or the context
 *   menu toggles favorite; adds from this tab record recents (cap 10)
 * - footer: plugin count, [Rescan] (plugins/scan, Shift = full) with inline
 *   event/scanProgress, gear → Settings dialog
 */

import React, { memo, useCallback, useMemo, useState } from "react";
import { useStore } from "../../store/store";
import {
  addPlugin,
  getPluginRegistry,
  scanPlugins,
  unblacklistPlugin,
} from "../../store/actions";
import { setDragChip, setPluginDrag } from "../../lib/dnd";
import { pluginCardEnter, pluginCardLeave } from "./pluginHoverCard";
import { pluginKey } from "../../lib/ids";
import { groupPluginVariants } from "../../lib/pluginVariants";
import { isBool, loadPref, oneOf, savePref, usePrefState } from "../../lib/prefs";
import type { PluginInfo } from "../../protocol/types";
import { contextMenuHandler, type MenuEntry } from "../common/ContextMenu";
import { Icon } from "../common/icons";
import { IconButton } from "../common/IconButton";
import { Select } from "../common/Select";
import { TextInput } from "../common/TextInput";
import { Toggle } from "../common/Toggle";
import { Tooltip } from "../common/Tooltip";
import { VirtualList } from "../common/VirtualList";
import { baseName, errText } from "./Browser";

const ROW_H = 24;
const RECENT_MAX = 10;

type GroupBy = "vendor" | "category" | "flat";

interface GroupRow {
  kind: "group";
  key: string;
  label: string;
  count: number;
  collapsed: boolean;
}
interface PluginRowModel {
  kind: "plugin";
  plugin: PluginInfo;
  /** Set for rows inside the "★ Favorites" / "Recent" pseudo-groups (keeps row keys unique). */
  sect?: "fav" | "recent";
}
type Row = GroupRow | PluginRowModel;

const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function buildRows(
  registry: PluginInfo[],
  query: string,
  groupBy: GroupBy,
  collapsed: ReadonlySet<string>,
  favorites: readonly string[],
  recent: readonly string[],
  favoritesOnly: boolean,
): { rows: Row[]; matchCount: number; variantsByKey: Map<string, string[]> } {
  const q = query.trim().toLowerCase();
  const favSet = new Set(favorites);
  let filtered = (
    q
      ? registry.filter(
          (p) => p.name.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q),
        )
      : registry.slice()
  ).sort((a, b) => a.name.localeCompare(b.name));
  // One row per plugin: shell channel-routing / bitness twins collapse to the best
  // variant (searching a routing token like "mono" still surfaces its group).
  const grouped = groupPluginVariants(filtered);
  filtered = grouped.plugins;
  const variantsByKey = grouped.variantsByKey;
  // Favorites-only mode: restrict the whole list to favorited plugins.
  if (favoritesOnly) filtered = filtered.filter((p) => favSet.has(p.uid));

  if (groupBy === "flat") {
    return {
      rows: filtered.map((plugin) => ({ kind: "plugin", plugin })),
      matchCount: filtered.length,
      variantsByKey,
    };
  }

  const rows: Row[] = [];

  // Pseudo-groups pinned above the real groups (skipped in flat mode, and redundant when
  // already filtered to favorites). Their plugins ALSO appear in their normal group; `sect`
  // keeps the VirtualList keys unique. Omitted when empty.
  const pseudo: { key: string; label: string; sect: "fav" | "recent"; plugins: PluginInfo[] }[] =
    favoritesOnly
      ? []
      : [
          {
            key: "fav:*",
            label: "★ Favorites",
            sect: "fav",
            plugins: filtered.filter((p) => favSet.has(p.uid)), // `filtered` is already name-sorted
          },
          {
            key: "recent:*",
            label: "Recent",
            sect: "recent",
            plugins: recent
              .slice(0, RECENT_MAX)
              .map((uid) => filtered.find((p) => p.uid === uid))
              .filter((p): p is PluginInfo => p !== undefined),
          },
        ];
  for (const { key, label, sect, plugins } of pseudo) {
    if (plugins.length === 0) continue;
    const isCollapsed = collapsed.has(key);
    rows.push({ kind: "group", key, label, count: plugins.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const plugin of plugins) rows.push({ kind: "plugin", plugin, sect });
  }

  const groups = new Map<string, PluginInfo[]>();
  for (const p of filtered) {
    const raw = groupBy === "vendor" ? p.vendor : p.category;
    const label = raw && raw.trim() !== "" ? raw : groupBy === "vendor" ? "Unknown vendor" : "Uncategorized";
    const list = groups.get(label);
    if (list) list.push(p);
    else groups.set(label, [p]);
  }
  const labels = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const label of labels) {
    const plugins = groups.get(label) as PluginInfo[];
    const key = `${groupBy}:${label}`;
    const isCollapsed = collapsed.has(key);
    rows.push({ kind: "group", key, label, count: plugins.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const plugin of plugins) rows.push({ kind: "plugin", plugin });
  }
  return { rows, matchCount: filtered.length, variantsByKey };
}

/* ============================================================================
 * Rows
 * ========================================================================= */

const PluginRowView = memo(function PluginRowView({
  p,
  favorite,
  variants,
  onAdd,
  onToggleFavorite,
  onUnblacklist,
  onRescan,
}: {
  p: PluginInfo;
  favorite: boolean;
  /** Full names of merged shell-routing/bitness twins (incl. this row), when > 1. */
  variants?: string[];
  onAdd: (p: PluginInfo) => void;
  onToggleFavorite: (p: PluginInfo) => void;
  onUnblacklist: (p: PluginInfo) => void;
  onRescan: (full: boolean) => void;
}) {
  // Built lazily at open time so connection / selection / scan state is current.
  const menuItems = (): MenuEntry[] => {
    const st = useStore.getState();
    const scanning = st.scanProgress !== null;
    const addTitle = p.blacklisted
      ? "Blacklisted — remove it from the blacklist first"
      : !st.connected
        ? "Engine disconnected"
        : st.selection.trackIds[0] === undefined
          ? "Select a track first"
          : `Add "${p.name}" to the first selected track`;
    return [
      {
        label: "Add to Selected Track",
        icon: "plus",
        disabled: p.blacklisted || !st.connected || st.selection.trackIds[0] === undefined,
        title: addTitle,
        onClick: () => onAdd(p),
      },
      {
        label: favorite ? "Unfavorite" : "Favorite",
        title: favorite
          ? `Remove "${p.name}" from favorites`
          : `Add "${p.name}" to favorites`,
        onClick: () => onToggleFavorite(p),
      },
      "separator",
      ...(p.blacklisted
        ? ([
            {
              label: "Remove from Blacklist",
              title: "Remove from blacklist and allow loading",
              onClick: () => onUnblacklist(p),
            },
          ] satisfies MenuEntry[])
        : []),
      {
        label: "Rescan Plugins…",
        icon: "refresh",
        disabled: !st.connected || scanning,
        title: !st.connected
          ? "Engine disconnected"
          : scanning
            ? "A scan is already running"
            : "Rescan plugin folders",
        onClick: () => onRescan(false),
      },
    ];
  };

  const row = (
    <div
      className={
        "plugin-row" + (p.isInstrument ? " instrument" : "") + (p.blacklisted ? " blacklisted" : "")
      }
      draggable={!p.blacklisted}
      onDragStart={(e) => {
        pluginCardLeave();
        setPluginDrag(e.dataTransfer, { uid: p.uid });
        setDragChip(e.dataTransfer, p.name, "plugin");
      }}
      onDoubleClick={() => onAdd(p)}
      onContextMenu={contextMenuHandler(menuItems)}
      onMouseEnter={(e) => pluginCardEnter(p, e.currentTarget)}
      onMouseLeave={pluginCardLeave}
      onMouseDown={pluginCardLeave}
    >
      <Icon name={p.isInstrument ? "piano" : "plug"} size={13} className="plugin-row-icon" />
      <span className="ellipsis grow">{p.name}</span>
      {variants && (
        <Tooltip content={"Merged shell variants (best one is used):\n" + variants.join("\n")}>
          <span className="badge">×{variants.length}</span>
        </Tooltip>
      )}
      <button
        type="button"
        className={"plugin-fav" + (favorite ? " active" : "")}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(p);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {favorite ? "★" : "☆"}
      </button>
      {p.blacklisted ? (
        <button
          type="button"
          className="plugin-unbl"
          title="Remove from blacklist and allow loading"
          onClick={(e) => {
            e.stopPropagation();
            onUnblacklist(p);
          }}
        >
          unblacklist
        </button>
      ) : null}
      {p.bitness === 32 && p.format !== "builtin" ? <span className="badge warn">32-bit</span> : null}
      <span className="badge">
        {p.format === "vst2" ? "VST2" : p.format === "vst3" ? "VST3" : "Stock"}
      </span>
    </div>
  );
  if (!p.blacklisted) return row;
  return (
    <Tooltip content={`Blacklisted: ${p.blacklistReason ?? "failed to load during scan"}`}>
      {row}
    </Tooltip>
  );
});

function GroupHeader({
  row,
  onToggle,
  onCollapseAll,
}: {
  row: GroupRow;
  onToggle: (key: string) => void;
  onCollapseAll: (on: boolean) => void;
}) {
  return (
    <div
      className="plugin-group"
      role="button"
      tabIndex={0}
      aria-expanded={!row.collapsed}
      onClick={() => onToggle(row.key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onToggle(row.key);
        }
      }}
      onContextMenu={contextMenuHandler(() => [
        { label: "Collapse All", icon: "chevronUp", onClick: () => onCollapseAll(true) },
        { label: "Expand All", icon: "chevronDown", onClick: () => onCollapseAll(false) },
      ])}
    >
      <Icon name={row.collapsed ? "chevronRight" : "chevronDown"} size={12} />
      <span className="ellipsis grow">{row.label}</span>
      <span className="plugin-group-count">{row.count}</span>
    </div>
  );
}

/* ============================================================================
 * Tab
 * ========================================================================= */

export interface PluginsTabProps {
  showHint: (msg: string) => void;
}

export default function PluginsTab({ showHint }: PluginsTabProps) {
  const registry = useStore((s) => s.registry);
  const scan = useStore((s) => s.scanProgress);
  const connected = useStore((s) => s.connected);
  const setDialogs = useStore((s) => s.setDialogs);

  const [query, setQuery] = useState("");
  // Group-by mode and which groups are collapsed persist across reloads (lib/prefs).
  // Collapse keys are "<groupBy>:<label>", so each grouping mode keeps its own set.
  const [groupBy, setGroupBy] = usePrefState<GroupBy>(
    "browser.pluginsGroupBy",
    "vendor",
    oneOf<GroupBy>("vendor", "category", "flat"),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(loadPref<string[]>("browser.pluginsCollapsed", [], isStringArray)),
  );
  // Favorited plugin uids + most-recent-first uids of plugins added from this tab.
  const [favorites, setFavorites] = useState<readonly string[]>(() =>
    loadPref<string[]>("browser.pluginFavorites", [], isStringArray),
  );
  const [recent, setRecent] = useState<readonly string[]>(() =>
    loadPref<string[]>("browser.pluginRecent", [], isStringArray),
  );
  // "Favorites only" filter (toggle left of the group-by select), persisted across reloads.
  const [favoritesOnly, setFavoritesOnly] = usePrefState<boolean>(
    "browser.pluginFavoritesOnly",
    false,
    isBool,
  );
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const { rows, matchCount, variantsByKey } = useMemo(
    () => buildRows(registry, query, groupBy, collapsed, favorites, recent, favoritesOnly),
    [registry, query, groupBy, collapsed, favorites, recent, favoritesOnly],
  );

  const toggleFavorite = useCallback((p: PluginInfo) => {
    setFavorites((prev) => {
      const next = prev.includes(p.uid) ? prev.filter((uid) => uid !== p.uid) : [...prev, p.uid];
      savePref("browser.pluginFavorites", next);
      return next;
    });
  }, []);

  const recordRecent = useCallback((uid: string) => {
    setRecent((prev) => {
      const next = [uid, ...prev.filter((u) => u !== uid)].slice(0, RECENT_MAX);
      savePref("browser.pluginRecent", next);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      savePref("browser.pluginsCollapsed", [...next]);
      return next;
    });
  }, []);

  // Collapse/expand ALL groups of the current grouping mode. Keys come from the full
  // (unfiltered) registry so collapse-all also covers groups hidden by the search.
  const groupKeys = useMemo(() => {
    if (groupBy === "flat") return [];
    const { rows: allRows } = buildRows(registry, "", groupBy, new Set(), favorites, recent, favoritesOnly);
    return allRows.filter((r): r is GroupRow => r.kind === "group").map((r) => r.key);
  }, [registry, groupBy, favorites, recent, favoritesOnly]);
  const allCollapsed = groupKeys.length > 0 && groupKeys.every((k) => collapsed.has(k));

  const setAllCollapsed = useCallback(
    (on: boolean) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        for (const k of groupKeys) {
          if (on) next.add(k);
          else next.delete(k);
        }
        savePref("browser.pluginsCollapsed", [...next]);
        return next;
      });
    },
    [groupKeys],
  );

  const onAdd = useCallback(
    (p: PluginInfo) => {
      void (async () => {
        if (p.blacklisted) {
          showHint(`"${p.name}" is blacklisted — unblacklist it first.`);
          return;
        }
        const st = useStore.getState();
        if (!st.connected) {
          showHint("Engine disconnected — cannot add plugins.");
          return;
        }
        const trackId = st.selection.trackIds[0];
        if (trackId === undefined) {
          showHint("Select a track first, or drag the plugin onto a track / mixer strip.");
          return;
        }
        const track =
          st.project?.tracks.find((t) => t.id === trackId) ??
          (st.project && st.project.masterTrack.id === trackId ? st.project.masterTrack : undefined);
        try {
          await addPlugin(trackId, p.uid);
          recordRecent(p.uid);
          showHint(`Added "${p.name}" to ${track ? `"${track.name}"` : "the selected track"}.`);
        } catch (e) {
          showHint(`Failed to add "${p.name}": ${errText(e)}`);
        }
      })();
    },
    [showHint, recordRecent],
  );

  const onUnblacklist = useCallback(
    (p: PluginInfo) => {
      void (async () => {
        try {
          await unblacklistPlugin(p.uid);
          try {
            const r = await getPluginRegistry();
            useStore.getState().setRegistry(r.registry);
          } catch {
            /* registry refreshes on next scanDone */
          }
          showHint(`Unblacklisted "${p.name}" — rescan to verify it loads.`);
        } catch (e) {
          showHint(`Unblacklist failed: ${errText(e)}`);
        }
      })();
    },
    [showHint],
  );

  const onRescan = useCallback(
    (full: boolean) => {
      scanPlugins(full ? true : undefined).catch((e) => showHint(`Scan failed: ${errText(e)}`));
    },
    [showHint],
  );

  const renderItem = useCallback(
    (i: number): React.ReactNode => {
      const r = rows[i];
      if (r === undefined) return null;
      if (r.kind === "group")
        return <GroupHeader row={r} onToggle={toggleGroup} onCollapseAll={setAllCollapsed} />;
      return (
        <PluginRowView
          p={r.plugin}
          favorite={favoriteSet.has(r.plugin.uid)}
          variants={variantsByKey.get(pluginKey(r.plugin))}
          onAdd={onAdd}
          onToggleFavorite={toggleFavorite}
          onUnblacklist={onUnblacklist}
          onRescan={onRescan}
        />
      );
    },
    [rows, toggleGroup, favoriteSet, variantsByKey, onAdd, toggleFavorite, onUnblacklist, onRescan],
  );

  const countText =
    query.trim() !== ""
      ? `${matchCount} of ${registry.length} plugin${registry.length === 1 ? "" : "s"}`
      : `${registry.length} plugin${registry.length === 1 ? "" : "s"}`;

  const scanPct = scan && scan.total > 0 ? Math.min(100, (scan.current / scan.total) * 100) : 0;

  return (
    <div className="col grow">
      <div className="browser-toolbar">
        <TextInput
          className="grow"
          type="search"
          value={query}
          onChange={setQuery}
          placeholder="Search plugins…"
          onKeyDown={(e) => {
            // Escape clears the filter (then a second Escape blurs via TextInput).
            if (e.key === "Escape" && query !== "") {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        <Toggle
          on={favoritesOnly}
          onChange={setFavoritesOnly}
          variant="warn"
          tooltip={favoritesOnly ? "Showing favorites only — click to show all" : "Show favorites only"}
        >
          {favoritesOnly ? "★" : "☆"}
        </Toggle>
        <Select
          value={groupBy}
          onChange={(v) => setGroupBy(v as GroupBy)}
          width={92}
          title="Group plugins by"
          options={[
            { value: "vendor", label: "Vendor" },
            { value: "category", label: "Category" },
            { value: "flat", label: "Flat" },
          ]}
        />
        <IconButton
          icon={allCollapsed ? "chevronDown" : "chevronUp"}
          size={22}
          tooltip={allCollapsed ? "Expand all groups" : "Collapse all groups"}
          disabled={groupBy === "flat" || groupKeys.length === 0}
          onClick={() => setAllCollapsed(!allCollapsed)}
        />
        <IconButton
          icon="link"
          size={22}
          tooltip="Open the Plugin Manager in a new browser tab"
          onClick={() => {
            const url = new URL(window.location.href);
            url.search = "?page=plugins";
            url.hash = "";
            window.open(url.toString(), "_blank", "noopener");
          }}
        />
      </div>

      <div className="browser-listwrap col">
        {registry.length === 0 ? (
          <div className="browser-empty">
            <Icon name="plug" size={22} />
            {scan ? (
              <span>Scanning plugins…</span>
            ) : (
              <>
                <span>No plugins in the registry.</span>
                <span className="faint">
                  Rescan below, or configure plugin folders in Settings (gear).
                </span>
              </>
            )}
          </div>
        ) : rows.length === 0 ? (
          <div className="browser-empty">
            {favoritesOnly && query.trim() === "" ? (
              <span>No favorite plugins yet — click the ☆ next to a plugin to add one.</span>
            ) : (
              <span>No plugins match “{query.trim()}”.</span>
            )}
          </div>
        ) : (
          <VirtualList
            itemCount={rows.length}
            itemHeight={ROW_H}
            itemKey={(i) => {
              const r = rows[i];
              return r.kind === "group" ? `g:${r.key}` : `p:${r.sect ?? "all"}:${pluginKey(r.plugin)}`;
            }}
            renderItem={renderItem}
          />
        )}
      </div>

      {scan !== null && (
        <div className="browser-progressblock">
          <div className="browser-progress">
            <div style={{ width: `${scanPct}%` }} />
          </div>
          <div className="row gap1">
            <span className="ellipsis grow">{baseName(scan.path)}</span>
            <span style={{ whiteSpace: "nowrap" }}>
              {scan.current}/{scan.total} · {scan.found} found
            </span>
          </div>
        </div>
      )}

      <div className="browser-footer">
        <span className="dim">{countText}</span>
        <div className="grow" />
        <Tooltip content={"Rescan plugin folders.\nShift-click = full rescan (ignores cache)."}>
          <button
            type="button"
            className="btn"
            disabled={!connected || scan !== null}
            onClick={(e) => onRescan(e.shiftKey)}
          >
            <Icon name="refresh" size={13} />
            {scan ? "Scanning…" : "Rescan"}
          </button>
        </Tooltip>
        <IconButton
          icon="settings"
          tooltip="Plugin folders & settings"
          onClick={() => setDialogs({ settings: true })}
        />
      </div>
    </div>
  );
}
