/**
 * Plugin hover card (UI_IMPROVE.md §5.1) — hover a Browser plugin row ~450ms →
 * floating card with vendor / format / bitness / category / path, blacklist
 * reason, and which tracks currently use the plugin (scanned from the project's
 * inserts at show time). Imperative singleton like ContextMenu: rows just call
 * pluginCardEnter/Leave, so the memoized row components need no extra state.
 */

import React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PluginInfo } from "../../protocol/types";
import { useStore } from "../../store/store";

const SHOW_DELAY_MS = 450;

let host: HTMLDivElement | null = null;
let reactRoot: Root | null = null;
let timer = 0;
let shownFor: string | null = null;

function render(content: React.ReactNode): void {
  if (!reactRoot) {
    host = document.createElement("div");
    host.id = "mydaw-plugincard-root";
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  }
  reactRoot.render(content);
}

export function pluginCardLeave(): void {
  if (timer) window.clearTimeout(timer);
  timer = 0;
  if (shownFor !== null) {
    shownFor = null;
    render(null);
  }
}

export function pluginCardEnter(p: PluginInfo, rowEl: HTMLElement): void {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    if (!rowEl.isConnected) return; // row scrolled away (VirtualList recycled it)
    shownFor = p.uid;
    render(<Card p={p} anchor={rowEl.getBoundingClientRect()} />);
  }, SHOW_DELAY_MS);
}

/** Hide on any scroll/wheel — the anchor moves under a fixed-position card. */
window.addEventListener("wheel", pluginCardLeave, { passive: true, capture: true });
window.addEventListener("scroll", pluginCardLeave, { passive: true, capture: true });

function Card({ p, anchor }: { p: PluginInfo; anchor: DOMRect }) {
  const proj = useStore.getState().project;
  const usedOn = proj
    ? proj.tracks.filter((t) => t.inserts.some((i) => i.uid === p.uid)).map((t) => t.name)
    : [];
  const x = Math.min(anchor.right + 8, window.innerWidth - 300);
  const y = Math.min(anchor.top, window.innerHeight - 180);
  return (
    <div className="plugin-card" style={{ left: x, top: y }}>
      <div className="plugin-card-name">{p.name}</div>
      <div className="plugin-card-sub">
        {p.vendor || "Unknown vendor"}
        {p.category ? ` · ${p.category}` : ""}
      </div>
      <div className="plugin-card-badges">
        <span className="badge">{p.format.toUpperCase()}</span>
        {p.bitness === 32 && <span className="badge warn">32-bit</span>}
        {p.isInstrument && <span className="badge accent">Instrument</span>}
        {p.blacklisted && <span className="badge danger">Blacklisted</span>}
      </div>
      {p.blacklisted && p.blacklistReason ? (
        <div className="plugin-card-row danger">{p.blacklistReason}</div>
      ) : null}
      <div className="plugin-card-row plugin-card-path" title={p.path}>
        {p.path}
      </div>
      <div className="plugin-card-row">
        {usedOn.length > 0 ? (
          <>
            <span className="dim">Used on: </span>
            {usedOn.slice(0, 4).join(", ")}
            {usedOn.length > 4 ? ` +${usedOn.length - 4} more` : ""}
          </>
        ) : (
          <span className="faint">Not used in this project</span>
        )}
      </div>
      <div className="plugin-card-foot">double-click adds to the selected track · drag onto a track or strip</div>
    </div>
  );
}
