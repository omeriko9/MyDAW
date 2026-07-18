/**
 * PluginLoadOverlay — Cubase-style modal progress while hosted plugins load
 * (project load, import auto-recreate, Recreate Plugins). Driven entirely by
 * event/pluginLoadProgress: shows "Loading plugins…", the current plugin name and a
 * determinate bar. Hides on {done:true} (short linger so one-plugin loads don't
 * flash), on engine disconnect, and after a 60 s stall (a plugin host that died
 * mid-load never sends done — the overlay must not wedge the UI forever).
 */

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ws } from "../../protocol/ws";
import { useStore } from "../../store/store";
import { Icon } from "../common/icons";

const LINGER_MS = 350;
const STALL_MS = 60_000;

export default function PluginLoadOverlay() {
  const connected = useStore((s) => s.connected);
  const [st, setSt] = useState<{ current: number; total: number; name: string } | null>(null);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = (r: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
      if (r.current !== null) {
        clearTimeout(r.current);
        r.current = null;
      }
    };
    const off = ws.on("event/pluginLoadProgress", (ev) => {
      clear(stallRef);
      if (ev.done) {
        clear(lingerRef);
        lingerRef.current = setTimeout(() => {
          lingerRef.current = null;
          setSt(null);
        }, LINGER_MS);
        setSt((prev) => (prev ? { ...prev, current: ev.total, name: "" } : prev));
        return;
      }
      clear(lingerRef);
      setSt({ current: ev.current, total: ev.total, name: ev.name });
      stallRef.current = setTimeout(() => {
        stallRef.current = null;
        setSt(null);
      }, STALL_MS);
    });
    return () => {
      off();
      clear(lingerRef);
      clear(stallRef);
    };
  }, []);

  useEffect(() => {
    if (!connected) setSt(null);
  }, [connected]);

  if (!st) return null;
  const pct = st.total > 0 ? Math.min(100, (st.current / st.total) * 100) : 0;
  return createPortal(
    <div className="modal-overlay plugin-load-overlay">
      <div className="modal" style={{ width: 420 }} role="dialog" aria-modal="true" aria-label="Loading plugins">
        <div className="modal-title">
          <Icon name="plug" size={14} className="dim" />
          <span className="grow ellipsis">Loading plugins…</span>
        </div>
        <div className="modal-body">
          <div className="plo-name ellipsis">{st.name || "Finishing…"}</div>
          <div className="dlg-progress">
            <div className="dlg-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="plo-count">
            {Math.min(st.current, st.total)} / {st.total}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
