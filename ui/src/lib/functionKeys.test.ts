import { describe, expect, it } from "vitest";
import { matchesDawFunctionKey } from "./functionKeys";

function key(
  code: "F3" | "F11",
  overrides: Partial<Pick<KeyboardEvent, "shiftKey" | "ctrlKey" | "metaKey" | "altKey">> = {},
) {
  return {
    code,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("matchesDawFunctionKey", () => {
  it("matches bare function keys in direct mode", () => {
    expect(matchesDawFunctionKey(key("F3"), "F3", "direct")).toBe(true);
    expect(matchesDawFunctionKey(key("F3", { shiftKey: true }), "F3", "direct")).toBe(false);
  });

  it("matches shifted function keys in shifted mode", () => {
    expect(matchesDawFunctionKey(key("F11", { shiftKey: true }), "F11", "shifted")).toBe(true);
    expect(matchesDawFunctionKey(key("F11"), "F11", "shifted")).toBe(false);
  });

  it("leaves modified browser and system shortcuts alone", () => {
    expect(matchesDawFunctionKey(key("F3", { ctrlKey: true }), "F3", "direct")).toBe(false);
    expect(matchesDawFunctionKey(key("F11", { altKey: true }), "F11", "direct")).toBe(false);
    expect(matchesDawFunctionKey(key("F11", { metaKey: true }), "F11", "direct")).toBe(false);
  });
});
