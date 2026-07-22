/**
 * Typed command senders — one thin wrapper per SPEC §5 client→engine message.
 * All wrappers return the typed reply promise from ws.request; state updates arrive via
 * event/projectChanged (engine is authoritative, SPEC §5.8), so wrappers do not mutate
 * the store except where a reply carries data worth caching (none do that here — callers
 * decide).
 *
 * Gesture helpers (bottom): transientParam / commitParam implement the SPEC §5 transient
 * drag pattern — send-while-drag with per-gesture coalescing (at most one in-flight
 * transient request per gesture key; newer values overwrite the queued one), then a final
 * non-transient commit that creates the undo entry and triggers projectChanged.
 */

import { ws } from "../protocol/ws";
import type {
  AddableTrackKind,
  AppSettings,
  AutomationAddPoint,
  AutomationPointUpdate,
  CcInput,
  CcUpdate,
  ClipEdge,
  ClipPatch,
  ClipProcessAudioOp,
  DriverType,
  ExportCprRequest,
  ExportMidiRequest,
  ExportRenderRequest,
  ExportTrackArchiveRequest,
  GridSetRequest,
  MarkerPatch,
  NoteInput,
  NoteUpdate,
  PluginSetPatch,
  ReplyPayload,
  RequestPayload,
  RequestType,
  SendPatch,
  SetAudioConfigRequest,
  TempoPoint,
  TimeSigEntry,
  TrackEqPatch,
  TrackPatch,
} from "../protocol/types";

/* ============================================================================
 * §5.1 — Session & project
 * ========================================================================= */

export const hello = (clientName = "MyDAW Browser UI") =>
  ws.request("session/hello", { clientName });

export const newProject = () => ws.request("project/new", {});
export const loadProject = (path: string) => ws.request("project/load", { path });
/** Fails with error code "no_path" if the project was never saved — then use dialogSaveProject. */
export const saveProject = () => ws.request("project/save", {});
export const saveProjectAs = (path: string) => ws.request("project/saveAs", { path });
/** Engine-picked location (Documents\MyDAW Projects\<name>) — silent pre-load/import save. */
export const autoSaveProjectAs = () => ws.request("project/saveAs", { auto: true });
export const loadRecentProject = (path: string) => ws.request("project/loadRecent", { path });
export const getRecoveryInfo = () => ws.request("project/recoveryInfo", {});
export const recoverProject = () => ws.request("project/recover", {});

/** Foreign-project import providers registered in the engine (id/name/extensions). */
export const getImportFormats = () => ws.request("project/getImportFormats", {});
/**
 * Import a foreign project file (e.g. .mid) as a NEW project — adoption semantics match
 * project/load (dirty, no save path). Errors: "no_provider" | "import_failed".
 */
export const importForeignProject = (path: string) =>
  ws.request("project/importForeign", { path });

/** Inserts in the model with NO live host instance (typical after Import Project). */
export const getUnresolvedPlugins = () => ws.request("project/getUnresolvedPlugins", {});

/** Native IFileDialog on the engine side; resolves {path|null} / {paths|null}. */
export const dialogSaveProject = () => ws.request("dialog/saveProject", {});
export const dialogOpenProject = () => ws.request("dialog/openProject", {});
export const dialogImportProject = () => ws.request("dialog/importProject", {});
export const dialogImportFiles = () => ws.request("dialog/importFiles", {});

/* ============================================================================
 * §5.2 — Tracks
 * ========================================================================= */

export const addTrack = (
  kind: AddableTrackKind,
  opts?: { name?: string; index?: number; channels?: 1 | 2 },
) => ws.request("cmd/track.add", { kind, ...opts });

export const removeTrack = (trackId: number) => ws.request("cmd/track.remove", { trackId });

export const reorderTrack = (trackId: number, newIndex: number, parentId?: number) =>
  ws.request("cmd/track.reorder", { trackId, newIndex, ...(parentId !== undefined ? { parentId } : {}) });

export const setTrack = (trackId: number, patch: TrackPatch, transient?: boolean) =>
  ws.request("cmd/track.set", { trackId, patch }, transient);

/**
 * Channel EQ. `patch.bands` (when present) REPLACES the whole band list. Use transient
 * while dragging an EQ knob/slider (prefer dragTrackEq/commitTrackEq below) so the engine
 * hears the change without an undo entry per frame; commit non-transiently on release.
 */
export const setTrackEq = (trackId: number, patch: TrackEqPatch, transient?: boolean) =>
  ws.request("cmd/track.setEq", { trackId, patch }, transient);

export const addSend = (trackId: number, destTrackId: number, level?: number, pre?: boolean) =>
  ws.request("cmd/track.addSend", { trackId, destTrackId, ...(level !== undefined ? { level } : {}), ...(pre !== undefined ? { pre } : {}) });

export const removeSend = (trackId: number, sendIndex: number) =>
  ws.request("cmd/track.removeSend", { trackId, sendIndex });

export const setSend = (trackId: number, sendIndex: number, patch: SendPatch, transient?: boolean) =>
  ws.request("cmd/track.setSend", { trackId, sendIndex, patch }, transient);

export const bounceTrack = (trackId: number, freeze?: boolean) =>
  ws.request("cmd/track.bounce", { trackId, ...(freeze !== undefined ? { freeze } : {}) });

export const unfreezeTrack = (trackId: number) => ws.request("cmd/track.unfreeze", { trackId });

/** Deep copy (clips, sends, automation, inserts incl. plugin state) inserted after the source. */
export const duplicateTrack = (trackId: number) => ws.request("cmd/track.duplicate", { trackId });

/* ============================================================================
 * §5.3 — Clips, notes, automation, arrangement
 * ========================================================================= */

export const addMidiClip = (trackId: number, startBeat: number, lengthBeats: number) =>
  ws.request("cmd/clip.addMidi", { trackId, startBeat, lengthBeats });

export const addAudioClip = (trackId: number, startBeat: number, assetId: number) =>
  ws.request("cmd/clip.addAudio", { trackId, startBeat, assetId });

export const moveClips = (clipIds: number[], deltaBeats: number, targetTrackId?: number) =>
  ws.request("cmd/clip.move", { clipIds, deltaBeats, ...(targetTrackId !== undefined ? { targetTrackId } : {}) });

export const resizeClip = (
  clipId: number,
  edge: ClipEdge,
  opts: { newStartBeat?: number; newLengthBeats?: number },
) => ws.request("cmd/clip.resize", { clipId, edge, ...opts });

export const splitClips = (clipIds: number[], atBeat: number) =>
  ws.request("cmd/clip.split", { clipIds, atBeat });

export const stretchClip = (clipId: number, ratio: number, transpose?: boolean) =>
  ws.request("cmd/clip.stretch", { clipId, ratio, ...(transpose ? { transpose: true } : {}) });

/** Destructive Audio→Process (Cubase-style): writes a new edit asset, repoints the clip. */
export const processAudioClip = (
  clipId: number,
  op: ClipProcessAudioOp,
  args?: { gainDb?: number; targetDb?: number },
) => ws.request("cmd/clip.processAudio", { clipId, op, ...args });

export const joinClips = (clipIds: number[]) => ws.request("cmd/clip.join", { clipIds });

export const deleteClips = (clipIds: number[]) => ws.request("cmd/clip.delete", { clipIds });

export const duplicateClips = (clipIds: number[]) =>
  ws.request("cmd/clip.duplicate", { clipIds });

export const setClip = (clipId: number, patch: ClipPatch, transient?: boolean) =>
  ws.request("cmd/clip.set", { clipId, patch }, transient);

/** One undo entry for the whole batch (SPEC §5.3). */
export const editNotes = (
  clipId: number,
  edits: { add?: NoteInput[]; remove?: number[]; update?: NoteUpdate[] },
) => ws.request("cmd/notes.edit", { clipId, ...edits });

/** CC/pitch-bend/aftertouch batch — one undo entry for the whole batch (mirrors notes.edit). */
export const editCc = (
  clipId: number,
  edits: { add?: CcInput[]; remove?: number[]; update?: CcUpdate[] },
) => ws.request("cmd/cc.edit", { clipId, ...edits });

export const quantizeNotes = (
  clipId: number,
  grid: number,
  strength: number,
  swing: number,
  noteIds?: number[],
) =>
  ws.request("cmd/notes.quantize", {
    clipId,
    grid,
    strength,
    swing,
    ...(noteIds !== undefined ? { noteIds } : {}),
  });

export const setAutomation = (
  trackId: number,
  paramRef: string,
  edits: { add?: AutomationAddPoint[]; remove?: number[]; update?: AutomationPointUpdate[] },
  transient?: boolean,
) => ws.request("cmd/automation.set", { trackId, paramRef, ...edits }, transient);

export const addMarker = (beat: number, name: string) =>
  ws.request("cmd/marker.add", { beat, name });

export const setMarker = (markerId: number, patch: MarkerPatch) =>
  ws.request("cmd/marker.set", { markerId, patch });

export const removeMarker = (markerId: number) =>
  ws.request("cmd/marker.remove", { markerId });

export const setTempo = (bpm: number, transient?: boolean) =>
  ws.request("cmd/tempo.set", { bpm }, transient);

export const setTimeSig = (num: number, den: number) =>
  ws.request("cmd/timesig.set", { num, den });

/** FULL tempo-map replace; engine validates (first beat 0, sorted, bpm 20..400). */
export const setTempoMap = (entries: TempoPoint[]) =>
  ws.request("cmd/tempoMap.set", { entries });

/** FULL time-signature-map replace; engine validates (first bar 0, num 1..32, den 1..32). */
export const setTimeSigMap = (entries: TimeSigEntry[]) =>
  ws.request("cmd/timeSigMap.set", { entries });

export const setLoop = (startBeat: number, endBeat: number, enabled: boolean, transient?: boolean) =>
  ws.request("cmd/loop.set", { startBeat, endBeat, enabled }, transient);

/** Persisted grid/snap settings — patch semantics, engine writes project.grid. */
export const setGrid = (patch: GridSetRequest, transient?: boolean) =>
  ws.request("cmd/grid.set", patch, transient);

/** Reply carries {label}; a full event/projectChanged follows (SPEC §5.3). */
export const undo = () => ws.request("edit/undo", {});
export const redo = () => ws.request("edit/redo", {});

/* ============================================================================
 * §5.4 — Transport & engine
 * ========================================================================= */

export const play = () => ws.request("transport/play", {});
/** stop at pos; second stop returns to start (SPEC §5.4) */
export const stop = () => ws.request("transport/stop", {});
export const pause = () => ws.request("transport/pause", {});
export const record = () => ws.request("transport/record", {});
export const locate = (beat: number) => ws.request("transport/locate", { beat });

export const setMetronome = (enabled: boolean, countInBars?: 0 | 1 | 2) =>
  ws.request("transport/setMetronome", {
    enabled,
    ...(countInBars !== undefined ? { countInBars } : {}),
  });

export const setAutomationWrite = (enabled: boolean) =>
  ws.request("transport/setAutomationWrite", { enabled });

export const getDevices = () => ws.request("engine/getDevices", {});

export const setAudioConfig = (cfg: {
  driver: DriverType;
  deviceId: string;
  sampleRate: number;
  bufferSize: number;
  exclusive?: boolean;
}) => ws.request("engine/setAudioConfig", cfg satisfies SetAudioConfigRequest);

export const getEngineStatus = () => ws.request("engine/getStatus", {});
export const panic = () => ws.request("engine/panic", {});
export const getLog = (tail?: number) =>
  ws.request("engine/getLog", tail !== undefined ? { tail } : {});

/* ============================================================================
 * §5.5 — Recording & media
 * ========================================================================= */

export const getMidiInputs = () => ws.request("midi/getInputs", {});

export const setMidiInputEnabled = (id: string, enabled: boolean) =>
  ws.request("midi/setInputEnabled", { id, enabled });

/** Live note audition — NOT undoable, no projectChanged; audible while stopped. */
/** Live-MIDI thru targets = the current track selection (spec 2026-07-22). */
export const setMidiThruTracks = (trackIds: number[]) =>
  ws.request("midi/setThruTracks", { trackIds });

export const previewNote = (trackId: number, pitch: number, velocity: number, on: boolean) =>
  ws.request("midi/preview", { trackId, pitch, velocity, on });

export const importMedia = (paths: string[], trackId?: number, atBeat?: number) =>
  ws.request("media/import", {
    paths,
    ...(trackId !== undefined ? { trackId } : {}),
    ...(atBeat !== undefined ? { atBeat } : {}),
  });

export const relinkAsset = (assetId: number, newPath: string) =>
  ws.request("media/relink", { assetId, newPath });

/** Offline render; if req.path is omitted the engine shows a native save dialog. */
export const renderExport = (req: ExportRenderRequest) => ws.request("export/render", req);

/** SMF export (fast, synchronous); if req.path is omitted the engine shows a native save dialog. */
export const exportMidi = (req: ExportMidiRequest = {}) => ws.request("export/midi", req);

/**
 * Cubase Track Archive XML export (File > Import > Track Archive on the Cubase side);
 * if req.path is omitted the engine shows a native save dialog. The reply carries
 * non-fatal warnings (inferred XML constructs, skipped clips/sends/inserts).
 */
export const exportTrackArchive = (req: ExportTrackArchiveRequest = {}) =>
  ws.request("export/trackArchive", req);

/**
 * Cubase .cpr project export (donor-splice writer — MIDI/Instrument tracks, notes,
 * faders/pans and tempo; validated to open in Cubase 5 and 13); if req.path is omitted
 * the engine shows a native save dialog. The reply carries non-fatal warnings (skipped
 * audio tracks/plugins/sends, multi-tempo).
 */
export const exportCpr = (req: ExportCprRequest = {}) => ws.request("export/cpr", req);

/* ============================================================================
 * §5.6 — Plugins
 * ========================================================================= */

export const scanPlugins = (full?: boolean) =>
  ws.request("plugins/scan", full !== undefined ? { full } : {});

export const getPluginRegistry = () => ws.request("plugins/getRegistry", {});

export const setPluginFolders = (vst2: string[], vst3: string[]) =>
  ws.request("plugins/setFolders", { vst2, vst3 });

export const getPluginFolders = () => ws.request("plugins/getFolders", {});

export const getDefaultPluginFolders = () => ws.request("plugins/getDefaultFolders", {});

export const unblacklistPlugin = (uid: string) => ws.request("plugins/unblacklist", { uid });

/** Manual disable (plugin manager): persists in the scanner blacklist until unblacklisted. */
export const blacklistPlugin = (path: string, uid?: string, reason?: string) =>
  ws.request("plugins/blacklist", {
    path,
    ...(uid ? { uid } : {}),
    ...(reason ? { reason } : {}),
  });

/**
 * Recreate unresolved inserts from the current registry — omitted instanceIds = ALL
 * unresolved. Undoable; the engine broadcasts event/projectChanged on success.
 */
export const recreatePlugins = (
  instanceIds?: number[],
  substitutions?: Array<{ instanceId: number; uid: string }>,
) =>
  ws.request("plugins/recreate", {
    ...(instanceIds !== undefined ? { instanceIds } : {}),
    ...(substitutions !== undefined && substitutions.length > 0 ? { substitutions } : {}),
  });

/** `copyFrom`: clone that instance's settings/state into the new one (Alt+drag copy). */
export const addPlugin = (trackId: number, uid: string, index?: number, copyFrom?: number) =>
  ws.request("cmd/plugin.add", {
    trackId,
    uid,
    ...(index !== undefined ? { index } : {}),
    ...(copyFrom !== undefined ? { copyFrom } : {}),
  });

export const removePlugin = (trackId: number, instanceId: number) =>
  ws.request("cmd/plugin.remove", { trackId, instanceId });

/**
 * Same channel: `newIndex` = post-removal reorder index. With `destTrackId`: move the
 * insert to that channel (same live instance, state preserved) at insertion index `newIndex`.
 */
export const movePlugin = (
  trackId: number,
  instanceId: number,
  newIndex: number,
  destTrackId?: number,
) =>
  ws.request("cmd/plugin.move", {
    trackId,
    instanceId,
    newIndex,
    ...(destTrackId !== undefined ? { destTrackId } : {}),
  });

export const setPlugin = (instanceId: number, patch: PluginSetPatch, transient?: boolean) =>
  ws.request("cmd/plugin.set", { instanceId, patch }, transient);

/** value normalized 0..1; while dragging prefer dragPluginParam/commitPluginParam below. */
export const setPluginParam = (instanceId: number, paramId: number, value: number, transient?: boolean) =>
  ws.request("cmd/plugin.setParam", { instanceId, paramId, value }, transient);

export const setPluginSample = (instanceId: number, assetId: number) =>
  ws.request("cmd/plugin.setSample", { instanceId, assetId });

export const midiLearn = (paramRef: string) => ws.request("midimap/learn", { paramRef });
export const midiUnlearn = (paramRef: string) => ws.request("midimap/remove", { paramRef });

export const addVca = (name?: string) => ws.request("cmd/vca.add", name ? { name } : {});
export const removeVca = (id: number) => ws.request("cmd/vca.remove", { id });
export const setVca = (id: number, patch: { gain?: number; name?: string }) =>
  ws.request("cmd/vca.set", { id, patch });
export const dragVcaGain = (id: number, gain: number) =>
  transientParam("cmd/vca.set", { id, patch: { gain } });
export const commitVcaGain = (id: number, gain: number) =>
  commitParam("cmd/vca.set", { id, patch: { gain } });

/* ---- comping (take folders) ---- */
export const createTakeFolder = (trackId: number, clipIds: number[], name?: string) =>
  ws.request("cmd/take.create", { trackId, clipIds, ...(name ? { name } : {}) });
/** Select one lane for the whole folder span. */
export const setTakeActiveLane = (trackId: number, folderId: number, activeLane: number) =>
  ws.request("cmd/take.setComp", { trackId, folderId, activeLane });
/** Set explicit per-segment comp boundaries (the swipe-comp result). */
export const setTakeComp = (
  trackId: number,
  folderId: number,
  comp: { startBeat: number; lane: number }[],
) => ws.request("cmd/take.setComp", { trackId, folderId, comp });
export const flattenTake = (trackId: number, folderId: number) =>
  ws.request("cmd/take.flatten", { trackId, folderId });

/* ---- track versions (alternative playlists) ---- */
/** Create a new version and switch to it; copy=true clones the current material. */
export const addTrackVersion = (trackId: number, opts?: { name?: string; copy?: boolean }) =>
  ws.request("cmd/version.add", { trackId, ...(opts?.name ? { name: opts.name } : {}), ...(opts?.copy ? { copy: true } : {}) });
export const switchTrackVersion = (trackId: number, versionId: number) =>
  ws.request("cmd/version.switch", { trackId, versionId });
export const renameTrackVersion = (trackId: number, versionId: number, name: string) =>
  ws.request("cmd/version.rename", { trackId, versionId, name });
export const deleteTrackVersion = (trackId: number, versionId: number) =>
  ws.request("cmd/version.delete", { trackId, versionId });

export const getPluginParams = (instanceId: number) =>
  ws.request("plugin/getParams", { instanceId });

export const getPluginPresets = (instanceId: number) =>
  ws.request("plugin/getPresets", { instanceId });

export const loadPluginPreset = (instanceId: number, id: number | string) =>
  ws.request("plugin/loadPreset", { instanceId, id });

export const savePluginPreset = (instanceId: number, name: string) =>
  ws.request("plugin/savePreset", { instanceId, name });

/** Opens the plugin's REAL native editor window on the engine machine (SPEC §5.6). */
export const openPluginEditor = (instanceId: number) =>
  ws.request("plugin/openEditor", { instanceId });

export const closePluginEditor = (instanceId: number) =>
  ws.request("plugin/closeEditor", { instanceId });

/* ============================================================================
 * §5.7 — Settings
 * ========================================================================= */

export const getSettings = () => ws.request("settings/get", {});
export const setSettings = (patch: Partial<AppSettings>) =>
  ws.request("settings/set", { patch });

/* ============================================================================
 * Gesture helpers — transient drag streams (SPEC §5 "transient")
 * ========================================================================= */

interface GestureSlot {
  // Latest unsent value while a transient request is in flight (coalesced).
  latest: { type: RequestType; payload: unknown } | null;
}

const gestures = new Map<string, GestureSlot>();

function gestureKey(type: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  // Patch-style commands (cmd/track.set, cmd/clip.set, ...) include WHICH fields are
  // being dragged, so two concurrent gestures on different params of the same object
  // (e.g. volume + pan) coalesce independently instead of dropping each other's frames.
  const patch = p.patch;
  const patchKeys =
    patch !== null && typeof patch === "object"
      ? Object.keys(patch as Record<string, unknown>).sort().join(",")
      : "";
  return [
    type,
    p.trackId ?? "",
    p.instanceId ?? "",
    p.paramId ?? "",
    p.sendIndex ?? "",
    p.clipId ?? "",
    p.markerId ?? "",
    p.paramRef ?? "",
    patchKeys,
  ].join("|");
}

async function pumpGesture(key: string, type: RequestType, payload: unknown): Promise<void> {
  let curType = type;
  let curPayload = payload;
  for (;;) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ws.request(curType, curPayload as any, true);
    } catch {
      // transient sends are fire-and-forget: drop errors (incl. not_connected mid-drag)
    }
    const slot = gestures.get(key);
    if (!slot || !slot.latest) break;
    curType = slot.latest.type;
    curPayload = slot.latest.payload;
    slot.latest = null;
  }
  gestures.delete(key);
}

/**
 * Send a value during a drag gesture. Transient envelope (no undo entry, no projectChanged).
 * Coalesces: while one transient request is in flight for this gesture, newer values replace
 * the queued one — the engine sees the freshest value without flooding.
 */
export function transientParam<K extends RequestType>(
  type: K,
  payload: RequestPayload<K>,
  key?: string,
): void {
  const k = key ?? gestureKey(type, payload);
  const slot = gestures.get(k);
  if (slot) {
    slot.latest = { type, payload };
    return;
  }
  gestures.set(k, { latest: null });
  void pumpGesture(k, type, payload);
}

/**
 * Final message of a gesture — sent WITHOUT transient so it lands on the undo stack and
 * triggers event/projectChanged. Drops any queued transient value for this gesture.
 */
export function commitParam<K extends RequestType>(
  type: K,
  payload: RequestPayload<K>,
  key?: string,
): Promise<ReplyPayload<K>> {
  const k = key ?? gestureKey(type, payload);
  const slot = gestures.get(k);
  if (slot) slot.latest = null; // final value wins; pump exits after its in-flight send
  return ws.request(type, payload, false);
}

/* Named conveniences for the most common drag gestures. */

export const dragTrack = (trackId: number, patch: TrackPatch) =>
  transientParam("cmd/track.set", { trackId, patch });
export const commitTrack = (trackId: number, patch: TrackPatch) =>
  commitParam("cmd/track.set", { trackId, patch });

/* EQ drags always carry the full band list in patch.bands, so the gesture key
 * (type|trackId|...|patchKeys) coalesces one EQ drag per track at a time. */
export const dragTrackEq = (trackId: number, patch: TrackEqPatch) =>
  transientParam("cmd/track.setEq", { trackId, patch });
export const commitTrackEq = (trackId: number, patch: TrackEqPatch) =>
  commitParam("cmd/track.setEq", { trackId, patch });

export const dragSend = (trackId: number, sendIndex: number, patch: SendPatch) =>
  transientParam("cmd/track.setSend", { trackId, sendIndex, patch });
export const commitSend = (trackId: number, sendIndex: number, patch: SendPatch) =>
  commitParam("cmd/track.setSend", { trackId, sendIndex, patch });

export const dragPluginParam = (instanceId: number, paramId: number, value: number) =>
  transientParam("cmd/plugin.setParam", { instanceId, paramId, value });
export const commitPluginParam = (instanceId: number, paramId: number, value: number) =>
  commitParam("cmd/plugin.setParam", { instanceId, paramId, value });
