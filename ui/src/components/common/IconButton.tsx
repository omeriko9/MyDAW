/**
 * IconButton — square icon-only button with optional delayed tooltip (owned by F4).
 * `active` lights it accent via [data-on]; `danger` recolors hover. Defaults 24px / 16px icon.
 */

import React from "react";
import { Icon, IconName } from "./icons";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps {
  icon: IconName;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  tooltip?: string;
  disabled?: boolean;
  /** Lit (toggled) state — renders with accent chrome via [data-on]. */
  active?: boolean;
  danger?: boolean;
  /** Button square size in px (default 24). Icon scales to size-8. */
  size?: number;
  iconSize?: number;
  className?: string;
  style?: React.CSSProperties;
  tabIndex?: number;
  /** Forwarded for drag/context interactions. */
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function IconButton({
  icon,
  onClick,
  tooltip,
  disabled,
  active,
  danger,
  size = 24,
  iconSize,
  className,
  style,
  tabIndex,
  onPointerDown,
  onContextMenu,
}: IconButtonProps) {
  const btn = (
    <button
      type="button"
      className={"btn-icon" + (danger ? " danger" : "") + (className ? " " + className : "")}
      style={size !== 24 ? { width: size, height: size, ...style } : style}
      data-on={active ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      tabIndex={tabIndex}
      aria-label={tooltip}
      aria-pressed={active}
    >
      <Icon name={icon} size={iconSize ?? Math.max(12, size - 8)} />
    </button>
  );
  if (!tooltip || disabled) return btn;
  return <Tooltip content={tooltip}>{btn}</Tooltip>;
}
