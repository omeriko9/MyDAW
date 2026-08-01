/**
 * Zustand store (SPEC §9) + engine event wiring.
 *
 * High-frequency streams (event/meters ~15 Hz, event/transport ~20 Hz) are kept OUTSIDE
 * React state: components subscribe imperatively to `metersBus` / `transportBus` and draw
 * to canvas directly. The store only mirrors a low-frequency transport snapshot (state /
 * loop transitions) so buttons re-render without 20 Hz churn.
 *
 * event/projectChanged applies granular merges per SPEC §5.8:
 *   - full present (or no local project) → replace
 *   - tracks: upsert by id (masterTrack handled separately); when the list covers EVERY
 *     existing track id its order is adopted wholesale, so track reordering (e.g. an
 *     engine answering cmd/track.reorder with scope:"track") is conveyed correctly
 *   - clips: upsert by clip id into target track (removing it from any other track)
 *   - removedTrackIds / removedClipIds → remove
 */

import { create } from "zustand";
import { showToast } from "../components/common/ToastHost";
import { dropPeaks } from "../components/Timeline/peaksCache";
import { invalidatePeaks } from "../lib/peaks";
import {
  isBool,
  loadBoolPref,
  loadPref,
  numberIn,
  oneOf,
  savePref,
  savePrefDebounced,
  shapeOf,
} from "../lib/prefs";
import { ws } from "../protocol/ws";
import type { ConnectionState } from "../protocol/ws";
import {
  DEFAULT_RIBBON,
  shellVisiblePanes,
  stockWorkspaces,
  validRibbon,
  validWorkspaces,
} from "../shell/shellTypes";
import type { RibbonState, ShellMode, WorkspacesState } from "../shell/shellTypes";
import type {
  Clip,
  EngineStatus,
  GetDevicesReply,
  HelloEngineInfo,
  ImportProgressEvent,
  LogEvent,
  MetersEvent,
  MetronomeState,
  MidiMap,
  MidiMapsState,
  MidiActivityEvent,
  RecordingNotesEvent,
  MidiInputInfo,
  PluginInfo,
  PluginStateEvent,
  Project,
  ProjectChangedEvent,
  RecentProject,
  RecoveryInfoReply,
  ScanProgressEvent,
  Track,
  TransportEvent,
} from "../protocol/types";

/* ============================================================================
 * Imperative buses (outside React state)
 * ========================================================================= */

export interface Bus<T> {
  /** Last value emitted, or null before the first event. */
  readonly last: T | null;
  emit(value: T): void;
  /** Returns an unsubscribe function. */
  subscribe(cb: (value: T) => void): () => void;
}

function makeBus<T>(): Bus<T> {
  const subs = new Set<(value: T) => void>();
  let lastValue: T | null = null;
  return {
    get last() {
      return lastValue;
    },
    emit(value: T) {
      lastValue = value;
      for (const cb of [...subs]) {
        try {
          cb(value);
        } catch (e) {
          console.error("[bus] subscriber threw:", e);
        }
      }
    },
    subscribe(cb: (value: T) => void) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}

/** event/meters — drive canvas meters directly from this (SPEC §9). */
export const metersBus: Bus<MetersEvent> = makeBus<MetersEvent>();
/** event/transport — drive the playhead/position readout directly from this. */
export const transportBus: Bus<TransportEvent> = makeBus<TransportEvent>();
/** event/midiActivity — throttled activity blips for track headers / status. */
export const midiActivityBus: Bus<MidiActivityEvent> = makeBus<MidiActivityEvent>();
/** event/recordingNotes — live in-progress MIDI take for the timeline record preview. */
export const recordingBus: Bus<RecordingNotesEvent> = makeBus<RecordingNotesEvent>();

/* ============================================================================
 * Store types
 * ========================================================================= */

/** Timeline tools: select(1) / draw(2) / erase(3) / split(4) (SPEC §9). */
export type Tool = "select" | "draw" | "erase" | "split";

/** Clip-edge resize behavior (Cubase sizing modes): normal trim, contents ride with
 *  the dragged edge, or the content time-stretches to the new duration. */
export type SizingMode = "normal" | "moveContents" | "timeStretch";

export type BottomTab = "mixer" | "pianoRoll" | "clipEditor" | "sheetMusic" | "visualizer" | null;

/** Pane focus for keyboard routing — set by pointerdown (capture) on each pane root. */
export type FocusedPane = "timeline" | "pianoRoll" | "clipEditor" | "sheetMusic" | "mixer";

/** Dock tabs that can be popped out into their own browser window (U3). */
export type PoppedOutTab = Exclude<BottomTab, null>;

export interface Selection {
  trackIds: number[];
  clipIds: number[];
  noteIds: number[];
}

export interface Viewport {
  /** horizontal zoom, px per beat */
  zoomX: number;
  /** vertical zoom (px per piano-roll row / track-height scale) */
  zoomY: number;
  /** horizontal scroll, px */
  scrollX: number;
  /** vertical scroll, px */
  scrollY: number;
}

/** Tabs hosted by the left Browser panel. The Inspector lives here as a tab (U6). */
export type BrowserTab = "plugins" | "files" | "inspector";

export interface PanelsState {
  browser: boolean;
  /** Which Browser tab is active (Plugins / Files / Inspector). */
  browserTab: BrowserTab;
  /** Legacy flag kept for the agent ui/layout.set surface; the Inspector is now a
   *  Browser tab (see browserTab), so this no longer drives a standalone panel. */
  inspector: boolean;
  /** Arrangement minimap strip above the timeline ruler (View → Minimap). */
  minimap: boolean;
  /** Right-docked agent chat panel (hidden by default; Ctrl+Shift+I / toolbar / View menu). */
  agent: boolean;
  /** Big Clock — floating readable-from-across-the-room position display (View menu). */
  bigClock: boolean;
  bottomTab: BottomTab;
  /** Slot-1 tab to restore when the dock is REOPENED — stashed by setPanels whenever a
   *  patch closes the dock. Reopening on a hard-coded "mixer" not only lost the pane the
   *  user was in, it could equal bottomTab2 and so destroy the split (App.tsx invariant).
   *  Optional: a panels object assembled without it is still valid, and the reopen then
   *  falls back to "mixer" as before. */
  bottomTabPrev?: PoppedOutTab;
  /** Second dock slot (split dock, UI_IMPROVE.md §6.1). null = not split. Only
   *  VISIBLE while bottomTab is non-null (the dock itself is open) — remembered
   *  across dock close/reopen. Never equals bottomTab (selecting the other
   *  half's tab swaps the halves). */
  bottomTab2: BottomTab;
  /** Dock tabs currently popped out into separate browser windows (portal-rendered). */
  poppedOut: Partial<Record<PoppedOutTab, boolean>>;
  /** Dock-capable panes visible in the ACTIVE non-classic shell (ribbon slots /
   *  workspace tiles) — maintained by setShellMode/setRibbon/setWorkspaces so
   *  lib/keyboard's paneVisible() follows what is actually on screen. undefined =
   *  classic shell active (the bottomTab fields above rule, as always). Runtime
   *  state, never persisted. */
  shellPanes?: PoppedOutTab[];
}

export interface DialogsState {
  /** Production Techniques wizard (Project menu; docs/PRODUCTION_TECHNIQUES_PLAN.md). */
  techniques: boolean;
  settings: boolean;
  export: boolean;
  /** Keyboard-shortcut cheat sheet ("?" key / Help menu) */
  shortcuts: boolean;
  /** Command palette (Ctrl+K / Help menu) — run any command, jump to bar/marker/track */
  palette: boolean;
  /** Quick-help card while "?" is HELD — the pane whose hints to show, or null.
   *  (Literal union mirrors keyboard.ts KeyContextName; importing it would cycle.) */
  quickHelp: "timeline" | "pianoRoll" | "clipEditor" | "sheetMusic" | null;
  /** "Recreate Plugins…" dialog (File menu; auto-opened once after Import Project) */
  recreatePlugins: boolean;
  /** Room View — perspective pan/level panner (mixer toolbar button) */
  roomView: boolean;
  /** open generic plugin editor windows — instanceIds in render order, LAST is topmost */
  pluginEditors: number[];
  /** crash-recovery offer (from project/recoveryInfo), or null */
  recovery: RecoveryInfoReply | null;
}

export interface DawState {
  /* connection / engine */
  connected: boolean;
  /** File ▸ Exit completed: the engine shut down ON PURPOSE — show the goodbye screen
   *  instead of the "reconnecting…" overlay (reconnect is stopped, nothing to reach). */
  shutdownByUser: boolean;
  engineInfo: HelloEngineInfo | null;
  engineStatus: EngineStatus | null;

  /* authoritative project mirror */
  project: Project | null;
  revision: number;
  dirty: boolean;

  /* registry / session lists */
  registry: PluginInfo[];
  recentProjects: RecentProject[];
  audioDevices: GetDevicesReply | null;
  midiInputs: MidiInputInfo[];

  /* low-frequency transport snapshot (state/loop transitions only; beat at 20 Hz → transportBus) */
  transport: TransportEvent;

  /* metronome — UI mirror of the engine state: seeded from the session/hello reply and
     reconciled from every event/transport + transport/* reply that carries the optional
     "metronome" field (reconcileMetronome below). User toggles (transport bar / "C" key)
     update this optimistically and send transport/setMetronome. */
  metronome: { enabled: boolean; countIn: 0 | 1 | 2 };

  /* automationWrite — UI mirror of the engine arm (same seeding/reconcile path as metronome):
     while ON and playing, fader/knob drags record automation points at the playhead. */
  automationWrite: boolean;

  /* MIDI control-surface maps + learn arm (seeded from session/hello, reconciled from
     event/midiMaps). armed = the paramRef awaiting the next CC, or null. */
  midiMaps: MidiMap[];
  midiLearnArm: string | null;

  /* plugin runtime states: instanceId → last event/pluginState */
  pluginStates: Record<number, PluginStateEvent>;

  /* progress */
  scanProgress: ScanProgressEvent | null;
  importProgress: ImportProgressEvent | null;
  exportProgress: number | null;
  /** async offline-process (DOP) render in flight: event/dopProgress → event/dopDone */
  dopJob: { clipId: number; pct: number; label?: string } | null;

  /* recent warn/error log lines (event/log), capped */
  logLines: LogEvent[];

  /* ui state */
  selection: Selection;
  tool: Tool;
  sizingMode: SizingMode;
  viewport: Viewport;
  /** pane under the last pointerdown — keyboard shortcuts (G/H zoom, edit actions) route here first */
  focusedPane: FocusedPane;
  /** timeline page-jump auto-scroll keeping the playhead in view (the "J" shortcut toggles it) */
  followPlayhead: boolean;
  panels: PanelsState;
  /** Which UI shell hosts the panes (docs/UI_ALTERNATIVES_PLAN.md). The panes are
   *  identical in all three; only how they are reached and arranged differs. */
  shellMode: ShellMode;
  /** Ribbon shell arrangement (persisted under ui.shell.ribbon). */
  ribbon: RibbonState;
  /** Workspaces shell arrangement (persisted under ui.shell.workspaces). */
  workspaces: WorkspacesState;
  activeMidiClipId: number | null;
  activeAudioClipId: number | null;
  dialogs: DialogsState;

  /* actions */
  setProject(project: Project | null): void;
  setEngineStatus(status: EngineStatus): void;
  setRegistry(registry: PluginInfo[]): void;
  setMidiInputs(inputs: MidiInputInfo[]): void;
  setAudioDevices(devices: GetDevicesReply): void;
  setSelection(patch: Partial<Selection>): void;
  clearSelection(): void;
  setTool(tool: Tool): void;
  setSizingMode(mode: SizingMode): void;
  setViewport(patch: Partial<Viewport>): void;
  setFocusedPane(pane: FocusedPane): void;
  setFollowPlayhead(on: boolean): void;
  setPanels(patch: Partial<PanelsState>): void;
  setShellMode(mode: ShellMode): void;
  /** Patch the ribbon arrangement. Single-instance invariant enforced here: a patch
   *  that would make both slots show the same pane SWAPS the slots instead. */
  setRibbon(patch: Partial<RibbonState>): void;
  /** Replace the workspaces state wholesale (callers use the pure tree helpers). */
  setWorkspaces(next: WorkspacesState): void;
  setActiveMidiClipId(id: number | null): void;
  setActiveAudioClipId(id: number | null): void;
  setDialogs(patch: Partial<DialogsState>): void;
  setMetronome(patch: Partial<{ enabled: boolean; countIn: 0 | 1 | 2 }>): void;
  setAutomationWrite(on: boolean): void;
  /** Open a generic plugin editor window (raises it to the front if already open). */
  openPluginEditorWindow(instanceId: number): void;
  /** Close one editor window (others stay open). */
  closePluginEditorWindow(instanceId: number): void;
}

/* ============================================================================
 * Granular projectChanged merge (SPEC §5.8)
 * ========================================================================= */

export function applyProjectChanged(project: Project, ev: ProjectChangedEvent): Project {
  let tracks: Track[] = project.tracks;
  let masterTrack: Track = project.masterTrack;

  if (ev.removedTrackIds && ev.removedTrackIds.length > 0) {
    const rm = new Set(ev.removedTrackIds);
    tracks = tracks.filter((t) => !rm.has(t.id));
  }

  if (ev.tracks && ev.tracks.length > 0) {
    const incoming: Track[] = [];
    for (const t of ev.tracks) {
      if (t.kind === "master" || t.id === masterTrack.id) masterTrack = t;
      else incoming.push(t);
    }
    const incomingIds = new Set(incoming.map((t) => t.id));
    if (tracks.every((t) => incomingIds.has(t.id))) {
      // The event covers every track we know about → it is the complete ordered
      // list; adopt it wholesale so reordering is conveyed (upserting by id would
      // freeze the old positions).
      tracks = incoming;
    } else {
      tracks = tracks.slice();
      for (const t of incoming) {
        const i = tracks.findIndex((x) => x.id === t.id);
        if (i >= 0) tracks[i] = t;
        else tracks.push(t);
      }
    }
  }

  if (ev.removedClipIds && ev.removedClipIds.length > 0) {
    const rm = new Set(ev.removedClipIds);
    tracks = tracks.map((t) =>
      t.clips.some((c) => rm.has(c.id))
        ? { ...t, clips: t.clips.filter((c) => !rm.has(c.id)) }
        : t,
    );
  }

  if (ev.clips && ev.clips.length > 0) {
    tracks = tracks.slice();
    for (const { trackId, clip } of ev.clips) {
      // A clip id lives on exactly one track; drop it elsewhere first (cross-track move).
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t.id !== trackId && t.clips.some((c) => c.id === clip.id)) {
          tracks[i] = { ...t, clips: t.clips.filter((c) => c.id !== clip.id) };
        }
      }
      // Clips only ever live on audio/midi/instrument tracks (Model::canHoldClips), and the
      // engine's serializer resolves each event through clipById → project.tracks, so trackId is
      // always a non-master member of `tracks` here — searching `tracks` alone is complete.
      const ti = tracks.findIndex((t) => t.id === trackId);
      if (ti < 0) continue; // unknown track — a tracks[] upsert or full sync will follow
      const t = tracks[ti];
      const clips: Clip[] = t.clips.slice();
      const ci = clips.findIndex((c) => c.id === clip.id);
      if (ci >= 0) clips[ci] = clip;
      else clips.push(clip);
      tracks[ti] = { ...t, clips };
    }
  }

  return { ...project, tracks, masterTrack };
}

/* ============================================================================
 * Store
 * ========================================================================= */

const initialTransport: TransportEvent = {
  state: "stopped",
  beat: 0,
  timeSec: 0,
  loop: { startBeat: 0, endBeat: 0, enabled: false },
};

/* Restored UI prefs (lib/prefs) — layout choices survive reloads. Zoom bounds mirror
   Timeline/layout MIN/MAX_ZOOM_* (not imported: layout → Fader would tangle module
   init order with this store). poppedOut is deliberately NOT restored — reopening a
   popup window needs a user gesture, so a restored flag would just show placeholders. */
const prefViewport = loadPref<Viewport>(
  "ui.viewport",
  { zoomX: 32, zoomY: 16, scrollX: 0, scrollY: 0 },
  shapeOf({
    zoomX: numberIn(0.5, 640),
    zoomY: numberIn(8, 48),
    scrollX: numberIn(0, 1e9),
    scrollY: numberIn(0, 1e9),
  }),
);
const prefPanels: PanelsState = {
  // minimap arrived later than the other fields — default it separately so older
  // stored panel objects (without the field) still validate and restore.
  minimap: loadBoolPref("ui.panels.minimap", true),
  // agent panel is likewise a later, separately-stored field; hidden by default.
  agent: loadBoolPref("ui.panels.agent", false),
  bigClock: loadBoolPref("ui.panels.bigClock", false),
  // split-dock second slot — later, separately-stored field (split off by default)
  bottomTab2: loadPref<BottomTab>(
    "ui.panels.bottomTab2",
    null,
    oneOf<BottomTab>("mixer", "pianoRoll", "clipEditor", "sheetMusic", "visualizer", null),
  ),
  // slot-1 tab to restore on dock reopen — likewise a later, separately-stored field
  bottomTabPrev: loadPref<PoppedOutTab>(
    "ui.panels.bottomTabPrev",
    "mixer",
    oneOf<PoppedOutTab>("mixer", "pianoRoll", "clipEditor", "sheetMusic", "visualizer"),
  ),
  ...loadPref<
    Omit<
      PanelsState,
      "poppedOut" | "minimap" | "agent" | "bottomTab2" | "bottomTabPrev" | "bigClock" | "shellPanes"
    >
  >(
    "ui.panels",
    { browser: true, browserTab: "plugins", inspector: true, bottomTab: "mixer" },
    shapeOf({
      browser: isBool,
      browserTab: oneOf<BrowserTab>("plugins", "files", "inspector"),
      inspector: isBool,
      bottomTab: oneOf<BottomTab>("mixer", "pianoRoll", "clipEditor", "sheetMusic", "visualizer", null),
    }),
  ),
  poppedOut: {},
};
/* UI shell (docs/UI_ALTERNATIVES_PLAN.md) — each shell persists its own arrangement
   under its own key, so switching modes is lossless in both directions. */
const prefShellMode = loadPref<ShellMode>(
  "ui.shellMode",
  "classic",
  oneOf<ShellMode>("classic", "ribbon", "workspaces"),
);
const prefRibbon = loadPref<RibbonState>("ui.shell.ribbon", DEFAULT_RIBBON, validRibbon);
const prefWorkspaces = loadPref<WorkspacesState>(
  "ui.shell.workspaces",
  stockWorkspaces(),
  validWorkspaces,
);
prefPanels.shellPanes = shellVisiblePanes(prefShellMode, prefRibbon, prefWorkspaces);
const prefTool = loadPref<Tool>("ui.tool", "select", oneOf("select", "draw", "erase", "split"));
const prefSizingMode = loadPref<SizingMode>(
  "ui.sizingMode",
  "normal",
  oneOf("normal", "moveContents", "timeStretch"),
);
const prefFollowPlayhead = loadBoolPref("ui.followPlayhead", false);

const MAX_LOG_LINES = 200;

/** Append-or-raise an editor window id; returns the same object when already topmost. */
function raisePluginEditor(dialogs: DialogsState, instanceId: number): DialogsState {
  const eds = dialogs.pluginEditors;
  if (eds[eds.length - 1] === instanceId) return dialogs;
  return { ...dialogs, pluginEditors: [...eds.filter((id) => id !== instanceId), instanceId] };
}

export const useStore = create<DawState>((set) => ({
  connected: false,
  shutdownByUser: false,
  engineInfo: null,
  engineStatus: null,

  project: null,
  revision: 0,
  dirty: false,

  registry: [],
  recentProjects: [],
  audioDevices: null,
  midiInputs: [],

  transport: initialTransport,
  metronome: { enabled: false, countIn: 0 },
  automationWrite: false,
  midiMaps: [],
  midiLearnArm: null,
  pluginStates: {},

  scanProgress: null,
  importProgress: null,
  exportProgress: null,
  dopJob: null,
  logLines: [],

  selection: { trackIds: [], clipIds: [], noteIds: [] },
  tool: prefTool,
  sizingMode: prefSizingMode,
  viewport: prefViewport,
  focusedPane: "timeline",
  followPlayhead: prefFollowPlayhead,
  panels: prefPanels,
  shellMode: prefShellMode,
  ribbon: prefRibbon,
  workspaces: prefWorkspaces,
  activeMidiClipId: null,
  activeAudioClipId: null,
  dialogs: { techniques: false, settings: false, export: false, shortcuts: false, palette: false, quickHelp: null, recreatePlugins: false, roomView: false, pluginEditors: [], recovery: null },

  setProject: (project) => set({ project }),
  setEngineStatus: (engineStatus) => set({ engineStatus }),
  setRegistry: (registry) => set({ registry }),
  setMidiInputs: (midiInputs) => set({ midiInputs }),
  setAudioDevices: (audioDevices) => set({ audioDevices }),
  setSelection: (patch) => set((s) => ({ selection: { ...s.selection, ...patch } })),
  clearSelection: () => set({ selection: { trackIds: [], clipIds: [], noteIds: [] } }),
  setTool: (tool) => set({ tool }),
  setSizingMode: (sizingMode) => set({ sizingMode }),
  setViewport: (patch) => set((s) => ({ viewport: { ...s.viewport, ...patch } })),
  // fired on EVERY pointerdown in a pane — return the same state when unchanged so
  // zustand skips the notify (no re-render per click)
  setFocusedPane: (focusedPane) =>
    set((s) => (s.focusedPane === focusedPane ? s : { ...s, focusedPane })),
  setFollowPlayhead: (followPlayhead) => set({ followPlayhead }),
  setPanels: (patch) =>
    set((s) => ({
      panels: {
        ...s.panels,
        // remember which pane slot 1 was showing when the dock is closed (see bottomTabPrev)
        ...(patch.bottomTab === null && s.panels.bottomTab !== null
          ? { bottomTabPrev: s.panels.bottomTab }
          : {}),
        ...patch,
      },
    })),
  setShellMode: (mode) =>
    set((s) => ({
      shellMode: mode,
      panels: { ...s.panels, shellPanes: shellVisiblePanes(mode, s.ribbon, s.workspaces) },
    })),
  setRibbon: (patch) =>
    set((s) => {
      let r: RibbonState = { ...s.ribbon, ...patch };
      if (r.secondary !== null && r.secondary === r.primary) {
        // Single-instance: picking the OTHER slot's pane swaps the slots (dock
        // setHalfTab semantics); a patch that collides any other way drops the split.
        if (patch.primary !== undefined && patch.primary === s.ribbon.secondary)
          r = { ...r, secondary: s.ribbon.primary };
        else if (
          patch.secondary !== undefined &&
          patch.secondary === s.ribbon.primary &&
          s.ribbon.secondary !== null
        )
          r = { ...r, primary: s.ribbon.secondary, secondary: s.ribbon.primary };
        else r = { ...r, secondary: null };
      }
      return {
        ribbon: r,
        panels:
          s.shellMode === "ribbon"
            ? { ...s.panels, shellPanes: shellVisiblePanes("ribbon", r, s.workspaces) }
            : s.panels,
      };
    }),
  setWorkspaces: (next) =>
    set((s) => ({
      workspaces: next,
      panels:
        s.shellMode === "workspaces"
          ? { ...s.panels, shellPanes: shellVisiblePanes("workspaces", s.ribbon, next) }
          : s.panels,
    })),
  setActiveMidiClipId: (activeMidiClipId) => set({ activeMidiClipId }),
  setActiveAudioClipId: (activeAudioClipId) => set({ activeAudioClipId }),
  setDialogs: (patch) => set((s) => ({ dialogs: { ...s.dialogs, ...patch } })),
  setMetronome: (patch) => set((s) => ({ metronome: { ...s.metronome, ...patch } })),
  setAutomationWrite: (automationWrite) => set({ automationWrite }),
  openPluginEditorWindow: (instanceId) =>
    set((s) => ({ dialogs: raisePluginEditor(s.dialogs, instanceId) })),
  closePluginEditorWindow: (instanceId) =>
    set((s) => ({
      dialogs: {
        ...s.dialogs,
        pluginEditors: s.dialogs.pluginEditors.filter((id) => id !== instanceId),
      },
    })),
}));

/* ============================================================================
 * Live-MIDI thru follows track SELECTION (spec 2026-07-22): mirror the selected
 * track ids to the engine (midi/setThruTracks) on every selection change —
 * debounced (click bursts) — and after every hello (engine restarts forget it).
 * Older engines without the endpoint reply with an error: swallowed (selection
 * thru is simply unavailable there; arming/monitor still works engine-side).
 * ========================================================================= */

let midiThruTimer: ReturnType<typeof setTimeout> | undefined;

export function syncMidiThru(): void {
  const s = useStore.getState();
  if (!s.connected) return;
  ws.request("midi/setThruTracks", { trackIds: s.selection.trackIds }).catch(() => {
    /* pre-thru engine — harmless */
  });
}

useStore.subscribe((s, prev) => {
  if (s.selection.trackIds !== prev.selection.trackIds) {
    if (midiThruTimer !== undefined) clearTimeout(midiThruTimer);
    midiThruTimer = setTimeout(syncMidiThru, 80);
  }
});

/* Persist the restored slices back on every change (drag-driven ones debounced).
   Field-compare against prev so unrelated store updates cost one pointer check. */
useStore.subscribe((s, prev) => {
  if (s.viewport !== prev.viewport) savePrefDebounced("ui.viewport", s.viewport);
  if (s.panels !== prev.panels) {
    const { browser, browserTab, inspector, bottomTab, bottomTab2, bottomTabPrev, minimap, agent, bigClock } = s.panels;
    savePrefDebounced("ui.panels", { browser, browserTab, inspector, bottomTab });
    savePrefDebounced("ui.panels.minimap", minimap);
    savePrefDebounced("ui.panels.agent", agent);
    savePrefDebounced("ui.panels.bottomTab2", bottomTab2);
    savePrefDebounced("ui.panels.bottomTabPrev", bottomTabPrev);
    savePrefDebounced("ui.panels.bigClock", bigClock);
  }
  if (s.shellMode !== prev.shellMode) savePref("ui.shellMode", s.shellMode);
  if (s.ribbon !== prev.ribbon) savePrefDebounced("ui.shell.ribbon", s.ribbon);
  if (s.workspaces !== prev.workspaces) savePrefDebounced("ui.shell.workspaces", s.workspaces);
  if (s.tool !== prev.tool) savePref("ui.tool", s.tool);
  if (s.sizingMode !== prev.sizingMode) savePref("ui.sizingMode", s.sizingMode);
  if (s.followPlayhead !== prev.followPlayhead) savePref("ui.followPlayhead", s.followPlayhead);
});

/**
 * Adopt the engine-reported metronome state (hello reply / transport events & replies).
 * The field is OPTIONAL on the wire — older engines omit it, in which case the local
 * mirror stands (the UI still works against an old engine).
 */
export function reconcileMetronome(m: MetronomeState | undefined): void {
  if (!m) return;
  const countIn: 0 | 1 | 2 = m.countInBars >= 2 ? 2 : m.countInBars === 1 ? 1 : 0;
  const cur = useStore.getState().metronome;
  if (cur.enabled === m.enabled && cur.countIn === countIn) return;
  useStore.setState({ metronome: { enabled: m.enabled, countIn } });
}

/** Adopt the engine-reported automation-write arm (optional wire field; old engines omit it). */
export function reconcileAutomationWrite(v: boolean | undefined): void {
  if (v === undefined) return;
  if (useStore.getState().automationWrite !== v) useStore.setState({ automationWrite: v });
}

/** Adopt the engine-reported MIDI maps + learn arm (session/hello + event/midiMaps). */
export function reconcileMidiMaps(s: MidiMapsState | undefined): void {
  if (!s) return;
  useStore.setState({ midiMaps: s.maps ?? [], midiLearnArm: s.armed ?? null });
}

/* ============================================================================
 * Engine event wiring (runs once on first import of this module)
 * ========================================================================= */

ws.onStateChange((s: ConnectionState) => {
  // On a disconnect, also clear any stale scan progress so a scanning dialog
  // (e.g. RecreatePluginsDialog) doesn't get stuck on the last reported state.
  useStore.setState({ connected: s === "open", ...(s !== "open" ? { scanProgress: null } : {}) });
});

/** session/hello (re-)sync — fired on every successful connect (SPEC §9). */
let helloRetryTimer: ReturnType<typeof setTimeout> | null = null;

async function sendHello(): Promise<void> {
  if (helloRetryTimer !== null) {
    clearTimeout(helloRetryTimer);
    helloRetryTimer = null;
  }
  try {
    const r = await ws.request("session/hello", { clientName: "MyDAW Browser UI" });
    // Adopting a hello project (initial connect OR reconnect after an engine restart —
    // asset ids restart with it): cached peaks may belong to the previous session.
    invalidatePeaks();
    dropPeaks();
    useStore.setState({
      engineInfo: r.engine,
      project: r.project,
      registry: r.pluginRegistry,
      recentProjects: r.recentProjects,
      audioDevices: r.audioDevices,
      midiInputs: r.midiInputs,
      // Re-seed from the engine: `dirty` lives client-side, so a reload or a second
      // tab otherwise came up thinking a project with unsaved engine-side edits was
      // clean — which silently disabled autoSaveIfDirty's save-before-replace guard.
      // Older engines omit the field; keep whatever we had rather than clearing it.
      ...(r.dirty !== undefined ? { dirty: r.dirty } : {}),
    });
    reconcileMetronome(r.metronome); // seed the metronome mirror (optional field)
    reconcileAutomationWrite(r.automationWrite);
    reconcileMidiMaps(r.midiMaps);
    syncMidiThru(); // engine restarts forget the thru set — reseed from selection
  } catch (e) {
    console.error("[store] session/hello failed:", e);
    if (ws.state === "open") {
      helloRetryTimer = setTimeout(() => void sendHello(), 2_000);
    }
  }
}

ws.onReconnect(() => {
  void sendHello();
});

ws.on("event/projectChanged", (ev) => {
  if (ev.full) {
    // Full replace: the project (and with it every asset record) may be a different
    // model entirely — asset ids recycle per model, and the engine's post-decode
    // reconcile (channels/lengthSamples) also arrives as a full event. Drop both
    // peaks caches so nothing renders another record's parse; refetches revalidate
    // against the engine's ETag (cheap 304 when the bytes are unchanged). Granular
    // merges never carry asset records (§5.8 tracks/clips only), so nothing to do
    // per-asset there.
    invalidatePeaks();
    dropPeaks();
  }
  useStore.setState((s) => {
    if (ev.full || !s.project) {
      return { project: ev.full ?? s.project, revision: ev.revision };
    }
    return { project: applyProjectChanged(s.project, ev), revision: ev.revision };
  });
});

ws.on("event/dirty", (ev) => {
  useStore.setState({ dirty: ev.dirty });
});

ws.on("event/shutdown", () => {
  // Deliberate exit (File ▸ Exit, any tab): stop reconnecting BEFORE the socket drops so
  // the offline overlay never flashes; App renders the goodbye screen instead.
  useStore.setState({ shutdownByUser: true });
  ws.disconnect();
});

// Open Recent changes live (save / save-as / import) — hello only seeds it at connect.
ws.on("event/recentProjects", (ev) => {
  useStore.setState({ recentProjects: ev.recentProjects });
});

ws.on("event/transport", (ev) => {
  transportBus.emit(ev);
  // Reconcile the metronome mirror when the event carries it (no-op when unchanged).
  reconcileMetronome(ev.metronome);
  reconcileAutomationWrite(ev.automationWrite);
  // Mirror into React state only on state/loop transitions (avoid 20 Hz re-renders).
  const t = useStore.getState().transport;
  if (
    t.state !== ev.state ||
    t.loop.enabled !== ev.loop.enabled ||
    t.loop.startBeat !== ev.loop.startBeat ||
    t.loop.endBeat !== ev.loop.endBeat
  ) {
    useStore.setState({ transport: ev });
  }
});

ws.on("event/meters", (ev) => {
  metersBus.emit(ev);
});

ws.on("event/midiActivity", (ev) => {
  midiActivityBus.emit(ev);
});

ws.on("event/recordingNotes", (ev) => {
  recordingBus.emit(ev);
});

ws.on("event/pluginState", (ev) => {
  useStore.setState((s) => ({
    pluginStates: { ...s.pluginStates, [ev.instanceId]: ev },
  }));
});

ws.on("event/midiMaps", (ev) => {
  reconcileMidiMaps(ev);
});

// event/pluginParams is intentionally NOT mirrored here: the generic plugin editor
// subscribes directly via ws.on("event/pluginParams", ...) for live updates.

ws.on("event/scanProgress", (ev) => {
  useStore.setState({ scanProgress: ev });
});

ws.on("event/scanDone", (ev) => {
  useStore.setState({ registry: ev.registry, scanProgress: null });
});

ws.on("event/importProgress", (ev) => {
  useStore.setState({ importProgress: ev.pct >= 100 ? null : ev });
});

ws.on("event/exportProgress", (ev) => {
  useStore.setState({ exportProgress: ev.pct >= 100 ? null : ev.pct });
});

ws.on("event/dopProgress", (ev) => {
  useStore.setState({ dopJob: { clipId: ev.clipId, pct: ev.pct ?? 0, label: ev.label } });
});

ws.on("event/dopDone", (ev) => {
  useStore.setState({ dopJob: null });
  if (!ev.ok) showToast(`Offline process failed: ${ev.error ?? "render failed"}`, "error");
});

/* The log sink broadcasts the fully FORMATTED line ("12:34:56.789 [error] audio: ..."),
   not a message — that framing is noise in a toast. The subsystem ("audio: ") stays: it is
   the only context most of these lines carry. */
const LOG_LINE_PREFIX_RE = /^\d{2}:\d{2}:\d{2}\.\d{3} \[\w+ *\] */;
const ERROR_TOAST_DEDUPE_MS = 4000;
let lastErrorToast: { key: string; at: number } = { key: "", at: 0 };

ws.on("event/log", (ev) => {
  useStore.setState((s) => {
    const logLines = s.logLines.length >= MAX_LOG_LINES
      ? [...s.logLines.slice(s.logLines.length - MAX_LOG_LINES + 1), ev]
      : [...s.logLines, ev];
    return { logLines };
  });
  // nothing renders logLines, so an error the engine reports (device fault, driver fallback)
  // would otherwise be invisible. Errors only — warns are far too chatty to toast.
  if (ev.level !== "error") return;
  const msg = ev.msg.replace(LOG_LINE_PREFIX_RE, "");
  // One fault, one toast: a device fault arrives twice (DriverManager both Log::error's it
  // and broadcasts its own event/log), the two wordings differing only in punctuation — so
  // the repeat key ignores everything but the letters and digits.
  const key = msg.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const now = Date.now();
  if (key === lastErrorToast.key && now - lastErrorToast.at < ERROR_TOAST_DEDUPE_MS) return;
  lastErrorToast = { key, at: now };
  showToast(msg, "error");
});
