/**
 * Command palette (UI_IMPROVE.md §7.1 + §1.2) — Ctrl+K.
 *
 * One fuzzy-searchable overlay for two jobs:
 *   - COMMANDS: every menu-bar item (flattened live from MenuBar.MENUS, so the
 *     palette and the menus can never drift) plus transport/tool commands that
 *     have no menu home. Disabled items render dimmed with their reason —
 *     the same §10 honesty policy as the menus.
 *   - JUMP: type a bar number ("57" / "57.3"), a marker name, or a track name —
 *     locate + reveal, or select the track.
 *
 * The overlay carries the .modal-overlay class ONLY so lib/keyboard's uiBlocked()
 * treats an open palette like a modal (global shortcuts go inert); its layout is
 * restyled by commandPalette.css. Recently executed commands rank first on an
 * empty query (pref "palette.recent").
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore, type Tool } from "../../store/store";
import { locate, play, record, stop } from "../../store/actions";
import { MENUS } from "../Transport/MenuBar";
import type { MenuEntry, MenuItemDef } from "../common/ContextMenu";
import { Icon, type IconName } from "../common/icons";
import { fuzzyMatch } from "../../lib/fuzzy";
import { revealBeat } from "../../lib/reveal";
import { toggleLoop } from "../../lib/keyboard";
import { barToBeat, timeSigAtBeat } from "../../lib/time";
import { loadPref, savePref } from "../../lib/prefs";
import "./commandPalette.css";

const fire = (p: Promise<unknown>): void => {
  p.catch((e) => console.warn("[palette] command failed:", e));
};

/* ============================================================================
 * Command collection
 * ========================================================================= */

interface Command {
  /** Stable identity for recency tracking: "File › Export › Export Audio…". */
  id: string;
  label: string;
  /** Menu path WITHOUT the label ("File › Export"); empty for group-only commands. */
  path: string;
  group: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  /** Tooltip/reason (menu `title`) — shown for disabled items. */
  reason?: string;
  checked?: boolean;
  run: () => void;
}

/** Separators AND icon rows — anything that isn't a plain, palettable item. */
function isNonItem(e: MenuEntry): e is Exclude<MenuEntry, MenuItemDef> {
  return typeof e === "string" || (typeof e === "object" && "type" in e);
}

function flattenMenus(): Command[] {
  const out: Command[] = [];
  for (const m of MENUS) {
    const walk = (entries: MenuEntry[], path: string[]): void => {
      for (const e of entries) {
        if (isNonItem(e)) continue;
        if (e.submenu && e.submenu.length > 0) {
          walk(e.submenu, [...path, e.label]);
          continue;
        }
        if (!e.onClick) continue;
        const pathStr = path.join(" › ");
        out.push({
          id: [...path, e.label].join(" › "),
          label: e.label,
          path: pathStr,
          group: path[0] ?? "Commands",
          icon: e.icon,
          shortcut: e.shortcut,
          disabled: e.disabled,
          reason: e.title,
          checked: e.checked,
          run: e.onClick,
        });
      }
    };
    walk(m.build(), [m.label]);
  }
  return out;
}

const TOOLS: Array<{ tool: Tool; label: string; icon: IconName; shortcut: string }> = [
  { tool: "select", label: "Select Tool", icon: "pointer", shortcut: "1" },
  { tool: "draw", label: "Draw Tool", icon: "pencil", shortcut: "2" },
  { tool: "erase", label: "Erase Tool", icon: "eraser", shortcut: "3" },
  { tool: "split", label: "Split Tool", icon: "split", shortcut: "4" },
];

/** Transport + tool commands that have no menu-bar home. */
function builtinCommands(): Command[] {
  const s = useStore.getState();
  const cmd = (
    label: string,
    icon: IconName,
    shortcut: string,
    run: () => void,
    checked?: boolean,
  ): Command => ({
    id: `Transport › ${label}`,
    label,
    path: "Transport",
    group: "Transport",
    icon,
    shortcut,
    checked,
    run,
  });
  return [
    cmd("Play / Pause", "play", "Space", () => fire(play())),
    cmd("Stop", "stop", "Num 0", () => fire(stop())),
    cmd("Record", "record", "R", () => fire(record())),
    cmd("Toggle Loop", "loop", "L", () => toggleLoop()),
    cmd("Go to Start", "chevronLeft", "Home", () => {
      fire(locate(0));
      revealBeat(0);
    }),
    ...TOOLS.map(
      (t): Command => ({
        id: `Tools › ${t.label}`,
        label: t.label,
        path: "Tools",
        group: "Tools",
        icon: t.icon,
        shortcut: t.shortcut,
        checked: s.tool === t.tool,
        run: () => useStore.getState().setTool(t.tool),
      }),
    ),
  ];
}

/* ============================================================================
 * Jump targets (query-dependent)
 * ========================================================================= */

interface Row {
  kind: "header" | "item";
  key: string;
  label: string;
  /** item fields */
  path?: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  reason?: string;
  checked?: boolean;
  ranges?: Array<[number, number]>;
  run?: () => void;
  /** commands only — recency id */
  cmdId?: string;
}

const BAR_RE = /^(\d{1,5})(?:[.:](\d{1,2}))?$/;

function jumpRows(query: string): Row[] {
  const s = useStore.getState();
  const p = s.project;
  if (!p) return [];
  const rows: Row[] = [];

  const barMatch = BAR_RE.exec(query.trim());
  if (barMatch) {
    const bar = Math.max(1, parseInt(barMatch[1], 10));
    const beatInBar = barMatch[2] ? Math.max(1, parseInt(barMatch[2], 10)) : 1;
    const barStart = barToBeat(bar, p.timeSigMap);
    const sig = timeSigAtBeat(barStart, p.timeSigMap);
    const unit = 4 / sig.den;
    const beat = barStart + Math.min(beatInBar - 1, sig.num - 1) * unit;
    rows.push({
      kind: "item",
      key: `bar:${bar}.${beatInBar}`,
      label: `Go to bar ${bar}${barMatch[2] ? `, beat ${beatInBar}` : ""}`,
      path: "Go to",
      icon: "flag",
      run: () => {
        fire(locate(beat));
        revealBeat(beat);
      },
    });
  }

  if (query.trim().length > 0) {
    const markers = p.markers
      .map((m) => ({ m, hit: fuzzyMatch(query, m.name) }))
      .filter((x) => x.hit !== null)
      .sort((a, b) => b.hit!.score - a.hit!.score)
      .slice(0, 6);
    if (markers.length > 0) {
      rows.push({ kind: "header", key: "h:markers", label: "Markers" });
      for (const { m, hit } of markers) {
        rows.push({
          kind: "item",
          key: `marker:${m.id}`,
          label: m.name,
          path: "Go to marker",
          icon: "marker",
          ranges: hit!.ranges,
          run: () => {
            fire(locate(m.beat));
            revealBeat(m.beat);
          },
        });
      }
    }

    const tracks = p.tracks
      .map((t) => ({ t, hit: fuzzyMatch(query, t.name) }))
      .filter((x) => x.hit !== null)
      .sort((a, b) => b.hit!.score - a.hit!.score)
      .slice(0, 6);
    if (tracks.length > 0) {
      rows.push({ kind: "header", key: "h:tracks", label: "Tracks" });
      for (const { t, hit } of tracks) {
        rows.push({
          kind: "item",
          key: `track:${t.id}`,
          label: t.name,
          path: "Select track",
          icon: "layers",
          ranges: hit!.ranges,
          run: () =>
            useStore.getState().setSelection({ trackIds: [t.id], clipIds: [], noteIds: [] }),
        });
      }
    }
  }
  return rows;
}

/* ============================================================================
 * Recency
 * ========================================================================= */

const RECENT_PREF = "palette.recent";
const RECENT_MAX = 8;
const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function loadRecents(): string[] {
  return loadPref<string[]>(RECENT_PREF, [], isStringArray);
}

function pushRecent(id: string): void {
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, RECENT_MAX);
  savePref(RECENT_PREF, next);
}

/* ============================================================================
 * Component
 * ========================================================================= */

function cmdToRow(c: Command, ranges?: Array<[number, number]>): Row {
  return {
    kind: "item",
    key: `cmd:${c.id}`,
    label: c.label,
    path: c.path,
    icon: c.icon,
    shortcut: c.shortcut,
    disabled: c.disabled,
    reason: c.reason,
    checked: c.checked,
    ranges,
    run: c.run,
    cmdId: c.id,
  };
}

export default function CommandPalette() {
  const open = useStore((s) => s.dialogs.palette);
  const setDialogs = useStore((s) => s.setDialogs);
  const close = () => setDialogs({ palette: false });

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Commands are collected once per open (menu builders read live store state).
  const commands = useMemo<Command[]>(
    () => (open ? [...builtinCommands(), ...flattenMenus()] : []),
    [open],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      // rAF: the input mounts with the portal this same commit
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    if (!open) return [];
    const jumps = jumpRows(query);
    const q = query.trim();

    if (q.length === 0) {
      const out: Row[] = [];
      const recents = loadRecents()
        .map((id) => commands.find((c) => c.id === id))
        .filter((c): c is Command => !!c && !c.disabled);
      if (recents.length > 0) {
        out.push({ kind: "header", key: "h:recent", label: "Recent" });
        out.push(...recents.map((c) => cmdToRow(c)));
      }
      let group = "";
      for (const c of commands) {
        if (c.group !== group) {
          group = c.group;
          out.push({ kind: "header", key: `h:${group}`, label: group });
        }
        out.push(cmdToRow(c));
      }
      return out;
    }

    // Query: fuzzy over "label ␣ path", ranked by score; jump groups after the
    // bar row but before weaker command hits would only confuse — keep order:
    // bar jump first (it is an exact, intentional input), commands, markers/tracks.
    const scored = commands
      .map((c) => ({ c, hit: fuzzyMatch(q, `${c.label} ${c.path}`) }))
      .filter((x) => x.hit !== null)
      .sort((a, b) => b.hit!.score - a.hit!.score)
      .slice(0, 24);
    const out: Row[] = [];
    const barRow = jumps.filter((r) => r.key.startsWith("bar:"));
    out.push(...barRow);
    if (scored.length > 0) {
      out.push({ kind: "header", key: "h:cmds", label: "Commands" });
      out.push(
        ...scored.map(({ c, hit }) =>
          // only label-internal ranges are highlightable in the row layout
          cmdToRow(c, hit!.ranges.filter((r) => r[0] < c.label.length)),
        ),
      );
    }
    out.push(...jumps.filter((r) => !r.key.startsWith("bar:")));
    return out;
  }, [open, query, commands]);

  const selectable = useMemo(() => rows.filter((r) => r.kind === "item"), [rows]);
  const selRow = selectable[Math.min(sel, Math.max(0, selectable.length - 1))];

  useEffect(() => {
    setSel(0);
  }, [query]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!selRow) return;
    listRef.current
      ?.querySelector(`[data-key="${CSS.escape(selRow.key)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selRow]);

  if (!open) return null;

  const execute = (row: Row | undefined): void => {
    if (!row || row.disabled || !row.run) return;
    if (row.cmdId) pushRecent(row.cmdId);
    close();
    row.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        setSel((i) => Math.min(i + 1, Math.max(0, selectable.length - 1)));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSel((i) => Math.max(0, i - 1));
        break;
      case "PageDown":
        e.preventDefault();
        setSel((i) => Math.min(i + 8, Math.max(0, selectable.length - 1)));
        break;
      case "PageUp":
        e.preventDefault();
        setSel((i) => Math.max(0, i - 8));
        break;
      case "Enter":
        e.preventDefault();
        execute(selRow);
        break;
      default:
        // Keep every other key inside the palette (the global handler is inert
        // anyway while .modal-overlay exists, but belt and braces).
        e.stopPropagation();
        break;
    }
  };

  const highlight = (label: string, ranges?: Array<[number, number]>): React.ReactNode => {
    if (!ranges || ranges.length === 0) return label;
    const out: React.ReactNode[] = [];
    let pos = 0;
    for (const [a, b] of ranges) {
      if (a >= label.length) break;
      if (a > pos) out.push(label.slice(pos, a));
      out.push(
        <mark key={a} className="cp-hl">
          {label.slice(a, Math.min(b, label.length))}
        </mark>,
      );
      pos = Math.min(b, label.length);
    }
    if (pos < label.length) out.push(label.slice(pos));
    return out;
  };

  return createPortal(
    <div
      className="modal-overlay cp-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="cp-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cp-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="cp-input"
            value={query}
            placeholder="Type a command, marker or track name, or a bar number…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="cp-kbd">Esc</span>
        </div>
        <div className="cp-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="cp-empty">No matches — try fewer letters, or a bar number.</div>
          )}
          {rows.map((row) =>
            row.kind === "header" ? (
              <div key={row.key} className="cp-header">
                {row.label}
              </div>
            ) : (
              <div
                key={row.key}
                data-key={row.key}
                className={
                  "cp-item" +
                  (row === selRow ? " sel" : "") +
                  (row.disabled ? " disabled" : "")
                }
                title={row.disabled ? row.reason : undefined}
                onMouseMove={() => {
                  const i = selectable.indexOf(row);
                  if (i >= 0 && i !== sel) setSel(i);
                }}
                onMouseDown={(e) => e.preventDefault()} // keep input focus
                onClick={() => execute(row)}
              >
                <span className="cp-icon">
                  {row.checked ? (
                    <Icon name="check" size={14} />
                  ) : row.icon ? (
                    <Icon name={row.icon} size={14} />
                  ) : null}
                </span>
                <span className="cp-label ellipsis">{highlight(row.label, row.ranges)}</span>
                {row.path ? <span className="cp-path ellipsis">{row.path}</span> : null}
                {row.shortcut ? <span className="cp-kbd">{row.shortcut}</span> : null}
              </div>
            ),
          )}
        </div>
        <div className="cp-foot">
          <span>
            <span className="cp-kbd">↑↓</span> navigate
          </span>
          <span>
            <span className="cp-kbd">Enter</span> run
          </span>
          <span>
            <span className="cp-kbd">Esc</span> close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
