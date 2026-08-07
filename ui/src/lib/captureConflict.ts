/**
 * Capture-honesty wording (SPEC §5.5 / §10) — pure functions turning the engine's
 * captureState (single capture endpoint + tracks it cannot honour) into the strings
 * the TransportBar chip and the warning toast show. Pure so vitest can pin them.
 *
 * v1 opens ONE capture endpoint: the first armed/monitoring audio track picks the
 * device, and every other armed/monitoring audio track is fed that same signal. A
 * track on the `conflicts` list asked for a different input and would silently
 * record the wrong source — the exact failure this wording exists to prevent.
 */

import type { CaptureStateEvent, Project } from "../protocol/types";

export interface CaptureWarning {
  /** Short chip label ("Input conflict" / "Input error"). */
  chip: string;
  /** Full sentence(s) for the chip tooltip and the transition toast. */
  detail: string;
  /** true when capture itself failed to open (worse than a conflict). */
  isError: boolean;
}

const deviceLabel = (d: string): string => (d === "default" || d === "" ? "system default" : d);

function trackName(project: Project | null, trackId: number): string {
  const t = project?.tracks.find((x) => x.id === trackId);
  return t ? t.name : `track ${trackId}`;
}

/**
 * Null when there is nothing to warn about (no conflict, no error) — the normal
 * state, in which the UI shows nothing at all.
 */
export function describeCaptureState(
  cs: CaptureStateEvent | null,
  project: Project | null,
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
  if (cs.conflicts.length === 0) return null;
  const winner = deviceLabel(cs.deviceId);
  const list = cs.conflicts
    .map((c) => `"${trackName(project, c.trackId)}" (wants ${deviceLabel(c.device)})`)
    .join(", ");
  return {
    chip: "Input conflict",
    detail:
      `One input device at a time in v1: capture is open on ${winner}, so ` +
      `${list} would record ${winner}'s signal instead. ` +
      "Arm tracks that share one input device, or re-point their input.",
    isError: false,
  };
}

/** Stable identity of a warning — the toast fires only when this changes. */
export function captureWarningKey(cs: CaptureStateEvent | null): string {
  if (!cs) return "";
  if (cs.error) return `error:${cs.error}`;
  if (cs.conflicts.length === 0) return "";
  return "conflict:" + cs.conflicts.map((c) => `${c.trackId}=${c.device}`).join(",");
}
