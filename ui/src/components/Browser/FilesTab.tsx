/**
 * Browser → Files tab (U6, SPEC §9).
 *
 * - project asset list: name, channels / sample rate / duration, missing badge + [Relink]
 * - rows are drag sources (lib/dnd setAssetDrag {assetId}) for the timeline
 * - [Import Files…] via engine-native dialog (dialog/importFiles → media/import)
 * - the whole tab is an OS-file drop zone (lib/dnd uploadFiles, no trackId)
 * - per-asset context menu: Relink…
 * - inline event/importProgress
 */

import React, { useCallback, useState } from "react";
import { useStore } from "../../store/store";
import { dialogImportFiles, relinkAsset } from "../../store/actions";
import { setAssetDrag, uploadFiles } from "../../lib/dnd";
import {
  extensionOf,
  importPickedPaths,
  projectOnlyExtensions,
} from "../Transport/projectFlows";
import type { Asset } from "../../protocol/types";
import { contextMenuHandler } from "../common/ContextMenu";
import { Icon } from "../common/icons";
import { Tooltip } from "../common/Tooltip";
import { VirtualList } from "../common/VirtualList";
import { formatTimeSec } from "../../lib/time";
import { baseName, errText } from "./Browser";

const ROW_H = 38;

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  // formatTimeSec → "M:SS.mmm"; keep a single decimal for density.
  return formatTimeSec(sec).replace(/\.(\d)\d*$/, ".$1");
}

function assetMeta(a: Asset): string {
  const ch = a.channels === 1 ? "mono" : a.channels === 2 ? "stereo" : `${a.channels} ch`;
  const sr = a.sampleRate > 0 ? `${(a.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")} kHz` : "? kHz";
  const dur = a.sampleRate > 0 ? formatDuration(a.lengthSamples / a.sampleRate) : "?";
  return `${ch} · ${sr} · ${dur}`;
}

function hasOsFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/* ============================================================================
 * Row
 * ========================================================================= */

function AssetRow({
  a,
  connected,
  onRelink,
}: {
  a: Asset;
  connected: boolean;
  onRelink: (a: Asset) => void;
}) {
  return (
    <div
      className={"asset-row" + (a.missing ? " missing" : "")}
      draggable
      onDragStart={(e) => setAssetDrag(e.dataTransfer, { assetId: a.id })}
      onContextMenu={contextMenuHandler(() => [
        {
          label: "Relink…",
          icon: "link",
          disabled: !connected,
          onClick: () => onRelink(a),
        },
      ])}
      title={a.originalPath ?? a.file}
    >
      <Icon name="audioWave" size={14} className="asset-icon" />
      <div className="col grow" style={{ minWidth: 0 }}>
        <div className="row gap1">
          <span className="ellipsis grow asset-name">{baseName(a.file)}</span>
          {a.missing ? (
            <Tooltip
              content={`File not found${a.originalPath ? `:\n${a.originalPath}` : "."}\nUse Relink to point at the moved file.`}
            >
              <span className="badge danger">missing</span>
            </Tooltip>
          ) : null}
        </div>
        <span className="asset-meta ellipsis">{assetMeta(a)}</span>
      </div>
      {a.missing ? (
        <button
          type="button"
          className="btn asset-relink"
          disabled={!connected}
          title="Relink to the moved or renamed file"
          onClick={(e) => {
            e.stopPropagation();
            onRelink(a);
          }}
        >
          <Icon name="link" size={12} />
          Relink
        </button>
      ) : null}
    </div>
  );
}

/* ============================================================================
 * Tab
 * ========================================================================= */

export interface FilesTabProps {
  showHint: (msg: string) => void;
}

export default function FilesTab({ showHint }: FilesTabProps) {
  const project = useStore((s) => s.project);
  const connected = useStore((s) => s.connected);
  const importProgress = useStore((s) => s.importProgress);
  const [dropDepth, setDropDepth] = useState(0);

  const assets = project?.assets ?? [];

  const doImport = useCallback(() => {
    void (async () => {
      try {
        const r = await dialogImportFiles();
        if (!r.paths || r.paths.length === 0) return; // user cancelled
        // A .cpr (or other foreign-project file) opens as a NEW project; media imports as assets.
        const res = await importPickedPaths(r.paths);
        if (res.kind === "project") showHint(`Opened project "${baseName(res.path)}".`);
        else if (res.kind === "media")
          showHint(`Imported ${res.count} file${res.count === 1 ? "" : "s"}.`);
      } catch (e) {
        showHint(`Import failed: ${errText(e)}`);
      }
    })();
  }, [showHint]);

  const onRelink = useCallback(
    (a: Asset) => {
      void (async () => {
        try {
          const r = await dialogImportFiles();
          const path = r.paths?.[0];
          if (!path) return; // cancelled
          await relinkAsset(a.id, path);
          showHint(`Relinked "${baseName(a.file)}".`);
        } catch (e) {
          showHint(`Relink failed: ${errText(e)}`);
        }
      })();
    },
    [showHint],
  );

  /* ---- OS-file drop zone (whole tab) ---- */

  const onDragEnter = (e: React.DragEvent) => {
    if (!hasOsFiles(e)) return;
    e.preventDefault();
    setDropDepth((d) => d + 1);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasOsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasOsFiles(e)) return;
    setDropDepth((d) => Math.max(0, d - 1));
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasOsFiles(e)) return;
    e.preventDefault();
    e.stopPropagation(); // handled here — keep it from the window stray-drop guard
    setDropDepth(0);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    void (async () => {
      try {
        // A dropped .cpr can't be opened here — a browser drop gives us bytes, not the file
        // path importForeign needs. Steer the user to File → Import Project; upload the rest.
        const projExts = await projectOnlyExtensions();
        const projectFiles = files.filter((f) => projExts.has(extensionOf(f.name)));
        const mediaFiles = files.filter((f) => !projExts.has(extensionOf(f.name)));
        if (projectFiles.length > 0)
          showHint(`To open "${projectFiles[0].name}", use File → Import Project.`);
        if (mediaFiles.length > 0) {
          const r = await uploadFiles(mediaFiles);
          showHint(`Imported ${r.assets.length} file${r.assets.length === 1 ? "" : "s"}.`);
        }
      } catch (e2) {
        showHint(errText(e2));
      }
    })();
  };

  const renderItem = useCallback(
    (i: number): React.ReactNode => {
      const a = assets[i];
      if (a === undefined) return null;
      return <AssetRow a={a} connected={connected} onRelink={onRelink} />;
    },
    [assets, connected, onRelink],
  );

  const importPct = importProgress ? Math.min(100, Math.max(0, importProgress.pct)) : 0;

  return (
    <div
      className="files-tab col grow"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="browser-listwrap col">
        {project === null ? (
          <div className="browser-empty">
            <Icon name="audioWave" size={22} />
            <span>Engine disconnected — no project loaded.</span>
          </div>
        ) : assets.length === 0 ? (
          <div className="browser-empty">
            <Icon name="audioWave" size={22} />
            <span>No audio files in this project yet.</span>
            <span className="faint">Drop audio files here, or use Import Files below.</span>
          </div>
        ) : (
          <VirtualList
            itemCount={assets.length}
            itemHeight={ROW_H}
            itemKey={(i) => assets[i]?.id ?? i}
            renderItem={renderItem}
          />
        )}
      </div>

      {importProgress !== null && (
        <div className="browser-progressblock">
          <div className="browser-progress">
            <div style={{ width: `${importPct}%` }} />
          </div>
          <div className="row gap1">
            <span className="ellipsis grow">Importing {baseName(importProgress.path)}</span>
            <span style={{ whiteSpace: "nowrap" }}>{Math.round(importPct)}%</span>
          </div>
        </div>
      )}

      <div className="browser-footer">
        <span className="dim">
          {assets.length} file{assets.length === 1 ? "" : "s"}
        </span>
        <div className="grow" />
        <button
          type="button"
          className="btn"
          disabled={!connected}
          title={connected ? "Import audio/MIDI files (engine-native dialog)" : "Engine disconnected"}
          onClick={doImport}
        >
          <Icon name="plus" size={13} />
          Import Files…
        </button>
      </div>

      {dropDepth > 0 && (
        <div className="browser-drop">
          <Icon name="export" size={16} />
          Drop files to import
        </div>
      )}
    </div>
  );
}
