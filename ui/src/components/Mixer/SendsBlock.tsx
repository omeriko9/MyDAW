/**
 * SendsBlock (U3) — the SENDS section of a channel strip (SPEC §5.2 / §9).
 *
 * Per send: enable dot (cmd/track.setSend {enabled}), destination bus name, PRE tag,
 * level Knob using the dragSend/commitSend transient gesture helpers. Right-click a
 * send row for Pre-fader / Enabled / Remove. The '+' in the section header opens a
 * menu of available bus destinations (cmd/track.addSend).
 */

import React from "react";
import type { Send, Track } from "../../protocol/types";
import * as actions from "../../store/actions";
import { gainToDbText } from "../common/Fader";
import { openContextMenu, contextMenuHandler, MenuEntry } from "../common/ContextMenu";
import { Icon } from "../common/icons";
import { Knob } from "../common/Knob";
import { showToast } from "../common/ToastHost";
import { useGestureValue } from "./useGestureValue";

/**
 * Mirror of Model::wouldCreateRoutingCycle (engine Model.h): the engine refuses a send
 * with routing_cycle when the source is reachable from the destination through existing
 * output/send edges. Only buses can be a send destination or a track output target, so a
 * DFS over `buses` visits every node the engine would. Kept in the UI so a cycling bus is
 * shown greyed out with the reason instead of as a dead menu item.
 */
function wouldCycle(buses: Track[], srcId: number, destId: number): boolean {
  if (srcId === destId) return true;
  const byId = new Map(buses.map((b) => [b.id, b]));
  const seen = new Set<number>();
  const stack: number[] = [destId];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    if (cur === srcId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = byId.get(cur);
    if (!t) continue;
    if (typeof t.outputTarget === "number") stack.push(t.outputTarget);
    for (const s of t.sends) if (s.destTrackId) stack.push(s.destTrackId);
  }
  return false;
}

function SendRow({
  track,
  send,
  index,
  buses,
}: {
  track: Track;
  send: Send;
  index: number;
  buses: Track[];
}) {
  const g = useGestureValue(send.level);
  const dest = buses.find((b) => b.id === send.destTrackId);
  const destName = dest ? dest.name : `Bus #${send.destTrackId}`;

  const menu = contextMenuHandler(() => [
    {
      label: "Pre-fader",
      checked: send.pre,
      onClick: () => void actions.setSend(track.id, index, { pre: !send.pre }),
    },
    {
      label: "Enabled",
      checked: send.enabled,
      onClick: () => void actions.setSend(track.id, index, { enabled: !send.enabled }),
    },
    "separator",
    {
      label: "Remove Send",
      icon: "trash",
      danger: true,
      onClick: () => void actions.removeSend(track.id, index),
    },
  ]);

  return (
    <div className={"mxsend" + (send.enabled ? " enabled" : "")} onContextMenu={menu}>
      <button
        type="button"
        className="mxsend-dot"
        data-on={send.enabled ? "true" : undefined}
        title={send.enabled ? "Disable send" : "Enable send"}
        onClick={() => void actions.setSend(track.id, index, { enabled: !send.enabled })}
      />
      <span className="mxsend-name" title={`Send → ${destName}${send.pre ? " (pre-fader)" : " (post-fader)"}`}>
        {destName}
      </span>
      {send.pre ? <span className="mxsend-pre">PRE</span> : null}
      <Knob
        size={16}
        min={0}
        max={1}
        defaultValue={1}
        value={g.value}
        disabled={!send.enabled}
        format={(v) => gainToDbText(v) + " dB"}
        title={`Send level ${gainToDbText(g.value)} dB — right-click for pre/post`}
        onChange={(v) => {
          g.drag(v);
          actions.dragSend(track.id, index, { level: v });
        }}
        onCommit={(v) => {
          g.end(v);
          void actions.commitSend(track.id, index, { level: v });
        }}
      />
    </div>
  );
}

export function SendsBlock({ track, buses }: { track: Track; buses: Track[] }) {
  const addSendMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const used = new Set(track.sends.map((s) => s.destTrackId));
    const candidates = buses.filter((b) => b.id !== track.id && !used.has(b.id));
    const items: MenuEntry[] =
      candidates.length > 0
        ? candidates.map((b) => {
            const cycles = wouldCycle(buses, track.id, b.id);
            return {
              label: b.name,
              icon: "sliders" as const,
              disabled: cycles,
              title: cycles
                ? `${b.name} already feeds this channel — a send would create a routing cycle`
                : undefined,
              // The engine can still refuse (its model may be ahead of ours); surface it
              // instead of letting the rejection die as an unhandled promise.
              onClick: () =>
                void actions
                  .addSend(track.id, b.id)
                  .catch((e) =>
                    showToast(`Add send failed: ${e instanceof Error ? e.message : e}`, "error"),
                  ),
            };
          })
        : [
            {
              label: buses.length === 0 ? "No buses — add one in the track list" : "All buses already used",
              disabled: true,
            },
          ];
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 2, items);
  };

  return (
    <div className="mxsec mxsec-sends">
      <div className="mxsec-label">
        <span>Sends</span>
        <button
          type="button"
          className="btn-icon"
          style={{ width: 14, height: 14 }}
          title="Add send"
          onClick={addSendMenu}
        >
          <Icon name="plus" size={9} />
        </button>
      </div>
      <div className="mxsec-body">
        {track.sends.map((s, i) => (
          <SendRow key={`${s.destTrackId}:${i}`} track={track} send={s} index={i} buses={buses} />
        ))}
        {track.sends.length === 0 && (
          <div className="faint" style={{ fontSize: 9, padding: "1px 2px" }}>
            no sends
          </div>
        )}
      </div>
    </div>
  );
}
