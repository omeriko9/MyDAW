/**
 * Post-take action toast (UI_IMPROVE.md §4.2, owned by U2) — when recording
 * stops and new clips landed, offer the two things a performer wants within
 * two seconds of finishing a take: throw it away, or open it for editing.
 *
 * Watches transport.state transitions on the store. New clips are diffed
 * against a snapshot taken at record start, AFTER a short grace period —
 * the engine finalizes the take via a projectChanged echo that can arrive
 * slightly after the transport stop event.
 */

import { useStore } from "../../store/store";
import type { Project } from "../../protocol/types";
import { undo } from "../../store/actions";
import { paneVisible } from "../../lib/keyboard";
import { showToast, type ToastAction } from "../common/ToastHost";

/** projectChanged echo grace period after the transport leaves "recording". */
const SETTLE_MS = 600;

function collectClipIds(p: Project | null): Set<number> {
  const ids = new Set<number>();
  if (p) for (const t of p.tracks) for (const c of t.clips) ids.add(c.id);
  return ids;
}

function openInPianoRoll(clipId: number, trackId: number): void {
  const s = useStore.getState();
  s.setSelection({ clipIds: [clipId], trackIds: [trackId], noteIds: [] });
  s.setActiveMidiClipId(clipId);
  if (!paneVisible(s.panels, "pianoRoll")) s.setPanels({ bottomTab: "pianoRoll" });
  s.setFocusedPane("pianoRoll");
}

function onRecordingStopped(idsAtStart: Set<number>): void {
  window.setTimeout(() => {
    const s = useStore.getState();
    const p = s.project;
    if (!p) return;
    const fresh = p.tracks.flatMap((t) =>
      t.clips.filter((c) => !idsAtStart.has(c.id)).map((c) => ({ track: t, clip: c })),
    );
    if (fresh.length === 0) return; // armed but nothing landed — stay quiet
    const firstMidi = fresh.find((x) => x.clip.type === "midi");
    const actions: ToastAction[] = [
      { label: "Undo take", onClick: () => void undo().catch(() => {}) },
    ];
    if (firstMidi) {
      actions.push({
        label: "Open in Piano Roll",
        onClick: () => openInPianoRoll(firstMidi.clip.id, firstMidi.track.id),
      });
    }
    const what =
      fresh.length === 1
        ? `"${fresh[0].clip.name || (fresh[0].clip.type === "midi" ? "MIDI clip" : "audio clip")}" on ${fresh[0].track.name}`
        : `${fresh.length} clips`;
    showToast(`Take recorded — ${what}`, "success", { actions, durationMs: 12_000 });
  }, SETTLE_MS);
}

/** Install the watcher (idempotent per call site; returns the unsubscribe). */
export function installRecordingToast(): () => void {
  let idsAtStart = new Set<number>();
  return useStore.subscribe((s, prev) => {
    const rec = s.transport.state === "recording";
    const was = prev.transport.state === "recording";
    if (rec && !was) idsAtStart = collectClipIds(s.project);
    else if (!rec && was) onRecordingStopped(idsAtStart);
  });
}
