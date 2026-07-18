/**
 * Automation lane UI state (U1) — which tracks have their lanes expanded and which
 * point-less "extra" lanes were added locally via the lane picker. Local-only zustand
 * store, deliberately NOT in store.ts: lane expansion is per-window view state, never
 * persisted and never engine-authoritative. Also caches plugin/getParams replies so the
 * lane picker (and paramSpecFor labels via cachePluginParamName) ask the engine once
 * per plugin (uid).
 */

import { create } from "zustand";
import { getPluginParams } from "../../store/actions";
import type { PluginInstance, PluginParam } from "../../protocol/types";
import { cachePluginParamName } from "./layout";

interface AutomationUiState {
  /** tracks with their automation lanes expanded */
  expanded: ReadonlySet<number>;
  /** locally added (still point-less) lanes per trackId */
  extraLanes: ReadonlyMap<number, readonly string[]>;
  setExpanded(trackId: number, on: boolean): void;
  addExtraLane(trackId: number, paramRef: string): void;
  removeExtraLane(trackId: number, paramRef: string): void;
}

export const useAutomationUi = create<AutomationUiState>((set) => ({
  expanded: new Set<number>(),
  extraLanes: new Map<number, readonly string[]>(),

  setExpanded: (trackId, on) =>
    set((s) => {
      if (s.expanded.has(trackId) === on) return s;
      const expanded = new Set(s.expanded);
      if (on) expanded.add(trackId);
      else expanded.delete(trackId);
      return { expanded };
    }),

  addExtraLane: (trackId, paramRef) =>
    set((s) => {
      const cur = s.extraLanes.get(trackId) ?? [];
      if (cur.includes(paramRef)) return s;
      const extraLanes = new Map(s.extraLanes);
      extraLanes.set(trackId, [...cur, paramRef]);
      return { extraLanes };
    }),

  removeExtraLane: (trackId, paramRef) =>
    set((s) => {
      const cur = s.extraLanes.get(trackId) ?? [];
      if (!cur.includes(paramRef)) return s;
      const extraLanes = new Map(s.extraLanes);
      const next = cur.filter((r) => r !== paramRef);
      if (next.length > 0) extraLanes.set(trackId, next);
      else extraLanes.delete(trackId);
      return { extraLanes };
    }),
}));

/* ============================================================================
 * plugin/getParams cache — lane picker submenus & param display names
 * ========================================================================= */

/**
 * Keyed by plugin uid, NOT instanceId: instance ids restart per project, so an
 * instanceId-keyed cache goes stale (collides) across project loads. Param ids/names —
 * the only fields consumed from this cache — are properties of the plugin itself.
 */
const paramsCache = new Map<string, PluginParam[]>();

/** Fetch (once per plugin uid) and cache its params; feeds the layout name cache. */
export async function pluginParamsFor(ins: PluginInstance): Promise<PluginParam[]> {
  const cached = paramsCache.get(ins.uid);
  if (cached) return cached;
  const { params } = await getPluginParams(ins.instanceId);
  for (const p of params) cachePluginParamName(ins.uid, p.id, p.name);
  paramsCache.set(ins.uid, params);
  return params;
}
