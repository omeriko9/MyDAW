/**
 * Focused-pane indicator (UI_IMPROVE.md §6.4) — keyboard shortcuts route to an
 * invisible-ish focus state (store.focusedPane + visibility fallbacks); this hook
 * exposes "keys route HERE" per pane so each root can show the accent strip
 * (theme.css [data-key-target]). The same key (Delete, Ctrl+A) does different
 * things depending on this state, so it must be visible.
 */

import { useStore } from "../../store/store";
import { keyRoutingPane, type KeyContextName } from "../../lib/keyboard";

/** True when keyboard shortcuts currently route to the named pane. */
export function useIsKeyTarget(name: KeyContextName): boolean {
  return useStore((s) => keyRoutingPane(s) === name);
}
