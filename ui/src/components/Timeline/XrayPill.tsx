/**
 * XrayPill (lib/xray) — floating lens picker next to the navigator pill.
 * Click → menu of lenses; the pill shows the active lens and a heat legend.
 */

import React from "react";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { Icon } from "../common/icons";
import { LENSES, type LensId } from "../../lib/xray";

export default function XrayPill({
  lens,
  onChange,
}: {
  lens: LensId;
  onChange: (l: LensId) => void;
}) {
  const active = lens !== "off";
  const label = active ? LENSES.find((l) => l.id === lens)?.label ?? "X-Ray" : "X-Ray";
  const openMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuEntry[] = [
      {
        label: "Off — track colors",
        checked: lens === "off",
        onClick: () => onChange("off"),
      },
      "separator",
      ...LENSES.map(
        (l): MenuEntry => ({
          label: l.label,
          title: l.hint,
          checked: lens === l.id,
          onClick: () => onChange(l.id),
        }),
      ),
    ];
    openContextMenu(r.left, r.top, items);
  };
  return (
    <button
      type="button"
      className={"tl-xray-pill" + (active ? " on" : "")}
      title={
        "X-ray lenses — recolor clips by CONTENT instead of track color:\n" +
        "density (busy/empty), register (bass warm / treble cool), energy (velocity).\n" +
        "Audio clips show neutral — the lenses read note data."
      }
      onClick={openMenu}
    >
      <Icon name="eye" size={14} />
      <span>{label}</span>
      {active && <span className="tl-xray-legend" />}
    </button>
  );
}
