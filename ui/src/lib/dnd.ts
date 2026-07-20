/**
 * Drag & drop glue (owned by U2) — pinned cross-module contract.
 *
 * Three internal drag payloads travel through the HTML5 DataTransfer:
 *   - plugins dragged from the Browser onto tracks / mixer insert slots
 *     (PLUGIN_MIME, payload {uid}),
 *   - project assets dragged from the Browser onto the timeline
 *     (ASSET_MIME, payload {assetId}),
 *   - existing mixer inserts dragged between channel strips (INSERT_MIME, Cubase-style:
 *     drag = move, Alt+drag = copy with settings, drop on nothing = remove — see the
 *     insert-drag section for the outcome state machine).
 *
 * NOTE: DataTransfer.getData() only works inside `drop` handlers — during `dragover`
 * use hasPluginDrag/hasAssetDrag (which check dt.types) to decide whether to accept.
 *
 * uploadFiles() is the OS-file drop path: POST /api/upload multipart (field "files"),
 * `trackId`/`atBeat` as query params — same effect as media/import (SPEC §5.5).
 */

import { HttpApi } from "../protocol/types";
import type { Asset } from "../protocol/types";

export const PLUGIN_MIME = "application/x-mydaw-plugin";
export const ASSET_MIME = "application/x-mydaw-asset";
export const INSERT_MIME = "application/x-mydaw-insert";

/* ============================================================================
 * Insert drag (an EXISTING plugin instance dragged between mixer insert slots)
 * ========================================================================= */

export interface InsertDrag {
  /** track the plugin currently lives on */
  trackId: number;
  instanceId: number;
  /** registry uid — used to re-create the plugin when copying to another track */
  uid: string;
  /** its current slot index on the source track */
  index: number;
}

/**
 * DataTransfer.getData() is unreadable during `dragover`, but the drop EFFECT (move within
 * the same channel vs Alt-copy to another) has to be decided there. Drags never leave the
 * document, so we also stash the payload module-side and peek at it while hovering.
 *
 * Insert-drag OUTCOME tracking (Cubase-style drop-on-nothing removal): while an insert
 * drag is in flight we listen document-wide. A drop that no mixer target consumed
 * (App.tsx's window guard preventDefault()s every dragover, so a release anywhere in the
 * window DOES fire `drop`) means "dropped on nothing" -> the source slot's dragend removes
 * the insert. Escape (tracked via keydown) or a release outside the window must CANCEL
 * instead — dragend's dropEffect is "none" for both, hence this state machine.
 */
let activeInsertDrag: InsertDrag | null = null;
let insertDragOutcome: "pending" | "void" | "cancelled" = "pending";

function onInsertDragKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") cancelInsertDrag();
}

function onInsertDragDocDrop(e: DragEvent): void {
  // Bubble phase: mixer targets stopPropagation() their drops, ClipCanvas lets insert
  // drags through untouched — anything still arriving here landed on "nothing".
  if (e.defaultPrevented) return;
  if (!e.dataTransfer || !hasInsertDrag(e.dataTransfer)) return;
  voidInsertDrag();
}

function installInsertDragListeners(): void {
  if (typeof document === "undefined") return; // node test env
  document.addEventListener("keydown", onInsertDragKeyDown, true);
  document.addEventListener("drop", onInsertDragDocDrop);
}

function uninstallInsertDragListeners(): void {
  if (typeof document === "undefined") return;
  document.removeEventListener("keydown", onInsertDragKeyDown, true);
  document.removeEventListener("drop", onInsertDragDocDrop);
}

export function setInsertDrag(dt: DataTransfer, data: InsertDrag): void {
  activeInsertDrag = data;
  insertDragOutcome = "pending";
  installInsertDragListeners();
  dt.setData(INSERT_MIME, JSON.stringify(data));
  dt.setData("text/plain", data.uid);
  dt.effectAllowed = "copyMove";
}

/** The in-flight insert drag, readable during dragover (null when none). */
export function peekInsertDrag(): InsertDrag | null {
  return activeInsertDrag;
}

/** A mixer drop target consumed the drag — the source slot must NOT remove anything. */
export function clearInsertDrag(): void {
  activeInsertDrag = null;
  insertDragOutcome = "pending";
  uninstallInsertDragListeners();
}

/** Escape (or a programmatic abort): the drag ends without any effect. */
export function cancelInsertDrag(): void {
  insertDragOutcome = "cancelled";
}

/**
 * An in-document drop that no mixer target consumed — "dropped on nothing", so the
 * source slot's dragend removes the insert. Escape wins if it was pressed first.
 * (Called by the document drop listener; exported for unit tests.)
 */
export function voidInsertDrag(): void {
  if (activeInsertDrag !== null && insertDragOutcome === "pending") insertDragOutcome = "void";
}

/** True while an insert drag is in flight AND nothing consumed/cancelled it yet. */
export function insertDragPending(): boolean {
  return activeInsertDrag !== null && insertDragOutcome === "pending";
}

/**
 * Called from the source slot's `dragend`. Returns "remove" when the drag ended on an
 * unhandled in-document drop ("dropped on nothing") — the caller then removes the insert
 * from its source channel. Consumed drops, Escape, and out-of-window releases (no drop
 * event at all, indistinguishable from Escape in Chromium, which suppresses keydown
 * during drags) all return "keep". Resets the drag state either way.
 */
export function endInsertDrag(): "remove" | "keep" {
  const outcome = activeInsertDrag !== null ? insertDragOutcome : "pending";
  clearInsertDrag();
  return outcome === "void" ? "remove" : "keep";
}

/**
 * Drop effect for the in-flight insert drag while hovering a channel target: reordering
 * the source channel is always a move; another channel is Alt-copy or (default) move.
 * Falls back to "copy" when no insert drag is active (e.g. a Browser plugin drag).
 */
export function insertDropEffectFor(targetTrackId: number, alt: boolean): "move" | "copy" {
  const src = activeInsertDrag;
  if (!src) return "copy";
  if (src.trackId === targetTrackId) return "move";
  return alt ? "copy" : "move";
}

export function readInsertDrag(dt: DataTransfer): InsertDrag | null {
  const raw = dt.getData(INSERT_MIME);
  if (!raw) return activeInsertDrag; // some browsers withhold data on same-document drops
  try {
    const p: unknown = JSON.parse(raw);
    if (p !== null && typeof p === "object") {
      const d = p as Partial<InsertDrag>;
      if (
        typeof d.trackId === "number" &&
        typeof d.instanceId === "number" &&
        typeof d.uid === "string" &&
        typeof d.index === "number"
      ) {
        return { trackId: d.trackId, instanceId: d.instanceId, uid: d.uid, index: d.index };
      }
    }
  } catch {
    /* malformed payload */
  }
  return activeInsertDrag;
}

/** dragover-safe check (data itself is unreadable until drop). */
export function hasInsertDrag(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(INSERT_MIME);
}

/**
 * Translate a drop BOUNDARY into cmd/plugin.move's `newIndex` when reordering within one
 * channel.
 *
 * `before` is the gap the plugin is dropped into (0..length, where `length` means "past the
 * last slot"). The engine removes the instance first and then inserts it, so any boundary to
 * the right of its original position shifts left by one. Returns null when the drop is a
 * no-op (dropped back into its own gap).
 */
export function reorderTargetIndex(
  before: number,
  fromIndex: number,
  length: number,
): number | null {
  const target = before > fromIndex ? before - 1 : before;
  const clamped = Math.max(0, Math.min(target, length - 1));
  return clamped === fromIndex ? null : clamped;
}

/* ============================================================================
 * Plugin drag (Browser → track / insert slot)
 * ========================================================================= */

export function setPluginDrag(dt: DataTransfer, data: { uid: string }): void {
  dt.setData(PLUGIN_MIME, JSON.stringify({ uid: data.uid }));
  // Plain-text fallback so dragging into external targets shows something sensible.
  dt.setData("text/plain", data.uid);
  dt.effectAllowed = "copy";
}

/**
 * Custom drag image (UI_IMPROVE.md §5.3): a styled chip with the dragged thing's
 * name, instead of the browser's translucent row snapshot. The element must be
 * IN THE DOM when setDragImage snapshots it — parked offscreen, removed next tick.
 */
export function setDragChip(dt: DataTransfer, label: string, kind: "plugin" | "asset"): void {
  const el = document.createElement("div");
  el.className = `drag-chip drag-chip-${kind}`;
  el.textContent = label;
  document.body.appendChild(el);
  try {
    dt.setDragImage(el, 14, 16);
  } catch {
    /* some engines refuse — the default ghost is fine */
  }
  window.setTimeout(() => el.remove(), 0);
}

export function readPluginDrag(dt: DataTransfer): { uid: string } | null {
  const raw = dt.getData(PLUGIN_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { uid?: unknown }).uid === "string"
    ) {
      return { uid: (parsed as { uid: string }).uid };
    }
  } catch {
    /* malformed payload */
  }
  return null;
}

/** dragover-safe check (data itself is unreadable until drop). */
export function hasPluginDrag(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(PLUGIN_MIME);
}

/* ============================================================================
 * Asset drag (Browser files tab → timeline)
 * ========================================================================= */

export function setAssetDrag(dt: DataTransfer, data: { assetId: number }): void {
  dt.setData(ASSET_MIME, JSON.stringify({ assetId: data.assetId }));
  dt.setData("text/plain", String(data.assetId));
  dt.effectAllowed = "copy";
}

export function readAssetDrag(dt: DataTransfer): { assetId: number } | null {
  const raw = dt.getData(ASSET_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { assetId?: unknown }).assetId === "number" &&
      Number.isFinite((parsed as { assetId: number }).assetId)
    ) {
      return { assetId: (parsed as { assetId: number }).assetId };
    }
  } catch {
    /* malformed payload */
  }
  return null;
}

/** dragover-safe check (data itself is unreadable until drop). */
export function hasAssetDrag(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(ASSET_MIME);
}

/* ============================================================================
 * OS file upload (browser drag-drop / file picker) — POST /api/upload
 * ========================================================================= */

export interface UploadResult {
  assets: Asset[];
  /** clips created when trackId was given (Clip-shaped; typed loosely per pinned contract) */
  clips?: unknown[];
  /** tracks created by .mid imports (Track-shaped) */
  tracks?: unknown[];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Upload local File objects to the engine. Same semantics as media/import:
 * decodes wav/mp3/flac/mid into project assets; creates clips when opts.trackId given
 * (placed at opts.atBeat). Throws Error with a useful message on any failure.
 */
export async function uploadFiles(
  files: File[],
  opts?: { trackId?: number; atBeat?: number },
): Promise<UploadResult> {
  if (files.length === 0) return { assets: [] };

  const params = new URLSearchParams();
  if (opts?.trackId !== undefined) params.set("trackId", String(opts.trackId));
  if (opts?.atBeat !== undefined) params.set("atBeat", String(opts.atBeat));
  const qs = params.toString();
  const url = qs ? `${HttpApi.upload}?${qs}` : HttpApi.upload;

  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: form });
  } catch (e) {
    throw new Error(
      `upload failed: network error (${e instanceof Error ? e.message : String(e)}) — is the engine running?`,
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* body unreadable */
    }
    throw new Error(
      `upload failed: HTTP ${res.status} ${res.statusText}${detail ? ` — ${truncate(detail.trim(), 200)}` : ""}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("upload failed: server returned a non-JSON response");
  }

  const body = (json ?? {}) as { assets?: unknown; clips?: unknown; tracks?: unknown };
  const assets = Array.isArray(body.assets) ? (body.assets as Asset[]) : [];
  const result: UploadResult = { assets };
  if (Array.isArray(body.clips)) result.clips = body.clips;
  if (Array.isArray(body.tracks)) result.tracks = body.tracks;
  return result;
}
