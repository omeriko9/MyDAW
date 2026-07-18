/**
 * Recreate Plugins dialog — lists inserts that exist in the project model with NO live
 * host instance (project/getUnresolvedPlugins; typical after Import Project).
 *   - [Recreate Now] → plugins/recreate against the current registry; per-row results.
 *   - [Add VST Folder…] reuses the Settings → Plugins folder mechanism (plugins/getFolders
 *     + plugins/setFolders with a typed path), then plugins/scan {full:true} with progress,
 *     and auto-runs plugins/recreate on event/scanDone.
 * Opens via store.dialogs.recreatePlugins (File menu; auto-opened once after a successful
 * Import Project — see projectFlows.importProjectFlow). The list refreshes from the engine
 * after every recreate and on every projectChanged; rows render ONLY engine-reported state.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../store/store";
import {
  getPluginFolders,
  getUnresolvedPlugins,
  recreatePlugins,
  scanPlugins,
  setPluginFolders,
} from "../../store/actions";
import type { PluginFormat, PluginRecreateResult, UnresolvedPlugin } from "../../protocol/types";
import { ws } from "../../protocol/ws";
import { Modal } from "../common/Modal";
import { Icon } from "../common/icons";
import { TextInput } from "../common/TextInput";
import { Select } from "../common/Select";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type RowStatus =
  | { kind: "missing" }
  | { kind: "found" }
  | { kind: "recreating" }
  | { kind: "ok" }
  | { kind: "failed"; error: string };

interface Row {
  p: UnresolvedPlugin;
  status: RowStatus;
}

function derivedStatus(p: UnresolvedPlugin): RowStatus {
  return { kind: p.inRegistry ? "found" : "missing" };
}

/**
 * Inline uid display. VST2 uids are signed-decimal fourcc codes — decode to the 4CC
 * ASCII (e.g. -1299139399 → 'PS01'-style) when all 4 bytes are printable; otherwise
 * (and for non-vst2 formats / non-numeric uids) show the raw value.
 */
function uidDisplay(p: UnresolvedPlugin): string {
  if (p.format === "vst2" && /^-?\d+$/.test(p.uid)) {
    const n = Number(p.uid);
    if (Number.isSafeInteger(n) && n >= -0x80000000 && n <= 0xffffffff) {
      const u = n >>> 0; // two's-complement → uint32
      const bytes = [(u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff];
      if (bytes.every((b) => b >= 0x20 && b <= 0x7e)) {
        return `'${String.fromCharCode(...bytes)}' (${p.uid})`;
      }
    }
  }
  return p.uid;
}

function StatusBadge({ status }: { status: RowStatus }) {
  switch (status.kind) {
    case "missing":
      return <span className="dlg-badge warn">missing</span>;
    case "found":
      return <span className="dlg-badge">in registry</span>;
    case "recreating":
      return <span className="dlg-badge">recreating…</span>;
    case "ok":
      return <span className="dlg-badge ok">ok</span>;
    case "failed":
      return (
        <span className="dlg-badge err" title={status.error}>
          failed: {status.error}
        </span>
      );
  }
}

export default function RecreatePluginsDialog() {
  const open = useStore((s) => s.dialogs.recreatePlugins);
  const setDialogs = useStore((s) => s.setDialogs);
  const scanProgress = useStore((s) => s.scanProgress);

  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Chosen substitutions (instanceId → registry uid), from each missing row's picker. */
  const [subs, setSubs] = useState<ReadonlyMap<number, string>>(new Map());
  /** Surfaced when plugins/scan replies {started:false} (a scan is already running). */
  const [scanBlocked, setScanBlocked] = useState(false);

  /* Add VST Folder… sub-form (same mechanism as Settings → Plugins: typed path + format). */
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [folderFormat, setFolderFormat] = useState<PluginFormat>("vst2");
  /** We started a scan from this dialog → auto-recreate when event/scanDone arrives. */
  const [scanPending, setScanPending] = useState(false);

  /**
   * Per-open epoch. Bumped each time the dialog opens AND whenever the project is
   * replaced while open (a projectChanged carrying a full Project). Async work (refresh /
   * recreate / scanDone auto-recreate) captures the epoch when it starts and DROPS its
   * result if the epoch advanced (project replaced) or the dialog closed in the meantime.
   * This kills stale rows merging into a freshly-imported project and scanDone
   * auto-recreating ALL against a different project. `openRef` mirrors `open` for reads
   * inside async closures.
   */
  const epochRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  // Mirrors scanPending for reads inside the scanDone listener. The listener is armed
  // unconditionally while open (so a scanDone arriving before React re-subscribes is not
  // missed); this ref — kept in sync at every setScanPending — gates the auto-recreate.
  const scanPendingRef = useRef(false);
  const armScanPending = useCallback((v: boolean) => {
    scanPendingRef.current = v;
    setScanPending(v);
  }, []);

  const close = () => {
    epochRef.current++; // invalidate any in-flight async work
    setDialogs({ recreatePlugins: false });
    setRows([]);
    setLoaded(false);
    setBusy(false);
    setErr(null);
    setSubs(new Map());
    setScanBlocked(false);
    setAddingFolder(false);
    setFolderDraft("");
    armScanPending(false);
  };

  const refresh = useCallback(() => {
    const epoch = epochRef.current;
    getUnresolvedPlugins()
      .then(({ plugins }) => {
        // Drop the reply if the project was replaced or the dialog closed meanwhile.
        if (epoch !== epochRef.current || !openRef.current) return;
        setRows((prev) => {
          const ids = new Set(plugins.map((p) => p.instanceId));
          // Rows no longer in the unresolved set: keep ONLY successes (the engine
          // removed them because recreation landed). A gone row that was still
          // `recreating` had no result and is dropped — never perpetually recreating.
          const resolved = prev.filter(
            (r) => !ids.has(r.p.instanceId) && r.status.kind === "ok",
          );
          const current = plugins.map((p): Row => {
            const old = prev.find((r) => r.p.instanceId === p.instanceId);
            // Still unresolved → recreation did not land. Preserve only a terminal
            // `failed` (so the user sees why); any leftover `recreating` resets to the
            // engine-derived state (missing|in-registry) so the cycle always terminates.
            const status =
              old && old.status.kind === "failed" ? old.status : derivedStatus(p);
            return { p, status };
          });
          return [...resolved, ...current];
        });
        setLoaded(true);
      })
      .catch((e) => {
        if (epoch !== epochRef.current || !openRef.current) return;
        setErr(errText(e));
      });
  }, []);

  // Reset all row/scan state to a clean slate and mint a fresh epoch. Used on open and
  // on project replacement so nothing merges across opens or across a project swap.
  const resetForNewEpoch = useCallback(() => {
    epochRef.current++;
    setRows([]);
    setLoaded(false);
    // Clear busy here too: in-flight async work for the old epoch will no-op via its
    // epoch guard (including its .finally), so nothing else will release `busy`.
    setBusy(false);
    setErr(null);
    setSubs(new Map());
    setScanBlocked(false);
    armScanPending(false);
    setAddingFolder(false);
  }, [armScanPending]);

  // On open: fresh epoch + clean rows, then load from the engine.
  useEffect(() => {
    if (!open) return;
    resetForNewEpoch();
    refresh();
  }, [open, resetForNewEpoch, refresh]);

  // While open, a projectChanged carrying a FULL project means the project was REPLACED
  // (Import Project / load / undo-redo / recover). Treat it as a new epoch: discard all
  // existing rows (which belong to the old project) and reload. Granular in-place edits
  // (no `full`, e.g. our own recreate's broadcast) only re-refresh and keep the epoch —
  // so they never clobber the results we are mid-applying.
  useEffect(() => {
    if (!open) return;
    return ws.on("event/projectChanged", (ev) => {
      if (!openRef.current) return;
      if (ev.full) resetForNewEpoch();
      refresh();
    });
  }, [open, resetForNewEpoch, refresh]);

  const applyResults = (results: PluginRecreateResult[]) => {
    setRows((prev) =>
      prev.map((r): Row => {
        const res = results.find((x) => x.instanceId === r.p.instanceId);
        if (!res) {
          // No result for this row. If it was marked `recreating` (instance vanished or
          // the engine omitted it), reset to derived state so it never sticks. Leave any
          // other status (ok / already-terminal) untouched.
          return r.status.kind === "recreating" ? { ...r, status: derivedStatus(r.p) } : r;
        }
        return {
          ...r,
          status: res.ok
            ? ({ kind: "ok" } as const)
            : ({ kind: "failed", error: res.error ?? "unknown error" } as const),
        };
      }),
    );
  };

  const recreateNow = useCallback(() => {
    const epoch = epochRef.current;
    setErr(null);
    setBusy(true);
    setRows((prev) =>
      prev.map(
        (r): Row => (r.status.kind === "ok" ? r : { ...r, status: { kind: "recreating" } }),
      ),
    );
    // Ship the chosen substitutions (missing rows whose picker selected a stand-in).
    const substitutions = [...subs.entries()]
      .filter(([, uid]) => uid !== "")
      .map(([instanceId, uid]) => ({ instanceId, uid }));
    recreatePlugins(undefined, substitutions)
      .then(({ results }) => {
        if (epoch !== epochRef.current || !openRef.current) return;
        applyResults(results);
      })
      .catch((e) => {
        if (epoch !== epochRef.current || !openRef.current) return;
        setErr(errText(e));
        // Unknown outcome — fall back to what the engine last reported per row.
        setRows((prev) =>
          prev.map((r) =>
            r.status.kind === "recreating" ? { ...r, status: derivedStatus(r.p) } : r,
          ),
        );
      })
      .finally(() => {
        // Don't touch a project that was swapped out (or a closed dialog) under us.
        if (epoch !== epochRef.current || !openRef.current) return;
        setBusy(false);
        refresh();
      });
  }, [refresh, subs]);

  // After OUR full rescan completes, recreate automatically with the fresh registry —
  // but only if the epoch the scan was armed under is still current (same project, still
  // open). Otherwise the scanDone belongs to a different/replaced project: ignore it.
  //
  // The listener is armed whenever the dialog is open (NOT gated on scanPending) so a
  // scanDone that arrives in the window between scanPlugins() resolving and React
  // re-subscribing is not missed. scanPendingRef gates whether we actually act, and the
  // epoch/open guards (read at fire time) preserve the stale-project protection.
  useEffect(() => {
    if (!open) return;
    return ws.on("event/scanDone", () => {
      if (!scanPendingRef.current) return;
      scanPendingRef.current = false;
      setScanPending(false);
      // A project replacement bumps the epoch AND clears scanPending via resetForNewEpoch,
      // so the gate above already drops a scanDone for a swapped project; the open guard
      // covers a closed dialog. recreateNow reads epochRef.current itself.
      if (!openRef.current) return;
      recreateNow();
    });
  }, [open, recreateNow]);

  const openAddFolder = () => {
    const missing = rows.find((r) => !r.p.inRegistry);
    setFolderFormat(missing ? missing.p.format : "vst2");
    setAddingFolder(true);
  };

  const addFolderAndScan = () => {
    // Guard against arming a scan while one is already running or work is in flight.
    if (busy || scanning) return;
    const path = folderDraft.trim();
    if (path.length === 0) return;
    const epoch = epochRef.current;
    setErr(null);
    setScanBlocked(false);
    setBusy(true);
    getPluginFolders()
      .then((f) => {
        const vst2 = f.vst2 ?? [];
        const vst3 = f.vst3 ?? [];
        const next =
          folderFormat === "vst2"
            ? { vst2: vst2.includes(path) ? vst2 : [...vst2, path], vst3 }
            : { vst2, vst3: vst3.includes(path) ? vst3 : [...vst3, path] };
        return setPluginFolders(next.vst2, next.vst3);
      })
      .then(() => {
        setAddingFolder(false);
        setFolderDraft("");
        return scanPlugins(true);
      })
      .then((reply) => {
        // Drop if the project was replaced or the dialog closed while we were arming.
        if (epoch !== epochRef.current || !openRef.current) return;
        // plugins/scan replies {started:false} when a scan is already running — nothing
        // started, so event/scanDone will never come. Do NOT arm the auto-recreate;
        // surface "scan already running" instead.
        if (!reply.started) {
          setScanBlocked(true);
        } else {
          armScanPending(true);
        }
      })
      .catch((e) => {
        if (epoch !== epochRef.current || !openRef.current) return;
        setErr(errText(e));
        armScanPending(false);
      })
      .finally(() => {
        if (epoch !== epochRef.current || !openRef.current) return;
        setBusy(false);
      });
  };

  const scanning = scanProgress !== null;
  const unresolved = rows.filter((r) => r.status.kind !== "ok");
  const pct =
    scanProgress && scanProgress.total > 0
      ? Math.min(100, (scanProgress.current / scanProgress.total) * 100)
      : 0;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Recreate plugins"
      width={620}
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={busy || scanning}
            onClick={() => (addingFolder ? setAddingFolder(false) : openAddFolder())}
          >
            <Icon name="folder" size={13} />
            Add VST Folder…
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || scanning || unresolved.length === 0}
            onClick={recreateNow}
          >
            <Icon name="plug" size={13} />
            {busy ? "Recreating…" : "Recreate Now"}
          </button>
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <div className="col gap2">
        {!loaded ? (
          <div className="dim">Loading unresolved plugins…</div>
        ) : rows.length === 0 ? (
          <div className="dim">No unresolved plugins — every insert has a live instance.</div>
        ) : (
          <>
            <div className="dim">
              {unresolved.length === 0
                ? "All plugins recreated."
                : `${unresolved.length} plugin ${
                    unresolved.length === 1 ? "insert has" : "inserts have"
                  } no live plugin instance. Recreate them from the plugin registry.`}
            </div>
            <div className="dlg-list">
              {rows.map(({ p, status }) => (
                <div className="dlg-item" key={p.instanceId}>
                  <Icon name={status.kind === "missing" ? "warning" : "plug"} size={14} />
                  <span className="col grow" style={{ minWidth: 0 }}>
                    <span className="name" title={p.hasState ? "Saved plugin state present" : undefined}>
                      {p.name}
                      {p.version ? <span className="dim"> v{p.version}</span> : null}
                    </span>
                    <span className="path">
                      {p.trackName} · slot {p.slotIndex + 1} · uid {uidDisplay(p)}
                    </span>
                    {p.source ? (
                      <span className="path" style={{ fontStyle: "italic" }} title={p.source}>
                        {p.source}
                      </span>
                    ) : null}
                    {status.kind !== "ok" && (p.suggestions?.length ?? 0) > 0 ? (
                      <span className="row gap1" style={{ marginTop: 3 }}>
                        <Select
                          value={subs.get(p.instanceId) ?? ""}
                          onChange={(uid) =>
                            setSubs((prev) => {
                              const next = new Map(prev);
                              if (uid === "") next.delete(p.instanceId);
                              else next.set(p.instanceId, uid);
                              return next;
                            })
                          }
                          width={300}
                          disabled={busy || scanning}
                          title="Recreate this insert as a similar installed plugin instead (state carries over only within the same plugin format)"
                          options={[
                            { value: "", label: "Substitute: keep waiting for the exact plugin" },
                            ...(p.suggestions ?? []).map((s) => ({
                              value: s.uid,
                              label: `Use: ${s.name} (${s.format.toUpperCase()} ${s.bitness}-bit)${
                                s.score >= 45 ? "" : " — similar in spirit"
                              }`,
                            })),
                          ]}
                        />
                      </span>
                    ) : null}
                  </span>
                  <span className="dlg-chip mono">
                    {p.format.toUpperCase()} {p.bitness}-bit
                  </span>
                  <StatusBadge status={status} />
                </div>
              ))}
            </div>
          </>
        )}

        {addingFolder ? (
          <div className="row gap1">
            <Select
              value={folderFormat}
              onChange={(v) => setFolderFormat(v as PluginFormat)}
              options={[
                { value: "vst2", label: "VST2" },
                { value: "vst3", label: "VST3" },
              ]}
              width={70}
            />
            <TextInput
              className="grow mono"
              style={{ fontSize: 11 }}
              value={folderDraft}
              onChange={setFolderDraft}
              placeholder="C:\\Path\\To\\Plugins"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Respect the same busy/scanning disable as the Add & Scan button:
                  // never kick off a scan while one is running or a recreate is in flight.
                  if (busy || scanning || folderDraft.trim().length === 0) return;
                  addFolderAndScan();
                }
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || scanning || folderDraft.trim().length === 0}
              onClick={addFolderAndScan}
            >
              <Icon name="refresh" size={13} />
              Add & Scan
            </button>
          </div>
        ) : null}

        {scanProgress ? (
          <div className="col gap1">
            <div className="dlg-progress">
              <div className="dlg-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="row gap2" style={{ fontSize: 11 }}>
              <span className="dim">
                Scanning {scanProgress.current}/{scanProgress.total}
              </span>
              <span className="grow ellipsis mono dim" title={scanProgress.path}>
                {scanProgress.path}
              </span>
              <span className="dim">{scanProgress.found} found</span>
            </div>
          </div>
        ) : null}

        {scanBlocked ? (
          <div className="dlg-warn">
            A plugin scan is already running. Wait for it to finish, then try again.
          </div>
        ) : null}

        {err ? <div className="dlg-error">{err}</div> : null}
      </div>
    </Modal>
  );
}
