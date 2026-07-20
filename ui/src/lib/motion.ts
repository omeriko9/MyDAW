/**
 * Interface-motion preference (owned by F4) — full / reduced / off.
 *
 * The motion system lives in CSS custom properties (theme.css §motion): every
 * transition/animation duration in the app resolves through --dur-fast / --dur-med /
 * --dur-move. This module stamps data-motion on the document root (main window +
 * pop-out panes, like lib/theme does for data-theme); the stamped value zeroes the
 * relevant tokens:
 *
 *   full     everything (default)
 *   reduced  color/opacity fades only — movement (--dur-move) is zeroed
 *   off      no transitions or animations at all
 *
 * The OS-level `prefers-reduced-motion: reduce` setting demotes "full" to "reduced"
 * automatically (the user's explicit "off" is already stronger). The stored pref is
 * the user's choice; the stamped attribute is the effective value.
 */

import { useEffect, useState } from "react";
import { loadPref, oneOf, savePref } from "./prefs";

export type MotionPref = "full" | "reduced" | "off";

/** window CustomEvent fired (on the MAIN window) after the motion pref changed. */
export const MOTION_EVENT = "mydaw:motionchange";

export const MOTION_OPTIONS: Array<{ value: MotionPref; label: string }> = [
  { value: "full", label: "Full" },
  { value: "reduced", label: "Reduced" },
  { value: "off", label: "Off" },
];

const isMotionPref = oneOf<MotionPref>("full", "reduced", "off");

let current: MotionPref = loadPref<MotionPref>("ui.motion", "full", isMotionPref);

const osReduced =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/** Pop-out documents that must be stamped along with the main one. */
const extraDocs = new Set<Document>();

function effective(pref: MotionPref): MotionPref {
  return pref === "full" && osReduced?.matches ? "reduced" : pref;
}

function stamp(doc: Document): void {
  doc.documentElement.dataset.motion = effective(current);
}

function stampAll(): void {
  stamp(document);
  for (const doc of extraDocs) {
    try {
      stamp(doc);
    } catch {
      /* popup already destroyed — unregister happens via its dispose */
    }
  }
}

export function getMotionPref(): MotionPref {
  return current;
}

/**
 * The EFFECTIVE motion level (pref + OS reduced-motion demotion) — what data-motion
 * is stamped with. JS-driven movement (smooth scrolling, viewport animation) should
 * run only when this returns "full", mirroring what --dur-move does in CSS.
 */
export function getEffectiveMotion(): MotionPref {
  return effective(current);
}

/**
 * Track a pop-out document: stamped immediately and on every later change.
 * Returns the unregister function (call from the pop-out's dispose).
 */
export function registerMotionDocument(doc: Document): () => void {
  extraDocs.add(doc);
  stamp(doc);
  return () => {
    extraDocs.delete(doc);
  };
}

export function applyMotionPref(pref: MotionPref): void {
  current = pref;
  savePref("ui.motion", pref);
  stampAll();
  window.dispatchEvent(new CustomEvent(MOTION_EVENT));
}

/** Apply the persisted pref to the main document (idempotent; called at startup). */
export function initMotion(): void {
  stampAll();
  // Follow live OS setting changes while the app runs.
  osReduced?.addEventListener?.("change", stampAll);
}

/** React hook — current motion pref as state (re-renders on switch). */
export function useMotionPref(): MotionPref {
  const [pref, setPref] = useState<MotionPref>(current);
  useEffect(() => {
    const on = () => setPref(current);
    window.addEventListener(MOTION_EVENT, on);
    return () => window.removeEventListener(MOTION_EVENT, on);
  }, []);
  return pref;
}
