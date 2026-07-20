/**
 * ShortcutsDialog — keyboard-shortcut cheat sheet (store.dialogs.shortcuts; opened by
 * the "?" key or Help → Keyboard Shortcuts…). The table mirrors lib/keyboard.ts — keep
 * the two in sync when bindings change.
 */

import React from "react";
import { useStore } from "../../store/store";
import { Modal } from "../common/Modal";

interface Binding {
  keys: string[];
  what: string;
}

const GROUPS: Array<{ title: string; items: Binding[] }> = [
  {
    title: "Transport",
    items: [
      { keys: ["Space"], what: "Play / stop" },
      { keys: ["R"], what: "Record" },
      { keys: ["L"], what: "Loop on/off" },
      { keys: ["P"], what: "Set loop to the selected clips" },
      { keys: ["C"], what: "Metronome on/off" },
      { keys: ["J"], what: "Follow playhead (auto-scroll)" },
      { keys: ["+", "−"], what: "Nudge playhead by one grid step (hold to scrub)" },
      { keys: ["Home"], what: "Jump to project start" },
      { keys: ["End"], what: "Jump to project end" },
    ],
  },
  {
    title: "Numpad (classic DAW layout)",
    items: [
      { keys: ["Enter"], what: "Start playback" },
      { keys: ["0"], what: "Stop" },
      { keys: ["*"], what: "Record" },
      { keys: ["/"], what: "Loop on/off" },
      { keys: ["1", "2"], what: "Jump to loop start / end" },
      { keys: ["."], what: "Jump to project start" },
    ],
  },
  {
    title: "Editing",
    items: [
      { keys: ["Ctrl+Z"], what: "Undo" },
      { keys: ["Ctrl+Y", "Ctrl+Shift+Z"], what: "Redo" },
      { keys: ["Ctrl+X", "Ctrl+C", "Ctrl+V"], what: "Cut / copy / paste (paste at playhead)" },
      { keys: ["Ctrl+D"], what: "Duplicate selection" },
      { keys: ["Delete"], what: "Delete selection (clips or notes)" },
      { keys: ["Ctrl+A"], what: "Select all (focused pane)" },
      { keys: ["B"], what: "Split selected clips at playhead" },
      { keys: ["Q"], what: "Quantize to grid (selected notes or MIDI clips)" },
      { keys: ["←", "→"], what: "Nudge clips / move notes by a grid step (Shift = bar / fine)" },
      { keys: ["↑", "↓"], what: "Transpose selected notes a semitone (Shift = octave)" },
      { keys: ["M"], what: "Mute selected tracks / clips" },
      { keys: ["S"], what: "Solo selected tracks" },
      { keys: ["Esc"], what: "Clear selection / cancel gesture" },
      { keys: ["Ctrl+S"], what: "Save project" },
      { keys: ["Ctrl+Shift+S"], what: "Save project as…" },
      { keys: ["Ctrl+I"], what: "Import project (.cpr / MIDI)" },
    ],
  },
  {
    title: "Tools & view",
    items: [
      { keys: ["1", "2", "3", "4"], what: "Tool: select / draw / erase / split" },
      { keys: ["G", "H"], what: "Zoom out / in (focused pane)" },
      { keys: ["Shift+G", "Shift+H"], what: "Vertical zoom out / in" },
      { keys: ["F"], what: "Zoom to fit — selection if any, else everything" },
      { keys: ["Ctrl+K"], what: "Command palette — run any command, jump to bar / marker / track" },
      { keys: ["Ctrl+Alt+1…4"], what: "Apply layout preset (Shift saves the current workspace)" },
      { keys: ["Ctrl+Shift+I"], what: "Agent panel" },
      { keys: ["?"], what: "This cheat sheet" },
    ],
  },
  {
    title: "Mouse",
    items: [
      { keys: ["2×click"], what: "Empty MIDI track lane: create a clip + open the piano roll" },
      { keys: ["2×click"], what: "MIDI clip: open in piano roll · audio clip: clip editor" },
      { keys: ["2×click"], what: "Empty piano-roll grid: add a note (select tool)" },
      { keys: ["Right-click"], what: "Tools + actions for whatever is under the cursor" },
      { keys: ["Drag"], what: "Arrangement empty space: rubber-band select (Shift/Ctrl adds)" },
      { keys: ["Ctrl+click", "Alt+click"], what: "Ruler: set loop start / loop end" },
      { keys: ["Right-drag"], what: "Arrangement: pan the grid (middle-drag pans too)" },
      { keys: ["Drag"], what: "Draw tool (2): drag out MIDI clips / notes" },
      { keys: ["Shift"], what: "Hold while dragging to bypass snap" },
      { keys: ["Drag"], what: "Mixer insert: reorder in the channel · onto another channel: move" },
      { keys: ["Alt+drag"], what: "Mixer insert onto another channel: copy (with settings)" },
      { keys: ["Drag"], what: "Mixer insert dropped outside the strips: remove (Esc cancels)" },
    ],
  },
];

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
        {GROUPS.map((g) => (
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
