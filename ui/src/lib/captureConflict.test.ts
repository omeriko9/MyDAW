import { describe, expect, it } from "vitest";
import { captureWarningKey, describeCaptureState } from "./captureConflict";
import type { CaptureStateEvent, Project } from "../protocol/types";

const project = {
  tracks: [
    { id: 1, name: "Vocals" },
    { id: 2, name: "Guitar" },
  ],
} as unknown as Project;

const state = (over: Partial<CaptureStateEvent>): CaptureStateEvent => ({
  deviceId: "default",
  conflicts: [],
  ...over,
});

describe("describeCaptureState", () => {
  it("is silent with no engine report, no conflicts, or closed capture", () => {
    expect(describeCaptureState(null, project)).toBeNull();
    expect(describeCaptureState(state({}), project)).toBeNull();
    expect(describeCaptureState(state({ deviceId: "" }), project)).toBeNull();
  });

  it("names the conflicting track, both devices, and the consequence", () => {
    const w = describeCaptureState(
      state({ deviceId: "Focusrite", conflicts: [{ trackId: 2, device: "USB Mic" }] }),
      project,
    );
    expect(w).not.toBeNull();
    expect(w!.chip).toBe("Input conflict");
    expect(w!.isError).toBe(false);
    expect(w!.detail).toContain('"Guitar"');
    expect(w!.detail).toContain("USB Mic");
    expect(w!.detail).toContain("Focusrite");
    expect(w!.detail).toContain("record");
  });

  it("humanizes the default device and survives an unknown track id", () => {
    const w = describeCaptureState(
      state({ conflicts: [{ trackId: 99, device: "USB Mic" }] }),
      project,
    );
    expect(w!.detail).toContain("system default");
    expect(w!.detail).toContain("track 99"); // no crash, still identifiable
    // ...and no project at all (hello races projectChanged) must not throw either.
    expect(() => describeCaptureState(state({ conflicts: [{ trackId: 1, device: "x" }] }), null)).not.toThrow();
  });

  it("reports a capture-open failure as an error, over any conflict list", () => {
    const w = describeCaptureState(
      state({ error: "device in use", conflicts: [{ trackId: 2, device: "USB Mic" }] }),
      project,
    );
    expect(w!.chip).toBe("Input error");
    expect(w!.isError).toBe(true);
    expect(w!.detail).toContain("device in use");
    expect(w!.detail).toContain("silent");
  });
});

describe("captureWarningKey", () => {
  it("is stable for the same problem and changes when the problem changes", () => {
    const a = state({ conflicts: [{ trackId: 2, device: "USB Mic" }] });
    expect(captureWarningKey(a)).toBe(captureWarningKey(state({ conflicts: [{ trackId: 2, device: "USB Mic" }] })));
    expect(captureWarningKey(a)).not.toBe(captureWarningKey(state({ conflicts: [{ trackId: 1, device: "USB Mic" }] })));
    expect(captureWarningKey(a)).not.toBe(captureWarningKey(state({ error: "boom" })));
  });

  it("is empty exactly when there is nothing to warn about", () => {
    expect(captureWarningKey(null)).toBe("");
    expect(captureWarningKey(state({}))).toBe("");
    expect(captureWarningKey(state({ conflicts: [{ trackId: 2, device: "d" }] }))).not.toBe("");
  });
});
