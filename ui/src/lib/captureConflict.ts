/**
 * Capture-honesty wording (SPEC §5.5 / §10) — pure functions turning the engine's
 * captureState (open capture endpoints + armed tracks whose device is NOT open)
 * into the strings the TransportBar chip and the warning toast show. Pure so
 * vitest can pin them.
 *
 * Multi-endpoint capture (2026-08-07): the engine opens one session per distinct
 * armed/monitoring device, so two mics on two interfaces just WORK. What remains
 * to warn about is a device that could not be opened (unplugged, wrong id, driver
 * refused) — that track records/monitors silence until it opens — and a capture
 * reconfigure failing outright. Device ids are raw endpoint GUIDs on the wire;
 * everything user-facing resolves them to friendly names via the device list
 * (the raw-GUID toast is exactly the bug report that prompted this rewrite).
 */

import type { CaptureStateEvent, GetDevicesReply, Project } from "../protocol/types";

export interface CaptureWarning {
  /** Short chip label ("Input unavailable" / "Input error"). */
  chip: string;
  /** Full sentence(s) for the chip tooltip and the transition toast. */
  detail: string;
  /** true when capture itself failed to open (worse than one missing device). */
  isError: boolean;
}

/** Resolve an endpoint id to its friendly name; falls back to the raw id. */
export function deviceName(id: string, devices: GetDevicesReply | null): string {
  if (id === "default" || id === "") return "the system default input";
  for (const drv of devices?.drivers ?? [])
    for (const d of drv.devices) if (d.id === id) return `“${d.name}”`;
  return `“${id}”`;
}

function trackName(project: Project | null, trackId: number): string {
  const t = project?.tracks.find((x) => x.id === trackId);
  return t ? t.name : `track ${trackId}`;
}

/**
 * Null when there is nothing to warn about — the normal state (including the
 * normal MULTI-device state), in which the UI shows nothing at all.
 */
export function describeCaptureState(
  cs: CaptureStateEvent | null,
  project: Project | null,
  devices: GetDevicesReply | null,
): CaptureWarning | null {
  if (!cs) return null;
  if (cs.error) {
    return {
      chip: "Input error",
      detail:
        `Audio input failed to open (${cs.error}) — ` +
        "recording and input monitoring are silent until it opens.",
      isError: true,
    };
  }
  if (cs.unavailable.length === 0) return null;
  const list = cs.unavailable
    .map((u) => `“${trackName(project, u.trackId)}” (wants ${deviceName(u.device, devices)})`)
    .join(", ");
  return {
    chip: "Input unavailable",
    detail:
      `Couldn't open the input device for ${list} — that track records and monitors ` +
      "SILENCE until its device is available. Check the device is connected, or " +
      "re-point the track's input.",
    isError: false,
  };
}

/** Stable identity of a warning — the toast fires only when this changes. */
export function captureWarningKey(cs: CaptureStateEvent | null): string {
  if (!cs) return "";
  if (cs.error) return `error:${cs.error}`;
  if (cs.unavailable.length === 0) return "";
  return "unavailable:" + cs.unavailable.map((u) => `${u.trackId}=${u.device}`).join(",");
}
