/**
 * DialogsHost (U5) — mounts the app-level dialogs (SPEC §9):
 *   - Export (store.dialogs.export)
 *   - Relink (auto-opens while assets are missing)
 *   - Recreate Plugins (store.dialogs.recreatePlugins; auto-opened after Import Project)
 *   - Recovery prompt (project/recoveryInfo after hello)
 *   - Import Project by path (imperative openImportPathDialog(), U2)
 *   - Room View spatial panner (store.dialogs.roomView; mixer toolbar)
 *   - ToastHost (imperative showToast(), U2)
 * The imperative confirmDialog (./confirm) renders into its own root and needs no host.
 */

import React from "react";
import "./dialogs.css";
import ExportDialog from "./ExportDialog";
import RelinkDialog from "./RelinkDialog";
import RecreatePluginsDialog from "./RecreatePluginsDialog";
import RecoveryDialog from "./RecoveryDialog";
import PastePathDialog from "./PastePathDialog";
import PluginLoadOverlay from "./PluginLoadOverlay";
import ShortcutsDialog from "./ShortcutsDialog";
import RoomView from "../Mixer/RoomView";
import ToastHost from "../common/ToastHost";

export default function DialogsHost() {
  return (
    <>
      <ExportDialog />
      <RelinkDialog />
      <RecreatePluginsDialog />
      <RecoveryDialog />
      <PastePathDialog />
      <ShortcutsDialog />
      <RoomView />
      <PluginLoadOverlay />
      <ToastHost />
    </>
  );
}
