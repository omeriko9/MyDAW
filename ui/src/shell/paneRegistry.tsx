/**
 * Pane registry — the single table of panes the shells can place. The pane
 * COMPONENTS are unchanged (docs/UI_ALTERNATIVES_PLAN.md contract); this maps ids to
 * them plus display metadata. "timeline" is a registered pane so the Ribbon and
 * Workspaces shells can tile it — the Classic shell keeps it pinned center and never
 * looks it up here.
 */

import React from "react";
import Timeline from "../components/Timeline/Timeline";
import Mixer from "../components/Mixer/Mixer";
import InstrumentRack from "../components/InstrumentRack/InstrumentRack";
import PianoRoll from "../components/PianoRoll/PianoRoll";
import ClipEditor from "../components/ClipEditor/ClipEditor";
import SheetMusic from "../components/SheetMusic/SheetMusic";
import Visualizer from "../components/Visualizer/Visualizer";
import type { IconName } from "../components/common/icons";
import { PANE_LABELS } from "./shellTypes";
import type { DockPaneId, PaneId } from "./shellTypes";

export { PANE_LABELS };

export const PANE_ICONS: Record<PaneId, IconName> = {
  timeline: "layers",
  mixer: "mixer",
  instrumentRack: "piano",
  pianoRoll: "piano",
  clipEditor: "audioWave",
  sheetMusic: "staff",
  visualizer: "power",
};

/** Dock-capable panes in their canonical (classic dock tab) order. */
export const DOCK_PANES: DockPaneId[] = [
  "mixer",
  "instrumentRack",
  "pianoRoll",
  "clipEditor",
  "sheetMusic",
  "visualizer",
];

export function renderPane(id: PaneId): React.ReactNode {
  switch (id) {
    case "timeline":
      return <Timeline />;
    case "mixer":
      return <Mixer />;
    case "instrumentRack":
      return <InstrumentRack />;
    case "pianoRoll":
      return <PianoRoll />;
    case "clipEditor":
      return <ClipEditor />;
    case "sheetMusic":
      return <SheetMusic />;
    case "visualizer":
      return <Visualizer />;
  }
}
