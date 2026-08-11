/**
 * Blacklist panel (Plugin Manager page) — the RAW persistent blacklist, not the registry
 * view: entries whose crash predated a uid (path surrogates) or whose file vanished never
 * appear as registry rows, so the registry-derived list silently hid them. Shows why and
 * when each entry landed here, and batch-unblacklists in ONE engine round-trip (one save,
 * one event/scanDone) — 76 entries × one-by-one was unusable.
 *
 * Page constraint (main.tsx): no store.ts import — ws + actions only.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { BlacklistEntry } from "../../protocol/types";
import { getPluginBlacklist, unblacklistPlugins } from "../../store/actions";
import { ws } from "../../protocol/ws";

function fileOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** "2026-06-15T14:09:38Z" → local short date; raw string on anything unparseable. */
function whenLabel(when: string): string {
  const t = Date.parse(when);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : when;
}

export default function BlacklistPanel({ connected }: { connected: boolean }) {
  const [entries, setEntries] = useState<BlacklistEntry[]>([]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getPluginBlacklist()
      .then((r) => {
        setEntries(r.entries);
        // Drop checks for entries that no longer exist (post-unblacklist refresh).
        setChecked((prev) => {
          const paths = new Set(r.entries.map((e) => e.path));
          const next = new Set([...prev].filter((p) => paths.has(p)));
          return next.size === prev.size ? prev : next;
        });
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
    // Any blacklist mutation (this tab, the registry table, another window) broadcasts
    // scanDone — reuse it as the refresh signal, same as the registry view does.
    const off = ws.on("event/scanDone", refresh);
    return off;
  }, [refresh]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return entries;
    return entries.filter(
      (e) =>
        e.path.toLowerCase().includes(q) ||
        e.reason.toLowerCase().includes(q) ||
        (e.uid ?? "").toLowerCase().includes(q),
    );
  }, [entries, query]);

  const allShownChecked = rows.length > 0 && rows.every((e) => checked.has(e.path));
  const toggleAllShown = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (allShownChecked) for (const e of rows) next.delete(e.path);
      else for (const e of rows) next.add(e.path);
      return next;
    });
  const toggleOne = (path: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const run = useCallback(
    (req: { paths?: string[]; all?: boolean; rescan?: boolean }) => {
      setBusy(true);
      unblacklistPlugins(req)
        .then(() => setError(null)) // list refresh arrives via event/scanDone
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [],
  );

  const selected = [...checked];
  const actionable = connected && !busy;

  return (
    <div className="pm-bl">
      <div className="pm-toolbar">
        <input
          className="pm-search"
          type="search"
          aria-label="Search blacklist"
          placeholder="Search path, reason, uid…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="pm-spacer" />
        <button
          type="button"
          className="pm-btn"
          disabled={!actionable || selected.length === 0}
          onClick={() => run({ paths: selected })}
          title="Remove the checked entries from the blacklist (one operation)"
        >
          Unblacklist selected ({selected.length})
        </button>
        <button
          type="button"
          className="pm-btn"
          disabled={!actionable || selected.length === 0}
          onClick={() => run({ paths: selected, rescan: true })}
          title="Remove the checked entries AND rescan those files now"
        >
          …and rescan
        </button>
        <button
          type="button"
          className="pm-btn danger"
          disabled={!actionable || entries.length === 0}
          onClick={() => run({ all: true })}
          title="Empty the entire blacklist — every entry becomes scannable again on the next rescan"
        >
          Unblacklist all ({entries.length})
        </button>
      </div>
      {error && (
        <div className="pm-error" onClick={() => setError(null)} title="Click to dismiss">
          {error}
        </div>
      )}
      <table className="pm-table">
        <thead>
          <tr>
            <th className="pm-th pm-th-check">
              <input
                type="checkbox"
                aria-label="Select all shown"
                checked={allShownChecked}
                onChange={toggleAllShown}
              />
            </th>
            <th className="pm-th">File</th>
            <th className="pm-th">Reason</th>
            <th className="pm-th">When</th>
            <th className="pm-th pm-th-folder">Path</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.path} className="pm-row blacklisted">
              <td className="pm-td pm-td-check">
                <input
                  type="checkbox"
                  aria-label={`Select ${fileOf(e.path)}`}
                  checked={checked.has(e.path)}
                  onChange={() => toggleOne(e.path)}
                />
              </td>
              <td className="pm-td pm-td-name" title={e.uid ? `uid ${e.uid}` : undefined}>
                {fileOf(e.path)}
              </td>
              <td className="pm-td pm-td-reason">{e.reason || "—"}</td>
              <td className="pm-td pm-td-when">{whenLabel(e.when)}</td>
              <td className="pm-td pm-td-folder" title={e.path}>
                {e.path}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="pm-empty">
          {entries.length === 0
            ? "The blacklist is empty."
            : "Nothing matches the current search."}
        </div>
      )}
    </div>
  );
}
