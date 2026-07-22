/**
 * PluginLoadingChip (status bar) — persistent, NON-blocking "a plug-in is still
 * loading" indicator, driven by event/pluginState (store.pluginStates).
 *
 * Complements PluginLoadOverlay: the overlay covers batch loads (project open /
 * recreate) and deliberately hides after a 60s stall — but a sampler pulling
 * 11 GB into RAM can legitimately take minutes. This chip shows for EVERY
 * instance in "loading" state, for as long as it truly loads: spinner, plug-in
 * name, elapsed seconds; several at once collapse to a count with the details
 * in the tooltip. A short green "Loaded <name>" flash confirms completion.
 */

import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../../store/store";
import { Icon } from "../common/icons";

const DONE_FLASH_MS = 1800;

/** Insert name for an instanceId (project mirror), else derived from the event. */
function nameOf(instanceId: number): string {
  const s = useStore.getState();
  const p = s.project;
  if (p) {
    for (const t of [...p.tracks, p.masterTrack]) {
      const i = t.inserts.find((x) => x.instanceId === instanceId);
      if (i) return i.name;
    }
  }
  const msg = s.pluginStates[instanceId]?.message ?? "";
  return msg.replace(/^loading\s+/i, "") || `plug-in #${instanceId}`;
}

/** Loading start times — module scope so remounts don't reset the elapsed clock. */
const startedAt = new Map<number, number>();

export default function PluginLoadingChip() {
  const pluginStates = useStore((s) => s.pluginStates);
  const [, setTick] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLoading = useRef<Set<number>>(new Set());

  const loadingIds = Object.values(pluginStates)
    .filter((p) => p.state === "loading")
    .map((p) => p.instanceId);

  // Track start times + detect load completions (loading -> ok) for the flash.
  useEffect(() => {
    const now = Date.now();
    const cur = new Set(loadingIds);
    for (const id of cur) if (!startedAt.has(id)) startedAt.set(id, now);
    for (const id of prevLoading.current) {
      if (!cur.has(id)) {
        const ended = pluginStates[id];
        startedAt.delete(id);
        if (ended?.state === "ok") {
          setDone(nameOf(id));
          if (doneTimer.current) clearTimeout(doneTimer.current);
          doneTimer.current = setTimeout(() => {
            doneTimer.current = null;
            setDone(null);
          }, DONE_FLASH_MS);
        }
      }
    }
    prevLoading.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginStates]);

  // 1 Hz elapsed-time repaint while anything loads.
  useEffect(() => {
    if (loadingIds.length === 0) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [loadingIds.length]);

  useEffect(
    () => () => {
      if (doneTimer.current) clearTimeout(doneTimer.current);
    },
    [],
  );

  if (loadingIds.length === 0) {
    if (done === null) return null;
    return (
      <span className="sb-item sb-plugload done" title="Plug-in finished loading">
        <Icon name="check" size={12} />
        <span className="ellipsis">Loaded {done}</span>
      </span>
    );
  }

  const now = Date.now();
  const elapsed = (id: number): number =>
    Math.max(0, Math.round((now - (startedAt.get(id) ?? now)) / 1000));
  const longest = Math.max(...loadingIds.map(elapsed));
  const label =
    loadingIds.length === 1
      ? `Loading ${nameOf(loadingIds[0])}…`
      : `Loading ${loadingIds.length} plug-ins…`;
  const title =
    loadingIds.map((id) => `${nameOf(id)} — ${elapsed(id)}s`).join("\n") +
    "\nLarge sample libraries can take minutes; the app stays usable meanwhile.";

  return (
    <span className="sb-item sb-plugload" title={title}>
      <span className="sb-plug-spin">
        <Icon name="refresh" size={12} />
      </span>
      <span className="ellipsis">{label}</span>
      <span className="mono dim">{longest}s</span>
    </span>
  );
}
