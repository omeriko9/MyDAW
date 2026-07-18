/**
 * openEditor — "just open the plugin's UI", picking the right one.
 *
 * A plugin either has a native editor window or it does not, and the user should not have
 * to know which before double-clicking it. The engine only reports `hasEditor` for a LIVE
 * instance (it comes from the host process's effFlagsHasEditor / createView probe), so the
 * honest test is to ask it to open and fall back when it says no — which is also one round
 * trip instead of two.
 *
 * Built-ins and dormant inserts skip the attempt: built-ins are drawn in-app by design
 * (some have bespoke panels), and a dormant insert has no host process to ask.
 */

import { openPluginEditor } from "../../store/actions";
import { useStore } from "../../store/store";

export interface EditorTarget {
  instanceId: number;
  format?: string;
  /** Empty on an insert whose plugin was never (re)loaded — nothing to open natively. */
  path?: string;
}

/** True when this insert can only be shown with the in-app editor. */
export function inAppOnly(ins: EditorTarget): boolean {
  return ins.format === "builtin" || (ins.format !== "builtin" && ins.path === "");
}

/** Open the in-app (generic / custom panel) editor window. */
export function openInAppEditor(instanceId: number): void {
  useStore.getState().openPluginEditorWindow(instanceId);
}

/**
 * Open the plugin's native window if it has one, else the in-app editor.
 * Never rejects — falling back IS the success path for plugins without an editor.
 */
export async function openBestEditor(ins: EditorTarget): Promise<"native" | "in-app"> {
  if (inAppOnly(ins)) {
    openInAppEditor(ins.instanceId);
    return "in-app";
  }
  try {
    await openPluginEditor(ins.instanceId);
    return "native";
  } catch {
    openInAppEditor(ins.instanceId);
    return "in-app";
  }
}
