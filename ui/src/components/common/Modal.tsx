/**
 * Modal — portal'd dialog (owned by F4).
 *
 * Escape and overlay-click close (overlay configurable). Focus trap-lite: focuses the
 * panel on open, Tab cycles within, focus restored on close. Title bar with close X.
 * An element marked `data-autofocus` receives the initial focus instead of the first
 * focusable control (e.g. a dialog's default action button, so Enter activates it).
 */

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  /** Right-aligned action row (e.g. Cancel / OK buttons). */
  footer?: React.ReactNode;
  width?: number | string;
  /** Click on the dimmed backdrop closes (default true). */
  closeOnOverlay?: boolean;
  /** Hide the X button / title row entirely when no title and this is false. */
  showClose?: boolean;
  className?: string;
  /** Drag the dialog around by its title bar (offset resets on reopen). */
  draggable?: boolean;
  /**
   * Let the global transport shortcuts (play/stop/locate…) keep working while this
   * modal is open (lib/keyboard.ts checks data-transport-keys on the overlay).
   */
  transportKeys?: boolean;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width,
  closeOnOverlay = true,
  showClose = true,
  className,
  draggable,
  transportKeys,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const prevFocus = useRef<Element | null>(null);

  // Title-bar drag offset (draggable modals). Reset each time the dialog opens.
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    if (open) setOffset({ x: 0, y: 0 });
  }, [open]);
  const onTitleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggable || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, select")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onTitleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + e.clientX - d.px, y: d.oy + e.clientY - d.py });
  };
  const onTitleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement;
    // Focus the [data-autofocus] control if present, else the first focusable,
    // else the panel itself.
    const panel = panelRef.current;
    if (panel) {
      const first =
        panel.querySelector<HTMLElement>("[data-autofocus]") ??
        panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const prev = prevFocus.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const onTabTrap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const panelStyle: React.CSSProperties = {};
  if (width !== undefined) panelStyle.width = width;
  if (draggable && (offset.x !== 0 || offset.y !== 0))
    panelStyle.transform = `translate(${offset.x}px, ${offset.y}px)`;

  return createPortal(
    <div
      className="modal-overlay"
      data-transport-keys={transportKeys ? "allow" : undefined}
      onMouseDown={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={"modal" + (className ? " " + className : "")}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={onTabTrap}
      >
        {(title !== undefined || showClose) && (
          <div
            className={"modal-title" + (draggable ? " modal-title-drag" : "")}
            onPointerDown={onTitleDown}
            onPointerMove={onTitleMove}
            onPointerUp={onTitleUp}
            onPointerCancel={onTitleUp}
          >
            <span className="grow ellipsis">{title}</span>
            {showClose && <IconButton icon="x" onClick={onClose} tooltip="Close (Esc)" />}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
