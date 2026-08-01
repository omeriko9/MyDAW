/**
 * PanePicker — slim dropdown naming the pane a slot/tile shows; clicking opens the
 * shared ContextMenu with every pane. Single-instance semantics live in the CALLER
 * (picking a pane already shown elsewhere swaps the two slots/leaves).
 */

import { useRef } from "react";
import { openContextMenu } from "../components/common/ContextMenu";
import type { MenuEntry } from "../components/common/ContextMenu";
import { Icon } from "../components/common/icons";
import { PANE_ICONS, PANE_LABELS } from "./paneRegistry";
import { PANE_IDS } from "./shellTypes";
import type { PaneId } from "./shellTypes";

export function PanePicker({
  value,
  others = [],
  onPick,
}: {
  value: PaneId;
  /** Panes shown elsewhere in this shell — picking one swaps (noted in the menu). */
  others?: PaneId[];
  onPick: (id: PaneId) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);

  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const items: MenuEntry[] = PANE_IDS.map((id) => ({
      label: PANE_LABELS[id],
      icon: PANE_ICONS[id],
      checked: id === value,
      title:
        id !== value && others.includes(id)
          ? "Shown in another slot — selecting swaps the two"
          : undefined,
      onClick: () => onPick(id),
    }));
    openContextMenu(r.left, r.bottom + 2, items);
  };

  return (
    <button
      ref={ref}
      type="button"
      className="sp-pick"
      title="Choose which pane this slot shows"
      onClick={open}
    >
      <Icon name={PANE_ICONS[value]} size={14} />
      <span className="sp-pick-label">{PANE_LABELS[value]}</span>
      <Icon name="chevronDown" size={12} />
    </button>
  );
}
