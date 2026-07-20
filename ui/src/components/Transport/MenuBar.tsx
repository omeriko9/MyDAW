/**
 * MenuBar (owned by U2) — File / Edit / Project / Audio / MIDI at the left of the
 * transport bar. SPEC §10 honesty policy: every entry either works or is visibly
 * disabled with a tooltip reason — no dead items.
 *
 * Menus open through the shared ContextMenu (common/ContextMenu.tsx). While one is open,
 * hovering another title slides to it: the ContextMenu overlay swallows pointer events,
 * so the bar hit-tests a window-level pointermove against its title buttons instead.
 *
 * Edit entries dispatch through lib/keyboard's invokeEditAction so the menu and the
 * shortcuts share the same context-aware routing (focused pane first).
 */

import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store/store";
import {
  duplicateTrack,
  exportCpr,
  exportMidi,
  exportTrackArchive,
  getImportFormats,
  panic,
  removeTrack,
} from "../../store/actions";
import { showToast } from "../common/ToastHost";
import { hasClipboard } from "../../lib/clipboard";
import * as keyboardLib from "../../lib/keyboard";
import {
  applyLayoutSlot,
  getLayoutSlots,
  saveLayoutSlot,
  type LayoutSlotIndex,
} from "../../lib/layouts";
import { applyTheme, getTheme, THEMES } from "../../lib/theme";
import { toggleMetronome } from "../../store/metronome";
import { closeContextMenu, openContextMenu } from "../common/ContextMenu";
import type { MenuEntry } from "../common/ContextMenu";
import { Icon, type IconName } from "../common/icons";
import { confirmDialog } from "../Dialogs/confirm";
import { addTrackMenuItems } from "../Timeline/TrackHeaders";
import {
  closeProjectFlow,
  importFilesFlow,
  importProjectFlow,
  loadRecentFlow,
  newProjectFlow,
  newWindowFlow,
  openProjectFlow,
  saveProjectAsFlow,
  saveProjectFlow,
} from "./projectFlows";
import "./menubar.css";

const fire = (p: Promise<unknown>): void => {
  p.catch((e) => console.warn("[menu] command failed:", e));
};

/** Context-aware edit dispatch (focused pane first) — same paths as the shortcuts. */
const invokeEdit = keyboardLib.invokeEditAction;

/* ============================================================================
 * File menu
 * ========================================================================= */

// Supported foreign-project formats (project/getImportFormats) — lazily fetched on first
// menu open, then cached for the session; shown as the Import Project… hover tooltip.
let importFormatsTip: string | null = null;
let importFormatsFetched = false;

function fetchImportFormatsTipOnce(): void {
  if (importFormatsFetched) return;
  importFormatsFetched = true;
  getImportFormats()
    .then(({ formats }) => {
      if (formats.length === 0) return;
      importFormatsTip = formats
        .map((f) => `${f.name} (${f.extensions.map((x) => `.${x}`).join(", ")})`)
        .join("\n");
    })
    .catch(() => {
      importFormatsFetched = false; // tooltip is cosmetic — retry on next menu open
    });
}

function buildFileMenu(): MenuEntry[] {
  const s = useStore.getState();
  const last = s.recentProjects[0];
  const recent: MenuEntry[] =
    s.recentProjects.length > 0
      ? s.recentProjects.map((p) => ({
          label: p.name,
          title: p.path,
          onClick: () => void loadRecentFlow(p.path),
        }))
      : [{ label: "No recent projects", disabled: true }];
  return [
    { label: "New", icon: "plus", onClick: () => void newProjectFlow() },
    {
      label: "New Window",
      icon: "layers",
      title: "Open a second, independent project in a new browser tab (its own audio + undo)",
      onClick: () => void newWindowFlow(),
    },
    { label: "Open…", icon: "folder", onClick: () => void openProjectFlow() },
    {
      label: "Open Last Session",
      icon: "undo",
      title: last ? `Reopen ${last.name}` : "No recent project to reopen",
      disabled: !last,
      onClick: () => last && void loadRecentFlow(last.path),
    },
    { label: "Open Recent", icon: "refresh", submenu: recent },
    {
      label: "Close",
      icon: "close",
      title: "Close the current project — resets to an empty project (the engine has no unloaded state)",
      onClick: () => void closeProjectFlow(),
    },
    "separator",
    { label: "Save", icon: "save", shortcut: "Ctrl+S", onClick: () => void saveProjectFlow() },
    { label: "Save As…", shortcut: "Ctrl+Shift+S", onClick: () => void saveProjectAsFlow() },
    "separator",
    {
      label: "Import",
      icon: "audioWave",
      submenu: [
        { label: "Media Files…", icon: "audioWave", onClick: () => void importFilesFlow() },
        {
          label: "Project (.cpr/.mid)…",
          icon: "import",
          shortcut: "Ctrl+I",
          title: importFormatsTip ?? undefined,
          onClick: () => importProjectFlow(),
        },
      ],
    },
    {
      label: "Export",
      icon: "export",
      submenu: [
        {
          label: "Export Audio…",
          icon: "export",
          title: "Render the project to WAV / MP3 / FLAC / AAC",
          onClick: () => useStore.getState().setDialogs({ export: true }),
        },
        {
          // engine shows the native save dialog (*.mid); reply carries the path
          label: "Export MIDI…",
          icon: "midiNote",
          onClick: () => fire(exportMidi({})),
        },
        {
          // engine shows the native save dialog (*.xml); reply carries path + warnings
          label: "Export Cubase Track Archive…",
          icon: "export",
          title: "Track shells, mixer settings, inserts and MIDI parts as a Cubase-importable Track Archive XML",
          onClick: () =>
            fire(
              exportTrackArchive({}).then(({ path, warnings }) => {
                if (warnings.length > 0) {
                  console.log("[export/trackArchive] warnings:", warnings);
                  showToast(
                    `Exported ${path} (${warnings.length} warning${warnings.length === 1 ? "" : "s"} — see console/log)`,
                    "info",
                  );
                } else {
                  showToast(`Exported ${path}`, "success");
                }
              }),
            ),
        },
        {
          // engine shows the native save dialog (*.cpr); reply carries path + warnings
          label: "Export Cubase Project (.cpr)…",
          icon: "export",
          title:
            "Audio, MIDI and Instrument tracks — notes, audio clip references, faders, pan, VST inserts with their settings — as a Cubase project (MIDI/fader/pan layer verified in Cubase 5 and 13)",
          onClick: () =>
            fire(
              exportCpr({}).then(({ path, warnings }) => {
                if (warnings.length > 0) {
                  console.log("[export/cpr] warnings:", warnings);
                  showToast(
                    `Exported ${path} (${warnings.length} warning${warnings.length === 1 ? "" : "s"} — see console/log)`,
                    "info",
                  );
                } else {
                  showToast(`Exported ${path}`, "success");
                }
              }),
            ),
        },
      ],
    },
    "separator",
    {
      label: "Recreate Plugins…",
      icon: "plug",
      title: "Recreate plugin inserts that have no live plugin instance",
      onClick: () => useStore.getState().setDialogs({ recreatePlugins: true }),
    },
    "separator",
    {
      label: "Settings…",
      icon: "settings",
      onClick: () => useStore.getState().setDialogs({ settings: true }),
    },
  ];
}

/* ============================================================================
 * Edit menu
 * ========================================================================= */

function buildEditMenu(): MenuEntry[] {
  const s = useStore.getState();
  const hasClips = s.selection.clipIds.length > 0;
  const hasSel = hasClips || s.selection.noteIds.length > 0;
  const selTitle = hasSel ? undefined : "Nothing selected";
  // Cut/Copy/Duplicate route to the CLIP clipboard/duplicate paths only — no note-level
  // handler exists yet, so a notes-only selection must disable them with an honest
  // reason (§10: every entry either works or is visibly disabled with a tooltip).
  // Delete stays on hasSel: the piano-roll key context deletes selected notes.
  const clipTitle = hasClips
    ? undefined
    : hasSel
      ? "Select clips — note cut/copy/duplicate isn't supported yet"
      : "Nothing selected";
  const canPaste = hasClipboard();
  return [
    { label: "Undo", icon: "undo", shortcut: "Ctrl+Z", onClick: () => invokeEdit("undo") },
    { label: "Redo", icon: "redo", shortcut: "Ctrl+Y", onClick: () => invokeEdit("redo") },
    "separator",
    {
      label: "Cut",
      icon: "scissors",
      shortcut: "Ctrl+X",
      disabled: !hasClips,
      title: clipTitle,
      onClick: () => invokeEdit("cut"),
    },
    {
      label: "Copy",
      shortcut: "Ctrl+C",
      disabled: !hasClips,
      title: clipTitle,
      onClick: () => invokeEdit("copy"),
    },
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      disabled: !canPaste,
      title: canPaste ? "Paste at the playhead" : "Clipboard is empty",
      onClick: () => invokeEdit("paste"),
    },
    {
      label: "Duplicate",
      shortcut: "Ctrl+D",
      disabled: !hasClips,
      title: clipTitle,
      onClick: () => invokeEdit("duplicate"),
    },
    {
      label: "Delete",
      icon: "trash",
      shortcut: "Del",
      disabled: !hasSel,
      title: selTitle,
      onClick: () => invokeEdit("delete"),
    },
    "separator",
    {
      label: "Select All",
      shortcut: "Ctrl+A",
      disabled: !s.project,
      title: s.project ? undefined : "No project",
      onClick: () => invokeEdit("selectAll"),
    },
  ];
}

/* ============================================================================
 * Project menu
 * ========================================================================= */

function removeSelectedTracksFlow(trackIds: number[]): void {
  const n = trackIds.length;
  void confirmDialog({
    title: n === 1 ? "Remove track" : "Remove tracks",
    message: `Remove ${n === 1 ? "the selected track" : `${n} selected tracks`} and ${n === 1 ? "its" : "their"} clips? This can be undone.`,
    confirmLabel: "Remove",
    danger: true,
  }).then((ok) => {
    if (!ok) return;
    for (const id of trackIds) fire(removeTrack(id));
  });
}

function buildProjectMenu(): MenuEntry[] {
  const s = useStore.getState();
  const noProject = !s.project;
  const adds = addTrackMenuItems().map((it) =>
    typeof it === "object" && "label" in it && noProject
      ? { ...it, disabled: true, title: "No project — connect to the engine first" }
      : it,
  );
  const selTracks = s.selection.trackIds;
  const none = selTracks.length === 0;
  return [
    ...adds,
    "separator",
    {
      label:
        selTracks.length > 1
          ? `Duplicate Selected Tracks (${selTracks.length})`
          : "Duplicate Selected Track",
      icon: "plus",
      disabled: none,
      title: none
        ? "Select a track first"
        : "Deep copy — clips, sends, automation, inserts incl. plugin state",
      onClick: () => {
        for (const id of selTracks) fire(duplicateTrack(id));
      },
    },
    {
      label:
        selTracks.length > 1
          ? `Remove Selected Tracks (${selTracks.length})`
          : "Remove Selected Track",
      icon: "trash",
      danger: true,
      disabled: none,
      title: none ? "Select a track first" : undefined,
      onClick: () => removeSelectedTracksFlow(selTracks),
    },
  ];
}

/* ============================================================================
 * Audio / MIDI menus
 * ========================================================================= */

function buildAudioMenu(): MenuEntry[] {
  const s = useStore.getState();
  return [
    {
      label: "Reset Audio (Panic)",
      icon: "warning",
      title: "All notes off + reset the audio engine",
      onClick: () => fire(panic()),
    },
    "separator",
    {
      label: "Metronome",
      icon: "metronome",
      shortcut: "C",
      checked: s.metronome.enabled,
      onClick: () => toggleMetronome(),
    },
    {
      label: "Follow Playhead",
      shortcut: "J",
      checked: s.followPlayhead,
      title: "Auto-scroll the timeline to keep the playhead visible",
      onClick: () => s.setFollowPlayhead(!s.followPlayhead),
    },
    "separator",
    {
      label: "Audio Settings…",
      icon: "settings",
      title: "Driver / device / sample rate / buffer size (Settings → Audio)",
      onClick: () => useStore.getState().setDialogs({ settings: true }),
    },
  ];
}

/* ============================================================================
 * View menu
 * ========================================================================= */

function buildViewMenu(): MenuEntry[] {
  const s = useStore.getState();
  const theme = getTheme();
  const slots = getLayoutSlots();
  const slotIdx: LayoutSlotIndex[] = [1, 2, 3, 4];
  return [
    {
      label: "Theme",
      submenu: THEMES.map((t) => ({
        label: t.label,
        checked: theme === t.value,
        onClick: () => applyTheme(t.value),
      })),
    },
    {
      label: "Layouts",
      icon: "layers",
      title: "Workspace snapshots — panels, dock tabs and sizes",
      submenu: [
        ...slotIdx.map(
          (i): MenuEntry => ({
            label: slots[i - 1] ? `${i}: ${slots[i - 1]!.name}` : `${i}: (empty)`,
            shortcut: `Ctrl+Alt+${i}`,
            disabled: !slots[i - 1],
            title: slots[i - 1] ? undefined : `Save one via "Save Current As" below`,
            onClick: () => {
              applyLayoutSlot(i);
            },
          }),
        ),
        "separator",
        {
          label: "Save Current As",
          submenu: slotIdx.map(
            (i): MenuEntry => ({
              label: slots[i - 1] ? `Layout ${i} (replaces ${slots[i - 1]!.name})` : `Layout ${i}`,
              shortcut: `Ctrl+Alt+Shift+${i}`,
              onClick: () => {
                const snap = saveLayoutSlot(i);
                showToast(`Layout ${i} saved — ${snap.name}`, "success");
              },
            }),
          ),
        },
      ],
    },
    "separator",
    {
      label: "Browser",
      checked: s.panels.browser,
      title: "Left panel: plugins & project files & inspector",
      onClick: () => s.setPanels({ browser: !s.panels.browser }),
    },
    {
      label: "Agent",
      checked: s.panels.agent,
      shortcut: "Ctrl+Shift+I",
      title: "Right-docked AI assistant chat panel",
      onClick: () => s.setPanels({ agent: !s.panels.agent }),
    },
    {
      label: "Minimap",
      checked: s.panels.minimap,
      title: "Bird's-eye arrangement strip above the timeline",
      onClick: () => s.setPanels({ minimap: !s.panels.minimap }),
    },
    {
      label: "Bottom Dock",
      checked: s.panels.bottomTab !== null,
      title: "Mixer / Piano Roll / Clip Editor / Sheet Music / Visualizer dock",
      onClick: () => s.setPanels({ bottomTab: s.panels.bottomTab === null ? "mixer" : null }),
    },
    "separator",
    {
      label: "Follow Playhead",
      shortcut: "J",
      checked: s.followPlayhead,
      title: "Auto-scroll the timeline to keep the playhead visible",
      onClick: () => s.setFollowPlayhead(!s.followPlayhead),
    },
  ];
}

/* ============================================================================
 * Help menu
 * ========================================================================= */

function buildHelpMenu(): MenuEntry[] {
  return [
    {
      label: "Command Palette…",
      icon: "search",
      shortcut: "Ctrl+K",
      title: "Run any command, or jump to a bar / marker / track",
      onClick: () => useStore.getState().setDialogs({ palette: true }),
    },
    {
      label: "Keyboard Shortcuts…",
      shortcut: "?",
      onClick: () => useStore.getState().setDialogs({ shortcuts: true }),
    },
  ];
}

function buildMidiMenu(): MenuEntry[] {
  return [
    {
      label: "All Notes Off (Panic)",
      icon: "warning",
      onClick: () => fire(panic()),
    },
    "separator",
    {
      label: "MIDI Settings…",
      icon: "settings",
      title: "MIDI input devices (Settings → MIDI)",
      onClick: () => useStore.getState().setDialogs({ settings: true }),
    },
    {
      label: "Import MIDI File…",
      icon: "midiNote",
      title: "Import a Standard MIDI File as a new project (paste its full path)",
      onClick: () => importProjectFlow(),
    },
  ];
}

/* ============================================================================
 * Menu bar
 * ========================================================================= */

/** Exported for the command palette: it flattens these same builders, so palette
    commands and menu items can never drift apart. */
export const MENUS: Array<{ label: string; icon: IconName; build: () => MenuEntry[] }> = [
  { label: "File", icon: "folder", build: buildFileMenu },
  { label: "Edit", icon: "pencil", build: buildEditMenu },
  { label: "View", icon: "eye", build: buildViewMenu },
  { label: "Project", icon: "layers", build: buildProjectMenu },
  { label: "Audio", icon: "audioWave", build: buildAudioMenu },
  { label: "MIDI", icon: "midiNote", build: buildMidiMenu },
  { label: "Help", icon: "help", build: buildHelpMenu },
];

const OPEN_INTENT_MS = 90; // hover-intent delay before the first menu opens
const CLOSE_INTENT_MS = 260; // grace period after leaving the strip + the open menu

/**
 * Vertical menu strip flush against the app's left edge: one icon per menu, opening its
 * options as a flyout to the right on hover. Because the open ContextMenu overlay swallows
 * pointer events, sliding between menus and closing on hover-out are driven by a window-level
 * pointermove that hit-tests the icons and the open menu panel(s).
 */
export default function MenuBar() {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  // Icon-only (default) ↔ icons+labels, toggled by clicking the strip; persists.
  const [expanded, setExpanded] = useState<boolean>(
    () => localStorage.getItem("mydaw.ui.menuStripExpanded") === "1",
  );
  const toggleExpanded = (): void =>
    setExpanded((v) => {
      localStorage.setItem("mydaw.ui.menuStripExpanded", v ? "0" : "1");
      return !v;
    });
  const openIdxRef = useRef<number | null>(openIdx);
  openIdxRef.current = openIdx;
  const openTimer = useRef(0);
  const closeTimer = useRef(0);

  const clearOpenTimer = (): void => window.clearTimeout(openTimer.current);
  const clearCloseTimer = (): void => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = 0;
    }
  };

  const openMenu = (i: number): void => {
    clearOpenTimer();
    clearCloseTimer();
    fetchImportFormatsTipOnce();
    const el = refs.current[i];
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Flyout to the right of the icon, flush so travelling into it crosses no gap.
    openContextMenu(r.right, r.top, MENUS[i].build());
    setOpenIdx(i);
  };

  const close = (): void => {
    clearCloseTimer();
    closeContextMenu();
    setOpenIdx(null);
  };

  // First open is hover-triggered with a short intent delay (no overlay yet, so pointerenter
  // reaches the button). Switching between already-open menus happens in the pointermove
  // effect below, since the overlay then blocks direct hover.
  const onEnter = (i: number): void => {
    clearCloseTimer();
    if (openIdxRef.current !== null) return;
    clearOpenTimer();
    openTimer.current = window.setTimeout(() => openMenu(i), OPEN_INTENT_MS);
  };

  const pointInRect = (x: number, y: number, r: DOMRect): boolean =>
    x >= r.left && x < r.right && y >= r.top && y < r.bottom;

  useEffect(() => {
    if (openIdx === null) return;
    const onMove = (e: PointerEvent): void => {
      const ctx = document.getElementById("mydaw-ctx-root");
      if (!ctx || ctx.childElementCount === 0) {
        setOpenIdx(null);
        return;
      }
      // Over a strip icon -> keep/switch to it.
      for (let i = 0; i < MENUS.length; i++) {
        const el = refs.current[i];
        if (el && pointInRect(e.clientX, e.clientY, el.getBoundingClientRect())) {
          clearCloseTimer();
          if (i !== openIdxRef.current) openMenu(i);
          return;
        }
      }
      // Over the open menu (or a submenu) -> keep open.
      const overMenu = Array.from(ctx.querySelectorAll(".ctx-menu")).some((el) =>
        pointInRect(e.clientX, e.clientY, (el as HTMLElement).getBoundingClientRect()),
      );
      if (overMenu) {
        clearCloseTimer();
        return;
      }
      // Over neither -> close after a grace period.
      if (!closeTimer.current) {
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = 0;
          close();
        }, CLOSE_INTENT_MS);
      }
    };
    window.addEventListener("pointermove", onMove, true);
    return () => window.removeEventListener("pointermove", onMove, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIdx]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    [],
  );

  return (
    <div
      className={"menu-strip" + (expanded ? " expanded" : "")}
      role="menubar"
      aria-orientation="vertical"
      title={expanded ? "Click empty space to collapse" : "Click empty space to expand"}
      // A click on the strip itself (not on a menu button) toggles icon-only ↔ labeled.
      onClick={(e) => {
        if (e.target === e.currentTarget) toggleExpanded();
      }}
    >
      {MENUS.map((m, i) => (
        <button
          key={m.label}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitem"
          aria-label={m.label}
          title={expanded ? undefined : m.label}
          className={
            "ms-item" + (openIdx === i ? " open" : "") + (m.label === "Help" ? " ms-bottom" : "")
          }
          onPointerEnter={() => onEnter(i)}
          onPointerLeave={clearOpenTimer}
          onClick={() => openMenu(i)}
        >
          <Icon name={m.icon} size={18} />
          {expanded && <span className="ms-label">{m.label}</span>}
        </button>
      ))}
      <button
        type="button"
        className="ms-item ms-expander"
        title={expanded ? "Collapse menu bar" : "Expand menu bar"}
        aria-label={expanded ? "Collapse menu bar" : "Expand menu bar"}
        onClick={toggleExpanded}
      >
        <Icon name={expanded ? "chevronLeft" : "chevronRight"} size={14} />
        {expanded && <span className="ms-label dim">Collapse</span>}
      </button>
    </div>
  );
}
