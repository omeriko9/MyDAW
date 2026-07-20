/**
 * QuickHelpOverlay (UI_IMPROVE.md §7.3) — translucent card shown while "?" is
 * HELD, listing the key-routing pane's gestures and modifiers (shortcutTable
 * PANE_HINTS). Purely informational: pointer-events none, no modal-overlay
 * class (the keyboard stays live — transport keeps working under it). A quick
 * tap of "?" opens the full cheat sheet instead (lib/keyboard decides).
 */

import React from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store/store";
import { PANE_HINTS } from "../../lib/shortcutTable";

export default function QuickHelpOverlay() {
  const pane = useStore((s) => s.dialogs.quickHelp);
  if (pane === null) return null;
  const hints = PANE_HINTS[pane];
  return createPortal(
    <div className="qh-overlay">
      <div className="qh-card">
        <div className="qh-title">
          {hints.title}
          <span className="qh-title-note">keys route here</span>
        </div>
        <div className="qh-rows">
          {hints.items.map((b) => (
            <div key={b.what} className="qh-row">
              <span className="qh-keys">
                {b.keys.map((k, i) => (
                  <React.Fragment key={k}>
                    {i > 0 ? <span className="qh-sep">/</span> : null}
                    <kbd className="qh-kbd">{k}</kbd>
                  </React.Fragment>
                ))}
              </span>
              <span className="qh-what">{b.what}</span>
            </div>
          ))}
        </div>
        <div className="qh-foot">release ? to close · quick tap opens the full cheat sheet</div>
      </div>
    </div>,
    document.body,
  );
}
