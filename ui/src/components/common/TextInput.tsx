/**
 * TextInput — styled text field with commit semantics (owned by F4).
 *
 * If `onCommit` is given the field edits a local draft: Enter or blur commits,
 * Escape reverts and blurs (DAW rename ergonomics). `onChange` (if given) still
 * fires live on every keystroke.
 */

import React, { useEffect, useRef, useState } from "react";

export interface TextInputProps {
  value: string;
  onChange?: (value: string) => void;
  /** Commit on Enter / blur; Escape reverts. */
  onCommit?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Select all text when focused (default true when onCommit is set). */
  selectOnFocus?: boolean;
  type?: "text" | "search" | "password" | "number";
  maxLength?: number;
  spellCheck?: boolean;
  className?: string;
  style?: React.CSSProperties;
  width?: number | string;
  title?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function TextInput({
  value,
  onChange,
  onCommit,
  placeholder,
  disabled,
  autoFocus,
  selectOnFocus,
  type = "text",
  maxLength,
  spellCheck = false,
  className,
  style,
  width,
  title,
  onKeyDown,
}: TextInputProps) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const revertingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Track external value while not editing.
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const display = onCommit ? (focusedRef.current ? draft : value) : value;
  const doSelectOnFocus = selectOnFocus ?? !!onCommit;

  return (
    <input
      ref={inputRef}
      className={"input" + (className ? " " + className : "")}
      style={width !== undefined ? { width, ...style } : style}
      type={type}
      value={display}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      maxLength={maxLength}
      spellCheck={spellCheck}
      title={title}
      onFocus={(e) => {
        focusedRef.current = true;
        setDraft(value);
        if (doSelectOnFocus) e.target.select();
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (onCommit && !revertingRef.current && draft !== value) onCommit(draft);
        revertingRef.current = false;
        setDraft(value);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange?.(e.target.value);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter") {
          inputRef.current?.blur(); // blur handler commits
        } else if (e.key === "Escape") {
          revertingRef.current = true;
          setDraft(value);
          onChange?.(value);
          inputRef.current?.blur();
          e.stopPropagation(); // don't trigger global esc (clear selection)
        }
      }}
    />
  );
}
