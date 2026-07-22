/**
 * Plugin Manager — a full-page registry view served on `?page=plugins`, opened in its
 * own browser tab from the Browser's Plugins tab (link button). Standalone: it talks
 * to the engine over the shared WsClient directly (no zustand store, no project state),
 * so it works alongside any number of open DAW windows.
 *
 * Columns: favorite ★, name, kind (instrument/effect), format (VST2/VST3/built-in),
 * bits, vendor, category, I/O, folder, status. Actions: Disable (plugins/blacklist)
 * and Enable (plugins/unblacklist) — both broadcast event/scanDone so every open
 * window's registry refreshes live. Blacklisted rows are red-tinted; instruments and
 * effects carry their own accent colors.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import "../../lib/theme.css";
import "./pluginmanager.css";
import { ws, type ConnectionState } from "../../protocol/ws";
import type { PluginInfo, ScanProgressEvent } from "../../protocol/types";
import {
  blacklistPlugin,
  getPluginRegistry,
  scanPlugins,
  unblacklistPlugin,
} from "../../store/actions";
import { loadPref, savePref } from "../../lib/prefs";
import { Icon } from "../common/icons";

type KindFilter = "all" | "instruments" | "effects" | "blacklisted" | "bit32";
type SortKey = "name" | "kind" | "format" | "bitness" | "vendor" | "category" | "io" | "folder" | "status";

const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((e) => typeof e === "string");

function folderOf(p: PluginInfo): string {
  if (p.format === "builtin") return "";
  const i = Math.max(p.path.lastIndexOf("/"), p.path.lastIndexOf("\\"));
  return i > 0 ? p.path.slice(0, i) : p.path;
}

function fileOf(p: PluginInfo): string {
  const i = Math.max(p.path.lastIndexOf("/"), p.path.lastIndexOf("\\"));
  return i >= 0 ? p.path.slice(i + 1) : p.path;
}

function formatLabel(p: PluginInfo): string {
  return p.format === "vst2" ? "VST2" : p.format === "vst3" ? "VST3" : "Built-in";
}

/** Stable identity for rows: uid is NOT unique across shell variants — include path+bitness. */
function rowKey(p: PluginInfo): string {
  return `${p.format}|${p.uid}|${p.bitness}|${p.path}`;
}

function sortValue(p: PluginInfo, key: SortKey): string | number {
  switch (key) {
    case "name": return p.name.toLowerCase();
    case "kind": return p.isInstrument ? 0 : 1;
    case "format": return formatLabel(p);
    case "bitness": return p.bitness;
    case "vendor": return p.vendor.toLowerCase();
    case "category": return p.category.toLowerCase();
    case "io": return p.numInputs * 1000 + p.numOutputs;
    case "folder": return folderOf(p).toLowerCase();
    case "status": return p.blacklisted ? 1 : 0;
  }
}

export default function PluginManagerPage() {
  const [registry, setRegistry] = useState<PluginInfo[]>([]);
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const [scan, setScan] = useState<ScanProgressEvent | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<KindFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<readonly string[]>(() =>
    loadPref<string[]>("browser.pluginFavorites", [], isStringArray),
  );

  const refresh = useCallback(() => {
    getPluginRegistry()
      .then((r) => {
        setRegistry(r.registry);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    ws.connect();
    const offState = ws.onStateChange(setConnState);
    const offReconnect = ws.onReconnect(refresh); // fires on initial open too
    const offDone = ws.on("event/scanDone", (p) => {
      setScan(null);
      setRegistry(p.registry);
    });
    const offProg = ws.on("event/scanProgress", setScan);
    // Another tab may edit favorites (same localStorage) — follow it live.
    const onStorage = () =>
      setFavorites(loadPref<string[]>("browser.pluginFavorites", [], isStringArray));
    window.addEventListener("storage", onStorage);
    return () => {
      offState();
      offReconnect();
      offDone();
      offProg();
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  const toggleFavorite = useCallback((p: PluginInfo) => {
    setFavorites((prev) => {
      const next = prev.includes(p.uid) ? prev.filter((u) => u !== p.uid) : [...prev, p.uid];
      savePref("browser.pluginFavorites", [...next]);
      return next;
    });
  }, []);

  const disable = useCallback(
    (p: PluginInfo) => {
      const key = rowKey(p);
      setBusyKey(key);
      blacklistPlugin(p.path, p.uid)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusyKey((k) => (k === key ? null : k)));
      // registry refresh arrives via the event/scanDone broadcast
    },
    [],
  );

  const enable = useCallback(
    (p: PluginInfo) => {
      const key = rowKey(p);
      setBusyKey(key);
      // unblacklist matches uid exactly OR path (covers path-surrogate uids)
      unblacklistPlugin(p.uid !== "" ? p.uid : p.path)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusyKey((k) => (k === key ? null : k)));
    },
    [],
  );

  const counts = useMemo(() => {
    let instruments = 0;
    let effects = 0;
    let blacklisted = 0;
    let bit32 = 0;
    for (const p of registry) {
      if (p.isInstrument) instruments++;
      else effects++;
      if (p.blacklisted) blacklisted++;
      if (p.bitness === 32) bit32++;
    }
    return { instruments, effects, blacklisted, bit32 };
  }, [registry]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = registry.filter((p) => {
      if (filter === "instruments" && !p.isInstrument) return false;
      if (filter === "effects" && p.isInstrument) return false;
      if (filter === "blacklisted" && !p.blacklisted) return false;
      if (filter === "bit32" && p.bitness !== 32) return false;
      if (q === "") return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.vendor.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q)
      );
    });
    const { key, dir } = sort;
    out = out.slice().sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      // stable-ish secondary: name then path
      const na = a.name.toLowerCase();
      const nb = b.name.toLowerCase();
      if (na !== nb) return na < nb ? -1 : 1;
      return a.path < b.path ? -1 : 1;
    });
    return out;
  }, [registry, query, filter, sort]);

  const clickSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const th = (key: SortKey, label: string, extraClass = "") => (
    <th
      className={`pm-th ${extraClass}`}
      onClick={() => clickSort(key)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      {sort.key === key && <span className="pm-sort">{sort.dir === 1 ? "▲" : "▼"}</span>}
    </th>
  );

  const chip = (f: KindFilter, label: string, count: number, cls = "") => (
    <button
      type="button"
      className={`pm-chip ${cls}${filter === f ? " active" : ""}`}
      onClick={() => setFilter((cur) => (cur === f ? "all" : f))}
    >
      {label} <span className="pm-chip-count">{count}</span>
    </button>
  );

  const scanPct = scan && scan.total > 0 ? Math.min(100, (scan.current / scan.total) * 100) : 0;

  return (
    <div className="pm-page">
      <header className="pm-header">
        <div className="pm-title-row">
          <span className="pm-logo">
            <Icon name="plug" size={20} />
          </span>
          <h1 className="pm-title">Plugin Manager</h1>
          <span
            className={`pm-conn ${connState}`}
            title={connState === "open" ? "Connected to the engine" : `Engine: ${connState}`}
          >
            ● {connState === "open" ? "connected" : connState}
          </span>
          <span className="pm-spacer" />
          <button
            type="button"
            className="pm-btn"
            disabled={connState !== "open" || scan !== null}
            onClick={() => {
              scanPlugins().catch((e) => setError(String(e)));
            }}
            title="Rescan the configured plugin folders"
          >
            <Icon name="refresh" size={13} /> Rescan
          </button>
        </div>
        <div className="pm-toolbar">
          {chip("all", "All", registry.length)}
          {chip("instruments", "Instruments", counts.instruments, "inst")}
          {chip("effects", "Effects", counts.effects, "fx")}
          {chip("bit32", "32-bit", counts.bit32, "b32")}
          {chip("blacklisted", "Blacklisted", counts.blacklisted, "bl")}
          <input
            className="pm-search"
            type="search"
            placeholder="Search name, vendor, category, path…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {scan && (
          <div className="pm-scanline">
            <div className="pm-scanbar" style={{ width: `${scanPct}%` }} />
            <span className="pm-scantext">
              Scanning {scan.current}/{scan.total} — {scan.path} ({scan.found} found)
            </span>
          </div>
        )}
        {error && (
          <div className="pm-error" onClick={() => setError(null)} title="Click to dismiss">
            {error}
          </div>
        )}
      </header>

      <main className="pm-main">
        <table className="pm-table">
          <thead>
            <tr>
              <th className="pm-th pm-th-fav" title="Favorites (shared with the Browser panel)">★</th>
              {th("name", "Name")}
              {th("kind", "Kind")}
              {th("format", "Format")}
              {th("bitness", "Bits")}
              {th("vendor", "Vendor")}
              {th("category", "Category")}
              {th("io", "I/O")}
              {th("folder", "Folder", "pm-th-folder")}
              {th("status", "Status")}
              <th className="pm-th pm-th-actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const key = rowKey(p);
              const busy = busyKey === key;
              const fav = favorites.includes(p.uid);
              return (
                <tr
                  key={key}
                  className={
                    "pm-row" +
                    (p.blacklisted ? " blacklisted" : p.isInstrument ? " instrument" : " effect")
                  }
                >
                  <td className="pm-td pm-td-fav">
                    <button
                      type="button"
                      className={"pm-fav" + (fav ? " on" : "")}
                      title={fav ? "Remove from favorites" : "Add to favorites"}
                      onClick={() => toggleFavorite(p)}
                    >
                      {fav ? "★" : "☆"}
                    </button>
                  </td>
                  <td className="pm-td pm-td-name" title={p.path || p.uid}>
                    <span className="pm-dot" aria-hidden="true" />
                    <span className="pm-name">{p.name}</span>
                    {p.format !== "builtin" && <span className="pm-file">{fileOf(p)}</span>}
                  </td>
                  <td className="pm-td">
                    <span className={"pm-badge " + (p.isInstrument ? "inst" : "fx")}>
                      {p.isInstrument ? "Instrument" : "Effect"}
                    </span>
                  </td>
                  <td className="pm-td">
                    <span className={"pm-badge fmt-" + p.format}>{formatLabel(p)}</span>
                  </td>
                  <td className="pm-td">
                    {p.format === "builtin" ? (
                      <span className="pm-faint">—</span>
                    ) : (
                      <span className={"pm-badge " + (p.bitness === 32 ? "b32" : "b64")}>
                        {p.bitness}
                      </span>
                    )}
                  </td>
                  <td className="pm-td pm-td-vendor" title={p.vendor}>{p.vendor || "—"}</td>
                  <td className="pm-td" title={p.category}>{p.category || "—"}</td>
                  <td className="pm-td pm-td-io">{p.numInputs}→{p.numOutputs}</td>
                  <td className="pm-td pm-td-folder" title={p.path}>
                    {p.format === "builtin" ? <span className="pm-faint">stock</span> : folderOf(p)}
                  </td>
                  <td className="pm-td">
                    {p.blacklisted ? (
                      <span className="pm-status bad" title={p.blacklistReason || "blacklisted"}>
                        Blacklisted
                      </span>
                    ) : (
                      <span className="pm-status ok">OK</span>
                    )}
                  </td>
                  <td className="pm-td pm-td-actions">
                    {p.format === "builtin" ? null : p.blacklisted ? (
                      <button
                        type="button"
                        className="pm-btn pm-btn-enable"
                        disabled={busy || connState !== "open"}
                        onClick={() => enable(p)}
                        title={`Remove from the blacklist${p.blacklistReason ? ` (was: ${p.blacklistReason})` : ""}`}
                      >
                        Enable
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="pm-btn pm-btn-disable"
                        disabled={busy || connState !== "open"}
                        onClick={() => disable(p)}
                        title="Disable this plugin (adds it to the blacklist — reversible)"
                      >
                        Disable
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="pm-empty">
            {registry.length === 0
              ? connState === "open"
                ? "No plugins in the registry — configure folders in the DAW's Settings and rescan."
                : "Waiting for the engine…"
              : "Nothing matches the current filter."}
          </div>
        )}
      </main>

      <footer className="pm-footer">
        <span>
          {rows.length} shown of {registry.length} plugins · {counts.instruments} instruments ·{" "}
          {counts.effects} effects · {counts.blacklisted} blacklisted
        </span>
        <span className="pm-spacer" />
        <span className="pm-faint">
          Disable adds a plugin to MyDAW's persistent blacklist (never touches files on disk);
          Enable removes it again. Changes apply to all open windows immediately.
        </span>
      </footer>
    </div>
  );
}
