/**
 * Health panel (Plugin Manager page) — the "what is REALLY going on with my VSTs" view
 * (SPEC §5.6). Master/detail over plugins/getHealth:
 *   - summary chips = structured scan verdicts (counts over everything known; benign
 *     support DLLs are hidden from the LIST by default — they were 2,616 of 2,673
 *     real-world "failures" and drowned the ~44 that matter)
 *   - master table with checkboxes → batch unblacklist / blacklist
 *   - detail: full metadata, blacklist reason/when, the scan-host output tail, runtime
 *     (session-load) and probe outcomes, and per-file actions incl. Rescan-with-trace,
 *     Reveal in Explorer and Relocate.
 *
 * Page constraint (main.tsx): no store.ts import — ws + actions only.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginHealthFile, ProbeProgressEvent, ScanVerdict } from "../../protocol/types";
import {
  blacklistPlugin,
  cancelPluginProbe,
  getPluginHealth,
  probePlugins,
  relocatePlugin,
  revealPluginFile,
  scanPlugins,
  unblacklistPlugins,
} from "../../store/actions";
import { ws } from "../../protocol/ws";

function fileOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function whenLabel(ms?: number): string {
  return ms && ms > 0 ? new Date(ms).toLocaleString() : "—";
}

/** verdict → {label, chip class}; the copy explains rather than codes. */
export const VERDICTS: Record<ScanVerdict, { label: string; cls: string; help: string }> = {
  ok: { label: "OK", cls: "ok", help: "scanned fine and yields plugins" },
  not_plugin: { label: "Not a plugin", cls: "benign", help: "a DLL without a VST entry point — support files, not failures" },
  dep_missing: { label: "Missing dependency", cls: "benign", help: "a DLL this file needs is absent — typical for bundle support files" },
  init_failed: { label: "Failed to initialize", cls: "bad", help: "plugin-shaped but would not come up (LoadLibrary/AEffect/factory failure)" },
  scan_crashed: { label: "Crashed", cls: "bad", help: "took the scan host down — blacklisted" },
  scan_timeout: { label: "Timed out", cls: "bad", help: "exceeded the 20s scan budget — blacklisted" },
  user_disabled: { label: "Disabled", cls: "dis", help: "you disabled this file" },
};

type Filter = "problems" | "blacklisted" | "loadfail" | "ok" | "all";

export default function HealthPanel({ connected }: { connected: boolean }) {
  const [files, setFiles] = useState<PluginHealthFile[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [includeBenign, setIncludeBenign] = useState(false);
  const [filter, setFilter] = useState<Filter>("problems");
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<PluginHealthFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeProgressEvent | null>(null);

  const refresh = useCallback(() => {
    getPluginHealth({ includeBenign })
      .then((r) => {
        setFiles(r.files);
        setSummary(r.summary);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [includeBenign]);

  useEffect(() => {
    refresh();
    const off = ws.on("event/scanDone", refresh); // any blacklist/scan change refreshes
    const offProg = ws.on("event/probeProgress", setProbe);
    const offDone = ws.on("event/probeDone", (ev) => {
      setProbe(null);
      setNotice(`Automated pass done — ${ev.passed} passed, ${ev.failed} failed${ev.cancelled ? " (cancelled)" : ""}`);
      refresh();
    });
    return () => { off(); offProg(); offDone(); };
  }, [refresh]);

  // Detail follows the selection; re-fetched (with hostTail/logs) on every refresh so an
  // unblacklist or rescan updates the open panel too.
  useEffect(() => {
    if (!selectedPath) {
      setDetail(null);
      return;
    }
    let stale = false;
    getPluginHealth({ path: selectedPath })
      .then((r) => { if (!stale) setDetail(r.files[0] ?? null); })
      .catch(() => { if (!stale) setDetail(null); });
    return () => { stale = true; };
  }, [selectedPath, files]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (filter === "problems" &&
          !(["init_failed", "scan_crashed", "scan_timeout"].includes(f.verdict) ||
            f.blacklisted ||
            f.plugins.some((p) => p.runtime?.verdict === "load_failed" || p.probe?.verdict === "load_failed")))
        return false;
      if (filter === "blacklisted" && !f.blacklisted) return false;
      if (filter === "loadfail" &&
          !f.plugins.some((p) => p.runtime?.verdict === "load_failed" || p.probe?.verdict === "load_failed"))
        return false;
      if (filter === "ok" && f.verdict !== "ok") return false;
      if (q === "") return true;
      return (
        f.path.toLowerCase().includes(q) ||
        (f.error ?? "").toLowerCase().includes(q) ||
        (f.blacklistReason ?? "").toLowerCase().includes(q) ||
        f.plugins.some((p) => p.name.toLowerCase().includes(q) || p.vendor.toLowerCase().includes(q))
      );
    });
  }, [files, filter, query]);

  const allShownChecked = rows.length > 0 && rows.every((f) => checked.has(f.path));
  const toggleAllShown = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (allShownChecked) for (const f of rows) next.delete(f.path);
      else for (const f of rows) next.add(f.path);
      return next;
    });
  const toggleOne = (path: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const act = useCallback((fn: () => Promise<unknown>, doneMsg?: string) => {
    setBusy(true);
    setNotice(null);
    fn()
      .then(() => { setError(null); if (doneMsg) setNotice(doneMsg); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  const selected = [...checked];
  const actionable = connected && !busy;
  const chip = (f: Filter, label: string, count: number | undefined, cls = "") => (
    <button
      type="button"
      className={`pm-chip ${cls}${filter === f ? " active" : ""}`}
      aria-pressed={filter === f}
      onClick={() => setFilter(f)}
      title={label}
    >
      {label} {count !== undefined && <span className="pm-chip-count">{count}</span>}
    </button>
  );

  const problems =
    (summary.init_failed ?? 0) + (summary.scan_crashed ?? 0) + (summary.scan_timeout ?? 0);
  const benign = (summary.not_plugin ?? 0) + (summary.dep_missing ?? 0);

  const relocateFlow = (f: PluginHealthFile) => {
    // A text prompt is honest here: the engine validates existence and warns when the
    // target is outside every configured folder. (No native picker on a web page.)
    const to = window.prompt(`New location for\n${f.path}`, f.path);
    if (!to || to === f.path) return;
    act(async () => {
      const r = await relocatePlugin(f.path, to);
      if (r.warning) setNotice(r.warning);
      setSelectedPath(to);
    }, "relocated — rescanning the new file");
  };

  return (
    <div className="pm-health">
      <div className="pm-toolbar">
        {chip("problems", "Problems", problems, "bad")}
        {chip("blacklisted", "Blacklisted", (summary.user_disabled ?? 0) + (summary.scan_crashed ?? 0) + (summary.scan_timeout ?? 0), "bl")}
        {chip("loadfail", "Load failures", summary.load_failed, "bad")}
        {chip("ok", "OK", summary.ok, "okc")}
        {chip("all", "All", undefined)}
        <label className="pm-benign-toggle" title="Support DLLs inside plugin bundles: files without a VST entry point or with missing dependencies — not real failures">
          <input
            type="checkbox"
            checked={includeBenign}
            onChange={(e) => setIncludeBenign(e.target.checked)}
          />
          show support DLLs ({benign})
        </label>
        <input
          className="pm-search"
          type="search"
          aria-label="Search health"
          placeholder="Search path, name, vendor, reason…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="pm-btn"
          disabled={!actionable || probe !== null}
          title="Deep load-test every enabled plugin through the probe host (serial, low priority — safe while playing). Finds the ones that scan fine but fail to load."
          onClick={() => act(async () => {
            const r = await probePlugins({ all: true });
            if (!r.started) throw new Error(`probe not started: ${r.reason ?? "unknown"}`);
            setNotice(`Automated pass started — ${r.total} plugin(s)`);
          })}
        >
          Run automated pass
        </button>
      </div>

      {probe && (
        <div className="pm-scanline">
          <div className="pm-scanbar"
            style={{ width: `${probe.total > 0 ? Math.min(100, (probe.current / probe.total) * 100) : 0}%` }} />
          <span className="pm-scantext">
            Probing {probe.current}/{probe.total} — {probe.name} ({probe.verdict})
          </span>
          <button type="button" className="pm-btn pm-scancancel"
            onClick={() => { cancelPluginProbe().catch((e) => setError(String(e))); }}
            title="Stop the pass — verdicts recorded so far are kept">
            Cancel
          </button>
        </div>
      )}

      {selected.length > 0 && (
        <div className="pm-toolbar pm-batchbar">
          <span>{selected.length} selected</span>
          <button type="button" className="pm-btn" disabled={!actionable}
            onClick={() => act(() => unblacklistPlugins({ paths: selected }), "unblacklisted")}>
            Unblacklist
          </button>
          <button type="button" className="pm-btn" disabled={!actionable}
            onClick={() => act(() => unblacklistPlugins({ paths: selected, rescan: true }), "unblacklisted — rescanning")}>
            Unblacklist + rescan
          </button>
          <button type="button" className="pm-btn" disabled={!actionable || probe !== null}
            title="Deep load-test the selected files"
            onClick={() => act(async () => {
              const r = await probePlugins({ paths: selected });
              if (!r.started) throw new Error(`probe not started: ${r.reason ?? "unknown"}`);
            })}>
            Probe
          </button>
          <button type="button" className="pm-btn danger" disabled={!actionable}
            onClick={() => act(async () => {
              for (const p of selected) await blacklistPlugin(p);
            }, "disabled")}>
            Disable
          </button>
          <button type="button" className="pm-btn" onClick={() => setChecked(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      {notice && <div className="pm-notice" onClick={() => setNotice(null)}>{notice}</div>}
      {error && <div className="pm-error" onClick={() => setError(null)} title="Click to dismiss">{error}</div>}

      <div className="pm-health-split">
        <div className="pm-health-master">
          <table className="pm-table">
            <thead>
              <tr>
                <th className="pm-th pm-th-check">
                  <input type="checkbox" aria-label="Select all shown"
                    checked={allShownChecked} onChange={toggleAllShown} />
                </th>
                <th className="pm-th">File</th>
                <th className="pm-th">Plugins</th>
                <th className="pm-th">State</th>
                <th className="pm-th">Why</th>
                <th className="pm-th pm-th-when">Last scan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const v = VERDICTS[f.verdict] ?? VERDICTS.not_plugin;
                const loadFail = f.plugins.some(
                  (p) => p.runtime?.verdict === "load_failed" || p.probe?.verdict === "load_failed");
                return (
                  <tr key={f.path}
                    className={"pm-row pm-row-click" + (selectedPath === f.path ? " selected" : "")}
                    onClick={() => setSelectedPath(f.path)}>
                    <td className="pm-td pm-td-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${fileOf(f.path)}`}
                        checked={checked.has(f.path)} onChange={() => toggleOne(f.path)} />
                    </td>
                    <td className="pm-td pm-td-name" title={f.path}>{fileOf(f.path)}</td>
                    <td className="pm-td" title={f.plugins.map((p) => p.name).join(", ")}>
                      {f.plugins.length === 0 ? "—"
                        : f.plugins.length === 1 ? f.plugins[0].name
                        : `${f.plugins[0].name} +${f.plugins.length - 1}`}
                    </td>
                    <td className="pm-td">
                      <span className={"pm-verdict " + v.cls} title={v.help}>{v.label}</span>
                      {f.blacklisted && <span className="pm-verdict dis" title={f.blacklistReason}>BL</span>}
                      {loadFail && <span className="pm-verdict bad" title="failed to load in a session or probe">load!</span>}
                    </td>
                    <td className="pm-td pm-td-reason" title={f.blacklistReason ?? f.error ?? ""}>
                      {f.blacklistReason ?? f.error ?? "—"}
                    </td>
                    <td className="pm-td pm-td-when">{whenLabel(f.lastScanMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="pm-empty">
              {files.length === 0 ? "Nothing recorded yet — run a scan." : "Nothing matches the current filter."}
            </div>
          )}
        </div>

        {detail && (
          <aside className="pm-health-detail">
            <h3 className="pm-detail-title" title={detail.path}>{fileOf(detail.path)}</h3>
            <div className="pm-detail-grid">
              <span>Path</span><span className="mono">{detail.path}</span>
              <span>Format</span><span>{detail.format}{detail.bitness ? ` · ${detail.bitness}-bit` : ""}</span>
              <span>State</span>
              <span>
                <span className={"pm-verdict " + (VERDICTS[detail.verdict]?.cls ?? "benign")}>
                  {VERDICTS[detail.verdict]?.label ?? detail.verdict}
                </span>
              </span>
              {detail.error && (<><span>Scan error</span><span>{detail.error}</span></>)}
              {detail.blacklisted && (
                <>
                  <span>Blacklisted</span>
                  <span>{detail.blacklistReason} · {detail.blacklistWhen}</span>
                </>
              )}
              <span>Last scan</span><span>{whenLabel(detail.lastScanMs)}</span>
            </div>

            {detail.plugins.length > 0 && (
              <div className="pm-detail-plugins">
                {detail.plugins.map((p) => (
                  <div key={`${p.uid}|${p.bitness}`} className="pm-detail-plugin">
                    <b>{p.name}</b> <span className="pm-faint">{p.vendor} · {p.category || "—"}</span>
                    {p.runtime && (
                      <div className={p.runtime.verdict === "ok" ? "pm-ok-line" : "pm-bad-line"}>
                        last session load: {p.runtime.verdict}
                        {p.runtime.message ? ` — ${p.runtime.message}` : ""} ({whenLabel(p.runtime.whenMs)})
                      </div>
                    )}
                    {p.probe && (
                      <div className={p.probe.verdict === "ok" ? "pm-ok-line" : "pm-bad-line"}>
                        last probe: {p.probe.verdict}
                        {p.probe.message ? ` — ${p.probe.message}` : ""} ({whenLabel(p.probe.whenMs)})
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="pm-detail-actions">
              {detail.blacklisted ? (
                <button type="button" className="pm-btn" disabled={!actionable}
                  onClick={() => act(() => unblacklistPlugins({ paths: [detail.path] }), "unblacklisted")}>
                  Unblacklist
                </button>
              ) : (
                <button type="button" className="pm-btn danger" disabled={!actionable}
                  onClick={() => act(() => blacklistPlugin(detail.path), "disabled")}>
                  Disable
                </button>
              )}
              <button type="button" className="pm-btn" disabled={!actionable}
                title="Rescan just this file (ignores its cache entry)"
                onClick={() => act(() => scanPlugins(true, [detail.path]), "rescanning this file")}>
                Rescan file
              </button>
              <button type="button" className="pm-btn" disabled={!actionable}
                title="Rescan with verbose host tracing — the captured output below then holds the full load trace"
                onClick={() => act(() =>
                  ws.request("plugins/scan", { full: true, paths: [detail.path], trace: true }),
                  "rescanning with trace — reopen this file when done")}>
                Rescan with trace
              </button>
              <button type="button" className="pm-btn" disabled={!actionable}
                onClick={() => act(() => revealPluginFile(detail.path))}>
                Reveal in Explorer
              </button>
              <button type="button" className="pm-btn" disabled={!actionable}
                title="The file moved on disk — point MyDAW at its new location (projects re-resolve by plugin id)"
                onClick={() => relocateFlow(detail)}>
                Relocate…
              </button>
            </div>

            {detail.hostTail && (
              <>
                <h4 className="pm-detail-h4">Scan host output</h4>
                <pre className="pm-hosttail">{detail.hostTail.split(" | ").join("\n")}</pre>
              </>
            )}
            {detail.plugins.map((p) =>
              p.probe?.log ? (
                <React.Fragment key={`log|${p.uid}|${p.bitness}`}>
                  <h4 className="pm-detail-h4">Probe log — {p.name}</h4>
                  <pre className="pm-hosttail">{p.probe.log}</pre>
                </React.Fragment>
              ) : null,
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
