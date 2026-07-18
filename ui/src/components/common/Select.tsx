/**
 * Select — styled native <select> (.select) (owned by F4).
 * Options as {value,label} array (optgroups via `group`), or pass children instead.
 */

import React from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Optional optgroup label — consecutive options with the same group are grouped. */
  group?: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options?: SelectOption[];
  /** Alternative to `options`: raw <option>/<optgroup> children. */
  children?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  width?: number | string;
}

export function Select({
  value,
  onChange,
  options,
  children,
  disabled,
  className,
  style,
  title,
  width,
}: SelectProps) {
  let body: React.ReactNode = children;
  if (options) {
    const out: React.ReactNode[] = [];
    let i = 0;
    while (i < options.length) {
      const g = options[i].group;
      if (g === undefined) {
        const o = options[i];
        out.push(
          <option key={`o${i}`} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>,
        );
        i++;
      } else {
        const start = i;
        const groupOpts: React.ReactNode[] = [];
        while (i < options.length && options[i].group === g) {
          const o = options[i];
          groupOpts.push(
            <option key={`o${i}`} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>,
          );
          i++;
        }
        out.push(
          <optgroup key={`g${start}`} label={g}>
            {groupOpts}
          </optgroup>,
        );
      }
    }
    body = out;
  }
  return (
    <select
      className={"select" + (className ? " " + className : "")}
      style={width !== undefined ? { width, ...style } : style}
      value={value}
      disabled={disabled}
      title={title}
      onChange={(e) => onChange(e.target.value)}
    >
      {body}
    </select>
  );
}
