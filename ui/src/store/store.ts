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
  bottomTab: BottomTab;
  /** Dock tabs currently popped out into separate browser windows (portal-rendered). */
  poppedOut: Partial<Record<PoppedOutTab, boolean>>;
}

export interface DialogsState {
  settings: boolean;
  export: boolean;
  /** Keyboard-shortcut cheat sheet ("?" key / Help menu) */
  shortcuts: boolean;
  /** Command palette (Ctrl+K / Help menu) — run any command, jump to bar/marker/track */
  palette: boolean;
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

  /* recent warn/error log lines (event/log), capped */
  logLines: LogEvent[];

  /* ui state */
  selection: Selection;
  tool: Tool;
  viewport: Viewport;
  /** pane under the last pointerdown — keyboard shortcuts (G/H zoom, edit actions) route here first */
  focusedPane: FocusedPane;
  /** timeline page-jump auto-scroll keeping the playhead in view (the "J" shortcut toggles it) */
  followPlayhead: boolean;
  panels: PanelsState;
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
  setViewport(patch: Partial<Viewport>): void;
  setFocusedPane(pane: FocusedPane): void;
  setFollowPlayhead(on: boolean): void;
  setPanels(patch: Partial<PanelsState>): void;
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
  ...loadPref<Omit<PanelsState, "poppedOut" | "minimap" | "agent">>(
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
const prefTool = loadPref<Tool>("ui.tool", "select", oneOf("select", "draw", "erase", "split"));
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
  logLines: [],

  selection: { trackIds: [], clipIds: [], noteIds: [] },
  tool: prefTool,
  viewport: prefViewport,
  focusedPane: "timeline",
  followPlayhead: prefFollowPlayhead,
  panels: prefPanels,
  activeMidiClipId: null,
  activeAudioClipId: null,
  dialogs: { settings: false, export: false, shortcuts: false, palette: false, recreatePlugins: false, roomView: false, pluginEditors: [], recovery: null },

  setProject: (project) => set({ project }),
  setEngineStatus: (engineStatus) => set({ engineStatus }),
  setRegistry: (registry) => set({ registry }),
  setMidiInputs: (midiInputs) => set({ midiInputs }),
  setAudioDevices: (audioDevices) => set({ audioDevices }),
  setSelection: (patch) => set((s) => ({ selection: { ...s.selection, ...patch } })),
  clearSelection: () => set({ selection: { trackIds: [], clipIds: [], noteIds: [] } }),
  setTool: (tool) => set({ tool }),
  setViewport: (patch) => set((s) => ({ viewport: { ...s.viewport, ...patch } })),
  // fired on EVERY pointerdown in a pane — return the same state when unchanged so
  // zustand skips the notify (no re-render per click)
  setFocusedPane: (focusedPane) =>
    set((s) => (s.focusedPane === focusedPane ? s : { ...s, focusedPane })),
  setFollowPlayhead: (followPlayhead) => set({ followPlayhead }),
  setPanels: (patch) => set((s) => ({ panels: { ...s.panels, ...patch } })),
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

/* Persist the restored slices back on every change (drag-driven ones debounced).
   Field-compare against prev so unrelated store updates cost one pointer check. */
useStore.subscribe((s, prev) => {
  if (s.viewport !== prev.viewport) savePrefDebounced("ui.viewport", s.viewport);
  if (s.panels !== prev.panels) {
    const { browser, browserTab, inspector, bottomTab, minimap, agent } = s.panels;
    savePrefDebounced("ui.panels", { browser, browserTab, inspector, bottomTab });
    savePrefDebounced("ui.panels.minimap", minimap);
    savePrefDebounced("ui.panels.agent", agent);
  }
  if (s.tool !== prev.tool) savePref("ui.tool", s.tool);
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
    });
    reconcileMetronome(r.metronome); // seed the metronome mirror (optional field)
    reconcileAutomationWrite(r.automationWrite);
    reconcileMidiMaps(r.midiMaps);
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

ws.on("event/log", (ev) => {
  useStore.setState((s) => {
    const logLines = s.logLines.length >= MAX_LOG_LINES
      ? [...s.logLines.slice(s.logLines.length - MAX_LOG_LINES + 1), ev]
      : [...s.logLines, ev];
    return { logLines };
  });
});
