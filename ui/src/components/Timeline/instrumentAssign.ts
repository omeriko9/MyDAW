/**
 * Instrument assignment for tracks — the ONE implementation behind the header
 * dropdown pickers and the Browser-plugin drag-drops (headers + arrangement rows).
 *
 * Semantics (mirrors Cubase's mental model):
 *  - instrument track: replace its instrument insert in place (add at the same
 *    index, then remove the old instance — the SPEC §5.6 no-replace-command idiom);
 *  - routed MIDI track: the instrument lives on the HOST — replace it there;
 *  - unrouted MIDI track: create an Instrument track named after the plugin,
 *    load it, and point the feeder's midiTarget at it.
 *
 * Every entry point re-resolves live state from the store at call time (menus and
 * drops are deferred — a projectChanged in between must not double-apply).
 */

import { useStore } from "../../store/store";
import { addPlugin, addTrack, removePlugin, setTrack } from "../../store/actions";
import type { PluginInfo, Track } from "../../protocol/types";

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

/** Unrouted MIDI track: create an Instrument track hosting `p` and route into it. */
export function assignInstrumentToFeeder(feederId: number, p: PluginInfo): void {
  void (async () => {
    const { track: inst } = await addTrack("instrument");
    await setTrack(inst.id, { name: p.name });
    await addPlugin(inst.id, p.uid);
    await setTrack(feederId, { midiTarget: inst.id });
  })().catch((e) => console.warn("[timeline] assign instrument failed:", e));
}

/**
 * Give an INSTRUMENT plugin to any track that can take one. Returns false when the
 * combination makes no sense (effect plugin, or a frozen target) so callers can
 * fall back to their default behavior / explain via toast.
 */
export function assignInstrumentToTrack(t: Track, p: PluginInfo): boolean {
  if (!p.isInstrument) return false;
  if (t.kind === "instrument") {
    if (t.frozen) return false;
    replaceInstrumentOn(t.id, p);
    return true;
  }
  if (t.kind !== "midi") return false;
  const host = t.midiTarget ? liveTrack(t.midiTarget) : undefined;
  if (host) {
    if (host.frozen) return false;
    replaceInstrumentOn(host.id, p);
  } else {
    assignInstrumentToFeeder(t.id, p);
  }
  return true;
}
