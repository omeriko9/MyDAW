/**
 * PaneHost — the one way a shell puts a pane on screen: error boundary + the
 * popped-out placeholder (single-instance invariant: a pane living in its own
 * window is never rendered in the shell too).
 */

import { useStore } from "../store/store";
import type { PoppedOutTab } from "../store/store";
import { PanelBoundary } from "./PanelBoundary";
import { DockPlaceholder, POPOUT_DEFS, usePopouts } from "./popouts";
import { PANE_LABELS, renderPane } from "./paneRegistry";
import type { PaneId } from "./shellTypes";

export function PaneHost({ pane }: { pane: PaneId }) {
  const popped = useStore(
    (s) => pane !== "timeline" && !!s.panels.poppedOut[pane as PoppedOutTab],
  );
  const pops = usePopouts();
  if (popped && pane !== "timeline") {
    const tab = pane as PoppedOutTab;
    return <DockPlaceholder label={POPOUT_DEFS[tab].label} pop={pops.popouts[tab]} />;
  }
  return (
    <PanelBoundary key={pane} name={PANE_LABELS[pane]}>
      {renderPane(pane)}
    </PanelBoundary>
  );
}
