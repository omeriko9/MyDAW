import { describe, expect, it } from "vitest";
import {
  DEFAULT_RIBBON,
  removeLeafAt,
  replaceTilePane,
  shellVisiblePanes,
  splitLeafAt,
  stockWorkspaces,
  swapTilePanes,
  tileLeaves,
  validRibbon,
  validWorkspaces,
} from "./shellTypes";
import type { WsTile } from "./shellTypes";

const edit: WsTile = {
  dir: "col",
  ratio: 0.55,
  a: { pane: "timeline" },
  b: { pane: "pianoRoll" },
};

describe("shell tile tree", () => {
  it("lists leaves in order", () => {
    expect(tileLeaves(edit)).toEqual(["timeline", "pianoRoll"]);
  });

  it("splits a leaf into a new pane pair", () => {
    const t = splitLeafAt(edit, ["b"], "row", "mixer");
    expect(tileLeaves(t)).toEqual(["timeline", "pianoRoll", "mixer"]);
    // the original leaf keeps the first slot of the new split
    expect(t).toMatchObject({ b: { dir: "row", a: { pane: "pianoRoll" }, b: { pane: "mixer" } } });
  });

  it("removing a leaf lets the sibling absorb the space", () => {
    expect(removeLeafAt(edit, ["a"])).toEqual({ pane: "pianoRoll" });
    // removing the only leaf is a no-op
    expect(removeLeafAt({ pane: "mixer" }, [])).toEqual({ pane: "mixer" });
  });

  it("swap keeps the single-instance invariant instead of duplicating", () => {
    const t = swapTilePanes(edit, "timeline", "pianoRoll");
    expect(tileLeaves(t)).toEqual(["pianoRoll", "timeline"]);
  });

  it("replace targets only the named pane", () => {
    expect(tileLeaves(replaceTilePane(edit, "pianoRoll", "mixer"))).toEqual([
      "timeline",
      "mixer",
    ]);
  });
});

describe("shell state validators", () => {
  it("accept the shipped defaults", () => {
    expect(validRibbon(DEFAULT_RIBBON)).toBe(true);
    expect(validWorkspaces(stockWorkspaces())).toBe(true);
  });

  it("reject a ribbon with both slots on the same pane", () => {
    expect(validRibbon({ ...DEFAULT_RIBBON, secondary: DEFAULT_RIBBON.primary })).toBe(false);
  });

  it("reject a workspace tiling the same pane twice", () => {
    const w = stockWorkspaces();
    w.list[0] = {
      id: "ws-1",
      name: "Bad",
      root: { dir: "row", ratio: 0.5, a: { pane: "mixer" }, b: { pane: "mixer" } },
    };
    expect(validWorkspaces(w)).toBe(false);
  });

  it("reject a stale activeId", () => {
    expect(validWorkspaces({ ...stockWorkspaces(), activeId: "ws-99" })).toBe(false);
  });
});

describe("shellVisiblePanes (keyboard-routing bridge)", () => {
  it("is undefined for classic (dock fields rule)", () => {
    expect(shellVisiblePanes("classic", DEFAULT_RIBBON, stockWorkspaces())).toBeUndefined();
  });

  it("lists ribbon slots minus the timeline", () => {
    expect(
      shellVisiblePanes("ribbon", { ...DEFAULT_RIBBON, secondary: "mixer" }, stockWorkspaces()),
    ).toEqual(["mixer"]);
  });

  it("lists the ACTIVE workspace's dock panes", () => {
    const w = { ...stockWorkspaces(), activeId: "ws-3" }; // Edit: timeline + pianoRoll
    expect(shellVisiblePanes("workspaces", DEFAULT_RIBBON, w)).toEqual(["pianoRoll"]);
  });
});
