/**
 * Mixer popups (U3): a small anchored-portal popup primitive plus the two concrete
 * popups the mixer needs — a searchable plugin picker ('+' insert slot, SPEC §9) and
 * a track-color palette (color tab at the top of each strip).
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginInfo } from "../../protocol/types";
import { useStore } from "../../store/store";
import { TRACK_COLORS } from "../../lib/canvas";
import { pluginKey } from "../../lib/ids";
import { groupPluginVariants } from "../../lib/pluginVariants";
import { Icon } from "../common/icons";
import { TextInput } from "../common/TextInput";
import { VirtualList } from "../common/VirtualList";

/* ============================================================================
 * AnchoredPopup — fixed-position portal, closes on outside click / Esc / resize
 * ========================================================================= */

export interface AnchoredPopupProps {
  x: number;
  y: number;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}

export function AnchoredPopup({ x, y, onClose, width, children }: AnchoredPopupProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Clamp to viewport once rendered.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - r.width - 4);
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    const away = () => onCloseRef.current();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      className="mxr-popup"
      style={{
        left: pos ? pos.x : x,
        top: pos ? pos.y : y,
        width,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ============================================================================
 * PluginPicker — searchable VirtualList over the registry (SPEC §9 mixer '+')
 * ========================================================================= */

export interface PluginPickerProps {
  x: number;
  y: number;
  /** Called with the chosen plugin; the picker closes itself afterwards. */
  onPick: (p: PluginInfo) => void;
  onClose: () => void;
  /** Show instruments first / only-effects etc. is left to the caller via filter. */
  filter?: (p: PluginInfo) => boolean;
}

export function PluginPicker({ x, y, onPick, onClose, filter }: PluginPickerProps) {
  const registry = useStore((s) => s.registry);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = registry
      .filter((p) => !p.blacklisted)
      .filter((p) => (filter ? filter(p) : true))
      .filter(
        (p) =>
          needle === "" ||
          p.name.toLowerCase().includes(needle) ||
          p.vendor.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    // One row per plugin — shell channel-routing / bitness twins collapse to the best.
    return groupPluginVariants(filtered).plugins;
  }, [registry, q, filter]);

  // Re-clamp the selection when the list shrinks (e.g. a scan completes and the registry
  // changes) so the highlight / scrollToIndex never points past the end of the list.
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const pick = (p: PluginInfo | undefined) => {
    if (!p) return;
    onPick(p);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(items[sel] ?? items[0]);
    }
  };

  return (
    <AnchoredPopup x={x} y={y} onClose={onClose} width={250}>
      <TextInput
        value={q}
        onChange={(v) => {
          setQ(v);
          setSel(0);
        }}
        placeholder="Search plugins…"
        type="search"
        autoFocus
        selectOnFocus={false}
        onKeyDown={onKeyDown}
      />
      <div style={{ height: 220 }}>
        {items.length === 0 ? (
          <div className="mxr-noresults">
            {registry.length === 0 ? "No plugins — scan from the Browser" : "No matches"}
          </div>
        ) : (
          <VirtualList
            itemCount={items.length}
            itemHeight={22}
            scrollToIndex={sel}
            itemKey={(i) => pluginKey(items[i])}
            renderItem={(i) => {
              const p = items[i];
              return (
                <div
                  className="mxr-plugin-row"
                  data-sel={i === sel ? "true" : undefined}
                  onClick={() => setSel(i)}
                  onDoubleClick={() => pick(p)}
                  title={`${p.name} — ${p.vendor} (${p.format.toUpperCase()}, ${p.bitness}-bit)`}
                >
                  <Icon name={p.isInstrument ? "piano" : "plug"} size={12} />
                  <span className="ellipsis grow">{p.name}</span>
                  <span className="mxr-plugin-vendor">{p.vendor}</span>
                </div>
              );
            }}
          />
        )}
      </div>
      <div className="mxr-hint">Enter / double-click to add — full search in the Browser</div>
    </AnchoredPopup>
  );
}

/* ============================================================================
 * ColorPopup — 12-swatch track color palette (TRACK_COLORS)
 * ========================================================================= */

export interface ColorPopupProps {
  x: number;
  y: number;
  onPick: (color: string) => void;
  onClose: () => void;
}

export function ColorPopup({ x, y, onPick, onClose }: ColorPopupProps) {
  return (
    <AnchoredPopup x={x} y={y} onClose={onClose}>
      <div className="mxr-swatches">
        {TRACK_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="mxr-swatch"
            style={{ background: c }}
            title={c}
            onClick={() => {
              onPick(c);
              onClose();
            }}
          />
        ))}
      </div>
    </AnchoredPopup>
  );
}
