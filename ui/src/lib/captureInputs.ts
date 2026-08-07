/**
 * Capture-input option building — the ONE implementation behind the mixer strip's
 * input select, the Inspector's input row and the Add Audio Track dialog (Omer,
 * 2026-08-07: adding an audio channel must ask mono/stereo + which input).
 *
 * Only the RUNNING driver's capture channels are offerable — an inputDevice from
 * another backend can never be opened. Stereo pairs step by 2 (non-overlapping
 * In 1/2, In 3/4 — hardware-style; the Inspector's old overlapping pairs were a
 * bug this file retires). Value encoding: `${deviceId}::${firstChannel}`; "" = no
 * input. Pure functions (vitest-able); callers pass live store state.
 */

import type { GetDevicesReply } from "../protocol/types";
import type { SelectOption } from "../components/common/Select";

export function captureInputOptions(
  audioDevices: GetDevicesReply | null,
  driverName: string,
  stereo: boolean,
): SelectOption[] {
  const opts: SelectOption[] = [{ value: "", label: "No Input" }];
  const driver = audioDevices?.drivers.find(
    (d) => d.available && d.type === driverName.toLowerCase(),
  );
  for (const dev of driver?.devices ?? []) {
    if (dev.maxInputs <= 0) continue;
    if (stereo) {
      for (let c = 0; c + 1 < dev.maxInputs; c += 2)
        opts.push({ value: `${dev.id}::${c}`, label: `In ${c + 1}/${c + 2}`, group: dev.name });
      if (dev.maxInputs === 1)
        opts.push({ value: `${dev.id}::0`, label: "In 1", group: dev.name });
    } else {
      for (let c = 0; c < dev.maxInputs; c++)
        opts.push({ value: `${dev.id}::${c}`, label: `In ${c + 1}`, group: dev.name });
    }
  }
  return opts;
}

export function parseCaptureInput(v: string): { inputDevice: string; inputChannel: number } {
  if (v === "") return { inputDevice: "", inputChannel: 0 };
  const i = v.lastIndexOf("::");
  return { inputDevice: v.slice(0, i), inputChannel: Number(v.slice(i + 2)) };
}
