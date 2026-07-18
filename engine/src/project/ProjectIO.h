// MyDAW — project/ProjectIO.h (E3)
// Project persistence per SPEC §6: a project is a folder `Name.mydaw/` containing
// project.json, audio/, peaks/, plugin-states/, autosave/. Atomic saves (tmp+rename),
// plugin chunk capture via HostProcessManager, autosave round-robin (5 slots), crash
// recovery via %APPDATA%/MyDAW/session.lock, recent-projects list, asset relink.
//
// Main-thread only (called from command/message processing, SPEC §7). Non-RT.

#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "project/Model.h"
#include "util/Json.h"

namespace mydaw {

class EventBus;
class HostProcessManager; // plugins/HostProcess.h (E7)
class AssetStore;         // media/AssetStore.h (E4)

class ProjectIO {
public:
    // Snapshots %APPDATA%/MyDAW/session.lock at construction (crash-recovery probe must
    // see the PREVIOUS run's lock before this run overwrites it).
    ProjectIO();

    // ----- wiring (E9, optional; everything tolerates null) ------------------
    void setEventBus(EventBus* bus) { eventBus_ = bus; }
    void setHostProcessManager(HostProcessManager* hpm) { host_ = hpm; }
    void setAssetStore(AssetStore* store) { assets_ = store; }
    // App-level orphan plugin-state store (SPEC §5.6): when the host has no state for an
    // instance (dormant import), capturePluginStates falls back to these bytes for the
    // plugin-states/<id>.bin write and clears the entry (the file now owns the state).
    void setOrphanStates(std::map<uint64_t, std::vector<uint8_t>>* m) { orphanStates_ = m; }

    // ----- lifecycle (SPEC §5.1) ---------------------------------------------
    // Fresh default project; clears the project path. Never fails in practice.
    bool newProject(Model& model, std::string& err);

    // `projectJsonPathOrDir` may be the Name.mydaw folder or the project.json inside it.
    // Fills `missingAssets` with ids of assets whose files cannot be found (their
    // Asset::missing flags are set on the model). Wires the AssetStore (project dir,
    // async loads, peaks) when one is set.
    bool load(const std::string& projectJsonPathOrDir, Model& model,
              std::vector<uint64_t>& missingAssets, std::string& err);

    // Atomic save to the current project folder. Captures plugin state chunks to
    // plugin-states/<instanceId>.bin (HostProcessManager) and copies still-external
    // referenced audio into audio/. err == "no_path" when the project was never saved
    // (protocol error code, SPEC §5.1).
    bool save(Model& model, std::string& err);

    // Creates `<dir>.mydaw/` (or uses `dir` verbatim when it already ends in .mydaw),
    // full folder structure, copies referenced assets into audio/, then saves.
    // Renames the project after the folder.
    bool saveAs(Model& model, const std::string& dir, std::string& err);

    const std::string& projectDir() const { return projectDir_; }
    bool hasPath() const { return !projectDir_.empty(); }
    std::string projectJsonPath() const; // "" when no path

    // Engine-picked location for an automatic Save As (project/saveAs {auto:true} — the
    // UI auto-saves a never-saved project before load/import replaces it):
    // <Documents>\MyDAW Projects\<sanitized name>, deduped " 2"/" 3"… against the
    // "<dir>.mydaw" folder saveAs will create. Falls back to %USERPROFILE%\Documents.
    std::string defaultSaveAsDir(const std::string& projectName) const;

    // ----- dirty tracking ----------------------------------------------------
    // Broadcasts event/dirty {dirty} via the EventBus on transitions.
    void markDirty();
    void clearDirty();
    bool isDirty() const { return dirty_; }

    // ----- autosave (driven by Autosave::tick, E9 main loop) ------------------
    // Writes autosave/project-<n>.json (n = 1..5, oldest slot overwritten) inside the
    // project folder — or %APPDATA%/MyDAW/autosave/ for never-saved projects — and
    // captures plugin chunks. Does NOT clear dirty.
    bool autosaveNow(Model& model, std::string& err);

    // ----- crash recovery (SPEC §6/§5.1) --------------------------------------
    struct RecoveryInfo {
        bool available = false;
        std::string autosavePath; // newest autosave json (or project.json fallback)
        int64_t mtime = 0;        // unix seconds
        std::string projectPath;  // project folder from the stale lock ("" = unsaved)
    };
    RecoveryInfo recoveryInfo() const; // based on the lock snapshot taken at startup
    bool recover(Model& model, std::string& err); // loads recoveryInfo().autosavePath
    void clearSessionLock();                      // clean shutdown (E9)

    // ----- recent projects (%APPDATA%/MyDAW/recent.json, max 10) --------------
    json recentProjects() const; // [{path,name,mtime}], newest first
    // Remember `path` (project dir OR an imported foreign file — .cpr/.mid; Open
    // Recent re-imports those) as the newest entry. Temp-dir paths are refused.
    // Broadcasts event/recentProjects {recentProjects} so open UIs refresh live.
    void addRecent(const std::string& path, const std::string& name);

    // ----- relink (media/relink, SPEC §5.5) -----------------------------------
    // Updates Asset::file/originalPath, clears `missing`, re-triggers
    // AssetStore::loadAsync + ensurePeaks. Marks dirty. Caller (E9) broadcasts the
    // resulting projectChanged.
    bool relink(Model& model, uint64_t assetId, const std::string& newPath,
                std::string& err);

    // Absolute path of an asset's audio file (project-relative entries resolved
    // against projectDir(); absolute entries returned verbatim).
    std::string resolveAssetPath(const Asset& a) const;

private:
    bool saveInternal(Model& model, const std::string& assetSourceDir, std::string& err);
    // Writes each insert's state chunk to <targetDir>/plugin-states/<id>.bin. A live host's
    // getState wins; otherwise the in-RAM orphan bytes are written (the orphan entry is KEPT
    // — durable session fallback). Used for both normal saves (targetDir = projectDir_) and
    // no-path autosave/recovery snapshots (targetDir = appdata autosave dir) so an unsaved
    // import's plugin state survives a crash before Save-As.
    //   stampModel == true  (real project dir, hasPath()): stamps pi.stateFile (target-
    //                        relative) onto the live model so save/load round-trips it.
    //   stampModel == false (no-path autosave dir): does NOT touch the live model — a
    //                        project-dir-relative stateFile would be meaningless / dangling
    //                        with no project dir. The written rel paths are returned in
    //                        `wrote` so the caller can stamp the on-disk JSON snapshot only.
    void capturePluginStates(Model& model, const std::string& targetDir, bool stampModel,
                             std::map<uint64_t, std::string>* wrote = nullptr);
    void copyExternalAssets(Model& model, const std::string& sourceDir);
    void refreshMissingFlags(Model& model, std::vector<uint64_t>* missingAssets);
    void wireAssetStore(Model& model);
    void writeSessionLock();
    std::string autosaveDir() const;       // project autosave/ or appdata fallback
    std::string sessionLockPath() const;
    std::string recentJsonPath() const;
    void broadcastDirty();

    EventBus* eventBus_ = nullptr;
    HostProcessManager* host_ = nullptr;
    AssetStore* assets_ = nullptr;
    std::map<uint64_t, std::vector<uint8_t>>* orphanStates_ = nullptr;

    std::string projectDir_; // "" = never saved
    bool dirty_ = false;

    bool startupLockExisted_ = false;
    std::string startupLockProjectPath_;
};

} // namespace mydaw
