import { beforeEach, describe, expect, it } from "vitest";
import { executeUiOperation, isUiMutation, UiOpError } from "./uiExecutor";
import { useStore } from "../store/store";

// The store persists UI prefs on every change through window/localStorage; the vitest node
// environment has neither, so provide minimal in-memory stubs.
const mem = new Map<string, string>();
type G = Record<string, unknown>;
(globalThis as G).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
(globalThis as G).window = globalThis;

beforeEach(() => {
  useStore.setState({
    selection: { trackIds: [], clipIds: [], noteIds: [] },
    panels: {
      browser: true,
      browserTab: "plugins",
      inspector: true,
      minimap: true,
      agent: false,
      bottomTab: "mixer",
      poppedOut: {},
    },
    dialogs: {
      settings: false,
      export: false,
      shortcuts: false,
      palette: false,
      recreatePlugins: false,
      roomView: false,
      pluginEditors: [],
      recovery: null,
    },
    focusedPane: "timeline",
    followPlayhead: false,
    tool: "select",
    viewport: { zoomX: 32, zoomY: 16, scrollX: 0, scrollY: 0 },
  });
});

describe("executeUiOperation — store-mapped ops", () => {
  it("gets and sets selection with replace semantics", () => {
    executeUiOperation("ui/selection.set", { selection: { trackIds: [1, 2] } });
    expect(useStore.getState().selection.trackIds).toEqual([1, 2]);
    expect(executeUiOperation("ui/selection.get", {})).toEqual({
      trackIds: [1, 2],
      clipIds: [],
      noteIds: [],
    });
  });

  it("merges selection with add and toggle modes", () => {
    useStore.getState().setSelection({ trackIds: [1] });
    executeUiOperation("ui/selection.set", { selection: { trackIds: [2] }, mode: "add" });
    expect(useStore.getState().selection.trackIds.sort()).toEqual([1, 2]);
    executeUiOperation("ui/selection.set", { selection: { trackIds: [1] }, mode: "toggle" });
    expect(useStore.getState().selection.trackIds).toEqual([2]);
  });

  it("sets focus, follow, tool, and panels", () => {
    executeUiOperation("ui/focus.set", { pane: "mixer" });
    expect(useStore.getState().focusedPane).toBe("mixer");
    executeUiOperation("ui/follow.set", { enabled: true });
    expect(useStore.getState().followPlayhead).toBe(true);
    executeUiOperation("ui/tool.set", { tool: "draw" });
    expect(useStore.getState().tool).toBe("draw");
    executeUiOperation("ui/layout.set", { agent: true, inspector: false });
    expect(useStore.getState().panels.agent).toBe(true);
    expect(useStore.getState().panels.inspector).toBe(false);
  });

  it("opens a dialog", () => {
    executeUiOperation("ui/dialog.set", { dialog: "settings", open: true, tab: "llm" });
    expect(useStore.getState().dialogs.settings).toBe(true);
  });

  it("applies explicit viewport fields", () => {
    executeUiOperation("ui/viewport.set", { pane: "timeline", zoomX: 64, scrollX: 100 });
    expect(useStore.getState().viewport).toMatchObject({ zoomX: 64, scrollX: 100 });
  });

  it("reveals an entity by selecting and focusing", () => {
    executeUiOperation("ui/entity.reveal", { kind: "clip", id: 7, focus: true });
    expect(useStore.getState().selection.clipIds).toEqual([7]);
    expect(useStore.getState().focusedPane).toBe("clipEditor");
  });

  it("clears selection via edit.invoke", () => {
    useStore.getState().setSelection({ trackIds: [1, 2] });
    executeUiOperation("ui/edit.invoke", { action: "clearSelection" });
    expect(useStore.getState().selection.trackIds).toEqual([]);
  });
});

describe("executeUiOperation — validation and unsupported", () => {
  it("rejects invalid enums", () => {
    expect(() => executeUiOperation("ui/theme.set", { theme: "neon" })).toThrow(UiOpError);
    expect(() => executeUiOperation("ui/tool.set", { tool: "lasso" })).toThrow(UiOpError);
    expect(() => executeUiOperation("ui/focus.set", { pane: "space" })).toThrow(UiOpError);
  });

  it("requires mandatory fields", () => {
    expect(() => executeUiOperation("ui/dialog.set", { dialog: "settings" })).toThrow(
      /open is required/,
    );
    expect(() => executeUiOperation("ui/pluginEditor.set", { open: true })).toThrow(
      /instanceId/,
    );
  });

  it("reports unsupported operations honestly", () => {
    expect(() => executeUiOperation("ui/midi.transform", { transform: "reverse" })).toThrow(
      /unsupported_operation|not available/,
    );
    expect(() => executeUiOperation("ui/viewport.set", { pane: "timeline", fit: "content" })).toThrow(
      UiOpError,
    );
    expect(() => executeUiOperation("ui/nope", {})).toThrow(/unknown UI operation/);
  });

  it("classifies mutations vs the read-only selection.get", () => {
    expect(isUiMutation("ui/selection.get")).toBe(false);
    expect(isUiMutation("ui/theme.set")).toBe(true);
  });
});
