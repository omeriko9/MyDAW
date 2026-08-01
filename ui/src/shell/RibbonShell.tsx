/**
 * Ribbon shell (docs/UI_ALTERNATIVES_PLAN.md §2) — an Office-style ribbon replaces
 * the menu strip + dock tabs as primary navigation. One category per main view
 * (Arrange/Edit/Mix/Score/Visualize) plus File and View; selecting a category makes
 * that view the primary pane AND fills the strip with that view's commands. The
 * contextual groups render the SAME MenuEntry objects the menus/palette use
 * (MENUS), so ribbon commands can never drift from the menu commands. Below the
 * ribbon: TransportBar (always visible), then Browser | SplitPane | Agent.
 */

import { useRef } from "react";
import { useStore } from "../store/store";
import { MENUS } from "../components/Transport/MenuBar";
import TransportBar from "../components/Transport/TransportBar";
import StatusBar from "../components/Transport/StatusBar";
import { openContextMenu } from "../components/common/ContextMenu";
import type { MenuEntry, MenuItemDef } from "../components/common/ContextMenu";
import { Icon, type IconName } from "../components/common/icons";
import { loadBoolPref } from "../lib/prefs";
import { RIBBON_CATEGORY_PANE } from "./shellTypes";
import type { RibbonCategory } from "./shellTypes";
import { LeftBrowser, RightAgent } from "./flanks";
import { SplitPane } from "./SplitPane";
import { usePopouts } from "./popouts";

/* ============================================================================
 * Category → contextual groups (each group renders an existing menu's entries)
 * ========================================================================= */

interface GroupDef {
  title: string;
  /** MENUS label whose builder supplies this group's entries. */
  menu: string;
}

const CATEGORY_DEFS: Array<{ id: RibbonCategory; label: string; groups: GroupDef[] }> = [
  {
    id: "arrange",
    label: "Arrange",
    groups: [
      { title: "Edit", menu: "Edit" },
      { title: "Tracks", menu: "Project" },
      { title: "Transport", menu: "Audio" },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    groups: [
      { title: "Edit", menu: "Edit" },
      { title: "MIDI", menu: "MIDI" },
    ],
  },
  {
    id: "mix",
    label: "Mix",
    groups: [
      { title: "Transport", menu: "Audio" },
      { title: "Edit", menu: "Edit" },
    ],
  },
  {
    id: "score",
    label: "Score",
    groups: [
      { title: "Edit", menu: "Edit" },
      { title: "MIDI", menu: "MIDI" },
    ],
  },
  {
    id: "visualize",
    label: "Visualize",
    groups: [{ title: "Transport", menu: "Audio" }],
  },
  {
    id: "view",
    label: "View",
    groups: [
      { title: "View", menu: "View" },
      { title: "Help", menu: "Help" },
    ],
  },
];

const menuBuild = (label: string): MenuEntry[] =>
  MENUS.find((m) => m.label === label)?.build() ?? [];

/** Regular activatable entry (not a separator or icon row). */
const isItem = (e: MenuEntry): e is MenuItemDef => typeof e === "object" && !("type" in e);

/* ============================================================================
 * Ribbon widgets
 * ========================================================================= */

function RibbonButton({ entry }: { entry: MenuItemDef }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const onClick = () => {
    if (entry.submenu) {
      const r = ref.current?.getBoundingClientRect();
      if (r) openContextMenu(r.left, r.bottom + 2, entry.submenu);
    } else {
      entry.onClick?.();
    }
  };
  return (
    <button
      ref={ref}
      type="button"
      className={"rib-btn" + (entry.checked ? " on" : "") + (entry.danger ? " danger" : "")}
      disabled={entry.disabled}
      title={entry.title ?? entry.label}
      onClick={onClick}
    >
      {entry.icon ? <Icon name={entry.icon} size={15} /> : null}
      <span className="rib-btn-label">{entry.label}</span>
      {entry.submenu ? <Icon name="chevronDown" size={10} /> : null}
    </button>
  );
}

/** Tab-strip dropdown (File, and the overflow menus on the right). */
function MenuDropButton({
  label,
  icon,
  compact,
}: {
  label: string;
  icon?: IconName;
  compact?: boolean;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      ref={ref}
      type="button"
      className={"rib-tab rib-menu" + (compact ? " compact" : "")}
      title={label}
      aria-label={label}
      onClick={() => {
        const r = ref.current?.getBoundingClientRect();
        if (r) openContextMenu(r.left, r.bottom + 2, menuBuild(label));
      }}
    >
      {icon ? <Icon name={icon} size={15} /> : null}
      {compact ? null : <span>{label}</span>}
      <Icon name="chevronDown" size={10} />
    </button>
  );
}

/* ============================================================================
 * Shell
 * ========================================================================= */

export default function RibbonShell() {
  // Broad subscription on purpose: group entries carry live disabled/checked state
  // (selection, clipboard, project) — the ribbon is a small DOM, re-rendering it on
  // store changes is cheap and keeps it as fresh as a just-opened menu.
  useStore();
  const ribbon = useStore((s) => s.ribbon);
  const setRibbon = useStore((s) => s.setRibbon);
  const recording = useStore((s) => s.transport.state === "recording");
  const recordVisuals = recording && loadBoolPref("ui.recordVisuals", true);
  const { note: popoutNote } = usePopouts();

  const pickCategory = (id: RibbonCategory) => {
    const pane = RIBBON_CATEGORY_PANE[id];
    setRibbon({ category: id, ...(pane !== undefined ? { primary: pane } : {}) });
  };

  const cat = CATEGORY_DEFS.find((c) => c.id === ribbon.category) ?? CATEGORY_DEFS[0];

  return (
    <div className="app-frame" data-shell="ribbon">
      <div className="app-root" data-recording={recordVisuals || undefined}>
        <div className="rib-bar">
          <div className="rib-tabs" role="menubar">
            <MenuDropButton label="File" icon="folder" />
            {CATEGORY_DEFS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="rib-tab"
                data-on={c.id === ribbon.category ? "true" : undefined}
                onClick={() => pickCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
            <div className="grow" />
            <MenuDropButton label="Project" icon="layers" compact />
            <MenuDropButton label="Audio" icon="audioWave" compact />
            <MenuDropButton label="MIDI" icon="midiNote" compact />
            <MenuDropButton label="Help" icon="help" compact />
          </div>
          <div className="rib-groups">
            {cat.groups.map((g) => (
              <div key={g.title} className="rib-group">
                <div className="rib-group-body">
                  {menuBuild(g.menu)
                    .filter(isItem)
                    .map((entry, i) => (
                      <RibbonButton key={`${entry.label}-${i}`} entry={entry} />
                    ))}
                </div>
                <div className="rib-group-title">{g.title}</div>
              </div>
            ))}
          </div>
        </div>
        <TransportBar />
        {popoutNote !== null && <div className="app-dock-note">{popoutNote}</div>}
        <div className="app-main">
          <LeftBrowser />
          <div className="app-center">
            <SplitPane />
          </div>
          <RightAgent />
        </div>
        <StatusBar />
      </div>
    </div>
  );
}
