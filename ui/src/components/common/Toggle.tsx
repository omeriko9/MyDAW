/**
 * Toggle — toggle button (.btn-toggle, lights via [data-on]) (owned by F4).
 * `variant` recolors the lit state: accent (default) | danger (rec/mute) | warn (solo) | ok (monitor).
 * Icon-only toggles get their accessible name from `tooltip` (fallback `title`).
 */

import React from "react";
import { Icon, IconName } from "./icons";
import { Tooltip } from "./Tooltip";

export interface ToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Label content (e.g. "M", "S", "Snap"). */
  children?: React.ReactNode;
  icon?: IconName;
  variant?: "accent" | "danger" | "warn" | "ok";
  tooltip?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

export function Toggle({
  on,
  onChange,
  children,
  icon,
  variant = "accent",
  tooltip,
  disabled,
  className,
  style,
  title,
}: ToggleProps) {
  const btn = (
    <button
      type="button"
      className={"btn-toggle" + (className ? " " + className : "")}
      style={style}
      data-on={on ? "true" : undefined}
      data-variant={variant !== "accent" ? variant : undefined}
      disabled={disabled}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      aria-label={tooltip ?? title}
      title={title}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  );
  if (!tooltip || disabled) return btn;
  return <Tooltip content={tooltip}>{btn}</Tooltip>;
}
