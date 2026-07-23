/**
 * Typed UI executor (Increment 5) — runs the 13 ui/* catalog operations against the live
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
        throw new UiOpError(
          "unsupported_operation",
          "viewport fit-to-content is not available from the agent yet; set explicit zoom/scroll",
        );
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
      } else if (args.bottomTab === null) {
        patch.bottomTab = null;
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
      if (action === "clearSelection") {
        store.clearSelection();
        return { action };
      }
      throw new UiOpError(
        "unsupported_operation",
        `ui/edit.invoke "${action}" is not available from the agent in this build; use ` +
          "mydaw_execute/mydaw_batch for engine edits",
      );
    }

    case "ui/midi.transform":
      throw new UiOpError(
        "unsupported_operation",
        "ui/midi.transform is not available from the agent in this build; use mydaw_execute " +
          "cmd/notes.edit or cmd/notes.quantize for MIDI edits",
      );

    default:
      throw new UiOpError("unknown_operation", `unknown UI operation: ${operation}`);
  }
}

/** True when the operation is a mutation (everything except selection.get). */
export function isUiMutation(operation: string): boolean {
  return operation !== "ui/selection.get";
}
