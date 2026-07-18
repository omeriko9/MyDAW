import { describe, expect, it } from "vitest";
import { windowTitle } from "./appTitle";

describe("windowTitle", () => {
  it("shows the project name with the app suffix", () => {
    expect(windowTitle("My Song", false)).toBe("My Song — MyDAW");
  });

  it("prefixes a dirty marker while there are unsaved changes", () => {
    expect(windowTitle("My Song", true)).toBe("● My Song — MyDAW");
  });

  it("falls back to the bare app name without a project", () => {
    expect(windowTitle(null, false)).toBe("MyDAW");
    expect(windowTitle(undefined, false)).toBe("MyDAW");
    expect(windowTitle("", false)).toBe("MyDAW");
    expect(windowTitle("   ", false)).toBe("MyDAW");
  });

  it("still marks dirty with no project (e.g. unsaved new project)", () => {
    expect(windowTitle(null, true)).toBe("● MyDAW");
  });
});
