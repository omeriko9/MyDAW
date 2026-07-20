/**
 * ShortcutsDialog — keyboard-shortcut cheat sheet (store.dialogs.shortcuts; opened by
 * the "?" key or Help → Keyboard Shortcuts…). Renders lib/shortcutTable.ts — the
 * single display source of truth for bindings (UI_IMPROVE.md §7.2).
 */

import React from "react";
import { useStore } from "../../store/store";
import { SHORTCUT_GROUPS } from "../../lib/shortcutTable";
import { Modal } from "../common/Modal";

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="shk-keys">
      {keys.map((k, i) => (
        <React.Fragment key={k}>
          {i > 0 ? <span className="dim"> / </span> : null}
          <kbd className="shk-kbd">{k}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

export default function ShortcutsDialog() {
  const open = useStore((s) => s.dialogs.shortcuts);
  const setDialogs = useStore((s) => s.setDialogs);

  return (
    <Modal
      open={open}
      onClose={() => setDialogs({ shortcuts: false })}
      title="Keyboard Shortcuts"
      width={720}
    >
      <div className="shk-grid">
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title} className="shk-group">
            <div className="shk-title">{g.title}</div>
            {g.items.map((b) => (
              <div key={b.what} className="shk-row">
                <Keys keys={b.keys} />
                <span className="shk-what">{b.what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="shk-note dim">
        Shortcuts route to the focused pane (timeline, piano roll, clip editor) first — click a
        pane to focus it. Keys are inactive while typing in a text field.
      </div>
    </Modal>
  );
}
