/**
 * Collapsible inspector section (U5). Header toggles the body; optional right-side badge.
 * Collapsed/expanded is remembered per section title across reloads (lib/prefs).
 */

import React from "react";
import { isBool, usePrefState } from "../../lib/prefs";
import { Icon } from "../common/icons";

export interface SectionProps {
  title: string;
  /** Right-aligned content on the header row (e.g. a badge). */
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function Section({ title, badge, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = usePrefState(`ui.inspSection.${title}`, defaultOpen, isBool);
  return (
    <div className="insp-section">
      <div
        className="insp-section-header"
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            setOpen((o) => !o);
          }
        }}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <span className="grow ellipsis">{title}</span>
        {badge}
      </div>
      {open ? <div className="insp-section-body">{children}</div> : null}
    </div>
  );
}
