/**
 * Tabs — controlled tab bar (owned by F4). Content rendering is the caller's job.
 * Keyboard: Left/Right arrows move between tabs (roving focus).
 */

import React, { useRef } from "react";
import { Icon, IconName } from "./icons";

export interface TabDef {
  id: string;
  label: React.ReactNode;
  icon?: IconName;
  title?: string;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  /** Extra content right-aligned on the same row (e.g. action buttons). */
  right?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Tabs({ tabs, active, onChange, right, className, style }: TabsProps) {
  const barRef = useRef<HTMLDivElement | null>(null);

  const move = (dir: 1 | -1) => {
    const enabled = tabs.filter((t) => !t.disabled);
    if (enabled.length === 0) return;
    const cur = enabled.findIndex((t) => t.id === active);
    const next = enabled[(cur + dir + enabled.length) % enabled.length];
    onChange(next.id);
    // keep focus on the newly active tab
    requestAnimationFrame(() => {
      barRef.current
        ?.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(next.id)}"]`)
        ?.focus();
    });
  };

  return (
    <div
      ref={barRef}
      className={"tabs" + (className ? " " + className : "")}
      style={style}
      role="tablist"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            className="tab"
            data-tab-id={t.id}
            data-on={on ? "true" : undefined}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            title={t.title}
            onClick={() => onChange(t.id)}
          >
            {t.icon ? <Icon name={t.icon} size={14} /> : null}
            {t.label}
          </button>
        );
      })}
      {right !== undefined && (
        <>
          <div className="grow" />
          {right}
        </>
      )}
    </div>
  );
}
