/**
 * MyDAW WebSocket protocol + project model mirror.
 *
 * EXACT TypeScript mirror of docs/SPEC.md §5 (WebSocket protocol) and §6 (project format).
 * This file is the contract for every UI module — do not rename fields or message strings.
 *
 * Conventions (SPEC §4): ids are uint64 (number here; safe for monotonically increasing ids),
 * musical positions are `double beats` (quarter notes), audio offsets are `int64 samples`.
 */

/* ============================================================================
 * §6 — Project model
 * ========================================================================= */

/** tempoMap entry — v1: single entry at beat 0 (SPEC §6). */
export interface TempoPoint {
  beat: number;
  bpm: number;
}

/** timeSigMap entry — bar is 1-based; v1: single entry (SPEC §6). */
export interface TimeSigEntry {
  bar: number;
  num: number;
  den: number;
}

export interface LoopRegion {
  startBeat: number;
  endBeat: number;
  enabled: boolean;
}

/**
 * Grid settings. `division` is in beats. Snapping uses `division` and `triplet`;
 * `swing` (0..1) is for quantize only (cmd/notes.quantize).
 */
export interface Grid {
  division: number;
  snap: boolean;
  triplet: boolean;
  swing: number;
}

export interface Marker {
  id: number;
  beat: number;
  name: string;
  color?: string;
}

export interface Asset {
  id: number;
  /** project-folder-relative path, e.g. "audio/rec-1.wav" */
  file: string;
  originalPath?: string;
  sampleRate: number;
  channels: number;
  lengthSamples: number;
  missing?: boolean;
}

export type PluginFormat = "vst2" | "vst3" | "builtin";
export type Bitness = 32 | 64;

export interface PluginInstance {
  instanceId: number;
  /** vst2: decimal uniqueID string; vst3: class GUID string (SPEC §5.6). */
  uid: string;
  format: PluginFormat;
  path: string;
  bitness: Bitness;
  name: string;
  bypass: boolean;
  /** engine-side mix 0..1 */
  wetDry: number;
  /** plugin-states/<instanceId>.bin */
  stateFile?: string;
  paramValues?: Record<string, number>;
  /** sampler: bound audio asset id (0/absent = none) */
  sampleAssetId?: number;
  /** built-in compressor sidechain: source track id whose signal keys the detector (0/absent = self) */
  sidechainSource?: number;
}

export interface Note {
  id: number;
  /** 0..127 */
  pitch: number;
  /** 1..127 */
  velocity: number;
  /** relative to clip start, beats */
  startBeat: number;
  lengthBeats: number;
  /** default 0 */
  channel?: number;
}

/**
 * MIDI continuous-controller point on a MidiClip (kept sorted by (controller, beat)).
 * controller: 0..127 = MIDI CC number; 128 = pitch bend (value 0..1, 0.5 = center,
 * sent as 14-bit); 129 = channel aftertouch. beat is CLIP-RELATIVE; value is
 * normalized 0..1 (CC sent as round(value*127)).
 */
export interface MidiCc {
  id: number;
  controller: number;
  beat: number;
  value: number;
}

export interface AudioClip {
  id: number;
  type: "audio";
  name: string;
  startBeat: number;
  assetId: number;
  srcOffsetSamples: number;
  lengthSamples: number;
  /** linear gain */
  gain: number;
  fadeInSec: number;
  fadeOutSec: number;
  muted?: boolean;
  color?: string;
}

export interface MidiClip {
  id: number;
  type: "midi";
  name: string;
  startBeat: number;
  lengthBeats: number;
  muted?: boolean;
  color?: string;
  notes: Note[];
  /** CC / pitch-bend / aftertouch points (optional, [] default). */
  cc?: MidiCc[];
}

/** Discriminated union on `type`. */
export type Clip = AudioClip | MidiClip;

export function isAudioClip(c: Clip): c is AudioClip {
  return c.type === "audio";
}
export function isMidiClip(c: Clip): c is MidiClip {
  return c.type === "midi";
}

/* ---- comping: take folders (SPEC §6) ---- */
export interface TakeLane {
  id: number;
  name: string;
  clips: Clip[];
}
export interface CompSegment {
  /** plays from here until the next segment's startBeat (or the folder end) */
  startBeat: number;
  /** index into TakeFolder.lanes; -1 = silent gap */
  lane: number;
}
export interface TakeFolder {
  id: number;
  name: string;
  startBeat: number;
  endBeat: number;
  lanes: TakeLane[];
  /** sorted by startBeat; empty ⇒ lane 0 for the whole span */
  comp: CompSegment[];
}

/**
 * Cubase-style track version (alternative playlist). The ACTIVE version's material lives
 * in Track.clips/Track.takeFolders as always — the entry whose id === Track.activeVersionId
 * is a name-only placeholder; only inactive entries carry parked clips/takeFolders.
 */
export interface TrackVersion {
  id: number;
  name: string;
  clips: Clip[];
  takeFolders: TakeFolder[];
}

export interface Send {
  destTrackId: number;
  level: number;
  pre: boolean;
  enabled: boolean;
}

export interface AutomationPoint {
  id: number;
  beat: number;
  value: number;
  /** curve bend -1..1 (SPEC §6) */
  curve?: number;
}

/**
 * paramRef: "volume" | "pan" | "send:<index>" | "plugin:<instanceId>:<paramId>" (SPEC §5.3)
 */
export interface AutomationLane {
  paramRef: string;
  points: AutomationPoint[];
}

/**
 * Per-track parametric channel EQ band (SPEC §6 track.eq).
 * type enum (FIXED): 0=peak(bell), 1=lowShelf, 2=highShelf, 3=highCut(lowpass),
 * 4=lowCut(highpass), 5=notch. gainDb is ignored for cut/notch types.
 * Ranges: freqHz 20..20000, gainDb -24..+24, q 0.1..18.
 */
export interface EqBand {
  enabled: boolean;
  /** 0=peak | 1=lowShelf | 2=highShelf | 3=highCut | 4=lowCut | 5=notch */
  type: number;
  freqHz: number;
  gainDb: number;
  q: number;
}

/** Track channel EQ. Empty bands OR bypass=true => no processing. */
export interface TrackEq {
  bypass: boolean;
  bands: EqBand[];
}

export type TrackKind = "audio" | "midi" | "instrument" | "folder" | "bus" | "master";
/** kinds creatable via cmd/track.add */
export type AddableTrackKind = Exclude<TrackKind, "master">;

/** trackId of a bus, or "master", or "none" */
export type OutputTarget = number | "master" | "none";

export interface Track {
  id: number;
  kind: TrackKind;
  name: string;
  color: string;
  height?: number;
  /** folder parent */
  parentId?: number;
  channels: 1 | 2;
  /** linear, 1 = 0 dB */
  volume: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  recordArm: boolean;
  monitor?: boolean;
  inputDevice?: string;
  inputChannel?: number;
  outputTarget: OutputTarget;
  /**
   * MIDI routing (kind "midi" only): id of an Instrument-kind track that receives this
   * track's MIDI — one shared plugin instance for N midi tracks. Absent/0 = none, the
   * track plays through its own inserts (SPEC §6).
   */
  midiTarget?: number;
  /** VCA-group membership (0/absent = none); the VCA's gain multiplies this track's fader. */
  vcaId?: number;
  /** Channel EQ — absent/empty bands and not bypassed => no EQ (SPEC §6). */
  eq?: TrackEq;
  frozen?: boolean;
  frozenAssetId?: number;
  inserts: PluginInstance[];
  sends: Send[];
  automation: AutomationLane[];
  clips: Clip[];
  /** comping: stacked takes + per-segment comp selection (optional, absent = none). */
  takeFolders?: TakeFolder[];
  /** track versions (optional, absent = feature not engaged on this track). */
  versions?: TrackVersion[];
  /** id of the active version; present iff versions is non-empty. */
  activeVersionId?: number;
}

/** Hardware CC → param mapping (SPEC §5.2). paramRef: "track:<id>:volume|pan" | "plugin:<id>:<pid>". */
export interface MidiMap {
  cc: number;
  channel: number;
  paramRef: string;
}
export interface MidiMapsState {
  maps: MidiMap[];
  /** paramRef currently armed for learn (the next CC binds to it), or null. */
  armed: string | null;
}

/** VCA control-group fader (SPEC §6): gain multiplies the fader of every member track. */
export interface Vca {
  id: number;
  name: string;
  /** linear, 1 = 0 dB */
  gain: number;
}

/** opaque to engine (SPEC §6) */
export interface ProjectUiState {
  zoomX?: number;
  zoomY?: number;
  scrollX?: number;
  scrollY?: number;
  [key: string]: unknown;
}

export interface Project {
  formatVersion: 1;
  name: string;
  sampleRate: number;
  tempoMap: TempoPoint[];
  timeSigMap: TimeSigEntry[];
  loop: LoopRegion;
  grid: Grid;
  markers: Marker[];
  /** ordered, tree via parentId (folders) */
  tracks: Track[];
  /** kind: "master" */
  masterTrack: Track;
  assets: Asset[];
  /** VCA control-group faders (absent on older engines). */
  vcas?: Vca[];
  nextId: number;
  ui?: ProjectUiState;
}

/* ============================================================================
 * §5.6 — Plugin registry / params / presets
 * ========================================================================= */

export interface PluginInfo {
  uid: string;
  format: PluginFormat;
  path: string;
  bitness: Bitness;
  name: string;
  vendor: string;
  category: string;
  isInstrument: boolean;
  numInputs: number;
  numOutputs: number;
  blacklisted?: boolean;
  blacklistReason?: string;
}

export interface PluginParam {
  id: number;
  name: string;
  /** units */
  label: string;
  /** normalized 0..1 */
  value: number;
  defaultValue: number;
  /** discrete step count, if stepped */
  steps?: number;
  valueText: string;
}

export interface PluginPreset {
  /** vst2 program index (number) or preset id string for state-snapshot presets */
  id: number | string;
  name: string;
}

export type PluginRuntimeState =
  | "ok"
  | "loading"
  | "crashed"
  | "timeout"
  | "restarting"
  | "failed";

/* ============================================================================
 * §5.4 — Engine / devices / transport
 * ========================================================================= */

export type DriverType = "wasapi" | "asio";

export interface DeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  maxInputs: number;
  maxOutputs: number;
  sampleRates: number[];
}

export interface DriverInfo {
  type: DriverType;
  available: boolean;
  /** present when unavailable, e.g. "build without ASIO SDK" */
  reason?: string;
  devices: DeviceInfo[];
}

export interface EngineStatus {
  running: boolean;
  driver: string;
  device: string;
  sampleRate: number;
  bufferSize: number;
  latencyMs: number;
  xruns: number;
  cpuPercent: number;
  pdcSamples: number;
}

export type TransportState = "stopped" | "playing" | "recording";

/**
 * Engine metronome state (pinned wire contract): carried by the session/hello reply,
 * by event/transport payloads, and by every transport/* reply. OPTIONAL everywhere —
 * older engines omit it and the UI's local mirror then stands.
 */
export interface MetronomeState {
  enabled: boolean;
  countInBars: number;
}

/* ============================================================================
 * §5 — Envelopes
 * ========================================================================= */

export interface WsErrorInfo {
  code: string;
  message: string;
}

export interface ClientEnvelope {
  id: number;
  type: string;
  payload: unknown;
  /** transient = apply to model+audio, no undo entry, no projectChanged broadcast (SPEC §5) */
  transient?: boolean;
}

export interface ReplyOkEnvelope {
  replyTo: number;
  ok: true;
  payload: unknown;
}

export interface ReplyErrEnvelope {
  replyTo: number;
  ok: false;
  error: WsErrorInfo;
}

export type ReplyEnvelope = ReplyOkEnvelope | ReplyErrEnvelope;

export interface EventEnvelope {
  type: string;
  payload: unknown;
}

export type ServerEnvelope = ReplyEnvelope | EventEnvelope;

/** Replies/requests with no defined payload. */
export type EmptyObject = Record<string, never>;

/* ============================================================================
 * §5.1 — Session & project payloads
 * ========================================================================= */

export interface HelloRequest {
  clientName: string;
}

export interface HelloEngineInfo {
  version: string;
  sampleRate: number;
  blockSize: number;
  driver: string;
  latencyMs: number;
  asioAvailable: boolean;
  vst3Available: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
  mtime: number;
}

export interface MidiInputInfo {
  // NOTE(spec): SPEC writes {id,name}; id is a string for stability across reorders.
  id: string;
  name: string;
  /** present in midi/getInputs reply */
  enabled?: boolean;
}

export interface GetDevicesReply {
  drivers: DriverInfo[];
}

export interface HelloReply {
  engine: HelloEngineInfo;
  project: Project;
  pluginRegistry: PluginInfo[];
  recentProjects: RecentProject[];
  /** same shape as engine/getDevices reply */
  audioDevices: GetDevicesReply;
  midiInputs: MidiInputInfo[];
  /** authoritative metronome state — absent on older engines */
  metronome?: MetronomeState;
  /** automation-write arm — absent on older engines */
  automationWrite?: boolean;
  /** MIDI control-surface maps + learn-arm — absent on older engines */
  midiMaps?: MidiMapsState;
}

export interface ProjectLoadRequest {
  path: string;
}

export interface ProjectSaveAsRequest {
  /** Omit together with auto:true — the engine picks Documents\MyDAW Projects\<name>. */
  path?: string;
  /** True = engine-picked default location (silent auto-save before load/import). */
  auto?: boolean;
}

export interface ProjectSaveAsReply {
  /** project.json path inside the (possibly engine-picked) project folder. */
  path: string;
  project: Project;
}

export interface ProjectLoadRecentRequest {
  path: string;
}

/** Replies carry {project} on load/new (SPEC §5.1); recover behaves like load. */
export interface ProjectReply {
  project: Project;
}

/**
 * importForeign also reports content the provider recognized but could not import.
 * project/load and project/loadRecent re-run the importer for foreign paths (.cpr),
 * so their replies carry the same optional field.
 */
export interface ProjectImportForeignReply extends ProjectReply {
  warnings?: string[];
}

export interface RecoveryInfoReply {
  available: boolean;
  // NOTE(spec): meaningful only when available === true.
  autosavePath?: string;
  mtime?: number;
}

export interface DialogPathReply {
  path: string | null;
}

export interface DialogPathsReply {
  paths: string[] | null;
}

/** One foreign-project import provider (engine ImportProviderRegistry). */
export interface ImportFormatInfo {
  /** stable lowercase id, e.g. "smf" */
  id: string;
  /** e.g. "Standard MIDI File" */
  name: string;
  /** lowercase, no dot, e.g. ["mid","midi"] */
  extensions: string[];
}

export interface GetImportFormatsReply {
  formats: ImportFormatInfo[];
}

/** Errors: "no_provider" | "import_failed". Reply carries {project}; adoption ≙ project/load. */
export interface ProjectImportForeignRequest {
  path: string;
}

/* ============================================================================
 * §5.2 — Track commands
 * ========================================================================= */

export interface TrackAddRequest {
  kind: AddableTrackKind;
  name?: string;
  index?: number;
  channels?: 1 | 2;
}

export interface TrackAddReply {
  track: Track;
}

export interface TrackRemoveRequest {
  trackId: number;
}

export interface TrackReorderRequest {
  trackId: number;
  newIndex: number;
  parentId?: number;
}

export interface TrackPatch {
  name?: string;
  color?: string;
  height?: number;
  volume?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  recordArm?: boolean;
  monitor?: boolean;
  inputDevice?: string;
  inputChannel?: number;
  outputTarget?: OutputTarget;
  /** kind "midi" only — Instrument-track id to route this track's MIDI into; 0 clears. */
  midiTarget?: number;
  /** VCA-group id this track belongs to; 0 clears. */
  vcaId?: number;
}

export interface TrackSetRequest {
  trackId: number;
  patch: TrackPatch;
}

/**
 * Channel-EQ patch. `bands` (when present) REPLACES the whole band list; omit it to
 * change only `bypass`. Transient-aware (knob/slider drags) like cmd/track.set.
 */
export interface TrackEqPatch {
  bypass?: boolean;
  bands?: EqBand[];
}

export interface TrackSetEqRequest {
  trackId: number;
  patch: TrackEqPatch;
}

export interface TrackAddSendRequest {
  trackId: number;
  destTrackId: number;
  level?: number;
  pre?: boolean;
}

export interface TrackRemoveSendRequest {
  trackId: number;
  sendIndex: number;
}

export interface SendPatch {
  level?: number;
  pre?: boolean;
  enabled?: boolean;
}

export interface TrackSetSendRequest {
  trackId: number;
  sendIndex: number;
  patch: SendPatch;
}

/* §5.5 bounce/freeze */
export interface TrackBounceRequest {
  trackId: number;
  freeze?: boolean;
}

export interface TrackBounceReply {
  // NOTE(spec): reply payload unspecified in SPEC; the resulting asset arrives via
  // event/projectChanged. assetId provided here if the engine includes it.
  assetId?: number;
}

export interface TrackUnfreezeRequest {
  trackId: number;
}

export interface TrackDuplicateRequest {
  trackId: number;
}

/** The freshly created copy (inserted right after the source track). */
export interface TrackDuplicateReply {
  track: Track;
}

/* ============================================================================
 * §5.3 — Clips, notes, automation, arrangement
 * ========================================================================= */

export interface ClipAddMidiRequest {
  trackId: number;
  startBeat: number;
  lengthBeats: number;
  /* U2 extension (pinned): optional initial content/props — used by clipboard paste
   * and duplicate-like flows to reconstruct a clip in one command. */
  notes?: NoteInput[];
  name?: string;
  color?: string;
}

export interface ClipAddMidiReply {
  clip: MidiClip;
}

export interface ClipAddAudioRequest {
  trackId: number;
  startBeat: number;
  assetId: number;
  /* U2 extension (pinned): optional initial props — used by clipboard paste flows. */
  name?: string;
  color?: string;
  gain?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  srcOffsetSamples?: number;
  lengthSamples?: number;
}

export interface ClipAddAudioReply {
  clip: AudioClip;
}

export interface ClipMoveRequest {
  clipIds: number[];
  deltaBeats: number;
  targetTrackId?: number;
}

export type ClipEdge = "l" | "r";

/** audio: trims srcOffset/len; no stretch in v1 (SPEC §5.3) */
export interface ClipResizeRequest {
  clipId: number;
  edge: ClipEdge;
  newStartBeat?: number;
  newLengthBeats?: number;
}

export interface ClipSplitRequest {
  clipIds: number[];
  atBeat: number;
}

export interface ClipSplitReply {
  newClipIds: number[];
}

/** midi only in v1; audio join only if contiguous same-asset */
export interface ClipJoinRequest {
  clipIds: number[];
}

export interface ClipJoinReply {
  clip: Clip;
}

export interface ClipDeleteRequest {
  clipIds: number[];
}

export interface ClipDuplicateRequest {
  clipIds: number[];
}

export interface ClipDuplicateReply {
  clips: Clip[];
}

export interface ClipPatch {
  name?: string;
  color?: string;
  gain?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  muted?: boolean;
}

export interface ClipSetRequest {
  clipId: number;
  patch: ClipPatch;
}

/** Note to add — id optional (engine assigns; negative temp ids allowed for optimistic UI). */
export interface NoteInput {
  id?: number;
  pitch: number;
  velocity: number;
  startBeat: number;
  lengthBeats: number;
  channel?: number;
}

export interface NotePatch {
  pitch?: number;
  velocity?: number;
  startBeat?: number;
  lengthBeats?: number;
  channel?: number;
}

export interface NoteUpdate {
  noteId: number;
  patch: NotePatch;
}

/** One undo entry (SPEC §5.3). Missing arrays are treated as empty. */
export interface NotesEditRequest {
  clipId: number;
  add?: NoteInput[];
  remove?: number[];
  update?: NoteUpdate[];
}

/** CC point to add — the engine assigns the id. */
export interface CcInput {
  controller: number;
  beat: number;
  value: number;
}

export interface CcPatch {
  beat?: number;
  value?: number;
}

export interface CcUpdate {
  ccId: number;
  patch: CcPatch;
}

/** One undo entry for the whole batch (mirrors cmd/notes.edit); granular clip scope. */
export interface CcEditRequest {
  clipId: number;
  add?: CcInput[];
  remove?: number[];
  update?: CcUpdate[];
}

export interface NotesQuantizeRequest {
  clipId: number;
  noteIds?: number[];
  /** grid in beats */
  grid: number;
  /** 0..1 */
  strength: number;
  /** 0..1 */
  swing: number;
}

/** add-point shape per SPEC §5.3: {t, v, curve?} (t = beat, v = value). */
export interface AutomationAddPoint {
  t: number;
  v: number;
  curve?: number;
}

// NOTE(spec): point patch uses the stored point field names of §6 ({beat,value,curve}).
export interface AutomationPointPatch {
  beat?: number;
  value?: number;
  curve?: number;
}

export interface AutomationPointUpdate {
  pointId: number;
  patch: AutomationPointPatch;
}

/**
 * A span of musical time given either in beats or in 1-BASED bars (what the ruler shows
 * and what people say). Bars are converted engine-side against the time-signature map,
 * so a meter change mid-project cannot silently skew the result.
 */
export interface AutomationSpan {
  fromBeat?: number;
  toBeat?: number;
  fromBar?: number;
  toBar?: number;
}

export interface AutomationRampRequest extends AutomationSpan {
  trackId: number;
  /** "volume" | "pan" | "send:<index>" | "plugin:<instanceId>:<paramId>" */
  paramRef: string;
  fromValue: number;
  toValue: number;
  /** Bend, -1..1 (0 = linear). */
  curve?: number;
  /** 0/1 = a plain two-point ramp; >1 writes that many intermediate points. */
  steps?: number;
  /** Clear existing points inside the span first (default true). */
  replaceRange?: boolean;
}

export interface AutomationClearRequest extends AutomationSpan {
  trackId: number;
  paramRef: string;
}

export interface AutomationGetTargetsRequest {
  trackId: number;
  /** Case-insensitive substring filter over target names, e.g. "cutoff". */
  match?: string;
}

/** One automatable target, with the paramRef to pass to the automation commands. */
export interface AutomationTarget {
  paramRef: string;
  name: string;
  /** "track" | "send" | "plugin" */
  kind: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
  plugin?: string;
  paramName?: string;
  instanceId?: number;
  paramId?: number;
  valueText?: string;
  /** "live" = names from the running plugin; "model" = ids only (plugin not loaded). */
  source?: string;
  note?: string;
}

export interface AutomationTargetsReply {
  trackId: number;
  trackName?: string;
  targets: AutomationTarget[];
}

export interface AutomationSetRequest {
  trackId: number;
  /** "volume" | "pan" | "send:<index>" | "plugin:<instanceId>:<paramId>" */
  paramRef: string;
  add?: AutomationAddPoint[];
  remove?: number[];
  update?: AutomationPointUpdate[];
}

export interface MarkerAddRequest {
  beat: number;
  name: string;
}

export interface MarkerAddReply {
  // NOTE(spec): reply payload unspecified; marker also arrives via event/projectChanged.
  marker?: Marker;
}

export interface MarkerPatch {
  beat?: number;
  name?: string;
  color?: string;
}

export interface MarkerSetRequest {
  markerId: number;
  patch: MarkerPatch;
}

export interface MarkerRemoveRequest {
  markerId: number;
}

export interface TempoSetRequest {
  bpm: number;
}

export interface TimeSigSetRequest {
  num: number;
  den: number;
}

/**
 * Full tempo-map replace — undoable; engine validates (>=1 entry, first beat == 0,
 * sorted ascending, bpm clamped 20..400) and re-derives loop/transport.
 */
export interface TempoMapSetRequest {
  entries: TempoPoint[];
}

/** Full time-signature-map replace — first bar == 0, num 1..32, den in {1,2,4,8,16,32}. */
export interface TimeSigMapSetRequest {
  entries: TimeSigEntry[];
}

export interface LoopSetRequest {
  startBeat: number;
  endBeat: number;
  enabled: boolean;
}

/** Patch semantics — omitted fields keep their current value (SPEC §5.3). */
export interface GridSetRequest {
  division?: number;
  snap?: boolean;
  triplet?: boolean;
  swing?: number;
}

/** Reply also triggers a full event/projectChanged (SPEC §5.3). */
export interface UndoRedoReply {
  label: string;
}

/* ============================================================================
 * §5.4 — Transport & engine payloads
 * ========================================================================= */

export interface TransportLocateRequest {
  beat: number;
}

export interface SetMetronomeRequest {
  enabled: boolean;
  countInBars?: 0 | 1 | 2;
}

/** Every transport/* reply echoes the authoritative metronome + automation-write state. */
export interface TransportReply {
  metronome?: MetronomeState;
  automationWrite?: boolean;
}

export interface SetAudioConfigRequest {
  driver: DriverType;
  deviceId: string;
  sampleRate: number;
  bufferSize: number;
  exclusive?: boolean;
}

export interface SetAudioConfigReply {
  actual: {
    sampleRate: number;
    bufferSize: number;
    latencyMs: number;
  };
}

export interface GetLogRequest {
  tail?: number;
}

export interface GetLogReply {
  lines: string[];
}

/* ============================================================================
 * §5.5 — Recording & media payloads
 * ========================================================================= */

export interface MidiGetInputsReply {
  inputs: Array<MidiInputInfo & { enabled: boolean }>;
}

export interface MidiSetInputEnabledRequest {
  id: string;
  enabled: boolean;
}

/**
 * Live note audition — NOT undoable, no projectChanged; injected into the track's
 * live MIDI path (audible while stopped, regardless of arm).
 */
export interface MidiPreviewRequest {
  trackId: number;
  /** 0..127 */
  pitch: number;
  /** 1..127 */
  velocity: number;
  on: boolean;
}

/**
 * Live-MIDI thru follows the UI's track SELECTION (spec 2026-07-22): these tracks
 * (plus explicit per-track monitor toggles) play the hardware keyboard; arming is
 * for recording and does NOT imply thru. Multi-selection layers instruments.
 */
export interface MidiSetThruTracksRequest {
  trackIds: number[];
}

export interface MediaImportRequest {
  paths: string[];
  trackId?: number;
  atBeat?: number;
}

/** midi files may create tracks (SPEC §5.5). */
export interface MediaImportReply {
  assets: Asset[];
  clips: Clip[];
  tracks: Track[];
}

export interface MediaRelinkRequest {
  assetId: number;
  newPath: string;
}

export interface ExportFormat {
  /** "wav" (PCM) or an encoded codec (Media Foundation). */
  type: "wav" | "mp3" | "flac" | "m4a" | "aac";
  /** WAV only: 16 | 24 (PCM, TPDF dither) | 32 (float). */
  bitDepth: 16 | 24 | 32;
  /** Lossy (mp3/m4a) target bitrate in kbps (64..320, default 320). */
  kbps?: number;
}

export interface ExportRenderRequest {
  /** if no path, engine shows native save dialog */
  path?: string;
  startBeat: number;
  endBeat: number;
  format: ExportFormat;
  /** peak-normalize to 0 dBFS (ignored when loudnessTarget is set). */
  normalize?: boolean;
  /** integrated-loudness target in LUFS (e.g. -14); scales the export to hit it. */
  loudnessTarget?: number;
}

export interface ExportRenderReply {
  path: string;
  seconds: number;
  /** codec actually written (wav|mp3|flac|m4a). */
  format?: string;
  /** measured integrated loudness (BS.1770) of the written signal, LUFS. */
  lufs?: number;
  /** measured peak of the written signal, dBFS. */
  peakDb?: number;
}

/** SMF export — if no path, the engine shows a native save dialog (*.mid). */
export interface ExportMidiRequest {
  path?: string;
}

export interface ExportMidiReply {
  path: string;
}

/** Cubase Track Archive export — if no path, the engine shows a native save dialog (*.xml). */
export interface ExportTrackArchiveRequest {
  path?: string;
}

export interface ExportTrackArchiveReply {
  path: string;
  /** Non-fatal export caveats (inferred XML constructs, skipped clips/sends/inserts). */
  warnings: string[];
}

/** Cubase .cpr project export — if no path, the engine shows a native save dialog (*.cpr). */
export interface ExportCprRequest {
  path?: string;
}

export interface ExportCprReply {
  path: string;
  /** Non-fatal export caveats (skipped audio tracks/plugins/sends, multi-tempo). */
  warnings: string[];
}

/* ============================================================================
 * §5.6 — Plugin payloads
 * ========================================================================= */

export interface PluginsScanRequest {
  full?: boolean;
}

/** `started` is false when a scan was already running (this request started nothing). */
export interface PluginsScanReply {
  started: boolean;
}

export interface PluginsRegistryReply {
  registry: PluginInfo[];
}

export interface PluginsFolders {
  vst2: string[];
  vst3: string[];
}

export interface PluginsUnblacklistRequest {
  uid: string;
}

/**
 * Manual disable (plugin manager page). Path is the blacklist's primary key; uid alone
 * also works for registry rows with real uids. At least one must be present.
 */
export interface PluginsBlacklistRequest {
  uid?: string;
  path?: string;
  reason?: string;
}

/**
 * Recreate-plugins flow (pinned wire contract). An insert is "unresolved" when it exists
 * in the project model with NO live host instance (typical after Import Project).
 */
export interface UnresolvedPlugin {
  instanceId: number;
  name: string;
  uid: string;
  format: PluginFormat;
  bitness: number;
  version?: string;
  trackId: number;
  trackName: string;
  slotIndex: number;
  hasState: boolean;
  inRegistry: boolean;
  /** Pinned wire contract (optional): provenance of the imported insert,
   *  e.g. "Cubase 5.1.1 project, 2009; 32-bit era". */
  source?: string;
  /**
   * Present only when !inRegistry: registry plugins the engine considers usable
   * stand-ins — fuzzy name matches across format/bitness/channel-config-suffix
   * (Waves "stereo2stereo" etc.), else an in-spirit built-in. Sorted best-first.
   */
  suggestions?: PluginSuggestion[];
}

export interface PluginSuggestion {
  uid: string;
  name: string;
  format: PluginFormat;
  bitness: number;
  /** 0..100-ish similarity (name-based; 20 = in-spirit category stand-in). */
  score: number;
}

export interface GetUnresolvedPluginsReply {
  plugins: UnresolvedPlugin[];
}

/** Cubase-style destructive Audio→Process on an audio clip's span (new edit asset). */
export type ClipProcessAudioOp =
  | "gain"
  | "normalize"
  | "fadeIn"
  | "fadeOut"
  | "reverse"
  | "invert"
  | "silence"
  | "dcRemove";

export interface ClipProcessAudioRequest {
  clipId: number;
  op: ClipProcessAudioOp;
  /** op "gain": dB to apply (−48..48). */
  gainDb?: number;
  /** op "normalize": peak target in dBFS (default −1). */
  targetDb?: number;
}

/** Omitted instanceIds = recreate ALL unresolved inserts. */
export interface PluginsRecreateRequest {
  instanceIds?: number[];
  /**
   * Recreate these inserts as a DIFFERENT registry plugin (uid from `suggestions` or
   * any registry uid). Saved state carries over only within the same format.
   */
  substitutions?: Array<{ instanceId: number; uid: string }>;
}

export interface PluginRecreateResult {
  instanceId: number;
  ok: boolean;
  error?: string;
}

/**
 * Reply to plugins/recreate. Mutates the model on success (path/bitness/name refreshed
 * from the registry), goes through the command pipeline (undoable, broadcasts
 * event/projectChanged).
 */
export interface PluginsRecreateReply {
  results: PluginRecreateResult[];
}

export interface PluginAddRequest {
  trackId: number;
  uid: string;
  index?: number;
  /** existing instanceId to clone settings/state from (mixer Alt+drag copy) */
  copyFrom?: number;
}

export interface PluginAddReply {
  instance: PluginInstance;
}

export interface PluginRemoveRequest {
  trackId: number;
  instanceId: number;
}

export interface PluginMoveRequest {
  trackId: number;
  instanceId: number;
  /** same-channel: post-removal reorder index; with destTrackId: insertion index there */
  newIndex: number;
  /** move the insert to this channel instead (same live instance — state preserved) */
  destTrackId?: number;
}

export interface PluginSetPatch {
  bypass?: boolean;
  /** engine-side mix 0..1 */
  wetDry?: number;
  /** built-in compressor: source track id to key the sidechain detector (0 = none/self) */
  sidechainSource?: number;
}

export interface PluginSetRequest {
  instanceId: number;
  patch: PluginSetPatch;
}

/** normalized 0..1; use transient while dragging (SPEC §5.6) */
export interface PluginSetParamRequest {
  instanceId: number;
  paramId: number;
  value: number;
}

export interface PluginGetParamsRequest {
  instanceId: number;
}

export interface PluginGetParamsReply {
  params: PluginParam[];
  /** Pinned wire contract: true when the plugin has a native editor window
   *  (plugin/openEditor works). Absent on older engines — treat as unknown. */
  hasEditor?: boolean;
}

export interface PluginGetPresetsRequest {
  instanceId: number;
}

export interface PluginGetPresetsReply {
  presets: PluginPreset[];
}

export interface PluginLoadPresetRequest {
  instanceId: number;
  id: number | string;
}

export interface PluginSavePresetRequest {
  instanceId: number;
  name: string;
}

export interface PluginOpenEditorRequest {
  instanceId: number;
}

export interface PluginCloseEditorRequest {
  instanceId: number;
}

/* ============================================================================
 * §5.7 — Settings
 * ========================================================================= */

/** App settings persisted to %APPDATA%/MyDAW/settings.json. Open-ended by design. */
export interface AppSettings {
  autosaveMinutes?: number;
  theme?: string;
  [key: string]: unknown;
}

export interface SettingsSetRequest {
  patch: Partial<AppSettings>;
}

/* ============================================================================
 * §5.8 + §5.x — Event payloads
 * ========================================================================= */

export type ProjectChangedScope = "project" | "track" | "clip" | "mixer";

/**
 * State sync (SPEC §5.8). Engine is authoritative. Undo/redo/load/recover always send
 * scope:"project", full:<Project>. UI applies granular updates when present, else replaces.
 */
export interface ProjectChangedEvent {
  revision: number;
  scope: ProjectChangedScope;
  full?: Project;
  tracks?: Track[];
  clips?: Array<{ trackId: number; clip: Clip }>;
  removedTrackIds?: number[];
  removedClipIds?: number[];
}

export interface DirtyEvent {
  dirty: boolean;
}

/** ~20 Hz while playing + on change (SPEC §5.4). */
export interface TransportEvent {
  state: TransportState;
  beat: number;
  timeSec: number;
  loop: LoopRegion;
  /** authoritative metronome state — absent on older engines */
  metronome?: MetronomeState;
  /** automation-write arm — absent on older engines */
  automationWrite?: boolean;
}

/** [peakL, peakR, rmsL, rmsR], linear 0..~1.4 */
export type MeterValues = [number, number, number, number];

/** ~15 Hz (SPEC §5.4). Keys of `tracks` are trackIds as strings (JSON). */
export interface MetersEvent {
  tracks: Record<string, MeterValues>;
  master: MeterValues;
}

export interface MidiActivityEvent {
  deviceId: string;
  trackId?: number;
}

/** A note in an in-progress recording take (clip-relative beats; live-growing). */
export interface RecordingNote {
  pitch: number;
  startBeat: number;
  lengthBeats: number;
  velocity: number;
}

/** event/recordingNotes — throttled (~15 Hz) snapshot of the current MIDI take, for
 *  drawing the growing take rectangle + live notes on the timeline while recording. */
export interface RecordingNotesEvent {
  /** Absolute timeline beat where the take began. */
  startBeat: number;
  /** Take length so far in beats (playhead − startBeat). */
  lengthBeats: number;
  /** Armed MIDI/instrument track ids the take is mirrored onto. */
  trackIds: number[];
  notes: RecordingNote[];
}

export interface ImportProgressEvent {
  path: string;
  pct: number;
}

export interface ExportProgressEvent {
  pct: number;
}

export interface ScanProgressEvent {
  current: number;
  total: number;
  path: string;
  found: number;
}

export interface ScanDoneEvent {
  registry: PluginInfo[];
}

export interface PluginParamsEvent {
  instanceId: number;
  /** edits from native editor */
  changed: Array<{ id: number; value: number; valueText: string }>;
}

/**
 * Hosted-plugin creation progress (project load / import auto-recreate / Recreate
 * Plugins) — drives the Cubase-style loading modal. `current` is 1-based and covers
 * ATTEMPTED creations (failures advance it too); a final {done:true} closes the run.
 */
export interface PluginLoadProgressEvent {
  current: number;
  total: number;
  /** plugin display name currently being created ("" on the done event) */
  name: string;
  done: boolean;
}

/** UI must surface a clear error indicator on the insert slot (SPEC §5.6). */
export interface PluginStateEvent {
  instanceId: number;
  state: PluginRuntimeState;
  message?: string;
  restartCount: number;
}

export type LogLevel = "info" | "warn" | "error";

/** warn+error only are broadcast (SPEC §5.7). */
export interface LogEvent {
  level: LogLevel;
  msg: string;
}

/* ============================================================================
 * Request map — every client→engine message with its req/reply payload types.
 * `ws.request(type, payload)` is fully typed through this map.
 * ========================================================================= */

export interface RequestMap {
  // §5.1 session & project
  "session/hello": { req: HelloRequest; reply: HelloReply };
  "session/newWindow": { req: EmptyObject; reply: { url: string; port: number } };
  "project/new": { req: EmptyObject; reply: ProjectReply };
  "project/load": { req: ProjectLoadRequest; reply: ProjectImportForeignReply };
  "project/save": { req: EmptyObject; reply: EmptyObject };
  "project/saveAs": { req: ProjectSaveAsRequest; reply: ProjectSaveAsReply };
  "project/loadRecent": { req: ProjectLoadRecentRequest; reply: ProjectImportForeignReply };
  "project/recoveryInfo": { req: EmptyObject; reply: RecoveryInfoReply };
  "project/recover": { req: EmptyObject; reply: ProjectReply };
  "project/getImportFormats": { req: EmptyObject; reply: GetImportFormatsReply };
  "project/importForeign": { req: ProjectImportForeignRequest; reply: ProjectImportForeignReply };
  "project/getUnresolvedPlugins": { req: EmptyObject; reply: GetUnresolvedPluginsReply };
  "dialog/saveProject": { req: EmptyObject; reply: DialogPathReply };
  "dialog/openProject": { req: EmptyObject; reply: DialogPathReply };
  "dialog/importProject": { req: EmptyObject; reply: DialogPathReply };
  "dialog/importFiles": { req: EmptyObject; reply: DialogPathsReply };

  // §5.2 tracks
  "cmd/track.add": { req: TrackAddRequest; reply: TrackAddReply };
  "cmd/track.remove": { req: TrackRemoveRequest; reply: EmptyObject };
  "cmd/track.reorder": { req: TrackReorderRequest; reply: EmptyObject };
  "cmd/track.set": { req: TrackSetRequest; reply: EmptyObject };
  "cmd/track.setEq": { req: TrackSetEqRequest; reply: EmptyObject };
  "cmd/track.addSend": { req: TrackAddSendRequest; reply: EmptyObject };
  "cmd/track.removeSend": { req: TrackRemoveSendRequest; reply: EmptyObject };
  "cmd/track.setSend": { req: TrackSetSendRequest; reply: EmptyObject };
  "cmd/track.bounce": { req: TrackBounceRequest; reply: TrackBounceReply };
  "cmd/track.unfreeze": { req: TrackUnfreezeRequest; reply: EmptyObject };
  "cmd/track.duplicate": { req: TrackDuplicateRequest; reply: TrackDuplicateReply };

  // §5.3 clips / notes / automation / arrangement
  "cmd/clip.addMidi": { req: ClipAddMidiRequest; reply: ClipAddMidiReply };
  "cmd/clip.addAudio": { req: ClipAddAudioRequest; reply: ClipAddAudioReply };
  "cmd/clip.move": { req: ClipMoveRequest; reply: EmptyObject };
  "cmd/clip.resize": { req: ClipResizeRequest; reply: EmptyObject };
  "cmd/clip.split": { req: ClipSplitRequest; reply: ClipSplitReply };
  "cmd/clip.join": { req: ClipJoinRequest; reply: ClipJoinReply };
  "cmd/clip.delete": { req: ClipDeleteRequest; reply: EmptyObject };
  "cmd/clip.duplicate": { req: ClipDuplicateRequest; reply: ClipDuplicateReply };
  "cmd/clip.set": { req: ClipSetRequest; reply: EmptyObject };
  "cmd/notes.edit": { req: NotesEditRequest; reply: EmptyObject };
  "cmd/notes.quantize": { req: NotesQuantizeRequest; reply: EmptyObject };
  "cmd/cc.edit": { req: CcEditRequest; reply: EmptyObject };
  "cmd/automation.set": { req: AutomationSetRequest; reply: EmptyObject };
  "cmd/automation.ramp": { req: AutomationRampRequest; reply: EmptyObject };
  "cmd/automation.clear": { req: AutomationClearRequest; reply: EmptyObject };
  "automation/getTargets": { req: AutomationGetTargetsRequest; reply: AutomationTargetsReply };
  "cmd/marker.add": { req: MarkerAddRequest; reply: MarkerAddReply };
  "cmd/marker.set": { req: MarkerSetRequest; reply: EmptyObject };
  "cmd/marker.remove": { req: MarkerRemoveRequest; reply: EmptyObject };
  "cmd/tempo.set": { req: TempoSetRequest; reply: EmptyObject };
  "cmd/timesig.set": { req: TimeSigSetRequest; reply: EmptyObject };
  "cmd/tempoMap.set": { req: TempoMapSetRequest; reply: EmptyObject };
  "cmd/timeSigMap.set": { req: TimeSigMapSetRequest; reply: EmptyObject };
  "cmd/loop.set": { req: LoopSetRequest; reply: EmptyObject };
  "cmd/grid.set": { req: GridSetRequest; reply: EmptyObject };
  "edit/undo": { req: EmptyObject; reply: UndoRedoReply };
  "edit/redo": { req: EmptyObject; reply: UndoRedoReply };

  // §5.4 transport & engine (replies carry the optional metronome echo)
  "transport/play": { req: EmptyObject; reply: TransportReply };
  "transport/stop": { req: EmptyObject; reply: TransportReply };
  "transport/pause": { req: EmptyObject; reply: TransportReply };
  "transport/record": { req: EmptyObject; reply: TransportReply };
  "transport/locate": { req: TransportLocateRequest; reply: TransportReply };
  "transport/setMetronome": { req: SetMetronomeRequest; reply: TransportReply };
  "transport/setAutomationWrite": { req: { enabled: boolean }; reply: TransportReply };
  "engine/getDevices": { req: EmptyObject; reply: GetDevicesReply };
  "engine/setAudioConfig": { req: SetAudioConfigRequest; reply: SetAudioConfigReply };
  "engine/getStatus": { req: EmptyObject; reply: EngineStatus };
  "engine/panic": { req: EmptyObject; reply: EmptyObject };
  "engine/getLog": { req: GetLogRequest; reply: GetLogReply };

  // §5.5 recording & media
  "midi/getInputs": { req: EmptyObject; reply: MidiGetInputsReply };
  "midi/setInputEnabled": { req: MidiSetInputEnabledRequest; reply: EmptyObject };
  "midi/preview": { req: MidiPreviewRequest; reply: EmptyObject };
  "midi/setThruTracks": { req: MidiSetThruTracksRequest; reply: EmptyObject };
  "media/import": { req: MediaImportRequest; reply: MediaImportReply };
  "media/relink": { req: MediaRelinkRequest; reply: EmptyObject };
  "export/render": { req: ExportRenderRequest; reply: ExportRenderReply };
  "export/midi": { req: ExportMidiRequest; reply: ExportMidiReply };
  "export/trackArchive": { req: ExportTrackArchiveRequest; reply: ExportTrackArchiveReply };
  "export/cpr": { req: ExportCprRequest; reply: ExportCprReply };

  // §5.6 plugins
  "plugins/scan": { req: PluginsScanRequest; reply: PluginsScanReply };
  "plugins/getRegistry": { req: EmptyObject; reply: PluginsRegistryReply };
  "plugins/setFolders": { req: PluginsFolders; reply: PluginsFolders };
  "plugins/getFolders": { req: EmptyObject; reply: PluginsFolders };
  "plugins/getDefaultFolders": { req: EmptyObject; reply: PluginsFolders };
  "plugins/unblacklist": { req: PluginsUnblacklistRequest; reply: EmptyObject };
  "plugins/blacklist": { req: PluginsBlacklistRequest; reply: { added: boolean } };
  "plugins/recreate": { req: PluginsRecreateRequest; reply: PluginsRecreateReply };
  "cmd/plugin.add": { req: PluginAddRequest; reply: PluginAddReply };
  "cmd/plugin.remove": { req: PluginRemoveRequest; reply: EmptyObject };
  "cmd/plugin.move": { req: PluginMoveRequest; reply: EmptyObject };
  "cmd/plugin.set": { req: PluginSetRequest; reply: EmptyObject };
  "cmd/plugin.setParam": { req: PluginSetParamRequest; reply: EmptyObject };
  "cmd/plugin.setSample": { req: { instanceId: number; assetId: number }; reply: EmptyObject };
  "cmd/vca.add": { req: { name?: string }; reply: { vca: Vca } };
  "cmd/vca.remove": { req: { id: number }; reply: EmptyObject };
  "cmd/vca.set": { req: { id: number; patch: { gain?: number; name?: string } }; reply: EmptyObject };
  "cmd/clip.stretch": { req: { clipId: number; ratio: number; transpose?: boolean }; reply: { assetId: number; lengthSamples: number } };
  "cmd/clip.processAudio": { req: ClipProcessAudioRequest; reply: { assetId: number } };
  "cmd/take.create": { req: { trackId: number; clipIds: number[]; name?: string }; reply: { folder: TakeFolder } };
  "cmd/take.setComp": { req: { trackId: number; folderId: number; activeLane?: number; comp?: CompSegment[] }; reply: EmptyObject };
  "cmd/take.flatten": { req: { trackId: number; folderId: number }; reply: { clipIds: number[] } };
  "cmd/version.add": { req: { trackId: number; name?: string; copy?: boolean }; reply: { versionId: number; track: Track } };
  "cmd/version.switch": { req: { trackId: number; versionId: number }; reply: { track: Track } };
  "cmd/version.rename": { req: { trackId: number; versionId: number; name: string }; reply: EmptyObject };
  "cmd/version.delete": { req: { trackId: number; versionId: number }; reply: EmptyObject };
  "midimap/learn": { req: { paramRef: string }; reply: MidiMapsState };
  "midimap/remove": { req: { paramRef: string }; reply: MidiMapsState };
  "midimap/feedCc": { req: { cc: number; channel?: number; value: number }; reply: EmptyObject };
  "plugin/getParams": { req: PluginGetParamsRequest; reply: PluginGetParamsReply };
  "plugin/getPresets": { req: PluginGetPresetsRequest; reply: PluginGetPresetsReply };
  "plugin/loadPreset": { req: PluginLoadPresetRequest; reply: EmptyObject };
  "plugin/savePreset": { req: PluginSavePresetRequest; reply: EmptyObject };
  "plugin/openEditor": { req: PluginOpenEditorRequest; reply: EmptyObject };
  "plugin/closeEditor": { req: PluginCloseEditorRequest; reply: EmptyObject };

  // §5.7 misc
  // NOTE(spec): SPEC §5.7 does not state the settings/get reply shape; pinned here as the
  // flat AppSettings object (NOT wrapped in {settings:{...}}) — E8's Api must reply flat.
  "settings/get": { req: EmptyObject; reply: AppSettings };
  "settings/set": { req: SettingsSetRequest; reply: EmptyObject };
}

export type RequestType = keyof RequestMap;
export type RequestPayload<K extends RequestType> = RequestMap[K]["req"];
export type ReplyPayload<K extends RequestType> = RequestMap[K]["reply"];

/** Open Recent list changed (save / save-as / import) — full replacement, newest first. */
export interface RecentProjectsEvent {
  recentProjects: RecentProject[];
}

/* ============================================================================
 * Event map — every engine→client event with its payload type.
 * ========================================================================= */

export interface EventMap {
  "event/projectChanged": ProjectChangedEvent;
  "event/dirty": DirtyEvent;
  "event/recentProjects": RecentProjectsEvent;
  "event/transport": TransportEvent;
  "event/meters": MetersEvent;
  "event/midiActivity": MidiActivityEvent;
  "event/recordingNotes": RecordingNotesEvent;
  "event/importProgress": ImportProgressEvent;
  "event/exportProgress": ExportProgressEvent;
  "event/scanProgress": ScanProgressEvent;
  "event/scanDone": ScanDoneEvent;
  "event/pluginLoadProgress": PluginLoadProgressEvent;
  "event/pluginParams": PluginParamsEvent;
  "event/pluginState": PluginStateEvent;
  "event/midiMaps": MidiMapsState;
  "event/log": LogEvent;
}

export type EventType = keyof EventMap;
export type EventPayload<K extends EventType> = EventMap[K];

/* ============================================================================
 * Message name constants — grouped, for discoverability and typo safety.
 * Every string is checked against RequestMap / EventMap via `satisfies`.
 * ========================================================================= */

export const SessionMsg = {
  hello: "session/hello",
} as const satisfies Record<string, RequestType>;

export const ProjectMsg = {
  new: "project/new",
  load: "project/load",
  save: "project/save",
  saveAs: "project/saveAs",
  loadRecent: "project/loadRecent",
  recoveryInfo: "project/recoveryInfo",
  recover: "project/recover",
  getImportFormats: "project/getImportFormats",
  importForeign: "project/importForeign",
  getUnresolvedPlugins: "project/getUnresolvedPlugins",
} as const satisfies Record<string, RequestType>;

export const DialogMsg = {
  saveProject: "dialog/saveProject",
  openProject: "dialog/openProject",
  importProject: "dialog/importProject",
  importFiles: "dialog/importFiles",
} as const satisfies Record<string, RequestType>;

export const TrackCmd = {
  add: "cmd/track.add",
  remove: "cmd/track.remove",
  reorder: "cmd/track.reorder",
  set: "cmd/track.set",
  setEq: "cmd/track.setEq",
  addSend: "cmd/track.addSend",
  removeSend: "cmd/track.removeSend",
  setSend: "cmd/track.setSend",
  bounce: "cmd/track.bounce",
  unfreeze: "cmd/track.unfreeze",
  duplicate: "cmd/track.duplicate",
} as const satisfies Record<string, RequestType>;

export const ClipCmd = {
  addMidi: "cmd/clip.addMidi",
  addAudio: "cmd/clip.addAudio",
  move: "cmd/clip.move",
  resize: "cmd/clip.resize",
  split: "cmd/clip.split",
  join: "cmd/clip.join",
  delete: "cmd/clip.delete",
  duplicate: "cmd/clip.duplicate",
  set: "cmd/clip.set",
} as const satisfies Record<string, RequestType>;

export const NotesCmd = {
  edit: "cmd/notes.edit",
  quantize: "cmd/notes.quantize",
} as const satisfies Record<string, RequestType>;

export const CcCmd = {
  edit: "cmd/cc.edit",
} as const satisfies Record<string, RequestType>;

export const AutomationCmd = {
  set: "cmd/automation.set",
  ramp: "cmd/automation.ramp",
  clear: "cmd/automation.clear",
  getTargets: "automation/getTargets",
} as const satisfies Record<string, RequestType>;

export const MarkerCmd = {
  add: "cmd/marker.add",
  set: "cmd/marker.set",
  remove: "cmd/marker.remove",
} as const satisfies Record<string, RequestType>;

export const ArrangeCmd = {
  tempoSet: "cmd/tempo.set",
  timesigSet: "cmd/timesig.set",
  tempoMapSet: "cmd/tempoMap.set",
  timeSigMapSet: "cmd/timeSigMap.set",
  loopSet: "cmd/loop.set",
  gridSet: "cmd/grid.set",
} as const satisfies Record<string, RequestType>;

export const EditMsg = {
  undo: "edit/undo",
  redo: "edit/redo",
} as const satisfies Record<string, RequestType>;

export const TransportMsg = {
  play: "transport/play",
  stop: "transport/stop",
  pause: "transport/pause",
  record: "transport/record",
  locate: "transport/locate",
  setMetronome: "transport/setMetronome",
} as const satisfies Record<string, RequestType>;

export const EngineMsg = {
  getDevices: "engine/getDevices",
  setAudioConfig: "engine/setAudioConfig",
  getStatus: "engine/getStatus",
  panic: "engine/panic",
  getLog: "engine/getLog",
} as const satisfies Record<string, RequestType>;

export const MidiMsg = {
  getInputs: "midi/getInputs",
  setInputEnabled: "midi/setInputEnabled",
  preview: "midi/preview",
} as const satisfies Record<string, RequestType>;

export const MediaMsg = {
  import: "media/import",
  relink: "media/relink",
} as const satisfies Record<string, RequestType>;

export const ExportMsg = {
  render: "export/render",
  midi: "export/midi",
  trackArchive: "export/trackArchive",
  cpr: "export/cpr",
} as const satisfies Record<string, RequestType>;

export const PluginsMsg = {
  scan: "plugins/scan",
  getRegistry: "plugins/getRegistry",
  setFolders: "plugins/setFolders",
  getFolders: "plugins/getFolders",
  getDefaultFolders: "plugins/getDefaultFolders",
  unblacklist: "plugins/unblacklist",
  blacklist: "plugins/blacklist",
  recreate: "plugins/recreate",
} as const satisfies Record<string, RequestType>;

export const PluginCmd = {
  add: "cmd/plugin.add",
  remove: "cmd/plugin.remove",
  move: "cmd/plugin.move",
  set: "cmd/plugin.set",
  setParam: "cmd/plugin.setParam",
} as const satisfies Record<string, RequestType>;

export const PluginMsg = {
  getParams: "plugin/getParams",
  getPresets: "plugin/getPresets",
  loadPreset: "plugin/loadPreset",
  savePreset: "plugin/savePreset",
  openEditor: "plugin/openEditor",
  closeEditor: "plugin/closeEditor",
} as const satisfies Record<string, RequestType>;

export const SettingsMsg = {
  get: "settings/get",
  set: "settings/set",
} as const satisfies Record<string, RequestType>;

export const Ev = {
  projectChanged: "event/projectChanged",
  dirty: "event/dirty",
  recentProjects: "event/recentProjects",
  transport: "event/transport",
  meters: "event/meters",
  midiActivity: "event/midiActivity",
  recordingNotes: "event/recordingNotes",
  importProgress: "event/importProgress",
  exportProgress: "event/exportProgress",
  scanProgress: "event/scanProgress",
  scanDone: "event/scanDone",
  pluginParams: "event/pluginParams",
  pluginState: "event/pluginState",
  log: "event/log",
} as const satisfies Record<string, EventType>;

/* ============================================================================
 * HTTP endpoints (SPEC §5.5)
 * ========================================================================= */

export const HttpApi = {
  /** POST multipart — same effect as media/import; reply body = MediaImportReply JSON. */
  upload: "/api/upload",
  /** GET binary peak data (§7 PeakFile format), cache forever. */
  peaks: (assetId: number, lod: number): string => `/api/peaks/${assetId}?lod=${lod}`,
} as const;

/** paramRef builders (SPEC §5.3). */
export const ParamRef = {
  volume: "volume",
  pan: "pan",
  send: (index: number): string => `send:${index}`,
  plugin: (instanceId: number, paramId: number): string => `plugin:${instanceId}:${paramId}`,
} as const;
