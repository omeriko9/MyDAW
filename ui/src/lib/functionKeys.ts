/** User preference for DAW function keys versus preserving browser F3/F11. */

import { loadPref, oneOf } from "./prefs";

export type FunctionKeyMode = "direct" | "shifted";
export const FUNCTION_KEY_MODE_PREF = "ui.functionKeyMode";
export const FUNCTION_KEY_MODE_DEFAULT: FunctionKeyMode = "direct";
export const isFunctionKeyMode = oneOf<FunctionKeyMode>("direct", "shifted");

export function functionKeyMode(): FunctionKeyMode {
  return loadPref(
    FUNCTION_KEY_MODE_PREF,
    FUNCTION_KEY_MODE_DEFAULT,
    isFunctionKeyMode,
  );
}

export function matchesDawFunctionKey(
  event: Pick<KeyboardEvent, "code" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
  code: "F3" | "F11",
  mode = functionKeyMode(),
): boolean {
  return (
    event.code === code &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.shiftKey === (mode === "shifted")
  );
}
