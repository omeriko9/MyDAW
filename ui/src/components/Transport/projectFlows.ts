/**
 * Project file flows (owned by U2) — shared by the transport-bar File menu and the
 * global keyboard shortcuts (Ctrl+S etc.).
 *
 * SPEC §5.1: project/save with no path yet → error "no_path"; the UI then asks the
 * engine to open a native save dialog (dialog/saveProject) and retries via saveAs.
 * Destructive flows (New / Close / Open / Recent / Import) AUTO-SAVE the current
 * project first instead of nagging (autoSaveIfDirty) — a confirm only appears if
 * the auto-save itself fails.
 */

import { ws, WsRequestError } from "../../protocol/ws";
import {
  autoSaveProjectAs,
  dialogImportFiles,
  dialogImportProject,
  dialogOpenProject,
  dialogSaveProject,
  getImportFormats,
  getRecoveryInfo,
  getUnresolvedPlugins,
  importForeignProject,
  importMedia,
  loadProject,
  loadRecentProject,
  newProject,
  recreatePlugins,
  saveProject,
  saveProjectAs,
} from "../../store/actions";
import { useStore } from "../../store/store";
import { confirmDialog } from "../Dialogs/confirm";
import { openImportPathDialog } from "../Dialogs/PastePathDialog";
import { showToast } from "../common/ToastHost";

/**
 * Log + surface a flow failure. Failures used to be console-only ("import silently
 * no-ops"); now they raise an error toast unless `toast` is false (cosmetic checks).
 */
function logFlowError(what: string, e: unknown, toast = true): void {
  if (e instanceof WsRequestError && e.code === "not_connected") return; // offline — overlay shows
  console.error(`[project] ${what} failed:`, e);
  if (toast) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${what[0].toUpperCase()}${what.slice(1)} failed: ${msg}`, "error");
  }
}

/**
 * Auto-save the current project before a destructive replace (New / Close / Open /
 * Recent / Import) — no "unsaved changes?" nag: a saved project saves silently in
 * place; a never-saved one is saved to an engine-picked folder (project/saveAs
 * {auto:true} → Documents\MyDAW Projects\<name>, deduped) with a toast saying where
 * it went. Only a FAILED save falls back to the old discard-confirm, so work is
 * never silently lost. Returns true = proceed with the destructive flow.
 */
async function autoSaveIfDirty(title: string): Promise<boolean> {
  if (!useStore.getState().dirty) return true;
  try {
    await saveProject();
    return true;
  } catch (e) {
    if (e instanceof WsRequestError && e.code === "no_path") {
      try {
        const { project } = await autoSaveProjectAs();
        showToast(`"${project.name}" auto-saved to Documents\\MyDAW Projects.`, "info");
        return true;
      } catch (e2) {
        logFlowError("auto-save", e2, false);
      }
    } else {
      logFlowError("auto-save", e, false);
    }
    return confirmDialog({
      title,
      message: "Auto-saving the current project failed. Discard its unsaved changes?",
      confirmLabel: "Discard",
      danger: true,
    });
  }
}

export async function newProjectFlow(): Promise<void> {
  try {
    if (!(await autoSaveIfDirty("New Project"))) return;
    await newProject();
  } catch (e) {
    logFlowError("new project", e);
  }
}

/**
 * File → New Window. Asks the engine to spawn a second, independent MyDAW instance (its own
 * blank project + audio graph) on a free port, then opens it in a new browser tab. The tab
 * is opened synchronously (inside the click gesture) to dodge popup blockers, then pointed
 * at the child once it is serving. The child self-closes ~15 s after this tab is closed.
 */
export async function newWindowFlow(): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  try {
    const { url } = await ws.request("session/newWindow", {});
    if (tab) tab.location.href = url;
    else window.open(url, "_blank");
  } catch (e) {
    tab?.close();
    logFlowError("new window", e);
  }
}

/**
 * File → Close. The engine has no "no project loaded" state (SPEC §5.1), so Close
 * confirms when dirty and resets to an empty project (project/new) — same shape as New.
 */
export async function closeProjectFlow(): Promise<void> {
  try {
    if (!(await autoSaveIfDirty("Close Project"))) return;
    await newProject();
  } catch (e) {
    logFlowError("close project", e);
  }
}

export async function openProjectFlow(): Promise<void> {
  try {
    if (!(await autoSaveIfDirty("Open Project"))) return;
    const { path } = await dialogOpenProject();
    if (!path) return; // user cancelled the native dialog
    await loadProject(path);
  } catch (e) {
    logFlowError("open project", e);
  }
}

export async function loadRecentFlow(path: string): Promise<void> {
  try {
    if (!(await autoSaveIfDirty("Open Recent Project"))) return;
    await loadRecentProject(path);
    // Recents include imported foreign projects (.cpr/.mid) — the engine re-imports
    // those, so run the same post-import plugin loading as Import Project.
    if (/\.(cpr|midi?)$/i.test(path)) await offerPluginRecreation();
  } catch (e) {
    logFlowError(`open recent (${path})`, e);
  }
}

/** Save; on no_path falls through to Save As. Returns true if the project was saved. */
export async function saveProjectFlow(): Promise<boolean> {
  try {
    await saveProject();
    return true;
  } catch (e) {
    if (e instanceof WsRequestError && e.code === "no_path") {
      return saveProjectAsFlow();
    }
    logFlowError("save", e);
    return false;
  }
}

/** Native save dialog → project/saveAs. Returns true if saved. */
export async function saveProjectAsFlow(): Promise<boolean> {
  try {
    const { path } = await dialogSaveProject();
    if (!path) return false; // cancelled
    await saveProjectAs(path);
    return true;
  } catch (e) {
    logFlowError("save as", e);
    return false;
  }
}

/**
 * Imported projects reference plugins with no live host instance. Everything the
 * registry can resolve by uid is recreated AUTOMATICALLY (state restore included) —
 * the user shouldn't have to click "Recreate Now" for plugins that are installed.
 * Only genuinely missing / failed plugins open the Recreate dialog (which offers
 * substitutes; manual access: File → Recreate Plugins…).
 */
export async function offerPluginRecreation(): Promise<void> {
  try {
    const { plugins } = await getUnresolvedPlugins();
    if (plugins.length === 0) return;
    const resolvable = plugins.filter((p) => p.inRegistry);
    if (resolvable.length > 0) {
      showToast(
        `Loading ${resolvable.length} imported plugin${resolvable.length === 1 ? "" : "s"}…`,
        "info",
      );
      try {
        const { results } = await recreatePlugins(resolvable.map((p) => p.instanceId));
        const failed = results.filter((r) => !r.ok).length;
        if (failed === 0)
          showToast(`${results.length} plugin${results.length === 1 ? "" : "s"} loaded.`, "success");
      } catch (e) {
        logFlowError("auto plugin recreation", e, false);
      }
    }
    const after = await getUnresolvedPlugins();
    if (after.plugins.length > 0) useStore.getState().setDialogs({ recreatePlugins: true });
  } catch (e) {
    logFlowError("unresolved-plugins check", e, false); // dialog stays reachable via File menu
  }
}

/**
 * Import a foreign project (e.g. .cpr / Standard MIDI File) as a NEW project.
 * Entry point (File → Import → Project…) opens the paste-path dialog — browsers cannot
 * read full OS paths and the native picker is flaky, so typing/pasting a path is the
 * primary flow; the dialog's "Browse (native)…" button falls back to the old picker.
 */
export function importProjectFlow(): void {
  openImportPathDialog();
}

/**
 * Import a foreign project file by absolute path — destructive like Open, so the current
 * project auto-saves first. project/importForeign: the engine adopts the imported model (dirty,
 * no save path) and broadcasts the full project via event/projectChanged.
 * Throws on import failure ("no_provider" | "import_failed") — callers display the error.
 */
export async function importForeignPathFlow(path: string): Promise<"imported" | "cancelled"> {
  if (!(await autoSaveIfDirty("Import Project"))) return "cancelled";
  await importForeignProject(path);
  await offerPluginRecreation();
  return "imported";
}

/** Old native-picker import flow — kept as the PastePathDialog "Browse (native)…" fallback. */
export async function importProjectNativeFlow(): Promise<void> {
  try {
    if (!(await autoSaveIfDirty("Import Project"))) return;
    const { path } = await dialogImportProject();
    if (!path) return; // user cancelled the native dialog
    await importForeignProject(path);
    await offerPluginRecreation();
  } catch (e) {
    logFlowError("import project", e); // "no_provider" | "import_failed" land here
  }
}

/**
 * Foreign-project formats that are NOT also media formats (e.g. Cubase .cpr). These open a
 * NEW project (project/importForeign), unlike .mid/.wav which import as media into the
 * current session. Fetched once from the engine's provider registry and cached; falls back
 * to {cpr} if the registry is unreachable. .mid/.midi are deliberately treated as media here
 * (Import Files adds MIDI clips); open them as a project via File → Import Project instead.
 */
const MEDIA_EXTS = new Set([
  "wav", "wave", "bwf", "mp3", "flac", "aif", "aiff", "aifc", "m4a", "aac",
  "ogg", "oga", "wma", "mid", "midi", "smf", "rmi",
]);
let projectOnlyExtsCache: Set<string> | null = null;

export async function projectOnlyExtensions(): Promise<Set<string>> {
  if (projectOnlyExtsCache) return projectOnlyExtsCache;
  try {
    const { formats } = await getImportFormats();
    const set = new Set<string>();
    for (const f of formats)
      for (const e of f.extensions) {
        const ext = e.toLowerCase().replace(/^\./, "");
        if (ext && !MEDIA_EXTS.has(ext)) set.add(ext);
      }
    projectOnlyExtsCache = set.size > 0 ? set : new Set(["cpr"]);
  } catch {
    projectOnlyExtsCache = new Set(["cpr"]); // engine offline — sensible default
  }
  return projectOnlyExtsCache;
}

export function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type ImportPathsResult =
  | { kind: "project"; path: string }
  | { kind: "media"; count: number }
  | { kind: "none" };

/**
 * Route a list of OS file PATHS picked from a native dialog: a foreign-project file (.cpr)
 * opens as a NEW project (replace, confirm-if-dirty, then offer plugin recreation); anything
 * else imports as media into the current project. A project replaces the whole session, so we
 * open at most one and ignore any other files in the same selection (with a console note).
 */
export async function importPickedPaths(paths: string[]): Promise<ImportPathsResult> {
  if (paths.length === 0) return { kind: "none" };
  const projExts = await projectOnlyExtensions();
  const projectPaths = paths.filter((p) => projExts.has(extensionOf(p)));
  const mediaPaths = paths.filter((p) => !projExts.has(extensionOf(p)));

  if (projectPaths.length > 0) {
    if (!(await autoSaveIfDirty("Import Project"))) return { kind: "none" };
    const path = projectPaths[0];
    await importForeignProject(path);
    await offerPluginRecreation();
    if (projectPaths.length > 1 || mediaPaths.length > 0)
      console.warn(
        "[import] opened a project file; other selected files were ignored (a project replaces the session).",
      );
    return { kind: "project", path };
  }

  const rep = await importMedia(mediaPaths);
  return { kind: "media", count: rep.assets.length };
}

/**
 * Native multi-file picker → smart route: .cpr opens as a project, media imports as assets
 * (assets land via event/projectChanged).
 */
export async function importFilesFlow(): Promise<void> {
  try {
    const { paths } = await dialogImportFiles();
    if (!paths || paths.length === 0) return;
    await importPickedPaths(paths);
  } catch (e) {
    logFlowError("import files", e);
  }
}

/* ============================================================================
 * Crash-recovery offer (SPEC §5.1 / §6) — checked once per app load after the
 * first successful connection; DialogsHost (U5) renders store.dialogs.recovery.
 * ========================================================================= */

let recoveryChecked = false;

export async function checkRecoveryOnce(): Promise<void> {
  if (recoveryChecked) return;
  recoveryChecked = true;
  try {
    const info = await getRecoveryInfo();
    if (info.available) {
      useStore.getState().setDialogs({ recovery: info });
    }
  } catch (e) {
    logFlowError("recovery check", e, false); // cosmetic — no toast
  }
}
