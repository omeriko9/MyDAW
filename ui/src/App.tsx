/**
 * App (owned by U2) — global wiring + shell selection. The workspace itself is
 * rendered by ONE of three interchangeable shells (docs/UI_ALTERNATIVES_PLAN.md;
 * switch via View → UI Mode, Settings → General, or Ctrl+Alt+M):
 *
 *   classic     shell/ClassicShell — SPEC §9: Browser | Timeline | Agent + bottom dock
 *   ribbon      shell/RibbonShell  — ribbon categories + split work area
 *   workspaces  shell/WorkspacesShell — named tiling workspaces
 *
 * The pane components are identical in all three; only their arrangement differs.
 * App keeps everything shell-independent: ws connect, keyboard, recovery, window
 * guards, the always-mounted dialog hosts, pop-out portal hosting (PopoutProvider —
 * pop-outs survive shell switches), and the offline/shutdown overlays.
 */

import { useEffect } from "react";
import "./lib/theme.css";
import "./components/Transport/transport.css";
import "./shell/shell.css";
import { ws } from "./protocol/ws";
import { useStore } from "./store/store";
import { windowTitle } from "./lib/appTitle";
import { initKeyboard } from "./lib/keyboard";
import { installRecordingToast } from "./components/Transport/recordingToast";
import { checkRecoveryOnce } from "./components/Transport/projectFlows";

import BigClock from "./components/Transport/BigClock";
import SettingsDialog from "./components/Settings/SettingsDialog";
import DialogsHost from "./components/Dialogs/DialogsHost";
import PluginEditorHost from "./components/PluginEditor/PluginEditorHost";
import { Icon } from "./components/common/icons";

import { PopoutProvider } from "./shell/popouts";
import ClassicShell from "./shell/ClassicShell";
import RibbonShell from "./shell/RibbonShell";
import WorkspacesShell from "./shell/WorkspacesShell";

export default function App() {
  const connected = useStore((s) => s.connected);
  const shutdownByUser = useStore((s) => s.shutdownByUser);
  const shellMode = useStore((s) => s.shellMode);
  const projectName = useStore((s) => s.project?.name ?? null);
  const dirty = useStore((s) => s.dirty);

  useEffect(() => {
    ws.connect(); // idempotent (StrictMode-safe); store wiring handles session/hello
  }, []);

  useEffect(() => initKeyboard(), []);
  useEffect(() => installRecordingToast(), []);

  // Tab / taskbar title mirrors the open project and its unsaved-changes state.
  useEffect(() => {
    document.title = windowTitle(projectName, dirty);
  }, [projectName, dirty]);

  // Stray OS-file drops must not let the browser navigate away and lose the session.
  // Real drop zones handle + stopPropagation in the bubble phase first, so anything
  // still reaching window is unhandled — swallow it.
  useEffect(() => {
    const onWindowDragOver = (e: DragEvent) => e.preventDefault();
    const onWindowDrop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, []);

  // Suppress the native browser context menu on bare surfaces — a DAW right-click
  // should never show "Back / Reload". Surfaces with their own menu preventDefault
  // before this bubble-phase listener runs; text inputs keep the native menu
  // (clipboard / spellcheck).
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      // Keep the native menu (copy/paste/spellcheck) on inputs and the selectable agent chat.
      if (el?.closest?.('input, textarea, [contenteditable="true"], .agent-transcript')) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Offer crash recovery once per app load, after the first successful connection.
  useEffect(() => {
    if (connected) void checkRecoveryOnce();
  }, [connected]);

  return (
    <PopoutProvider>
      {shellMode === "classic" ? (
        <ClassicShell />
      ) : shellMode === "ribbon" ? (
        <RibbonShell />
      ) : (
        <WorkspacesShell />
      )}

      {/* always-mounted hosts (shell-independent) */}
      <DialogsHost />
      <SettingsDialog />
      <PluginEditorHost />
      <BigClock />

      {/* deliberate exit (File ▸ Exit): goodbye screen — reconnect is stopped, the
          engine is gone on purpose, so never show the scary "reconnecting…" spinner */}
      {shutdownByUser && (
        <div className="app-offline">
          <div className="app-offline-card app-shutdown-card">
            <Icon name="check" size={16} />
            <div>
              <div>MyDAW has exited — your project was saved.</div>
              <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                You can close this tab. To start MyDAW again, double-click the MyDAW file
                like before.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* engine-offline overlay — UI stays mounted underneath */}
      {!connected && !shutdownByUser && (
        <div className="app-offline">
          <div className="app-offline-card">
            <span className="spin">
              <Icon name="refresh" size={16} />
            </span>
            Engine offline — reconnecting…
          </div>
        </div>
      )}
    </PopoutProvider>
  );
}
