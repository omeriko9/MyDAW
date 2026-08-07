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

import { useStore } from "../../store/store";
import { addPlugin, addTrack, removePlugin, setTrack } from "../../store/actions";
import type { PluginInfo, Project, Track } from "../../protocol/types";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";

function liveTrack(trackId: number): Track | undefined {
  return useStore.getState().project?.tracks.find((t) => t.id === trackId);
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
  const cur = instrumentInsertOfTrack(live);
  if (cur?.uid === p.uid) return; // already this instrument
  void (async () => {
    const idx = cur ? live.inserts.findIndex((i) => i.instanceId === cur.instanceId) : 0;
    await addPlugin(live.id, p.uid, Math.max(0, idx));
    if (cur) await removePlugin(live.id, cur.instanceId);
  })().catch((e) => console.warn("[timeline] instrument replace failed:", e));
}

/**
 * MIDI track gets its own instrument — Cubase behavior (Omer, 2026-08-07): the track
 * CONVERTS to an Instrument track in place (clips, sends, routing kept) and hosts the
 * plugin itself. No separate host track is minted anymore; shared/multitimbral hosts
 * remain the Instrument Rack's job (routeMidiToInstrument).
 */
export function assignInstrumentToFeeder(feederId: number, p: PluginInfo): void {
  void (async () => {
    await setTrack(feederId, { kind: "instrument" });
    await addPlugin(feederId, p.uid);
  })().catch((e) => console.warn("[timeline] assign instrument failed:", e));
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
