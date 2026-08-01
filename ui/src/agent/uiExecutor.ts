/**
 * Typed UI executor (Increment 5) — runs the 14 ui/* catalog operations against the live
 * store/theme, making mydaw_ui work for the in-app agent (and, via the controller bridge,
 * for external MCP clients). No arbitrary selector clicking or JS evaluation: every action
 * is a typed, whitelisted store mutation.
 *
 * Each executor returns a structured result or throws a UiOpError {code,message}; the tool
 * layer converts a throw into an isError tool result (never a fake success).
 */

import { applyTheme, type ThemeName } from "../lib/theme";
import { savePref } from "../lib/prefs";
import {
  invokeEditAction,
  loopToSelection,
  zoomToFitPane,
  type KeyContextName,
} from "../lib/keyboard";
import { pasteAt } from "../lib/clipboard";
import { revealPane } from "../shell/reveal";
import * as MF from "../lib/midiFunctions";
import { applyLogicalEditor, type LeProgram } from "../lib/logicalEditor";
import { editNotes } from "../store/actions";
import type { MidiClip, Note } from "../protocol/types";
import {
  useStore,
  type BottomTab,
  type FocusedPane,
  type Selection,
  type Tool,
} from "../store/store";

export class UiOpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UiOpError";
    this.code = code;
  }
}

type Args = Record<string, unknown>;

const asObject = (v: unknown): Args =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Args) : {};
const asBool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;
const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const asIntArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];

const THEMES = new Set<ThemeName>(["dark", "light", "slate", "sepia", "prism"]);
const TOOLS = new Set<Tool>(["select", "draw", "erase", "split"]);
const PANES = new Set<FocusedPane>(["timeline", "pianoRoll", "clipEditor", "sheetMusic", "mixer"]);
const DIALOGS = new Set(["settings", "export", "shortcuts", "recreatePlugins"]);
const BOTTOM_TABS = new Set(["mixer", "pianoRoll", "clipEditor", "sheetMusic", "visualizer"]);

function require<T>(value: T | undefined | null, code: string, message: string): T {
  if (value === undefined || value === null) throw new UiOpError(code, message);
  return value;
}

/** Merge a selection according to replace/add/toggle semantics. */
function mergeSelection(
  current: Selection,
  patch: Partial<Selection>,
  mode: "replace" | "add" | "toggle",
): Selection {
  const combine = (cur: number[], next: number[] | undefined): number[] => {
    if (next === undefined) return mode === "replace" ? [] : cur;
    if (mode === "replace") return [...next];
    if (mode === "add") return [...new Set([...cur, ...next])];
    // toggle
    const set = new Set(cur);
    for (const id of next) (set.has(id) ? set.delete(id) : set.add(id));
    return [...set];
  };
  return {
    trackIds: combine(current.trackIds, patch.trackIds),
    clipIds: combine(current.clipIds, patch.clipIds),
    noteIds: combine(current.noteIds, patch.noteIds),
  };
}

/**
 * Execute one UI operation. Returns a JSON-serializable result. Throws UiOpError for bad
 * arguments or operations this build does not support.
 */
export function executeUiOperation(operation: string, payloadRaw: unknown): unknown {
  const args = asObject(payloadRaw);
  const store = useStore.getState();

  switch (operation) {
    case "ui/selection.get":
      return store.selection;

    case "ui/selection.set": {
      const sel = asObject(args.selection);
      const mode = args.mode === "add" || args.mode === "toggle" ? args.mode : "replace";
      const next = mergeSelection(
        store.selection,
        {
          trackIds: "trackIds" in sel ? asIntArray(sel.trackIds) : undefined,
          clipIds: "clipIds" in sel ? asIntArray(sel.clipIds) : undefined,
          noteIds: "noteIds" in sel ? asIntArray(sel.noteIds) : undefined,
        },
        mode,
      );
      store.setSelection(next);
      return next;
    }

    case "ui/focus.set": {
      const pane = String(args.pane);
      if (!PANES.has(pane as FocusedPane)) throw new UiOpError("invalid_arguments", `bad pane: ${pane}`);
      store.setFocusedPane(pane as FocusedPane);
      return { pane };
    }

    case "ui/follow.set": {
      const enabled = asBool(args.enabled, store.followPlayhead);
      store.setFollowPlayhead(enabled);
      return { enabled };
    }

    case "ui/tool.set": {
      const tool = String(args.tool);
      if (!TOOLS.has(tool as Tool)) throw new UiOpError("invalid_arguments", `bad tool: ${tool}`);
      store.setTool(tool as Tool);
      return { tool };
    }

    case "ui/theme.set": {
      const theme = String(args.theme);
      if (!THEMES.has(theme as ThemeName)) throw new UiOpError("invalid_arguments", `bad theme: ${theme}`);
      applyTheme(theme as ThemeName);
      return { theme };
    }

    case "ui/viewport.set": {
      if (args.fit !== undefined) {
        // Fit-to-content: same path as the Z key / zoom pills (per-pane handlers).
        const pane = typeof args.pane === "string" ? args.pane : store.focusedPane;
        const fitPane: KeyContextName =
          pane === "pianoRoll" || pane === "clipEditor" || pane === "sheetMusic"
            ? pane
            : "timeline";
        const applied = zoomToFitPane(fitPane);
        return { fit: true, pane: fitPane, applied };
      }
      const patch: Record<string, number> = {};
      for (const key of ["zoomX", "zoomY", "scrollX", "scrollY"] as const) {
        const n = asNumber(args[key]);
        if (n !== undefined) patch[key] = n;
      }
      store.setViewport(patch);
      return { applied: patch };
    }

    case "ui/layout.set": {
      const patch: Record<string, unknown> = {};
      for (const key of ["browser", "inspector", "minimap", "agent"] as const) {
        if (typeof args[key] === "boolean") patch[key] = args[key];
      }
      // The Inspector is a Browser tab now, so "inspector:true" opens the Browser onto that
      // tab; "inspector:false" leaves the Browser on a non-inspector tab. (The legacy
      // panels.inspector flag is still set for the agent surface / older clients.)
      if (patch.inspector === true) {
        patch.browser = true;
        patch.browserTab = "inspector";
      } else if (patch.inspector === false && store.panels.browserTab === "inspector") {
        patch.browserTab = "plugins";
      }
      if (typeof args.bottomTab === "string" && BOTTOM_TABS.has(args.bottomTab)) {
        patch.bottomTab = args.bottomTab as BottomTab;
        // Non-classic shells have no dock: map "show this pane" onto the active
        // shell (ribbon category / workspace) so the op keeps meaning what it says.
        if (store.shellMode !== "classic")
          revealPane(args.bottomTab as Exclude<BottomTab, null>);
      } else if (args.bottomTab === null) {
        patch.bottomTab = null;
      }
      // Split dock: the second bottom pane (UI_IMPROVE Tier 2); null closes the split.
      if (typeof args.bottomTab2 === "string" && BOTTOM_TABS.has(args.bottomTab2)) {
        patch.bottomTab2 = args.bottomTab2 as BottomTab;
      } else if (args.bottomTab2 === null) {
        patch.bottomTab2 = null;
      }
      store.setPanels(patch);
      return { applied: patch };
    }

    case "ui/dialog.set": {
      const dialog = String(args.dialog);
      if (!DIALOGS.has(dialog)) throw new UiOpError("invalid_arguments", `bad dialog: ${dialog}`);
      const open = require(typeof args.open === "boolean" ? args.open : undefined, "invalid_arguments", "open is required");
      store.setDialogs({ [dialog]: open });
      if (dialog === "settings" && open && typeof args.tab === "string") {
        savePref("ui.settingsTab", args.tab);
      }
      return { dialog, open };
    }

    case "ui/pluginEditor.set": {
      const instanceId = require(asNumber(args.instanceId), "invalid_arguments", "instanceId is required");
      const open = require(typeof args.open === "boolean" ? args.open : undefined, "invalid_arguments", "open is required");
      if (open) store.openPluginEditorWindow(instanceId);
      else store.closePluginEditorWindow(instanceId);
      return { instanceId, open };
    }

    case "ui/entity.reveal": {
      const kind = String(args.kind);
      const id = require(asNumber(args.id), "invalid_arguments", "id is required");
      const select = asBool(args.select, true);
      const focus = asBool(args.focus, false);
      if (select) {
        if (kind === "track") store.setSelection(mergeSelection(store.selection, { trackIds: [id] }, "replace"));
        else if (kind === "clip") store.setSelection(mergeSelection(store.selection, { clipIds: [id] }, "replace"));
        else if (kind === "note") store.setSelection(mergeSelection(store.selection, { noteIds: [id] }, "replace"));
      }
      if (focus) {
        store.setFocusedPane(kind === "note" ? "pianoRoll" : kind === "clip" ? "clipEditor" : "timeline");
      }
      return { kind, id, selected: select, focused: focus };
    }

    case "ui/edit.invoke": {
      const action = String(args.action);
      switch (action) {
        case "clearSelection":
          store.clearSelection();
          return { action };
        case "paste": {
          // atBeat pastes at an explicit position; otherwise the context-aware
          // menu path (focused pane first) decides, exactly like Ctrl+V.
          const atBeat = asNumber(args.atBeat);
          if (atBeat !== undefined) {
            void pasteAt(atBeat).catch((err) => console.warn("[agent] paste failed:", err));
            return { action, atBeat };
          }
          invokeEditAction("paste");
          return { action };
        }
        case "copy":
        case "cut":
        case "delete":
        case "duplicate":
        case "selectAll":
          // Same context-aware entry point the menu bar uses (PINNED name).
          invokeEditAction(action);
          return { action };
        case "zoomToFit": {
          const fp = store.focusedPane;
          const pane: KeyContextName =
            fp === "pianoRoll" || fp === "clipEditor" || fp === "sheetMusic" ? fp : "timeline";
          return { action, applied: zoomToFitPane(pane) };
        }
        case "locatorsToSelection":
          // "P" — loop to the selected clips' bounds (no clip selection = no-op).
          loopToSelection();
          return { action };
        default:
          throw new UiOpError("invalid_arguments", `unknown edit action: ${action}`);
      }
    }

    case "ui/midi.logicalEditor": {
      // Cubase-style Logical Editor, agent-flavored: run an arbitrary rule program
      // (filters → transform/delete/select) from lib/logicalEditor over explicit notes,
      // a whole clip, or the current selection; committed as ONE cmd/notes.edit.
      const project = store.project;
      if (!project) throw new UiOpError("no_project", "no project loaded");
      const explicitClipId = asNumber(args.clipId);
      const clipId = explicitClipId ?? store.activeMidiClipId ?? undefined;
      if (clipId === undefined)
        throw new UiOpError(
          "invalid_arguments",
          "no clipId given and no active MIDI clip — pass clipId (mydaw_query view:clips)",
        );
      let clip: MidiClip | undefined;
      for (const t of project.tracks) {
        const c = t.clips.find((x) => x.id === clipId);
        if (c) {
          if (c.type !== "midi") throw new UiOpError("invalid_arguments", "clipId is not a MIDI clip");
          clip = c;
          break;
        }
      }
      if (!clip) throw new UiOpError("not_found", `clipId not found: ${clipId}`);
      const idFilter = asIntArray(args.noteIds);
      const wanted =
        idFilter.length > 0
          ? idFilter
          : explicitClipId === undefined
            ? store.selection.noteIds
            : [];
      const notes: Note[] =
        wanted.length > 0 ? clip.notes.filter((n) => wanted.includes(n.id)) : [...clip.notes];
      if (notes.length === 0)
        throw new UiOpError("invalid_arguments", "no notes matched (clip empty or bad noteIds)");
      const program = asObject(args.program) as unknown as LeProgram;
      if (!Array.isArray(program.filters) || typeof program.mode !== "string")
        throw new UiOpError("invalid_arguments", "program needs {mode, filters[], actions[]}");
      if (!Array.isArray(program.actions)) program.actions = [];
      const r = applyLogicalEditor(notes, program);
      if (program.mode === "select") {
        useStore.getState().setSelection({ noteIds: r.matchedIds });
        return { clipId, notes: notes.length, matched: r.matchedIds.length, selected: r.matchedIds.length };
      }
      const updates = r.patch.update?.length ?? 0;
      const removes = r.patch.remove?.length ?? 0;
      if (updates > 0 || removes > 0) {
        void editNotes(clipId, r.patch).catch((err) =>
          console.warn("[agent] midi.logicalEditor commit failed:", err),
        );
      }
      return { clipId, notes: notes.length, matched: r.matchedIds.length, updated: updates, removed: removes };
    }

    case "ui/midi.transform": {
      // The Piano Roll's MIDI-functions menu, agent-flavored: pure transforms from
      // lib/midiFunctions over explicit notes (clipId+noteIds), a whole clip, or the
      // current note selection in the active MIDI clip; committed as ONE cmd/notes.edit.
      const transform = String(args.transform);
      const project = store.project;
      if (!project) throw new UiOpError("no_project", "no project loaded");
      const explicitClipId = asNumber(args.clipId);
      const clipId = explicitClipId ?? store.activeMidiClipId ?? undefined;
      if (clipId === undefined)
        throw new UiOpError(
          "invalid_arguments",
          "no clipId given and no active MIDI clip — pass clipId (mydaw_query view:clips)",
        );
      let clip: MidiClip | undefined;
      for (const t of project.tracks) {
        const c = t.clips.find((x) => x.id === clipId);
        if (c) {
          if (c.type !== "midi") throw new UiOpError("invalid_arguments", "clipId is not a MIDI clip");
          clip = c;
          break;
        }
      }
      if (!clip) throw new UiOpError("not_found", `clipId not found: ${clipId}`);
      const idFilter = asIntArray(args.noteIds);
      const selected = explicitClipId === undefined && idFilter.length === 0
        ? store.selection.noteIds
        : [];
      const wanted = idFilter.length > 0 ? idFilter : selected;
      const notes: Note[] =
        wanted.length > 0 ? clip.notes.filter((n) => wanted.includes(n.id)) : [...clip.notes];
      if (notes.length === 0)
        throw new UiOpError("invalid_arguments", "no notes matched (clip empty or bad noteIds)");
      const o = asObject(args.options);
      const num = (key: string, fallback?: number): number => {
        const v = asNumber(o[key]);
        if (v === undefined && fallback === undefined)
          throw new UiOpError("invalid_arguments", `options.${key} is required for ${transform}`);
        return v ?? (fallback as number);
      };
      const optNum = (key: string): number | undefined => asNumber(o[key]);
      let patch: MF.NotesPatch;
      switch (transform) {
        case "transpose": patch = MF.transpose(notes, num("semitones")); break;
        case "fixedLength": patch = MF.fixedLength(notes, num("lengthBeats")); break;
        case "legato": patch = MF.legato(notes, num("overlapBeats", 0)); break;
        case "humanizeTiming": patch = MF.humanizeTiming(notes, num("maxBeats", 0.05)); break;
        case "humanizeVelocity": patch = MF.humanizeVelocity(notes, num("amount", 10)); break;
        case "scaleVelocity": patch = MF.scaleVelocity(notes, num("multiplier", 1), num("add", 0)); break;
        case "reverse": patch = MF.reverse(notes); break;
        case "deleteDoubles": patch = MF.deleteDoubles(notes); break;
        case "deleteOverlapsMono": patch = MF.deleteOverlapsMono(notes); break;
        case "deleteOverlapsPoly": patch = MF.deleteOverlapsPoly(notes); break;
        case "fixedVelocity": patch = MF.fixedVelocity(notes, num("velocity")); break;
        case "limitVelocity": patch = MF.limitVelocity(notes, num("min", 1), num("max", 127)); break;
        case "compressVelocity": patch = MF.compressVelocity(notes, num("ratio"), num("center", 64)); break;
        case "deleteNotes": {
          const minLengthBeats = optNum("minLengthBeats");
          const minVelocity = optNum("minVelocity");
          if (minLengthBeats === undefined && minVelocity === undefined)
            throw new UiOpError(
              "invalid_arguments",
              "deleteNotes needs options.minLengthBeats and/or options.minVelocity",
            );
          patch = MF.deleteNotes(notes, { minLengthBeats, minVelocity });
          break;
        }
        case "mirror": patch = MF.mirror(notes, optNum("axisPitch")); break;
        case "restrictPolyphony": patch = MF.restrictPolyphony(notes, num("maxVoices")); break;
        case "rampVelocity": patch = MF.rampVelocity(notes, num("from"), num("to")); break;
        case "smoothVelocity": patch = MF.smoothVelocity(notes); break;
        default:
          throw new UiOpError("invalid_arguments", `unknown transform: ${transform}`);
      }
      const updates = patch.update?.length ?? 0;
      const removes = patch.remove?.length ?? 0;
      if (updates === 0 && removes === 0)
        return { transform, clipId, notes: notes.length, updated: 0, removed: 0 };
      void editNotes(clipId, patch).catch((err) =>
        console.warn("[agent] midi.transform commit failed:", err),
      );
      return { transform, clipId, notes: notes.length, updated: updates, removed: removes };
    }

    default:
      throw new UiOpError("unknown_operation", `unknown UI operation: ${operation}`);
  }
}

/** True when the operation is a mutation (everything except selection.get). */
export function isUiMutation(operation: string): boolean {
  return operation !== "ui/selection.get";
}
