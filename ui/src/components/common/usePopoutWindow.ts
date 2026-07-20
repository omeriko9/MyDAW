/**
 * usePopoutWindow — owns a separate browser window (window.open) plus a portal mount
 * point inside it (U3: pop-out dock tabs). SAME-JS-CONTEXT approach: the popup hosts
 * DOM only; React, the zustand store, the ws singleton and the imperative buses all
 * live in the MAIN window, so a pane rendered through ReactDOM.createPortal into the
 * popup keeps working transparently.
 *
 * Responsibilities:
 *  - window.open("", name, …) a named popup; title + dark background are set
 *    SYNCHRONOUSLY on open (before any stylesheet arrives) to avoid a white flash;
 *  - copy every <style> / <link rel="stylesheet"> from the main document.head into the
 *    popup and KEEP them in sync via a MutationObserver — vite injects <style> nodes
 *    dynamically in dev and edits their text in place on HMR;
 *  - forward popup keydowns (non-editable targets only) to the MAIN window as synthetic
 *    KeyboardEvents so the global shortcut map (lib/keyboard.ts, which does not check
 *    isTrusted) and capture-phase Escape handlers keep working; when a main-window
 *    handler preventDefault()s the forwarded event, the popup's original event is
 *    preventDefault()ed too (e.g. Space must not scroll the popup);
 *  - dock back when the popup goes away ('pagehide' / 'beforeunload' + a win.closed
 *    poll as belt-and-braces) → onClosed fires exactly once;
 *  - close the popup when the main window unloads ('pagehide') or the owning component
 *    unmounts;
 *  - popup blocked by the browser → open() returns false and nothing else changes
 *    (the caller keeps the pane docked and surfaces a notice).
 *
 * Known quirk (accepted): overlays that portal into the MAIN document — ContextMenu,
 * Tooltip, Modal — open in the main window even when triggered from a popped-out pane.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { registerThemeDocument } from "../../lib/theme";
import { registerMotionDocument } from "../../lib/motion";

export interface PopoutOptions {
  /** window.open name (e.g. "MyDAW-mixer") — reopening reuses the same OS window. */
  name: string;
  /** Popup document.title. */
  title: string;
  width?: number;
  height?: number;
  /**
   * Fired exactly once whenever the popup goes away for ANY reason (user closed it,
   * close() was called, the main window unloaded, the owner unmounted). Read through a
   * ref, so an inline closure is fine; safe to setState from here.
   */
  onClosed?: () => void;
}

export interface PopoutWindow {
  /** Portal mount point inside the popup; null while not popped out. */
  container: HTMLElement | null;
  /** True while the popup is open (container mounted). */
  isOpen: boolean;
  /**
   * Open the popup (or focus it when already open). Call from a user gesture —
   * popup blockers only allow window.open under transient user activation.
   * Returns false when the browser blocked the popup.
   */
  open: () => boolean;
  /** Close the popup programmatically (dock back). Triggers onClosed. */
  close: () => void;
  /** Bring the popup to the front, if open. */
  focus: () => void;
}

interface Session {
  win: Window;
  /** Remove listeners/observers/poll. Does NOT close the window. */
  dispose: () => void;
}

/** Cross-realm-safe editable check — popup elements are NOT `instanceof HTMLElement`
 *  of the main realm, so duck-type instead. */
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

export function usePopoutWindow(opts: PopoutOptions): PopoutWindow {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const sessionRef = useRef<Session | null>(null);

  /** Tear down the current session (idempotent) and notify the owner exactly once. */
  const endSession = useCallback((closeWindow: boolean) => {
    const s = sessionRef.current;
    if (!s) return;
    sessionRef.current = null;
    s.dispose();
    if (closeWindow) {
      try {
        if (!s.win.closed) s.win.close();
      } catch {
        /* window already destroyed */
      }
    }
    setContainer(null);
    optsRef.current.onClosed?.();
  }, []);

  const open = useCallback((): boolean => {
    const existing = sessionRef.current;
    if (existing) {
      if (!existing.win.closed) {
        existing.win.focus();
        return true;
      }
      endSession(false); // zombie (popup died without notifying) — clean up, reopen below
    }

    const { name, title, width = 1000, height = 480 } = optsRef.current;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 3));
    let win: Window | null = null;
    try {
      win = window.open(
        "",
        name,
        `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
      );
    } catch {
      win = null;
    }
    if (!win) return false; // popup blocked — caller keeps the pane docked

    const doc = win.document;

    /* ---- reset stale content (window.open reuses same-name windows, e.g. after HMR) */
    doc.head.querySelectorAll("[data-mydaw-popout]").forEach((n) => n.remove());
    doc.body.textContent = "";

    /* ---- title + dark chrome SYNCHRONOUSLY, before any stylesheet loads ---- */
    doc.title = title;
    const mainCss = window.getComputedStyle(document.body);
    for (const el of [doc.documentElement, doc.body]) {
      el.style.background = mainCss.backgroundColor;
      el.style.color = mainCss.color;
      el.style.margin = "0";
      el.style.height = "100%";
      el.style.overflow = "hidden";
    }
    // Mirror class hooks so the copied CSS applies identically (theme is class-agnostic
    // today, but this keeps the popup correct if that ever changes).
    doc.documentElement.className = document.documentElement.className;
    doc.body.className = document.body.className;
    // Theme + motion: stamp data-theme / data-motion now and on every later switch.
    const unregisterTheme = registerThemeDocument(doc);
    const unregisterMotion = registerMotionDocument(doc);

    /* ---- stylesheet mirroring (initial copy + live sync for vite dev injection) ---- */
    const cloneMap = new Map<Element, HTMLElement>();
    const syncStyles = () => {
      const sources = Array.from(
        document.head.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]'),
      );
      const alive = new Set<Element>(sources);
      for (const [src, clone] of cloneMap) {
        if (!alive.has(src)) {
          clone.remove();
          cloneMap.delete(src);
        }
      }
      for (const src of sources) {
        const existing = cloneMap.get(src);
        if (existing) {
          // vite HMR edits <style> text / <link> hrefs IN PLACE — mirror without
          // re-appending (avoids refetch/FOUC for unchanged links).
          if (src instanceof HTMLStyleElement && existing.textContent !== src.textContent) {
            existing.textContent = src.textContent;
          } else if (
            src instanceof HTMLLinkElement &&
            (existing as HTMLLinkElement).href !== src.href
          ) {
            (existing as HTMLLinkElement).href = src.href;
          }
        } else {
          const clone = doc.importNode(src, true);
          clone.setAttribute("data-mydaw-popout", "");
          // Use the RESOLVED .href — the popup is about:blank, so a relative href
          // attribute would not resolve against the dev server / app origin.
          if (src instanceof HTMLLinkElement) (clone as HTMLLinkElement).href = src.href;
          cloneMap.set(src, clone);
          doc.head.appendChild(clone);
        }
      }
    };
    syncStyles();
    const mo = new MutationObserver(syncStyles);
    mo.observe(document.head, {
      childList: true,
      subtree: true, // style text lives in child text nodes
      characterData: true,
      attributes: true,
    });

    /* ---- portal mount point ---- */
    const root = doc.createElement("div");
    root.setAttribute("data-mydaw-popout", "");
    root.className = "app-dock-body"; // same flex-column sizing the docked panes get
    root.style.position = "fixed";
    root.style.inset = "0";
    doc.body.appendChild(root);

    /* ---- keyboard forwarding: popup keydown → synthetic keydown on the MAIN window */
    const onPopupKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      const fwd = new KeyboardEvent("keydown", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        location: e.location,
        bubbles: true,
        cancelable: true,
      });
      // dispatchEvent returns false when a handler preventDefault()ed → mirror it so
      // the popup doesn't also apply its default (e.g. Space scrolling the page).
      if (!window.dispatchEvent(fwd)) e.preventDefault();
    };
    win.addEventListener("keydown", onPopupKeyDown);

    // Same native-context-menu suppression the main window applies (App.tsx) — panes
    // with their own menus preventDefault before this bubble listener fires.
    const onPopupContextMenu = (e: MouseEvent) => {
      if (!isEditableTarget(e.target)) e.preventDefault();
    };
    win.addEventListener("contextmenu", onPopupContextMenu);

    /* ---- lifecycle ---- */
    // (declared before `session` on purpose; only runs after session is assigned)
    const onPopupGone = () => {
      if (sessionRef.current === session) endSession(false);
    };
    win.addEventListener("pagehide", onPopupGone);
    win.addEventListener("beforeunload", onPopupGone);
    // Belt-and-braces: some browsers are flaky about pagehide on about:blank popups.
    const poll = window.setInterval(() => {
      if (win.closed) onPopupGone();
    }, 500);
    // Main window unloading (refresh/close) takes all popups with it.
    const onMainHide = () => {
      try {
        win.close();
      } catch {
        /* already gone */
      }
    };
    window.addEventListener("pagehide", onMainHide);

    const session: Session = {
      win,
      dispose: () => {
        mo.disconnect();
        unregisterTheme();
        unregisterMotion();
        window.clearInterval(poll);
        window.removeEventListener("pagehide", onMainHide);
        try {
          win.removeEventListener("keydown", onPopupKeyDown);
          win.removeEventListener("contextmenu", onPopupContextMenu);
          win.removeEventListener("pagehide", onPopupGone);
          win.removeEventListener("beforeunload", onPopupGone);
        } catch {
          /* popup document already destroyed */
        }
      },
    };
    sessionRef.current = session;
    setContainer(root);
    win.focus();
    return true;
  }, [endSession]);

  const close = useCallback(() => endSession(true), [endSession]);

  const focus = useCallback(() => {
    const s = sessionRef.current;
    if (s && !s.win.closed) s.win.focus();
  }, []);

  // Owner unmount (incl. dev HMR remounts): close the popup and notify, so the store's
  // poppedOut flag never points at a dead window. No-op when nothing is open
  // (StrictMode's mount→cleanup→mount probe is safe).
  useEffect(() => () => endSession(true), [endSession]);

  return { container, isOpen: container !== null, open, close, focus };
}
