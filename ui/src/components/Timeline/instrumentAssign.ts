/**
 * Instrument assignment for tracks — the ONE implementation behind the header
 * dropdown pickers and the Browser-plugin drag-drops (headers + arrangement rows).
 *
 * Semantics (mirrors Cubase's mental model):
 *  - instrument track: replace its instrument insert in place (add at the same
 *    index, then remove the old instance — the SPEC §5.6 no-replace-command idiom);
 *  - unrouted MIDI track: create an Instrument track named after the plugin,
 *    load it, and point the feeder's midiTarget at it.
 *
 * Every entry point re-resolves live state from the store at call time (menus and
 * drops are deferred — a projectChanged in between must not double-apply).
 */

import { useSyncExternalStore } from "react";
import { useStore } from "../../store/store";
import { addPlugin, addTrack, removePlugin, setTrack } from "../../store/actions";
import type { PluginInfo, Project, Track } from "../../protocol/types";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";

function liveTrack(trackId: number): Track | undefined {
  return useStore.getState().project?.tracks.find((t) => t.id === trackId);
}

/* ============================================================================
 * In-flight registry (Omer, 2026-08-07: "some can take time, add a small
 * spinning thingy … so the user won't try to do the same action again")
 *
 * cmd/plugin.add does not reply until the engine has spawned the host AND the
 * plug-in finished init — for Kontakt/Addictive Drums that is seconds. During
 * that window the new instanceId does not exist yet, so store.pluginStates has
 * NOTHING to show: the promise itself is the only truth. Module-level +
 * useSyncExternalStore (same pattern as ToastHost) so any flow can mark a track
 * busy without prop-drilling.
 * ========================================================================= */

const busyTracks = new Set<number>();
const busySubs = new Set<() => void>();
let busyVersion = 0;

function emitBusy(): void {
  busyVersion++;
  for (const cb of [...busySubs]) cb();
}

/** Run `fn` with `trackId` marked busy; always clears, success or failure. */
export async function withInstrumentBusy<T>(trackId: number, fn: () => Promise<T>): Promise<T> {
  busyTracks.add(trackId);
  emitBusy();
  try {
    return await fn();
  } finally {
    busyTracks.delete(trackId);
    emitBusy();
  }
}

export function subscribeInstrumentBusy(cb: () => void): () => void {
  busySubs.add(cb);
  return () => {
    busySubs.delete(cb);
  };
}

export const instrumentBusyVersion = (): number => busyVersion;
export const isInstrumentBusy = (trackId: number): boolean => busyTracks.has(trackId);

/**
 * A predicate for "is this track's instrument being swapped/loaded right now" —
 * one hook call for a whole list of rows (a per-row hook would break the rules
 * of hooks). Combines the in-flight command above with the engine's own
 * "loading" state for inserts that already exist (event/pluginState): the first
 * covers the add round-trip (during which no instanceId exists yet), the second
 * a plug-in still streaming samples after it replied.
 */
export function useInstrumentBusyCheck(): (trackId: number) => boolean {
  useSyncExternalStore(subscribeInstrumentBusy, instrumentBusyVersion, () => 0);
  const pluginStates = useStore((s) => s.pluginStates);
  const project = useStore((s) => s.project);
  return (trackId: number) => {
    if (busyTracks.has(trackId)) return true;
    const t = project?.tracks.find((x) => x.id === trackId);
    return !!t && t.inserts.some((i) => pluginStates[i.instanceId]?.state === "loading");
  };
}

/**
 * The track's instrument insert: registry-confirmed instruments win; a dormant
 * imported insert (uid unknown to the registry) in the FIRST slot counts too —
 * otherwise assigning would STACK a second instrument in front of it.
 */
export function instrumentInsertOfTrack(t: Track) {
  const registry = useStore.getState().registry;
  const known = t.inserts.find((ins) => {
    const info = registry.find((p) => p.uid === ins.uid);
    return info ? info.isInstrument : false;
  });
  if (known) return known;
  const first = t.inserts[0];
  if (first && !registry.some((p) => p.uid === first.uid)) return first;
  return undefined;
}

/** MIDI feeders currently sharing an instrument host. */
export function instrumentFeeders(project: Project, hostId: number): Track[] {
  return project.tracks.filter((t) => t.kind === "midi" && t.midiTarget === hostId);
}

/** Route a MIDI track to an existing host (0 disconnects it). */
export function routeMidiToInstrument(feederId: number, hostId: number): void {
  void setTrack(feederId, { midiTarget: hostId }).catch((e) =>
    console.warn("[timeline] instrument routing failed:", e),
  );
}

/** Create one instrument host and return it after the plug-in has been loaded. */
export async function createInstrumentHost(p: PluginInfo): Promise<Track> {
  const { track: inst } = await addTrack("instrument");
  await setTrack(inst.id, { name: p.name });
  await addPlugin(inst.id, p.uid);
  return liveTrack(inst.id) ?? { ...inst, name: p.name };
}

/** Replace (or set) the instrument ON `trackId` (an instrument track). */
export function replaceInstrumentOn(trackId: number, p: PluginInfo): void {
  const live = liveTrack(trackId);
  if (!live || live.frozen) return;
  if (isInstrumentBusy(trackId)) return; // a swap is already loading — ignore the re-click
  const cur = instrumentInsertOfTrack(live);
  if (cur?.uid === p.uid) return; // already this instrument
  void withInstrumentBusy(trackId, async () => {
    const idx = cur ? live.inserts.findIndex((i) => i.instanceId === cur.instanceId) : 0;
    await addPlugin(live.id, p.uid, Math.max(0, idx));
    if (cur) await removePlugin(live.id, cur.instanceId);
  }).catch((e) => console.warn("[timeline] instrument replace failed:", e));
}

/**
 * MIDI track gets its own instrument — Cubase behavior (Omer, 2026-08-07): the track
 * CONVERTS to an Instrument track in place (clips, sends, routing kept) and hosts the
 * plugin itself. No separate host track is minted anymore; shared/multitimbral hosts
 * remain the Instrument Rack's job (routeMidiToInstrument).
 */
export function assignInstrumentToFeeder(feederId: number, p: PluginInfo): void {
  if (isInstrumentBusy(feederId)) return;
  void withInstrumentBusy(feederId, async () => {
    await setTrack(feederId, { kind: "instrument" });
    await addPlugin(feederId, p.uid);
  }).catch((e) => console.warn("[timeline] assign instrument failed:", e));
}

/**
 * Safe Browser-drop chooser for a MIDI track. Reusing an already-loaded matching
 * instance is first-class; creating a private instance is the non-destructive choice.
 * Replacing a shared host remains available, but explicitly names its blast radius.
 */
export function openInstrumentDropChoices(
  feederId: number,
  p: PluginInfo,
  x: number,
  y: number,
): boolean {
  if (!p.isInstrument) return false;
  const project = useStore.getState().project;
  const feeder = project?.tracks.find((t) => t.id === feederId);
  if (!project || !feeder || feeder.kind !== "midi") return false;
  const current = feeder.midiTarget
    ? project.tracks.find((t) => t.id === feeder.midiTarget && t.kind === "instrument")
    : undefined;
  const matching = project.tracks.filter(
    (t) => t.kind === "instrument" && instrumentInsertOfTrack(t)?.uid === p.uid,
  );
  const items: MenuEntry[] = [
    { label: `Use ${p.name}`, disabled: true },
    ...matching.map((host): MenuEntry => ({
      label: `${host.name} · existing instance`,
      icon: "link",
      checked: current?.id === host.id,
      onClick: () => routeMidiToInstrument(feeder.id, host.id),
    })),
    ...(matching.length > 0 ? (["separator"] as MenuEntry[]) : []),
    {
      label: "Load on this track (becomes an Instrument track)",
      icon: "piano",
      title: "Cubase-style: the MIDI track converts in place and hosts the instrument itself",
      onClick: () => assignInstrumentToFeeder(feeder.id, p),
    },
  ];
  const currentInsert = current ? instrumentInsertOfTrack(current) : undefined;
  if (current && currentInsert?.uid !== p.uid) {
    const count = instrumentFeeders(project, current.id).length;
    items.push(
      "separator",
      {
        label: `Replace ${current.name} for ${count} MIDI track${count === 1 ? "" : "s"}`,
        icon: "warning",
        danger: true,
        disabled: !!current.frozen,
        title: current.frozen ? "Unfreeze the instrument host first" : undefined,
        onClick: () => replaceInstrumentOn(current.id, p),
      },
    );
  }
  openContextMenu(x, y, items);
  return true;
}
