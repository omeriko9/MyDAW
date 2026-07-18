/**
 * Settings → PLUGINS tab (U5): VST2/VST3 scan folder lists (add/remove),
 * Rescan / Full Rescan with event/scanProgress bar, blacklist viewer + unblacklist.
 */

import React, { useEffect, useState } from "react";
import type { PluginsFolders } from "../../protocol/types";
import { useStore } from "../../store/store";
import {
  getDefaultPluginFolders,
  getPluginFolders,
  getPluginRegistry,
  scanPlugins,
  setPluginFolders,
  unblacklistPlugin,
} from "../../store/actions";
import { TextInput } from "../common/TextInput";
import { IconButton } from "../common/IconButton";
import { Icon } from "../common/icons";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function FolderList({
  title,
  paths,
  onAdd,
  onRemove,
}: {
  title: string;
  paths: string[];
  onAdd: (path: string) => void;
  onRemove: (index: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const p = draft.trim();
    if (p.length === 0) return;
    onAdd(p);
    setDraft("");
  };
  return (
    <div className="col gap1">
      <div className="sett-subhead">{title}</div>
      {paths.length > 0 ? (
        <div className="sett-list">
          {paths.map((p, i) => (
            <div className="sett-item" key={`${p}-${i}`}>
              <Icon name="folder" size={13} />
              <span className="name mono" title={p} style={{ fontSize: 11 }}>
                {p}
              </span>
              <IconButton icon="trash" size={20} danger tooltip="Remove folder" onClick={() => onRemove(i)} />
            </div>
          ))}
        </div>
      ) : (
        <div className="sett-note">No folders.</div>
      )}
      <div className="row gap1">
        <TextInput
          className="grow mono"
          style={{ fontSize: 11 }}
          value={draft}
          onChange={setDraft}
          placeholder="C:\\Path\\To\\Plugins"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <IconButton icon="plus" tooltip="Add folder" onClick={add} disabled={draft.trim().length === 0} />
      </div>
    </div>
  );
}

export function PluginsTab() {
  const registry = useStore((s) => s.registry);
  const scanProgress = useStore((s) => s.scanProgress);
  const setRegistry = useStore((s) => s.setRegistry);

  const [folders, setFolders] = useState<PluginsFolders | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scanning = scanProgress !== null;

  useEffect(() => {
    let alive = true;
    getPluginFolders()
      .then((f) => {
        if (alive) setFolders({ vst2: f.vst2 ?? [], vst3: f.vst3 ?? [] });
      })
      .catch((e) => {
        if (alive) {
          setErr(errText(e));
          setFolders({ vst2: [], vst3: [] });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const commitFolders = (next: PluginsFolders) => {
    setFolders(next);
    setErr(null);
    setPluginFolders(next.vst2, next.vst3)
      .then((saved) => setFolders({ vst2: saved.vst2 ?? [], vst3: saved.vst3 ?? [] }))
      .catch((e) => setErr(errText(e)));
  };

  const restoreDefaults = () => {
    setErr(null);
    getDefaultPluginFolders()
      .then((defs) => setPluginFolders(defs.vst2 ?? [], defs.vst3 ?? []))
      .then((saved) => setFolders({ vst2: saved.vst2 ?? [], vst3: saved.vst3 ?? [] }))
      .catch((e) => setErr(errText(e)));
  };

  const startScan = (full: boolean) => {
    setErr(null);
    scanPlugins(full).catch((e) => setErr(errText(e)));
  };

  const blacklisted = registry.filter((p) => p.blacklisted);

  const unblacklist = (uid: string) => {
    setErr(null);
    unblacklistPlugin(uid)
      .then(() => getPluginRegistry())
      .then((r) => setRegistry(r.registry))
      .catch((e) => setErr(errText(e)));
  };

  const pct =
    scanProgress && scanProgress.total > 0
      ? Math.min(100, (scanProgress.current / scanProgress.total) * 100)
      : 0;

  return (
    <div className="col gap2">
      {folders === null ? (
        <div className="dim">Loading plugin folders…</div>
      ) : (
        <>
          <FolderList
            title="VST2 folders"
            paths={folders.vst2}
            onAdd={(p) => commitFolders({ ...folders, vst2: [...folders.vst2, p] })}
            onRemove={(i) =>
              commitFolders({ ...folders, vst2: folders.vst2.filter((_, k) => k !== i) })
            }
          />
          <FolderList
            title="VST3 folders"
            paths={folders.vst3}
            onAdd={(p) => commitFolders({ ...folders, vst3: [...folders.vst3, p] })}
            onRemove={(i) =>
              commitFolders({ ...folders, vst3: folders.vst3.filter((_, k) => k !== i) })
            }
          />
        </>
      )}

      <div className="row gap1">
        <button type="button" className="btn" disabled={scanning} onClick={() => startScan(false)}>
          <Icon name="refresh" size={13} />
          Rescan
        </button>
        <button type="button" className="btn" disabled={scanning || folders === null} onClick={restoreDefaults}>
          Default
        </button>
        <button
          type="button"
          className="btn"
          disabled={scanning}
          title="Ignore the scan cache and rescan every file"
          onClick={() => startScan(true)}
        >
          Full Rescan
        </button>
        <span className="dim" style={{ fontSize: 11 }}>
          {registry.filter((p) => !p.blacklisted).length} plugins in registry
        </span>
      </div>

      {scanProgress ? (
        <div className="col gap1">
          <div className="sett-progress">
            <div className="sett-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="row gap2" style={{ fontSize: 11 }}>
            <span className="dim">
              {scanProgress.current}/{scanProgress.total}
            </span>
            <span className="grow ellipsis mono dim" title={scanProgress.path}>
              {scanProgress.path}
            </span>
            <span className="dim">{scanProgress.found} found</span>
          </div>
        </div>
      ) : null}

      <div className="sett-subhead">Blacklist</div>
      {blacklisted.length === 0 ? (
        <div className="sett-note">No blacklisted plugins.</div>
      ) : (
        <div className="sett-list">
          {blacklisted.map((p) => (
            <div className="sett-item" key={p.uid}>
              <Icon name="warning" size={13} />
              <span className="col grow" style={{ minWidth: 0 }}>
                <span className="name" title={p.path}>
                  {p.name || p.path.split(/[\\/]/).pop()}
                </span>
                <span className="path">{p.blacklistReason ?? "unknown reason"}</span>
              </span>
              <button type="button" className="btn" onClick={() => unblacklist(p.uid)}>
                Unblacklist
              </button>
            </div>
          ))}
        </div>
      )}

      {err ? <div className="sett-error">{err}</div> : null}
    </div>
  );
}
