/**
 * Automation lane UI state (U1) — which tracks have their lanes expanded and which
 * point-less "extra" lanes were added locally via the lane picker. Local-only zustand
 * store, deliberately NOT in store.ts: lane expansion is per-window view state, never
 * persisted and never engine-authoritative. Also caches plugin/getParams replies so the
 * lane picker (and paramSpecFor labels via cachePluginParamName) ask the engine once
 * per plugin (uid).
 */

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { getPluginParams } from "../../store/actions";
import { useStore } from "../../store/store";
import type { PluginInstance, PluginParam, Project } from "../../protocol/types";
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
 * reveal-on-write
 * ========================================================================= */

/**
 * Expand a track's lanes the moment automation is WRITTEN into a lane it did not have
 * (SPEC §5.4). Without this, arming W and moving a fader — or a knob in a plugin's own
 * editor window — produced no visible feedback whatsoever: the lane existed in the model
 * but stayed hidden until someone thought to press "A", which is exactly how the feature
 * read as broken.
 *
 * Deliberately narrow: it only fires while the transport is ROLLING and that track is
 * actually armed (its own W, or the transport's master arm). Loading a project, undo, or
 * any ordinary edit therefore never force-expands anything — a track is only opened at
 * the moment the user's own gesture put something new in it.
 */
export function useRevealWrittenLanes(project: Project | null): void {
  const rolling = useStore((s) => s.transport.state !== "stopped");
  const masterArm = useStore((s) => s.automationWrite);
  // Per-track lane refs as of the previous project we saw. A track absent from this map
  // has never been compared (fresh load / newly created), so it can't count as "gained".
  const seen = useRef<Map<number, ReadonlySet<string>>>(new Map());

  useEffect(() => {
    const next = new Map<number, ReadonlySet<string>>();
    for (const t of project?.tracks ?? []) {
      const refs = new Set((t.automation ?? []).map((l) => l.paramRef));
      next.set(t.id, refs);
      const before = seen.current.get(t.id);
      if (!before || !rolling || !(masterArm || t.automationWrite === true)) continue;
      for (const ref of refs) {
        if (before.has(ref)) continue;
        useAutomationUi.getState().setExpanded(t.id, true);
        break;
      }
    }
    seen.current = next;
  }, [project, rolling, masterArm]);
}

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
