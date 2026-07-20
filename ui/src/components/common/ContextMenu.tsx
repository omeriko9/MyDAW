/**
 * ContextMenu — imperative context menu with submenus (owned by F4).
 *
 *   openContextMenu(e.clientX, e.clientY, [
 *     { label: "Rename", icon: "pencil", shortcut: "F2", onClick: ... },
 *     { label: "Color", submenu: [...] },
 *     "separator",
 *     { label: "Delete", icon: "trash", danger: true, onClick: ... },
 *   ]);
 *
 * Rendered into its own React root portal'd to <body>. Features: nested submenus
 * (hover with intent delay, or ArrowRight), separators, disabled, danger, checked,
 * shortcut hints, viewport clamping with submenu side-flip, full keyboard nav
 * (arrows / Home / End / Enter / Escape), closes on outside click / right-click /
 * scroll-wheel outside / window blur / resize.
 *
 * `contextMenuHandler(items)` is a convenience for onContextMenu props.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { Icon, IconName } from "./icons";

/* ============================================================================
 * Types
 * ========================================================================= */

export interface MenuItemDef {
  label: string;
  icon?: IconName;
  /** Native hover tooltip (HTML title attribute). */
  title?: string;
  /** Display-only hint, right-aligned (e.g. "Ctrl+D"). */
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Renders a check mark in the icon slot. */
  checked?: boolean;
  submenu?: MenuEntry[];
  onClick?: () => void;
}

/** One button in an icon row (Cubase-style toolbox strip at the top of a menu). */
export interface MenuIconDef {
  icon: IconName;
  /** Tooltip text (HTML title). */
  label: string;
  active?: boolean;
  onClick: () => void;
}

export interface MenuIconRow {
  type: "icons";
  buttons: MenuIconDef[];
}

export type MenuEntry = MenuItemDef | { type: "separator" } | "separator" | MenuIconRow;

function isSep(e: MenuEntry): e is "separator" | { type: "separator" } {
  return e === "separator" || (typeof e === "object" && "type" in e && e.type === "separator");
}

function isIcons(e: MenuEntry): e is MenuIconRow {
  return typeof e === "object" && "type" in e && e.type === "icons";
}

/** Regular activatable/highlightable entry (not a separator or icon row). */
function isItem(e: MenuEntry): e is MenuItemDef {
  return typeof e === "object" && !("type" in e);
}

/* ============================================================================
 * Imperative API (singleton root)
 * ========================================================================= */

let host: HTMLDivElement | null = null;
let reactRoot: Root | null = null;
let openSeq = 0;

export function openContextMenu(x: number, y: number, items: MenuEntry[]): void {
  if (!reactRoot) {
    host = document.createElement("div");
    host.id = "mydaw-ctx-root";
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  }
  reactRoot.render(<MenuOverlay key={++openSeq} x={x} y={y} items={items} />);
}

export function closeContextMenu(): void {
  reactRoot?.render(null);
}

/**
 * Convenience: `<div onContextMenu={contextMenuHandler(() => [...items])} />`.
 * Prevents the native menu and opens at the cursor. Pass a function to build
 * items lazily (with current state) at open time.
 */
export function contextMenuHandler(
  items: MenuEntry[] | (() => MenuEntry[]),
): (e: React.MouseEvent) => void {
  return (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, typeof items === "function" ? items() : items);
  };
}

/* ============================================================================
 * Overlay + menu chain
 * ========================================================================= */

interface Level {
  items: MenuEntry[];
  x: number;
  y: number;
  hi: number; // highlighted index, -1 none
  openerRect?: DOMRect; // submenu: rect of the parent item (for side flip)
}

const SUB_HOVER_MS = 120;

function nextEnabled(items: MenuEntry[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    const it = items[i];
    if (isItem(it) && !it.disabled) return i;
  }
  return -1;
}

function MenuOverlay({ x, y, items }: { x: number; y: number; items: MenuEntry[] }) {
  const [chain, setChain] = useState<Level[]>([{ items, x, y, hi: -1 }]);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const itemEls = useRef(new Map<string, HTMLElement>());
  const hoverTimer = useRef(0);
  const chainRef = useRef(chain);
  chainRef.current = chain;

  const close = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    closeContextMenu();
  };

  useEffect(() => {
    overlayRef.current?.focus();
    const onAway = () => close();
    window.addEventListener("blur", onAway);
    window.addEventListener("resize", onAway);
    return () => {
      window.removeEventListener("blur", onAway);
      window.removeEventListener("resize", onAway);
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const registerEl = (depth: number, index: number, el: HTMLElement | null) => {
    const key = `${depth}:${index}`;
    if (el) itemEls.current.set(key, el);
    else itemEls.current.delete(key);
  };

  /** Truncate to depth+1 levels and, if the item has a submenu, open it. */
  const syncSubmenu = (depth: number, index: number) => {
    const c = chainRef.current;
    const lvl = c[depth];
    if (!lvl) return;
    const it = lvl.items[index];
    const base = c.slice(0, depth + 1);
    base[depth] = { ...base[depth], hi: index };
    if (it && isItem(it) && !it.disabled && it.submenu && it.submenu.length > 0) {
      const el = itemEls.current.get(`${depth}:${index}`);
      if (el) {
        const r = el.getBoundingClientRect();
        base.push({ items: it.submenu, x: r.right + 2, y: r.top - 5, hi: -1, openerRect: r });
      }
    }
    setChain(base);
  };

  const onItemHover = (depth: number, index: number) => {
    // Highlight immediately; restructure (open/close submenus) with intent delay
    // so diagonal mouse travel into an open submenu doesn't slam it shut.
    setChain((c) => {
      const next = c.slice();
      if (next[depth]) next[depth] = { ...next[depth], hi: index };
      return next;
    });
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => syncSubmenu(depth, index), SUB_HOVER_MS);
  };

  const activate = (depth: number, index: number) => {
    const lvl = chainRef.current[depth];
    if (!lvl) return;
    const it = lvl.items[index];
    if (!it || !isItem(it) || it.disabled) return;
    if (it.submenu && it.submenu.length > 0) {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      syncSubmenu(depth, index);
      return;
    }
    close();
    it.onClick?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const c = chainRef.current;
    const depth = c.length - 1;
    const lvl = c[depth];
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "Escape":
        stop();
        close();
        break;
      case "ArrowDown": {
        stop();
        const i = nextEnabled(lvl.items, lvl.hi, 1);
        if (i >= 0) setChain((cc) => cc.map((l, d) => (d === depth ? { ...l, hi: i } : l)));
        break;
      }
      case "ArrowUp": {
        stop();
        const i = nextEnabled(lvl.items, lvl.hi === -1 ? lvl.items.length : lvl.hi, -1);
        if (i >= 0) setChain((cc) => cc.map((l, d) => (d === depth ? { ...l, hi: i } : l)));
        break;
      }
      case "Home":
      case "End": {
        stop();
        const i =
          e.key === "Home" ? nextEnabled(lvl.items, -1, 1) : nextEnabled(lvl.items, 0, -1);
        if (i >= 0) setChain((cc) => cc.map((l, d) => (d === depth ? { ...l, hi: i } : l)));
        break;
      }
      case "ArrowRight": {
        stop();
        if (lvl.hi >= 0) {
          const it = lvl.items[lvl.hi];
          if (it && isItem(it) && it.submenu && it.submenu.length > 0 && !it.disabled) {
            if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
            syncSubmenu(depth, lvl.hi);
            // highlight the submenu's first enabled item
            window.setTimeout(() => {
              setChain((cc) => {
                if (cc.length < 2) return cc;
                const last = cc.length - 1;
                const i = nextEnabled(cc[last].items, -1, 1);
                return cc.map((l, d) => (d === last && i >= 0 ? { ...l, hi: i } : l));
              });
            }, 0);
          }
        }
        break;
      }
      case "ArrowLeft":
        stop();
        if (c.length > 1) setChain(c.slice(0, c.length - 1));
        break;
      case "Enter":
      case " ":
        stop();
        if (lvl.hi >= 0) activate(depth, lvl.hi);
        break;
      default:
        // swallow everything else so app shortcuts don't fire under an open menu
        e.stopPropagation();
        break;
    }
  };

  return (
    <div
      ref={overlayRef}
      className="ctx-overlay"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (e.target === e.currentTarget) close();
      }}
      onWheel={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      {chain.map((lvl, d) => (
        <MenuList
          key={d}
          level={lvl}
          depth={d}
          onHover={onItemHover}
          onActivate={activate}
          onIconClick={(b) => {
            close();
            b.onClick();
          }}
          registerEl={registerEl}
        />
      ))}
    </div>
  );
}

/* ============================================================================
 * One menu panel
 * ========================================================================= */

function MenuList({
  level,
  depth,
  onHover,
  onActivate,
  onIconClick,
  registerEl,
}: {
  level: Level;
  depth: number;
  onHover: (depth: number, index: number) => void;
  onActivate: (depth: number, index: number) => void;
  onIconClick: (b: MenuIconDef) => void;
  registerEl: (depth: number, index: number, el: HTMLElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Clamp to viewport; submenus flip to the opener's left edge if they overflow right.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = level.x;
    let ny = level.y;
    if (nx + r.width > window.innerWidth - 4) {
      nx = level.openerRect
        ? Math.max(4, level.openerRect.left - r.width - 2)
        : Math.max(4, window.innerWidth - r.width - 4);
    }
    if (ny + r.height > window.innerHeight - 4) {
      ny = Math.max(4, window.innerHeight - r.height - 4);
    }
    setPos({ x: nx, y: ny });
  }, [level.x, level.y, level.items]);

  // Keep the keyboard highlight visible in scrollable menus.
  useEffect(() => {
    if (level.hi < 0) return;
    ref.current
      ?.querySelector(`[data-idx="${level.hi}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [level.hi]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{
        left: pos ? pos.x : level.x,
        top: pos ? pos.y : level.y,
        visibility: pos ? "visible" : "hidden",
      }}
      role="menu"
    >
      {level.items.map((it, i) => {
        if (isSep(it)) return <div key={i} className="ctx-sep" role="separator" />;
        if (isIcons(it)) {
          return (
            <div key={i} className="ctx-icons" role="group">
              {it.buttons.map((b) => (
                <button
                  key={b.label}
                  type="button"
                  className={"ctx-icon-btn" + (b.active ? " on" : "")}
                  title={b.label}
                  onClick={() => onIconClick(b)}
                >
                  <Icon name={b.icon} size={16} />
                </button>
              ))}
            </div>
          );
        }
        const hi = i === level.hi;
        const cls =
          "ctx-item" +
          (hi && !it.disabled ? " hi" : "") +
          (it.disabled ? " disabled" : "") +
          (it.danger ? " danger" : "");
        return (
          <div
            key={i}
            ref={(el) => registerEl(depth, i, el)}
            className={cls}
            data-idx={i}
            role="menuitem"
            title={it.title}
            aria-disabled={it.disabled}
            onMouseEnter={() => onHover(depth, i)}
            onClick={() => onActivate(depth, i)}
          >
            <span style={{ width: 16, height: 16, flex: "0 0 auto", display: "inline-flex" }}>
              {it.checked ? (
                <Icon name="check" />
              ) : it.icon ? (
                <Icon name={it.icon} />
              ) : null}
            </span>
            <span className="ellipsis">{it.label}</span>
            {it.shortcut ? <span className="ctx-shortcut">{it.shortcut}</span> : null}
            {it.submenu && it.submenu.length > 0 ? (
              <span style={{ marginLeft: it.shortcut ? 4 : "auto", display: "inline-flex" }}>
                <Icon name="chevronRight" size={12} />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
