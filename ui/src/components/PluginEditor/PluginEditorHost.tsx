/**
 * PluginEditorHost — generic in-browser plugin editor (U6, SPEC §9).
 *
 * Renders one floating, non-modal window per id in store.dialogs.pluginEditors
 * (render order = stacking order, LAST is topmost; pointerdown raises a window):
 * draggable by header, resizable via the bottom-right grip, position/size remembered
 * per instanceId in a module-level map; first-open windows cascade by 24px.
 *
 * Header: plugin name + vendor + runtime state badge (event/pluginState).
 * Toolbar: preset Select (plugin/getPresets → plugin/loadPreset), [Save Preset]
 * popover (plugin/savePreset), bypass Toggle + wet/dry Knob (cmd/plugin.set,
 * transient-while-dragging), [Native UI] (plugin/openEditor — real OS window on the
 * engine machine).
 * Body: searchable VirtualList of params (plugin/getParams); sliders send transient
 * cmd/plugin.setParam during drags and one final non-transient commit (SPEC §5.8);
 * live updates patched in from event/pluginParams (rows being dragged are skipped);
 * right-click a param → Add automation lane (cmd/automation.set) / Reset to default.
 *
 * NOTE(spec): there is no cmd/plugin.reload — a "failed" plugin can only be removed
 * and re-added; the state badge tooltip says so.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store/store";
import { ws } from "../../protocol/ws";
import {
  commitParam,
  commitPluginParam,
  dragPluginParam,
  getPluginParams,
  getPluginPresets,
  loadPluginPreset,
  openPluginEditor,
  savePluginPreset,
  setAutomation,
  setPlugin,
  setPluginSample,
  transientParam,
} from "../../store/actions";
import { ParamRef } from "../../protocol/types";
import { uploadFiles } from "../../lib/dnd";
import type {
  PluginInstance,
  PluginParam,
  PluginPreset,
  PluginStateEvent,
  Project,
  Track,
} from "../../protocol/types";
import { Icon } from "../common/icons";
import { IconButton } from "../common/IconButton";
import { Knob } from "../common/Knob";
import { Select } from "../common/Select";
import { TextInput } from "../common/TextInput";
import { Toggle } from "../common/Toggle";
import { Tooltip } from "../common/Tooltip";
import { VirtualList } from "../common/VirtualList";
import { openContextMenu } from "../common/ContextMenu";
import ParamRow from "./ParamRow";
import InstrumentEditor, { instrumentEditorSpec } from "./InstrumentEditors";
import "./plugineditor.css";

/* ============================================================================
 * Window geometry, remembered per instanceId for the app session
 * ========================================================================= */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_W = 340;
const MIN_H = 240;
const PARAM_ROW_H = 26;
/** Matches .pe-window in plugineditor.css; each window adds its stack index inline. */
const Z_BASE = 700;
/** First-open windows cascade by this much per already-open window. */
const CASCADE_PX = 24;

const editorRects = new Map<number, Rect>();

function defaultRect(cascade: number, size?: { w: number; h: number }): Rect {
  const w = size?.w ?? 480;
  const h = size?.h ?? 440;
  const off = cascade * CASCADE_PX;
  return {
    x: Math.max(8, Math.min(window.innerWidth - w - 8, Math.round((window.innerWidth - w) / 2) + off)),
    y: Math.max(8, Math.min(window.innerHeight - h - 8, Math.round((window.innerHeight - h) / 3) + off)),
    w,
    h,
  };
}

/* ============================================================================
 * Helpers
 * ========================================================================= */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function findInstance(
  project: Project | null,
  instanceId: number,
): { track: Track; instance: PluginInstance } | null {
  if (!project) return null;
  const all = [...project.tracks, project.masterTrack];
  for (const track of all) {
    for (const instance of track.inserts) {
      if (instance.instanceId === instanceId) return { track, instance };
    }
  }
  return null;
}

function StateBadge({ ev }: { ev: PluginStateEvent | undefined }) {
  if (!ev) return null;
  const cls =
    ev.state === "ok" ? "ok" : ev.state === "loading" || ev.state === "restarting" ? "warn" : "danger";
  const lines: string[] = [];
  if (ev.message) lines.push(ev.message);
  if (ev.restartCount > 0) lines.push(`Auto-restarts: ${ev.restartCount}`);
  if (ev.state === "failed")
    lines.push("No reload command exists — remove & re-add the plugin to reload it.");
  const badge = <span className={`badge ${cls}`}>{ev.state}</span>;
  return lines.length > 0 ? <Tooltip content={lines.join("\n")}>{badge}</Tooltip> : badge;
}

/* ============================================================================
 * Host — mounts one EditorWindow per open instanceId
 * ========================================================================= */

export default function PluginEditorHost() {
  const openIds = useStore((s) => s.dialogs.pluginEditors);
  if (openIds.length === 0) return null;
  // key remounts a window (fresh params/presets/geometry) when its instance changes;
  // stackIndex drives z-order (last = topmost).
  return (
    <>
      {openIds.map((id, i) => (
        <EditorWindow key={id} instanceId={id} stackIndex={i} />
      ))}
    </>
  );
}

/* ============================================================================
 * The floating window
 * ========================================================================= */

const NOTE_MS = 3500;

function EditorWindow({ instanceId, stackIndex }: { instanceId: number; stackIndex: number }) {
  const project = useStore((s) => s.project);
  const registry = useStore((s) => s.registry);
  const connected = useStore((s) => s.connected);
  const stateEv = useStore((s) => s.pluginStates[instanceId]);
  const raiseWindow = useStore((s) => s.openPluginEditorWindow);
  const closeWindow = useStore((s) => s.closePluginEditorWindow);

  const found = useMemo(() => findInstance(project, instanceId), [project, instanceId]);
  const foundRef = useRef(found);
  foundRef.current = found;

  // Close THIS window when its instance disappears from a live project (plugin removed elsewhere).
  useEffect(() => {
    if (project !== null && found === null) closeWindow(instanceId);
  }, [project, found, instanceId, closeWindow]);

  const info = found
    ? registry.find((r) => r.uid === found.instance.uid && r.format === found.instance.format) ??
      registry.find((r) => r.uid === found.instance.uid)
    : undefined;
  const title = found?.instance.name ?? "Plugin";
  const vendor = info?.vendor ?? "";

  /* ---- transient note (errors / confirmations) ---- */
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNote = useCallback((msg: string) => {
    setNote(msg);
    if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => {
      noteTimer.current = null;
      setNote(null);
    }, NOTE_MS);
  }, []);
  useEffect(
    () => () => {
      if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    },
    [],
  );

  /* ---- built-in instruments: dedicated panel UI (toolbar-toggle back to the list) ---- */
  const customSpec = instrumentEditorSpec(found?.instance.uid);
  const [showGeneric, setShowGeneric] = useState(false);
  const customActive = customSpec !== null && !showGeneric;

  /* ---- built-in sampler: load a WAV into this instance ---- */
  const isSampler = found?.instance.uid === "builtin:sampler";
  const isCompressor = found?.instance.uid === "builtin:compressor";
  const sidechainSource = found?.instance.sidechainSource ?? 0;
  // Tracks eligible as a sidechain key: anything but the compressor's own owner track.
  const scOptions = useMemo(() => {
    const ownerId = found?.track.id;
    const opts = [{ value: "0", label: "Sidechain: none" }];
    for (const t of project?.tracks ?? [])
      if (t.id !== ownerId) opts.push({ value: String(t.id), label: `SC: ${t.name}` });
    return opts;
  }, [project, found]);
  const sampleInputRef = useRef<HTMLInputElement | null>(null);
  const onPickSample = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const res = await uploadFiles([file]); // no trackId → asset only, no clip
        const assetId = res.assets[0]?.id;
        if (typeof assetId !== "number") {
          showNote("Upload produced no asset.");
          return;
        }
        await setPluginSample(instanceId, assetId);
        showNote(`Sample loaded: ${file.name}`);
      } catch (err) {
        showNote(`Load sample failed: ${errText(err)}`);
      }
    },
    [instanceId, showNote],
  );

  /* ---- geometry: drag header / resize grip, remembered per instance ---- */
  // First open: cascade by the number of windows already open (= this window's stack index).
  const [rect, setRect] = useState<Rect>(
    () => editorRects.get(instanceId) ?? defaultRect(stackIndex, customSpec ?? undefined),
  );
  const rectRef = useRef(rect);
  rectRef.current = rect;
  useEffect(() => {
    editorRects.set(instanceId, rect);
  }, [instanceId, rect]);

  const headDrag = useRef<{ px: number; py: number; rx: number; ry: number } | null>(null);
  const onHeadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // don't start a window drag from interactive header controls
    if ((e.target as HTMLElement).closest("button, input, select, .knob, .numdrag, .btn-toggle")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    headDrag.current = { px: e.clientX, py: e.clientY, rx: rectRef.current.x, ry: rectRef.current.y };
  };
  const onHeadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = headDrag.current;
    if (!d) return;
    const w = rectRef.current.w;
    const x = Math.min(window.innerWidth - 60, Math.max(60 - w, d.rx + e.clientX - d.px));
    const y = Math.min(window.innerHeight - 40, Math.max(0, d.ry + e.clientY - d.py));
    setRect((r) => ({ ...r, x, y }));
  };
  const onHeadUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!headDrag.current) return;
    headDrag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const gripDrag = useRef<{ px: number; py: number; rw: number; rh: number } | null>(null);
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gripDrag.current = { px: e.clientX, py: e.clientY, rw: rectRef.current.w, rh: rectRef.current.h };
  };
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = gripDrag.current;
    if (!d) return;
    const w = Math.min(window.innerWidth, Math.max(MIN_W, d.rw + e.clientX - d.px));
    const h = Math.min(window.innerHeight, Math.max(MIN_H, d.rh + e.clientY - d.py));
    setRect((r) => ({ ...r, w, h }));
  };
  const onGripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!gripDrag.current) return;
    gripDrag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  /* ---- params ---- */
  const [params, setParams] = useState<PluginParam[] | null>(null);
  const [paramsErr, setParamsErr] = useState<string | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [paramQuery, setParamQuery] = useState("");
  /** plugin/getParams top-level hasEditor; undefined on old engines (field absent). */
  const [hasEditor, setHasEditor] = useState<boolean | undefined>(undefined);
  const indexRef = useRef<Map<number, number>>(new Map());
  const draggingRef = useRef<number | null>(null);

  const loadParams = useCallback(async () => {
    setParamsLoading(true);
    setParamsErr(null);
    try {
      const r = await getPluginParams(instanceId);
      indexRef.current = new Map(r.params.map((p, i) => [p.id, i]));
      setParams(r.params);
      setHasEditor(r.hasEditor);
    } catch (e) {
      setParams(null);
      setParamsErr(errText(e));
    } finally {
      setParamsLoading(false);
    }
  }, [instanceId]);

  /* ---- native editor (real OS window on the engine machine) ---- */
  const openNativeEditor = useCallback(() => {
    openPluginEditor(instanceId).catch((e) => showNote(`Native editor failed: ${errText(e)}`));
  }, [instanceId, showNote]);

  /* ---- presets ---- */
  const [presets, setPresets] = useState<PluginPreset[]>([]);
  const [presetIdx, setPresetIdx] = useState(-1);
  const [saveOpen, setSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  const loadPresets = useCallback(async () => {
    try {
      const r = await getPluginPresets(instanceId);
      setPresets(r.presets);
    } catch {
      setPresets([]); // plugin exposes none / host can't reach it — Select shows "No presets"
    }
  }, [instanceId]);

  useEffect(() => {
    void loadParams();
    void loadPresets();
  }, [loadParams, loadPresets]);

  // After a crash → restart cycle completes, fetch params again if we have none.
  useEffect(() => {
    if (stateEv?.state === "ok" && params === null && !paramsLoading && paramsErr !== null) {
      void loadParams();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateEv?.state]);

  /* ---- live updates from the native editor (event/pluginParams) ---- */
  useEffect(() => {
    return ws.on("event/pluginParams", (ev) => {
      if (ev.instanceId !== instanceId) return;
      setParams((prev) => {
        if (!prev) return prev;
        let next: PluginParam[] | null = null;
        for (const ch of ev.changed) {
          if (draggingRef.current === ch.id) continue; // don't fight an active drag
          const i = indexRef.current.get(ch.id);
          if (i === undefined) continue;
          if (!next) next = prev.slice();
          next[i] = { ...next[i], value: ch.value, valueText: ch.valueText };
        }
        return next ?? prev;
      });
    });
  }, [instanceId]);

  /* ---- param edit plumbing (transient drag → single non-transient commit) ---- */
  const updateLocal = useCallback((id: number, value: number) => {
    setParams((prev) => {
      if (!prev) return prev;
      const i = indexRef.current.get(id);
      if (i === undefined) return prev;
      const next = prev.slice();
      next[i] = { ...next[i], value };
      return next;
    });
  }, []);

  const onParamChange = useCallback(
    (id: number, value: number) => {
      draggingRef.current = id;
      updateLocal(id, value);
      dragPluginParam(instanceId, id, value);
    },
    [instanceId, updateLocal],
  );

  const onParamCommit = useCallback(
    (id: number, value: number) => {
      draggingRef.current = null;
      updateLocal(id, value);
      void commitPluginParam(instanceId, id, value).catch((e) =>
        showNote(`Set parameter failed: ${errText(e)}`),
      );
    },
    [instanceId, updateLocal, showNote],
  );

  const onParamMenu = useCallback(
    (e: React.MouseEvent, p: PluginParam) => {
      e.preventDefault();
      e.stopPropagation();
      const owner = foundRef.current;
      openContextMenu(e.clientX, e.clientY, [
        {
          label: "Add automation lane",
          icon: "sliders",
          disabled: owner === null,
          onClick: () => {
            if (!owner) return;
            setAutomation(owner.track.id, ParamRef.plugin(instanceId, p.id), {})
              .then(() => showNote(`Automation lane added for "${p.name}".`))
              .catch((err) => showNote(`Add automation failed: ${errText(err)}`));
          },
        },
        {
          label: "Reset to default",
          icon: "undo",
          onClick: () => onParamCommit(p.id, p.defaultValue),
        },
      ]);
    },
    [instanceId, onParamCommit, showNote],
  );

  const filtered = useMemo(() => {
    if (!params) return [];
    const q = paramQuery.trim().toLowerCase();
    if (q === "") return params;
    return params.filter((p) => p.name.toLowerCase().includes(q) || String(p.id) === q);
  }, [params, paramQuery]);

  const renderRow = useCallback(
    (i: number): React.ReactNode => {
      const p = filtered[i];
      if (p === undefined) return null;
      return <ParamRow param={p} onChange={onParamChange} onCommit={onParamCommit} onMenu={onParamMenu} />;
    },
    [filtered, onParamChange, onParamCommit, onParamMenu],
  );

  /* ---- bypass / wet-dry (cmd/plugin.set) with optimistic local mirrors ---- */
  const storeBypass = found?.instance.bypass ?? false;
  const storeWetDry = found?.instance.wetDry ?? 1;
  const [bypassLocal, setBypassLocal] = useState<boolean | null>(null);
  const [wetLocal, setWetLocal] = useState<number | null>(null);
  // Engine echo (event/projectChanged) clears the optimistic mirror.
  useEffect(() => setBypassLocal(null), [storeBypass]);
  useEffect(() => setWetLocal(null), [storeWetDry]);
  const bypassShown = bypassLocal ?? storeBypass;
  const wetShown = wetLocal ?? storeWetDry;

  /* ---- preset actions ---- */
  const onPresetChange = useCallback(
    (v: string) => {
      if (v === "") return;
      const idx = Number(v);
      const pr = presets[idx];
      if (!pr) return;
      setPresetIdx(idx);
      void (async () => {
        try {
          await loadPluginPreset(instanceId, pr.id);
          showNote(`Loaded preset "${pr.name}".`);
          await loadParams(); // values changed wholesale
        } catch (e) {
          showNote(`Preset load failed: ${errText(e)}`);
        }
      })();
    },
    [presets, instanceId, loadParams, showNote],
  );

  const doSavePreset = useCallback(() => {
    const name = presetName.trim();
    if (name === "") return;
    setSaveOpen(false);
    void (async () => {
      try {
        await savePluginPreset(instanceId, name);
        showNote(`Saved preset "${name}".`);
        await loadPresets();
      } catch (e) {
        showNote(`Save preset failed: ${errText(e)}`);
      }
    })();
  }, [presetName, instanceId, loadPresets, showNote]);

  /* ---- render ---- */
  const close = () => closeWindow(instanceId);

  return (
    <div
      className="pe-window"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: Z_BASE + stackIndex }}
      role="dialog"
      aria-label={`${title} — generic plugin editor`}
      // capture: bring to front on any pointerdown inside, even when a child stops propagation
      onPointerDownCapture={() => raiseWindow(instanceId)}
    >
      <div
        className="pe-header"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onPointerCancel={onHeadUp}
      >
        <Icon name="plug" size={14} className="dim" />
        <span className="pe-title ellipsis">{title}</span>
        {vendor !== "" && <span className="pe-vendor ellipsis">{vendor}</span>}
        <StateBadge ev={stateEv} />
        <div className="grow" />
        <IconButton icon="x" tooltip="Close editor" onClick={close} />
      </div>

      <div className="pe-toolbar">
        <Select
          value={presetIdx >= 0 ? String(presetIdx) : ""}
          onChange={onPresetChange}
          width={140}
          disabled={presets.length === 0 || !connected}
          title={presets.length === 0 ? "This plugin reports no presets" : "Load preset"}
          options={[
            { value: "", label: presets.length === 0 ? "No presets" : "Preset…" },
            ...presets.map((pr, i) => ({ value: String(i), label: pr.name })),
          ]}
        />
        <IconButton
          icon="save"
          tooltip="Save preset…"
          disabled={!connected || found === null}
          onClick={() => {
            setPresetName("");
            setSaveOpen((o) => !o);
          }}
        />
        <Toggle
          on={bypassShown}
          icon="power"
          variant="warn"
          tooltip="Bypass insert (engine-side)"
          disabled={!connected || found === null}
          onChange={(on) => {
            setBypassLocal(on);
            setPlugin(instanceId, { bypass: on }).catch((e) =>
              showNote(`Bypass failed: ${errText(e)}`),
            );
          }}
        >
          Byp
        </Toggle>
        <Knob
          size={24}
          value={wetShown}
          min={0}
          max={1}
          defaultValue={1}
          label="Mix"
          title="Wet/dry mix (engine-side)"
          format={(v) => `${Math.round(v * 100)}%`}
          disabled={!connected || found === null}
          onChange={(v) => {
            setWetLocal(v);
            transientParam("cmd/plugin.set", { instanceId, patch: { wetDry: v } });
          }}
          onCommit={(v) => {
            setWetLocal(v);
            void commitParam("cmd/plugin.set", { instanceId, patch: { wetDry: v } }).catch((e) =>
              showNote(`Wet/dry failed: ${errText(e)}`),
            );
          }}
        />
        {customSpec !== null && (
          <IconButton
            icon={showGeneric ? "piano" : "scriptList"}
            tooltip={showGeneric ? "Show instrument panel" : "Show parameter list"}
            onClick={() => setShowGeneric((g) => !g)}
          />
        )}
        {isCompressor && (
          <Select
            value={String(sidechainSource)}
            onChange={(v) => {
              void setPlugin(instanceId, { sidechainSource: Number(v) }).catch((e) =>
                showNote(`Sidechain routing failed: ${errText(e)}`),
              );
            }}
            width={150}
            disabled={!connected || found === null}
            title="Key the compressor's detector from another track's signal"
            options={scOptions}
          />
        )}
        {isSampler && (
          <>
            <button
              type="button"
              className="btn"
              disabled={!connected || found === null}
              title="Load a WAV/audio file for this sampler"
              onClick={() => sampleInputRef.current?.click()}
            >
              <Icon name="folder" size={12} /> Load Sample…
            </button>
            <input
              ref={sampleInputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.flac,.aif,.aiff"
              style={{ display: "none" }}
              onChange={onPickSample}
            />
          </>
        )}
        <div className="grow" />
        <Tooltip
          content={
            "Open the plugin's REAL editor in a native window on the engine machine\n(works for 32- and 64-bit plugins; it is not streamed into the browser)."
          }
        >
          <button
            type="button"
            className="btn"
            disabled={!connected || found === null}
            onClick={openNativeEditor}
          >
            <Icon name="export" size={13} />
            Native UI
          </button>
        </Tooltip>

        {saveOpen && (
          <div className="pe-popover">
            <TextInput
              value={presetName}
              onChange={setPresetName}
              placeholder="Preset name"
              autoFocus
              width={160}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  doSavePreset();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setSaveOpen(false);
                }
              }}
            />
            <button
              type="button"
              className="btn primary"
              disabled={presetName.trim() === ""}
              onClick={doSavePreset}
            >
              Save
            </button>
            <button type="button" className="btn" onClick={() => setSaveOpen(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>

      {!customActive && (
        <div className="pe-search">
          <Icon name="search" size={13} className="dim" />
          <TextInput
            className="grow"
            type="search"
            value={paramQuery}
            onChange={setParamQuery}
            placeholder="Search parameters…"
          />
          <span className="pe-count">
            {params
              ? paramQuery.trim() !== ""
                ? `${filtered.length}/${params.length}`
                : `${params.length}`
              : "—"}{" "}
            params
          </span>
        </div>
      )}

      <div className="pe-body">
        {project === null ? (
          <div className="pe-empty">
            <Icon name="plug" size={20} />
            <span>Engine disconnected.</span>
            <span className="faint">Parameter editing resumes when the engine reconnects.</span>
          </div>
        ) : paramsLoading && params === null ? (
          <div className="pe-empty">
            <span>Loading parameters…</span>
          </div>
        ) : paramsErr !== null ? (
          <div className="pe-empty">
            <Icon name="warning" size={18} />
            <span>Couldn’t load parameters: {paramsErr}</span>
            <button type="button" className="btn" onClick={() => void loadParams()}>
              <Icon name="refresh" size={13} />
              Retry
            </button>
          </div>
        ) : params === null || params.length === 0 ? (
          <div className="pe-empty">
            {hasEditor === true ? (
              // Pinned: plugin/getParams carries hasEditor — a no-params plugin with a
              // native editor (e.g. PlugSound) is controlled through that window.
              <>
                <span>
                  This plugin has no automatable parameters — it is controlled through its
                  native editor window.
                </span>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!connected || found === null}
                  onClick={openNativeEditor}
                >
                  <Icon name="export" size={13} />
                  Open Native Editor
                </button>
              </>
            ) : (
              // hasEditor === false (really nothing to show) or undefined (old engine)
              <span>This plugin exposes no parameters.</span>
            )}
          </div>
        ) : customActive && found !== null ? (
          <InstrumentEditor
            uid={found.instance.uid}
            params={params}
            trackId={found.track.id}
            disabled={!connected}
            onChange={onParamChange}
            onCommit={onParamCommit}
            onMenu={onParamMenu}
          />
        ) : filtered.length === 0 ? (
          <div className="pe-empty">
            <span>No parameters match “{paramQuery.trim()}”.</span>
          </div>
        ) : (
          <VirtualList
            itemCount={filtered.length}
            itemHeight={PARAM_ROW_H}
            itemKey={(i) => filtered[i]?.id ?? i}
            renderItem={renderRow}
          />
        )}
        {note !== null && <div className="pe-hint">{note}</div>}
      </div>

      <div
        className="pe-resize"
        title="Resize"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      />
    </div>
  );
}
