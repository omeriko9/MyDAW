/**
 * SplitPane — the Ribbon shell's work area (plan §2.2): one or two pane slots with
 * a draggable splitter, orientation toggle (side-by-side / stacked), swap, and
 * close-secondary. Generalization of the classic split dock; the single-instance
 * invariant (picking the other slot's pane swaps) is enforced in store.setRibbon.
 */

import { useRef } from "react";
import { useStore } from "../store/store";
import type { PoppedOutTab } from "../store/store";
import { IconButton } from "../components/common/IconButton";
import { Resizer } from "../components/common/Resizer";
import { RIBBON_SPLIT_MAX, RIBBON_SPLIT_MIN, PANE_IDS } from "./shellTypes";
import type { PaneId } from "./shellTypes";
import { PaneHost } from "./PaneHost";
import { PanePicker } from "./PanePicker";
import { usePopouts } from "./popouts";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function SplitPane() {
  const ribbon = useStore((s) => s.ribbon);
  const setRibbon = useStore((s) => s.setRibbon);
  const poppedOut = useStore((s) => s.panels.poppedOut);
  const { popouts, popOut } = usePopouts();
  const ref = useRef<HTMLDivElement | null>(null);

  const both = ribbon.secondary !== null;
  const sideBySide = ribbon.orientation === "v";

  const popButton = (pane: PaneId) => {
    if (pane === "timeline") return null; // the arrangement cannot pop out
    const tab = pane as PoppedOutTab;
    return poppedOut[tab] ? (
      <IconButton
        icon="export"
        size={18}
        active
        tooltip="Dock back into the app"
        onClick={() => popouts[tab].close()}
      />
    ) : (
      <IconButton
        icon="export"
        size={18}
        tooltip="Pop out into a separate window"
        onClick={() => popOut(tab)}
      />
    );
  };

  const slot = (which: 1 | 2) => {
    const pane = which === 1 ? ribbon.primary : (ribbon.secondary as PaneId);
    const other = which === 1 ? ribbon.secondary : ribbon.primary;
    return (
      <div
        className="sp-slot"
        style={
          both && which === 1
            ? { flex: `0 0 ${(ribbon.split * 100).toFixed(2)}%` }
            : { flex: "1 1 0%" }
        }
      >
        <div className="sp-head">
          <PanePicker
            value={pane}
            others={other !== null ? [other] : []}
            onPick={(id) => setRibbon(which === 1 ? { primary: id } : { secondary: id })}
          />
          <div className="grow" />
          {popButton(pane)}
          {which === 1 && !both && (
            <IconButton
              icon="split"
              size={18}
              tooltip="Split — show a second pane beside this one"
              onClick={() => {
                const next = PANE_IDS.find((p) => p !== ribbon.primary);
                if (next) setRibbon({ secondary: next });
              }}
            />
          )}
          {both && which === 2 && (
            <>
              <IconButton
                icon="layers"
                size={18}
                tooltip={sideBySide ? "Stack the panes (splitter horizontal)" : "Panes side by side (splitter vertical)"}
                onClick={() => setRibbon({ orientation: sideBySide ? "h" : "v" })}
              />
              <IconButton
                icon="refresh"
                size={18}
                tooltip="Swap the two panes"
                onClick={() => setRibbon({ primary: ribbon.secondary as PaneId })}
              />
              <IconButton
                icon="x"
                size={18}
                tooltip="Close this pane"
                onClick={() => setRibbon({ secondary: null })}
              />
            </>
          )}
        </div>
        <div className="sp-body">
          <PaneHost pane={pane} />
        </div>
      </div>
    );
  };

  return (
    <div ref={ref} className={"sp-root " + (sideBySide ? "sp-cols" : "sp-rows")}>
      {slot(1)}
      {both && (
        <>
          <Resizer
            dir={sideBySide ? "v" : "h"}
            onResize={(delta) => {
              const el = ref.current;
              const size = el ? (sideBySide ? el.clientWidth : el.clientHeight) : 1;
              // read fresh — drag deltas can outpace React's re-render of this closure
              const cur = useStore.getState().ribbon.split;
              setRibbon({
                split: clamp(cur + delta / Math.max(1, size), RIBBON_SPLIT_MIN, RIBBON_SPLIT_MAX),
              });
            }}
            onReset={() => setRibbon({ split: 0.5 })}
          />
          {slot(2)}
        </>
      )}
    </div>
  );
}
