import { describe, expect, it } from "vitest";
import { captureWarningKey, describeCaptureState, deviceName } from "./captureConflict";
import type { CaptureStateEvent, GetDevicesReply, Project } from "../protocol/types";

const project = {
  tracks: [
    { id: 1, name: "Vocals" },
    { id: 2, name: "Guitar" },
  ],
} as unknown as Project;

const GUID = "{0.0.1.00000000}.{519cb916-9f14-484c-85a4-f89fae02ec07}";

const devices = {
  drivers: [
    {
      type: "wasapi",
      available: true,
      devices: [
        { id: "rode-id", name: "Rode NT-USB", isDefault: true, maxInputs: 2, maxOutputs: 0, sampleRates: [] },
        { id: GUID, name: "Audio Kontrol 1 In", isDefault: false, maxInputs: 2, maxOutputs: 0, sampleRates: [] },
      ],
    },
  ],
} as unknown as GetDevicesReply;

const state = (over: Partial<CaptureStateEvent>): CaptureStateEvent => ({
  devices: [{ deviceId: "default", channels: 2, base: 0 }],
  unavailable: [],
  ...over,
});

describe("describeCaptureState (multi-endpoint)", () => {
  it("is silent in the normal states — including the normal MULTI-device state", () => {
    expect(describeCaptureState(null, project, devices)).toBeNull();
    expect(describeCaptureState(state({}), project, devices)).toBeNull();
    expect(
      describeCaptureState(
        state({
          devices: [
            { deviceId: "default", channels: 2, base: 0 },
            { deviceId: GUID, channels: 2, base: 2 },
          ],
        }),
        project,
        devices,
      ),
    ).toBeNull(); // two mics on two interfaces is just… working now
  });

  it("names the track and the FRIENDLY device name — never the raw GUID", () => {
    const w = describeCaptureState(
      state({ unavailable: [{ trackId: 2, device: GUID }] }),
      project,
      devices,
    );
    expect(w).not.toBeNull();
    expect(w!.chip).toBe("Input unavailable");
    expect(w!.isError).toBe(false);
    expect(w!.detail).toContain("“Guitar”");
    expect(w!.detail).toContain("Audio Kontrol 1 In");
    expect(w!.detail).not.toContain("{0.0.1"); // the raw-GUID toast was the bug report
    expect(w!.detail).toContain("SILENCE"); // the consequence, stated
  });

  it("falls back to the raw id when the device list doesn't know it, and survives no project", () => {
    const w = describeCaptureState(
      state({ unavailable: [{ trackId: 99, device: "gone-id" }] }),
      null,
      null,
    );
    expect(w!.detail).toContain("track 99");
    expect(w!.detail).toContain("gone-id");
  });

  it("reports a capture-open failure as an error, over any unavailable list", () => {
    const w = describeCaptureState(
      state({ error: "device in use", unavailable: [{ trackId: 2, device: GUID }] }),
      project,
      devices,
    );
    expect(w!.chip).toBe("Input error");
    expect(w!.isError).toBe(true);
    expect(w!.detail).toContain("device in use");
  });
});

describe("deviceName", () => {
  it("resolves ids, humanizes default, falls back to the raw id", () => {
    expect(deviceName("default", devices)).toBe("the system default input");
    expect(deviceName(GUID, devices)).toBe("“Audio Kontrol 1 In”");
    expect(deviceName("nope", devices)).toBe("“nope”");
  });
});

describe("captureWarningKey", () => {
  it("is stable for the same problem and changes when the problem changes", () => {
    const a = state({ unavailable: [{ trackId: 2, device: GUID }] });
    expect(captureWarningKey(a)).toBe(
      captureWarningKey(state({ unavailable: [{ trackId: 2, device: GUID }] })),
    );
    expect(captureWarningKey(a)).not.toBe(
      captureWarningKey(state({ unavailable: [{ trackId: 1, device: GUID }] })),
    );
    expect(captureWarningKey(a)).not.toBe(captureWarningKey(state({ error: "boom" })));
  });

  it("is empty exactly when there is nothing to warn about", () => {
    expect(captureWarningKey(null)).toBe("");
    expect(captureWarningKey(state({}))).toBe("");
    expect(captureWarningKey(state({ unavailable: [{ trackId: 2, device: "d" }] }))).not.toBe("");
  });
});
