/**
 * Global keyboard shortcut manager (owned by U2) — SPEC §9 key map.
 *
 * Default bindings (active unless an input/textarea/select/contentEditable element is
 * focused, or a context menu / modal is open — then this manager is fully inert):
 *
 *   Space                 play / stop
 *   R                     record
 *   C                     metronome on / off
 *   Numpad . / .          jump to project start
 *   Numpad Enter          start playback
 *   Numpad 0              stop
 *   Numpad *              arm the selected track(s), then record
 *   Numpad /              loop / cycle toggle
 *   Numpad 1 / 2          locate to loop start / end
 *   Ctrl+Z                undo
 *   Ctrl+Y / Ctrl+Shift+Z redo
 *   Ctrl+C / X / V        copy / cut / paste (lib/clipboard.ts; paste at playhead)
 *   Ctrl+D                duplicate selected clips (cmd/clip.duplicate)
 *   Delete / Backspace    delete selection (per focus context: notes or clips)
 *   Ctrl+S                save (no_path → native Save As flow)
 *   Ctrl+Shift+S          save as (always the native Save As flow)
 *   Ctrl+I                import project (.cpr / MIDI — paste-path dialog)
 *   B                     split selected clips at playhead
 *   Q                     quantize to grid — selected notes when the piano roll is
 *                         visible, else the selected MIDI clips (transport "Q" button)
 *   P                     loop/locators to selection (selected clips' bounds)
 *   F                     zoom to fit — selection if any, else all content (per pane)
 *   Arrows                edit the selection: timeline ←/→ nudge clips by a grid step
 *                         (Shift = bar); piano roll ←/→ move notes (Shift = fine ¼),
 *                         ↑/↓ transpose semitone (Shift = octave)
 *   M                     mute — selected TRACKS when only tracks are selected (group
 *                         toggle), else mute/unmute selected clips
 *   S                     solo/unsolo selected tracks (group toggle)
 *   L                     loop toggle
 *   J                     follow-playhead toggle (timeline page-jump auto-scroll)
 *   1 / 2 / 3 / 4         tool: select / draw / erase / split
 *   + / -                 nudge playhead forward / back by one grid step (1 beat when
 *                         snap is off); Numpad + / - too; key-repeat scrubs
 *   G / H                 zoom out / in (Cubase-style; more / less time fits) — routed
 *                         to the focused pane (piano roll / clip editor), else timeline
 *   Shift+G / Shift+H     vertical zoom out / in (track height / piano-roll rows)
 *   Home / End            locate project start / end
 *   Ctrl+A                select all (per focus context; default: all clips)
 *   Escape                clear selection (context may override, e.g. cancel a drag)
 *   ?                     keyboard-shortcut cheat sheet (Help menu)
 *
 * Focus contexts: panels register handlers via registerKeyContext(name, handlers).
 * Resolution order: store.focusedPane (set by pointerdown-capture on each pane root)
 * when its handlers are usable — bottom panes also need to be VISIBLE: dock tab active
 * or popped out into their own window (paneVisible) — then the open-tab heuristic
 * ("pianoRoll" → "clipEditor"), then "timeline". A context handler returning a falsy
 * value falls back to the default behaviour (clip-level clipboard / selection commands).
 *
 * Installed once from App via initKeyboard() — bubble-phase window listener, so any
 * component may stopPropagation()/preventDefault() on keydown to take precedence.
 * Menus reuse the same context-aware routing via invokeEditAction().
 */

import { useStore, transportBus } from "../store/store";
import type { FocusedPane, PanelsState, PoppedOutTab } from "../store/store";
import {
  deleteClips,
  duplicateClips,
  locate,
  play,
  quantizeNotes,
  record,
  redo,
  setLoop,
  splitClips,
  setClip,
  setTrack,
  stop,
  undo,
} from "../store/actions";
import { copySelection, cutSelection, findClipById, pasteAt } from "./clipboard";
import { toggleMetronome } from "../store/metronome";
import {
  importProjectFlow,
  saveProjectAsFlow,
  saveProjectFlow,
} from "../components/Transport/projectFlows";
import { closeContextMenu } from "../components/common/ContextMenu";
import {
  MAX_ZOOM_X,
  MAX_ZOOM_Y,
  MIN_ZOOM_X,
  MIN_ZOOM_Y,
} from "../components/Timeline/layout";
import { beatsToSeconds, gridStepBeats, secondsToBeats } from "./time";
import type { Project, Track } from "../protocol/types";
import { isMidiClip } from "../protocol/types";

/* ============================================================================
 * Focus-context registry
 * ========================================================================= */

export interface KeyContextHandlers {
  /** Delete the context's selection (e.g. notes in the piano roll). */
  deleteSelection?: () => void;
  /** Ctrl+A within the context. */
  selectAll?: () => void;
  /** Return true to consume; falsy → default clip-clipboard behaviour. */
  copy?: () => boolean | void;
  cut?: () => boolean | void;
  paste?: () => boolean | void;
  duplicate?: () => boolean | void;
  /** Return true to consume Escape (e.g. cancel an in-progress gesture). */
  escape?: () => boolean | void;
  /** G/H horizontal zoom by factor. Return true to consume; falsy → timeline viewport. */
  zoomH?: (factor: number) => boolean | void;
  /** Shift+G/H vertical zoom by factor. Return true to consume; falsy → timeline viewport. */
  zoomV?: (factor: number) => boolean | void;
  /**
   * Arrow-key edit on the selection. dx −1/+1 = left/right, dy −1/+1 = up/down,
   * big = Shift held (coarser: bar / octave — pane-defined). Return true to consume;
   * falsy → the arrows keep their default (nothing / native scroll).
   */
  nudge?: (dx: -1 | 0 | 1, dy: -1 | 0 | 1, big: boolean) => boolean | void;
  /** F — fit the selection (or all content) into view. Return true to consume. */
  zoomToFit?: () => boolean | void;
}

export type KeyContextName = "timeline" | "pianoRoll" | "clipEditor" | "sheetMusic";

const contexts = new Map<KeyContextName, KeyContextHandlers>();

/**
 * Register a panel's key handlers. Returns an unregister function (call it on unmount).
 * Re-registering the same name replaces the previous handlers.
 */
export function registerKeyContext(
  name: KeyContextName,
  handlers: KeyContextHandlers,
): () => void {
  contexts.set(name, handlers);
  return () => {
    if (contexts.get(name) === handlers) contexts.delete(name);
  };
}

/**
 * A bottom pane keeps its key routing while VISIBLE: its dock tab is active, or it is
 * popped out into its own window (popped panes render regardless of the active tab —
 * even with the dock closed — SPEC §9). Exported for the other tab gates with the same
 * semantics (pane key contexts, transport quantize) so they cannot drift.
 */
export function paneVisible(panels: PanelsState, tab: PoppedOutTab): boolean {
  return panels.bottomTab === tab || !!panels.poppedOut[tab];
}

/**
 * The pane keyboard shortcuts currently route to, as pure store state — the
 * name-level mirror of activeContext() below. activeContext() additionally requires
 * the handlers to be registered, but registration tracks mount/visibility, so this
 * store view matches in practice. Drives the focused-pane indicator (the accent
 * strip on the pane that owns Delete/Ctrl+A — UI_IMPROVE.md §6.4); keep the two
 * resolutions in the same order or the indicator lies.
 */
export function keyRoutingPane(s: {
  focusedPane: FocusedPane;
  panels: PanelsState;
}): KeyContextName {
  const f = s.focusedPane;
  if (f === "pianoRoll" || f === "clipEditor" || f === "sheetMusic") {
    if (paneVisible(s.panels, f)) return f;
  } else if (f === "timeline") {
    return "timeline";
  }
  if (s.panels.bottomTab === "pianoRoll") return "pianoRoll";
  if (s.panels.bottomTab === "clipEditor") return "clipEditor";
  return "timeline";
}

/**
 * store.focusedPane first (set by pointerdown-capture on each pane root), as long as
 * its handlers are usable — bottom panes also need to be visible (dock tab active or
 * popped out; a pane focused but since closed falls through). Then the legacy open-tab
 * heuristic (pianoRoll → clipEditor), then timeline. The mixer registers no key
 * context, so mixer focus resolves via the heuristic (its open tab is "mixer" →
 * timeline). The heuristic deliberately ignores popped-out panes: extending it would
 * silently reroute e.g. a mixer-focused Delete from clips to notes whenever a piano
 * roll happens to be popped out.
 */
function activeContext(): KeyContextHandlers | null {
  const s = useStore.getState();
  const tab = s.panels.bottomTab;
  const focused = s.focusedPane;
  if (focused === "pianoRoll" || focused === "clipEditor" || focused === "sheetMusic") {
    if (paneVisible(s.panels, focused)) {
      const c = contexts.get(focused);
      if (c) return c;
    }
  } else if (focused === "timeline") {
    const c = contexts.get("timeline");
    if (c) return c;
  }
  if (tab === "pianoRoll") {
    const c = contexts.get("pianoRoll");
    if (c) return c;
  }
  if (tab === "clipEditor") {
    const c = contexts.get("clipEditor");
    if (c) return c;
  }
  return contexts.get("timeline") ?? null;
}

/* ============================================================================
 * Inertness guards
 * ========================================================================= */

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** True when the user has a non-empty DOM text selection (e.g. highlighted chat text). */
function hasTextSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
}

/** True while a context menu or modal owns the keyboard. */
function uiBlocked(): boolean {
  const ctx = document.getElementById("mydaw-ctx-root");
  if (ctx && ctx.childElementCount > 0) return true;
  if (document.querySelector(".modal-overlay")) return true;
  return false;
}

/**
 * True when the ONLY thing blocking the keyboard is modal(s) that explicitly allow
 * transport keys through (data-transport-keys="allow", e.g. Room View) — the DAW should
 * keep playing/stopping/locating while such a window is open.
 */
function blockedButTransportAllowed(): boolean {
  const ctx = document.getElementById("mydaw-ctx-root");
  if (ctx && ctx.childElementCount > 0) return false; // an open menu really owns the keys
  const overlays = document.querySelectorAll<HTMLElement>(".modal-overlay");
  if (overlays.length === 0) return false;
  for (const o of overlays) if (o.dataset.transportKeys !== "allow") return false;
  return true;
}

/** Transport keys that stay live inside transport-friendly modals. */
function isTransportKey(e: KeyboardEvent): boolean {
  switch (e.code) {
    case "NumpadDecimal":
    case "NumpadEnter":
    case "Numpad0":
    case "NumpadMultiply":
    case "NumpadDivide":
    case "Numpad1":
    case "Numpad2":
    case "NumpadAdd":
    case "NumpadSubtract":
      return true;
    default:
      return e.key === " " || e.key === ".";
  }
}

/* ============================================================================
 * Default behaviours
 * ========================================================================= */

/** Numpad *: arm the selected armable track(s) that aren't armed yet before recording. */
function armSelectedTracks(): void {
  const s = useStore.getState();
  const p = s.project;
  if (!p) return;
  for (const id of s.selection.trackIds) {
    const t = p.tracks.find((tr) => tr.id === id);
    if (!t) continue;
    if (t.kind !== "audio" && t.kind !== "midi" && t.kind !== "instrument") continue;
    if (!t.recordArm) fire(setTrack(t.id, { recordArm: true }));
  }
}

const fire = (p: Promise<unknown>): void => {
  p.catch((e) => console.warn("[keyboard] command failed:", e));
};

function playheadBeat(): number {
  return transportBus.last?.beat ?? 0;
}

/** End beat of one clip (midi directly; audio via samples → seconds → beats). */
export function clipEndBeat(clip: Project["tracks"][number]["clips"][number], project: Project): number {
  if (isMidiClip(clip)) return clip.startBeat + clip.lengthBeats;
  const startSec = beatsToSeconds(clip.startBeat, project.tempoMap);
  const lenSec = project.sampleRate > 0 ? clip.lengthSamples / project.sampleRate : 0;
  return secondsToBeats(startSec + lenSec, project.tempoMap);
}

/** Last beat of any clip — End key target. */
export function projectEndBeat(project: Project): number {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const e = clipEndBeat(clip, project);
      if (e > end) end = e;
    }
  }
  return end;
}

/**
 * "P" — set the loop (locators) to the selected clips' bounds and enable it.
 * No clip selection → no-op (keeps the current loop).
 */
function loopToSelection(): void {
  const s = useStore.getState();
  const p = s.project;
  if (!p || s.selection.clipIds.length === 0) return;
  let start = Infinity;
  let end = 0;
  for (const id of s.selection.clipIds) {
    const found = findClipById(p, id);
    if (!found) continue;
    start = Math.min(start, found.clip.startBeat);
    end = Math.max(end, clipEndBeat(found.clip, p));
  }
  if (!Number.isFinite(start) || end <= start) return;
  fire(setLoop(start, end, true));
}

function defaultDelete(): void {
  const { selection } = useStore.getState();
  if (selection.clipIds.length > 0) fire(deleteClips(selection.clipIds));
}

function defaultSelectAll(): void {
  const s = useStore.getState();
  if (!s.project) return;
  const clipIds: number[] = [];
  for (const t of s.project.tracks) for (const c of t.clips) clipIds.push(c.id);
  s.setSelection({ clipIds, noteIds: [] });
}

function defaultDuplicate(): void {
  const { selection } = useStore.getState();
  if (selection.clipIds.length > 0) fire(duplicateClips(selection.clipIds));
}

function muteSelectedClips(): void {
  const s = useStore.getState();
  if (!s.project || s.selection.clipIds.length === 0) return;
  const found = s.selection.clipIds
    .map((id) => findClipById(s.project!, id))
    .filter((f): f is NonNullable<typeof f> => f !== null);
  if (found.length === 0) return;
  // Toggle as a group: if any selected clip is audible, mute all; else unmute all.
  const muteAll = found.some((f) => !f.clip.muted);
  for (const f of found) {
    if (Boolean(f.clip.muted) !== muteAll) fire(setClip(f.clip.id, { muted: muteAll }));
  }
}

/** Selected tracks resolved against the project (stale selection ids drop out). */
function selectedTracks(): Track[] {
  const s = useStore.getState();
  if (!s.project || s.selection.trackIds.length === 0) return [];
  const sel = new Set(s.selection.trackIds);
  return s.project.tracks.filter((t) => sel.has(t.id));
}

/** "S": group toggle — if ANY selected track is unsoloed, solo all; else unsolo all. */
function soloSelectedTracks(): void {
  const tracks = selectedTracks();
  if (tracks.length === 0) return;
  const solo = tracks.some((t) => !t.solo);
  for (const t of tracks) {
    if (t.solo !== solo) fire(setTrack(t.id, { solo }));
  }
}

/**
 * "Q" / transport Q button (PINNED name — TransportBar imports this): quantize the
 * piano roll's selected notes (or the whole active clip) when it is visible, else the
 * notes of every selected MIDI clip. Grid step/swing come from project.grid.
 */
export function quantizeSelection(): void {
  const s = useStore.getState();
  const p = s.project;
  if (!p) return;
  const step = gridStepBeats(p.grid);
  const swing = p.grid.swing;
  if (paneVisible(s.panels, "pianoRoll") && s.activeMidiClipId !== null) {
    fire(
      quantizeNotes(
        s.activeMidiClipId,
        step,
        1,
        swing,
        s.selection.noteIds.length > 0 ? s.selection.noteIds : undefined,
      ),
    );
    return;
  }
  for (const clipId of s.selection.clipIds) {
    const found = findClipById(p, clipId);
    if (found && isMidiClip(found.clip)) fire(quantizeNotes(found.clip.id, step, 1, swing));
  }
}

/** Track-mute group toggle (same semantics as solo). */
function muteSelectedTracks(tracks: Track[]): void {
  const mute = tracks.some((t) => !t.mute);
  for (const t of tracks) {
    if (t.mute !== mute) fire(setTrack(t.id, { mute }));
  }
}

/** Exported for the command palette's Transport group. */
export function toggleLoop(): void {
  const s = useStore.getState();
  const loop = s.project?.loop ?? s.transport.loop;
  fire(setLoop(loop.startBeat, loop.endBeat, !loop.enabled));
}

/**
 * +/- : nudge the playhead by one grid step (1 beat when snap is off). Key-repeat is
 * allowed (hold to scrub); the engine echo (~20 Hz) can lag the repeat rate, so recent
 * nudges accumulate from the last locally requested beat instead of transportBus.last.
 */
let nudgeBase: { beat: number; at: number } | null = null;

function nudgePlayhead(dir: 1 | -1): void {
  const grid = useStore.getState().project?.grid;
  const step = grid && grid.snap && grid.division > 0 ? gridStepBeats(grid) : 1;
  const now = performance.now();
  const base = nudgeBase && now - nudgeBase.at < 250 ? nudgeBase.beat : playheadBeat();
  const beat = Math.max(0, base + dir * step);
  nudgeBase = { beat, at: now };
  fire(locate(beat));
}

/**
 * Locate to an absolute beat from a non-nudge shortcut (Home/End/locator jumps).
 * Invalidates the nudge accumulator so a +/- within 250 ms of the previous nudge
 * re-bases on the new position instead of teleporting back to the stale pre-locate
 * beat. Every locate-style key MUST go through here (nudgePlayhead itself keeps
 * calling fire(locate()) directly so its own accumulation still works).
 */
function locateTo(beat: number): void {
  nudgeBase = null;
  fire(locate(beat));
}

/** G/H horizontal zoom — the focused pane's handler first, else the timeline viewport
 *  (clamps match Timeline/layout MIN/MAX_ZOOM_X). */
function zoomH(factor: number): void {
  if (activeContext()?.zoomH?.(factor)) return;
  const s = useStore.getState();
  const zoomX = Math.min(MAX_ZOOM_X, Math.max(MIN_ZOOM_X, s.viewport.zoomX * factor));
  if (zoomX !== s.viewport.zoomX) s.setViewport({ zoomX });
}

/** Shift+G/H vertical zoom — focused pane first, else track-height scale (layout
 *  MIN/MAX_ZOOM_Y, the vScaleOf domain). */
function zoomV(factor: number): void {
  if (activeContext()?.zoomV?.(factor)) return;
  const s = useStore.getState();
  const zoomY = Math.min(MAX_ZOOM_Y, Math.max(MIN_ZOOM_Y, s.viewport.zoomY * factor));
  if (zoomY !== s.viewport.zoomY) s.setViewport({ zoomY });
}

/* ============================================================================
 * Dispatcher
 * ========================================================================= */

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (isEditableTarget(e.target)) return;
  // Menus/modals own the keyboard (incl. their Esc) — except transport keys inside
  // modals that opt in (Room View): play/stop/locate must work in every view.
  if (uiBlocked() && !(blockedButTransportAllowed() && isTransportKey(e))) return;

  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const ctx = activeContext();
  const consume = () => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (ctrl && !e.altKey) {
    switch (key) {
      case "z":
        consume();
        if (e.repeat) return;
        fire(e.shiftKey ? redo() : undo());
        return;
      case "y":
        consume();
        if (e.repeat) return;
        fire(redo());
        return;
      case "s":
        consume();
        if (!e.repeat) void (e.shiftKey ? saveProjectAsFlow() : saveProjectFlow());
        return;
      case "c":
        if (e.repeat) return;
        // If the user has highlighted real text (e.g. in the agent chat), let the browser
        // copy it natively instead of copying the DAW clip/note selection.
        if (hasTextSelection()) return;
        consume();
        if (!ctx?.copy?.()) copySelection();
        return;
      case "x":
        if (e.repeat) return;
        consume();
        if (!ctx?.cut?.()) void cutSelection().catch((err) => console.warn("[keyboard] cut failed:", err));
        return;
      case "v":
        if (e.repeat) return;
        consume();
        if (!ctx?.paste?.()) void pasteAt().catch((err) => console.warn("[keyboard] paste failed:", err));
        return;
      case "d":
        if (e.repeat) return;
        consume();
        if (!ctx?.duplicate?.()) defaultDuplicate();
        return;
      case "a":
        consume();
        if (ctx?.selectAll) ctx.selectAll();
        else defaultSelectAll();
        return;
      case "k":
        // Command palette (UI_IMPROVE.md §7.1) — also Help → Command Palette.
        consume();
        if (!e.repeat) useStore.getState().setDialogs({ palette: true });
        return;
      case "i":
        // Ctrl+I = Import Project (.cpr / MIDI). Ctrl+Shift+I toggles the agent panel
        // (browser devtools may claim it; the toolbar icon and View menu remain reliable).
        consume();
        if (e.repeat) return;
        if (e.shiftKey) {
          const st = useStore.getState();
          st.setPanels({ agent: !st.panels.agent });
        } else {
          importProjectFlow();
        }
        return;
      default:
        return;
    }
  }

  if (e.altKey) return;

  // Numpad transport keys (standard DAW layout). Use e.code so they work regardless of
  // NumLock (with NumLock off, e.key would report Delete/End/etc.).
  switch (e.code) {
    case "NumpadDecimal": // jump to project start
      consume();
      if (!e.repeat) locateTo(0);
      return;
    case "NumpadEnter": // start playback
      consume();
      if (!e.repeat) fire(play());
      return;
    case "Numpad0": // stop
      consume();
      if (!e.repeat) fire(stop());
      return;
    case "NumpadMultiply": // record — first arm the selected track(s), Cubase-style
      consume();
      if (!e.repeat) {
        armSelectedTracks();
        fire(record());
      }
      return;
    case "NumpadDivide": // loop / cycle toggle
      consume();
      if (!e.repeat) toggleLoop();
      return;
    case "Numpad1": // to loop start (left locator)
    case "Numpad2": { // to loop end (right locator)
      consume();
      if (e.repeat) return;
      const s = useStore.getState();
      const loop = s.project?.loop ?? s.transport.loop;
      locateTo(e.code === "Numpad1" ? loop.startBeat : loop.endBeat);
      return;
    }
    case "NumpadAdd": // nudge playhead forward (repeat = scrub)
      consume();
      nudgePlayhead(1);
      return;
    case "NumpadSubtract": // nudge playhead back
      consume();
      nudgePlayhead(-1);
      return;
    default:
      break;
  }

  switch (key) {
    case " ": {
      consume();
      if (e.repeat) return;
      const state = useStore.getState().transport.state;
      fire(state === "stopped" ? play() : stop());
      return;
    }
    case ".": // main-row twin of Numpad . — jump to project start
      consume();
      if (!e.repeat) locateTo(0);
      return;
    case "r":
      consume();
      if (!e.repeat) fire(record());
      return;
    case "Delete":
    case "Backspace":
      consume();
      if (e.repeat) return;
      if (ctx?.deleteSelection) ctx.deleteSelection();
      else defaultDelete();
      return;
    case "b": {
      consume();
      if (e.repeat) return;
      const { clipIds } = useStore.getState().selection;
      if (clipIds.length > 0) fire(splitClips(clipIds, playheadBeat()));
      return;
    }
    case "q":
      consume();
      if (!e.repeat) quantizeSelection();
      return;
    case "p":
      consume();
      if (!e.repeat) loopToSelection();
      return;
    case "f":
      consume();
      if (!e.repeat) ctx?.zoomToFit?.();
      return;
    // Arrow-key selection editing — pane-defined; unhandled arrows keep their default
    // so panes without a nudge handler still scroll natively. Key-repeat allowed.
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown": {
      const dx = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
      const dy = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
      if (ctx?.nudge?.(dx as -1 | 0 | 1, dy as -1 | 0 | 1, e.shiftKey)) consume();
      return;
    }
    case "m": {
      consume();
      if (e.repeat) return;
      // tracks selected and no clips → mute the TRACKS (group toggle); else clip mute
      const sel = useStore.getState().selection;
      if (sel.trackIds.length > 0 && sel.clipIds.length === 0) {
        const tracks = selectedTracks();
        if (tracks.length > 0) muteSelectedTracks(tracks);
      } else {
        muteSelectedClips();
      }
      return;
    }
    case "s":
      consume();
      if (!e.repeat) soloSelectedTracks();
      return;
    case "c":
      consume();
      if (!e.repeat) toggleMetronome();
      return;
    case "l":
      consume();
      if (!e.repeat) toggleLoop();
      return;
    case "j": {
      consume();
      if (e.repeat) return;
      const s = useStore.getState();
      s.setFollowPlayhead(!s.followPlayhead);
      return;
    }
    case "1":
    case "2":
    case "3":
    case "4": {
      consume();
      const tools = ["select", "draw", "erase", "split"] as const;
      useStore.getState().setTool(tools[Number(key) - 1]);
      return;
    }
    // Nudge the playhead by one grid step. Key repeat is allowed — hold to scrub.
    case "+":
    case "=":
      consume();
      nudgePlayhead(1);
      return;
    case "-":
    case "_":
      consume();
      nudgePlayhead(-1);
      return;
    // Cubase-style zoom: G zooms out (more time fits), H zooms in. Shift+G/H = vertical
    // (track height). Key repeat is allowed deliberately — hold to keep zooming.
    case "g":
      consume();
      if (e.shiftKey) zoomV(0.8);
      else zoomH(0.8);
      return;
    case "h":
      consume();
      if (e.shiftKey) zoomV(1.25);
      else zoomH(1.25);
      return;
    case "Home":
      consume();
      locateTo(0);
      return;
    case "End": {
      consume();
      const p = useStore.getState().project;
      locateTo(p ? projectEndBeat(p) : 0);
      return;
    }
    case "Escape": {
      consume();
      if (ctx?.escape?.()) return;
      closeContextMenu(); // defensive — normally already closed when we get here
      useStore.getState().clearSelection();
      return;
    }
    case "?": {
      consume();
      if (!e.repeat) useStore.getState().setDialogs({ shortcuts: true });
      return;
    }
    default:
      return;
  }
}

/**
 * Menu-bar entry point (PINNED name) — run an edit action through the same
 * context-aware paths the key handlers use (focused pane first, defaults otherwise).
 */
export function invokeEditAction(
  name: "undo" | "redo" | "cut" | "copy" | "paste" | "duplicate" | "delete" | "selectAll",
): void {
  const ctx = activeContext();
  switch (name) {
    case "undo":
      fire(undo());
      return;
    case "redo":
      fire(redo());
      return;
    case "copy":
      if (!ctx?.copy?.()) copySelection();
      return;
    case "cut":
      if (!ctx?.cut?.()) void cutSelection().catch((err) => console.warn("[keyboard] cut failed:", err));
      return;
    case "paste":
      if (!ctx?.paste?.()) void pasteAt().catch((err) => console.warn("[keyboard] paste failed:", err));
      return;
    case "duplicate":
      if (!ctx?.duplicate?.()) defaultDuplicate();
      return;
    case "delete":
      if (ctx?.deleteSelection) ctx.deleteSelection();
      else defaultDelete();
      return;
    case "selectAll":
      if (ctx?.selectAll) ctx.selectAll();
      else defaultSelectAll();
      return;
  }
}

let installed = false;

/** Install the global handler (idempotent). Returns an uninstall function. */
export function initKeyboard(): () => void {
  if (installed) return () => {};
  installed = true;
  window.addEventListener("keydown", onKeyDown, false); // bubble phase by contract
  return () => {
    installed = false;
    window.removeEventListener("keydown", onKeyDown, false);
  };
}
