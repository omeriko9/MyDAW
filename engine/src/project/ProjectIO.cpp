// MyDAW — project/ProjectIO.cpp (E3)

#include "project/ProjectIO.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <ctime>
#include <fstream>
#include <sstream>
#include <utility>

#include "media/AssetStore.h"
#include "plugins/HostProcess.h"
#include "project/ModelOps.h"
#include "server/EventBus.h"
#include "util/Log.h"
#include "util/Paths.h"
#include "util/Strings.h"

namespace mydaw {

namespace {

constexpr int kAutosaveSlots = 5;
constexpr int kMaxRecent = 10;

bool isAbsolutePath(std::string_view p) {
    if (p.size() >= 2 && p[1] == ':')
        return true;
    if (p.size() >= 2 && (p[0] == '\\' || p[0] == '/') && (p[1] == '\\' || p[1] == '/'))
        return true; // UNC
    return false;
}

// Canonical form for path comparisons: lowercase, backslashes, no trailing separator.
std::string normPath(std::string_view p) {
    std::string out = lower(p);
    for (char& c : out)
        if (c == '/')
            c = '\\';
    while (!out.empty() && out.back() == '\\')
        out.pop_back();
    return out;
}

bool pathStartsWithDir(const std::string& absPath, const std::string& dir) {
    if (dir.empty())
        return false;
    const std::string a = normPath(absPath);
    const std::string d = normPath(dir) + "\\";
    return a.size() > d.size() && a.compare(0, d.size(), d) == 0;
}

// The OS temp directory. Throwaway/test projects (the smoke suite, imports, verification
// runs) save under here; they must never pollute the user's Recent list.
std::string tempDir() {
    wchar_t buf[MAX_PATH + 1];
    const DWORD n = GetTempPathW(MAX_PATH + 1, buf);
    if (n == 0 || n > MAX_PATH)
        return {};
    return wideToUtf8(std::wstring(buf, n));
}

bool isTempProject(const std::string& path) {
    return pathStartsWithDir(path, tempDir());
}

bool readTextFile(const std::string& path, std::string& out) {
    std::ifstream f(utf8ToWide(path).c_str(), std::ios::binary);
    if (!f.is_open())
        return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

bool writeTextFileAtomic(const std::string& path, const std::string& text,
                         std::string& err) {
    const std::string tmp = path + ".tmp";
    {
        std::ofstream f(utf8ToWide(tmp).c_str(), std::ios::binary | std::ios::trunc);
        if (!f.is_open()) {
            err = "cannot open for writing: " + tmp;
            return false;
        }
        f.write(text.data(), static_cast<std::streamsize>(text.size()));
        if (!f.good()) {
            err = "write failed: " + tmp;
            return false;
        }
    }
    if (!MoveFileExW(utf8ToWide(tmp).c_str(), utf8ToWide(path).c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        err = "atomic rename failed for: " + path;
        DeleteFileW(utf8ToWide(tmp).c_str());
        return false;
    }
    return true;
}

bool writeBinaryFile(const std::string& path, const std::vector<uint8_t>& data) {
    std::ofstream f(utf8ToWide(path).c_str(), std::ios::binary | std::ios::trunc);
    if (!f.is_open())
        return false;
    if (!data.empty())
        f.write(reinterpret_cast<const char*>(data.data()),
                static_cast<std::streamsize>(data.size()));
    return f.good();
}

bool readBinaryFile(const std::string& path, std::vector<uint8_t>& out) {
    out.clear();
    std::ifstream f(utf8ToWide(path).c_str(), std::ios::binary | std::ios::ate);
    if (!f.is_open())
        return false;
    const std::streamoff size = f.tellg();
    if (size < 0)
        return false;
    f.seekg(0);
    out.resize(static_cast<size_t>(size));
    if (size > 0)
        f.read(reinterpret_cast<char*>(out.data()), size);
    return f.good() || f.eof();
}

int64_t fileMTimeSeconds(const std::string& path) {
    WIN32_FILE_ATTRIBUTE_DATA fad{};
    if (!GetFileAttributesExW(utf8ToWide(path).c_str(), GetFileExInfoStandard, &fad))
        return 0;
    ULARGE_INTEGER t;
    t.LowPart = fad.ftLastWriteTime.dwLowDateTime;
    t.HighPart = fad.ftLastWriteTime.dwHighDateTime;
    // FILETIME (100ns since 1601) -> unix seconds.
    return static_cast<int64_t>((t.QuadPart - 116444736000000000ULL) / 10000000ULL);
}

int64_t nowUnixSeconds() {
    return static_cast<int64_t>(std::time(nullptr));
}

// "Drums.mydaw" -> "Drums"; "Drums" -> "Drums".
std::string projectNameFromDir(const std::string& dir) {
    std::string base = fileName(dir);
    if (iendsWith(base, ".mydaw"))
        base = base.substr(0, base.size() - 6);
    return base.empty() ? std::string("Untitled") : base;
}

} // namespace

// ---------------------------------------------------------------------------

ProjectIO::ProjectIO() {
    const std::string lock = sessionLockPath();
    if (fileExists(lock)) {
        startupLockExisted_ = true;
        std::string content;
        if (readTextFile(lock, content))
            startupLockProjectPath_ = trim(content);
        Log::info("ProjectIO: stale session.lock found (project: '%s') — recovery offered",
                  startupLockProjectPath_.c_str());
    }
}

std::string ProjectIO::sessionLockPath() const {
    return pathJoin(appDataDir(), "session.lock");
}

std::string ProjectIO::recentJsonPath() const {
    return pathJoin(appDataDir(), "recent.json");
}

std::string ProjectIO::projectJsonPath() const {
    return hasPath() ? pathJoin(projectDir_, "project.json") : std::string();
}

std::string ProjectIO::resolveAssetPath(const Asset& a) const {
    if (a.file.empty())
        return a.originalPath;
    if (isAbsolutePath(a.file))
        return a.file;
    return pathJoin(projectDir_, a.file);
}

// ----- dirty ---------------------------------------------------------------

void ProjectIO::broadcastDirty() {
    if (eventBus_)
        eventBus_->broadcast("event/dirty", json{{"dirty", dirty_}});
}

void ProjectIO::markDirty() {
    if (dirty_)
        return;
    dirty_ = true;
    broadcastDirty();
}

void ProjectIO::clearDirty() {
    if (!dirty_)
        return;
    dirty_ = false;
    broadcastDirty();
}

// ----- lifecycle -------------------------------------------------------------

bool ProjectIO::newProject(Model& model, std::string& err) {
    (void)err;
    model.project = Model::defaultProject();
    projectDir_.clear();
    if (assets_) {
        assets_->clear();
        assets_->setProjectDir("");
    }
    clearDirty();
    writeSessionLock();
    Log::info("ProjectIO: new project");
    return true;
}

bool ProjectIO::load(const std::string& projectJsonPathOrDir, Model& model,
                     std::vector<uint64_t>& missingAssets, std::string& err) {
    missingAssets.clear();
    std::string dir, file;
    if (dirExists(projectJsonPathOrDir)) {
        dir = projectJsonPathOrDir;
        file = pathJoin(dir, "project.json");
    } else {
        file = projectJsonPathOrDir;
        dir = parentDir(file);
    }
    std::string text;
    if (!readTextFile(file, text)) {
        err = "cannot read " + file;
        return false;
    }
    const json j = parseJson(text);
    if (j.is_discarded()) {
        err = "project.json is not valid JSON";
        return false;
    }
    Project p;
    if (!fromJson(j, p, &err))
        return false;

    model.project = std::move(p);
    projectDir_ = dir;
    refreshMissingFlags(model, &missingAssets);
    wireAssetStore(model);
    clearDirty();
    addRecent(projectDir_, model.project.name);
    writeSessionLock();
    Log::info("ProjectIO: loaded '%s' (%s)", model.project.name.c_str(), dir.c_str());
    return true;
}

bool ProjectIO::save(Model& model, std::string& err) {
    if (!hasPath()) {
        err = "no_path"; // protocol error code (SPEC §5.1)
        return false;
    }
    return saveInternal(model, projectDir_, err);
}

bool ProjectIO::saveAs(Model& model, const std::string& dir, std::string& err) {
    if (dir.empty()) {
        err = "empty saveAs path";
        return false;
    }
    std::string target = dir;
    if (!iendsWith(target, ".mydaw"))
        target += ".mydaw";

    const std::string oldDir = projectDir_;
    projectDir_ = target;
    model.project.name = projectNameFromDir(target);
    if (!saveInternal(model, oldDir, err)) {
        projectDir_ = oldDir; // roll back on failure
        return false;
    }
    return true;
}

bool ProjectIO::saveInternal(Model& model, const std::string& assetSourceDir,
                             std::string& err) {
    if (!ensureDir(projectDir_)) {
        err = "cannot create project folder: " + projectDir_;
        return false;
    }
    ensureDir(pathJoin(projectDir_, "audio"));
    ensureDir(pathJoin(projectDir_, "peaks"));
    ensureDir(pathJoin(projectDir_, "plugin-states"));
    ensureDir(pathJoin(projectDir_, "autosave"));

    capturePluginStates(model, projectDir_, /*stampModel=*/true); // real project dir
    copyExternalAssets(model, assetSourceDir);

    // error_handler_t::replace: a save must NEVER throw on a stray invalid-UTF-8 string
    // (defense in depth — import boundaries sanitize, util/Utf8.h; an uncaught throw here
    // would terminate the engine from the save/autosave path).
    const std::string text =
        toJson(model.project).dump(2, ' ', false, json::error_handler_t::replace);
    if (!writeTextFileAtomic(pathJoin(projectDir_, "project.json"), text, err))
        return false;

    if (assets_)
        assets_->setProjectDir(projectDir_);
    clearDirty();
    addRecent(projectDir_, model.project.name);
    writeSessionLock();
    Log::info("ProjectIO: saved '%s' -> %s", model.project.name.c_str(),
              projectDir_.c_str());
    return true;
}

void ProjectIO::capturePluginStates(Model& model, const std::string& targetDir,
                                    bool stampModel,
                                    std::map<uint64_t, std::string>* wrote) {
    if (!host_ || targetDir.empty())
        return;
    auto capture = [&](Track& t) {
        for (PluginInstance& pi : t.inserts) {
            std::vector<uint8_t> chunk;
            if (!host_->getState(pi.instanceId, chunk) || chunk.empty()) {
                // No live state (crashed instance OR dormant import) — fall back to the
                // orphan store so imported state survives the save (SPEC §5.6).
                chunk.clear();
                if (orphanStates_) {
                    const auto it = orphanStates_->find(pi.instanceId);
                    if (it != orphanStates_->end() && !it->second.empty())
                        chunk = it->second;
                }
                if (chunk.empty())
                    continue; // keep whatever stateFile we had
            }
            const std::string rel =
                "plugin-states/" + std::to_string(pi.instanceId) + ".bin";
            if (writeBinaryFile(pathJoin(targetDir, rel), chunk)) {
                // Stamp the live model only for a real project dir (stampModel). A no-path
                // autosave must NOT leave the in-RAM model carrying a stateFile that would
                // resolve against an empty/non-existent project dir — the on-disk snapshot
                // gets it via `wrote` instead, and recovery rebuilds the orphan store.
                if (stampModel)
                    pi.stateFile = rel;
                if (wrote)
                    (*wrote)[pi.instanceId] = rel;
                // Keep the orphan entry for the whole session (do NOT erase it here): the
                // .bin lives in THIS target dir, but Save-As to a new dir, re-saves, and
                // undo-across-save all need to re-emit it from the in-RAM orphan bytes.
                // A live host always takes priority above, so a kept entry is harmless.
            } else {
                Log::warn("ProjectIO: failed to write %s", rel.c_str());
            }
        }
    };
    for (Track& t : model.project.tracks)
        capture(t);
    capture(model.project.masterTrack);
}

void ProjectIO::copyExternalAssets(Model& model, const std::string& sourceDir) {
    const std::string audioDir = pathJoin(projectDir_, "audio");
    for (Asset& a : model.project.assets) {
        // Resolve where the file currently lives. a.file is EMPTY for foreign-import
        // assets referenced in place (cpr import, SPEC §5.1) — their audio lives at
        // a.originalPath; without this fallback a save marked every such asset missing.
        std::string src;
        if (a.file.empty())
            src = a.originalPath;
        else if (isAbsolutePath(a.file))
            src = a.file;
        else if (!sourceDir.empty())
            src = pathJoin(sourceDir, a.file);
        else
            src = pathJoin(projectDir_, a.file);

        // src may point into THIS project's audio/ for a file that was never copied
        // here (e.g. a cpr import copied into the PREVIOUS project's dir, then
        // newProject cleared the path so Save-As resolves the relative a.file against
        // the NEW dir). Recover via originalPath — the old dir is unknowable here.
        if (!src.empty() && !fileExists(src) && !a.originalPath.empty() &&
            fileExists(a.originalPath))
            src = a.originalPath;

        // Already inside THIS project's audio/ (recorded relative) AND actually
        // present? Nothing to do. Without the fileExists gate a missing file would be
        // silently skipped here instead of falling through to `missing` below.
        if (!a.file.empty() && !isAbsolutePath(a.file) &&
            pathStartsWithDir(src, projectDir_) && fileExists(src))
            continue;
        if (src.empty() || !fileExists(src)) {
            a.missing = true;
            continue;
        }

        // Pick a destination name, avoiding collisions with different files.
        std::string base = fileName(src);
        std::string dest = pathJoin(audioDir, base);
        if (normPath(dest) == normPath(src)) {
            // Same file already in place — just record it project-relative (covers an
            // in-place reference that already points into THIS project's audio/).
            a.file = "audio/" + base;
            a.missing = false;
            continue;
        }
        int suffix = 2;
        while (fileExists(dest)) {
            const std::string ext = fileExtension(base);
            const std::string stem = base.substr(0, base.size() - ext.size());
            base = stem + "-" + std::to_string(suffix++) + ext;
            dest = pathJoin(audioDir, base);
        }
        if (!CopyFileW(utf8ToWide(src).c_str(), utf8ToWide(dest).c_str(), FALSE)) {
            Log::warn("ProjectIO: failed to copy asset %s -> %s", src.c_str(),
                      dest.c_str());
            continue;
        }
        if (a.originalPath.empty())
            a.originalPath = src;
        a.file = "audio/" + base;
        a.missing = false;
    }
}

void ProjectIO::refreshMissingFlags(Model& model, std::vector<uint64_t>* missingAssets) {
    for (Asset& a : model.project.assets) {
        const std::string abs = resolveAssetPath(a);
        a.missing = abs.empty() || !fileExists(abs);
        if (a.missing && missingAssets)
            missingAssets->push_back(a.id);
    }
}

void ProjectIO::wireAssetStore(Model& model) {
    if (!assets_)
        return;
    assets_->clear();
    assets_->setProjectDir(projectDir_);
    for (const Asset& a : model.project.assets) {
        if (a.missing)
            continue;
        assets_->loadAsync(a, std::function<void(bool)>());
        assets_->ensurePeaks(a);
    }
}

// ----- autosave ---------------------------------------------------------------

std::string ProjectIO::autosaveDir() const {
    if (hasPath())
        return pathJoin(projectDir_, "autosave");
    return pathJoin(appDataDir(), "autosave");
}

bool ProjectIO::autosaveNow(Model& model, std::string& err) {
    const std::string dir = autosaveDir();
    if (!ensureDir(dir)) {
        err = "cannot create autosave dir: " + dir;
        return false;
    }
    // Capture plugin chunks alongside the autosave JSON (SPEC §6). For a SAVED project this
    // is the project's own plugin-states/ dir; for a never-saved import it is the recovery
    // autosave dir — without this an unsaved import's dormant plugin state (orphan store,
    // RAM only) would be lost on a crash before Save-As, which is the whole point of the
    // orphan store.
    //   hasPath():  stamp the live model (real project dir — save semantics; load round-
    //               trips the project-relative stateFile).
    //   no-path:    do NOT stamp the live model (a project-dir-relative stateFile would be
    //               dangling with no project dir). Capture the rel paths in `wrote` and
    //               stamp them into the ON-DISK snapshot only, so recover() can locate the
    //               .bin next to the autosave JSON and repopulate the orphan store.
    const std::string stateDir = hasPath() ? projectDir_ : dir;
    ensureDir(pathJoin(stateDir, "plugin-states"));
    std::map<uint64_t, std::string> wrote;
    capturePluginStates(model, stateDir, /*stampModel=*/hasPath(), &wrote);

    json snapshot = toJson(model.project);
    if (!hasPath() && !wrote.empty()) {
        // Patch the on-disk snapshot's inserts with their autosave-dir-relative stateFile so
        // recover() finds the .bin. The live model is intentionally left untouched.
        auto stamp = [&](json& trackJson) {
            if (!trackJson.is_object() || !trackJson.contains("inserts") ||
                !trackJson["inserts"].is_array())
                return;
            for (json& ij : trackJson["inserts"]) {
                if (!ij.is_object())
                    continue;
                const auto it = wrote.find(getOr<uint64_t>(ij, "instanceId", 0));
                if (it != wrote.end())
                    ij["stateFile"] = it->second;
            }
        };
        if (snapshot.contains("tracks") && snapshot["tracks"].is_array())
            for (json& tj : snapshot["tracks"])
                stamp(tj);
        if (snapshot.contains("masterTrack"))
            stamp(snapshot["masterTrack"]);
    }

    // Round-robin: overwrite the slot with the oldest mtime (free slots first).
    int slot = 1;
    int64_t oldest = INT64_MAX;
    for (int n = 1; n <= kAutosaveSlots; ++n) {
        const std::string path = pathJoin(dir, "project-" + std::to_string(n) + ".json");
        if (!fileExists(path)) {
            slot = n;
            break;
        }
        const int64_t mt = fileMTimeSeconds(path);
        if (mt < oldest) {
            oldest = mt;
            slot = n;
        }
    }
    const std::string path = pathJoin(dir, "project-" + std::to_string(slot) + ".json");
    // replace handler: autosave fires on a timer and must never throw (see saveInternal).
    if (!writeTextFileAtomic(path, snapshot.dump(2, ' ', false, json::error_handler_t::replace),
                             err))
        return false;
    Log::info("ProjectIO: autosaved -> %s", path.c_str());
    return true;
}

// ----- crash recovery -----------------------------------------------------------

void ProjectIO::writeSessionLock() {
    const std::string path = sessionLockPath();
    std::string err;
    if (!writeTextFileAtomic(path, projectDir_, err))
        Log::warn("ProjectIO: cannot write session.lock (%s)", err.c_str());
}

void ProjectIO::clearSessionLock() {
    DeleteFileW(utf8ToWide(sessionLockPath()).c_str());
}

ProjectIO::RecoveryInfo ProjectIO::recoveryInfo() const {
    RecoveryInfo info;
    if (!startupLockExisted_)
        return info;
    info.projectPath = startupLockProjectPath_;

    const std::string dir = startupLockProjectPath_.empty()
                                ? pathJoin(appDataDir(), "autosave")
                                : pathJoin(startupLockProjectPath_, "autosave");
    int64_t newest = 0;
    for (int n = 1; n <= kAutosaveSlots; ++n) {
        const std::string path = pathJoin(dir, "project-" + std::to_string(n) + ".json");
        if (!fileExists(path))
            continue;
        const int64_t mt = fileMTimeSeconds(path);
        if (mt > newest) {
            newest = mt;
            info.autosavePath = path;
            info.mtime = mt;
        }
    }
    if (info.autosavePath.empty() && !startupLockProjectPath_.empty()) {
        // No autosave — fall back to the saved project.json (recover == reload).
        const std::string pj = pathJoin(startupLockProjectPath_, "project.json");
        if (fileExists(pj)) {
            info.autosavePath = pj;
            info.mtime = fileMTimeSeconds(pj);
        }
    }
    info.available = !info.autosavePath.empty();
    return info;
}

bool ProjectIO::recover(Model& model, std::string& err) {
    const RecoveryInfo info = recoveryInfo();
    if (!info.available) {
        err = "no recovery data available";
        return false;
    }
    std::string text;
    if (!readTextFile(info.autosavePath, text)) {
        err = "cannot read " + info.autosavePath;
        return false;
    }
    const json j = parseJson(text);
    if (j.is_discarded()) {
        err = "autosave is not valid JSON";
        return false;
    }
    Project p;
    if (!fromJson(j, p, &err))
        return false;

    model.project = std::move(p);
    projectDir_ = info.projectPath; // may be "" (recovered never-saved project)

    // No-path recovery: the dormant inserts' state .bin files live next to the autosave
    // JSON (autosaveNow wrote them into the recovery autosave dir). Repopulate the in-RAM
    // orphan store from them so plugins/recreate can restore state once the user resaves —
    // mirrors a fresh import. stateFile stays as written but is meaningless without a
    // project dir, so clear it; the orphan store is now the authoritative source.
    if (!hasPath() && orphanStates_) {
        const std::string snapDir = parentDir(info.autosavePath);
        auto reload = [&](Track& t) {
            for (PluginInstance& pi : t.inserts) {
                if (pi.stateFile.empty())
                    continue;
                std::vector<uint8_t> chunk;
                if (readBinaryFile(pathJoin(snapDir, pi.stateFile), chunk) && !chunk.empty())
                    (*orphanStates_)[pi.instanceId] = std::move(chunk);
                pi.stateFile.clear(); // no project dir to resolve it against
            }
        };
        for (Track& t : model.project.tracks)
            reload(t);
        reload(model.project.masterTrack);
    }

    refreshMissingFlags(model, nullptr);
    wireAssetStore(model);
    dirty_ = false;
    markDirty(); // recovered state is unsaved by definition
    if (hasPath())
        addRecent(projectDir_, model.project.name);
    writeSessionLock();
    Log::info("ProjectIO: recovered from %s", info.autosavePath.c_str());
    return true;
}

// ----- recent projects -----------------------------------------------------------

json ProjectIO::recentProjects() const {
    std::string text;
    if (!readTextFile(recentJsonPath(), text))
        return json::array();
    json j = parseJson(text);
    if (j.is_discarded() || !j.is_array())
        return json::array();
    json out = json::array();
    for (const json& e : j) {
        if (!e.is_object())
            continue;
        const std::string path = getOr(e, "path", "");
        // Hide entries that no longer exist on disk or live in the OS temp dir (test /
        // throwaway projects that should never have been remembered).
        if (path.empty() || isTempProject(path) || !fileExists(path))
            continue;
        out.push_back(
            json{{"path", path}, {"name", getOr(e, "name", "")}, {"mtime", getOr<int64_t>(e, "mtime", 0)}});
        if (out.size() >= kMaxRecent)
            break;
    }
    return out;
}

void ProjectIO::addRecent(const std::string& path, const std::string& name) {
    if (path.empty() || isTempProject(path))
        return; // never remember throwaway/test projects saved under the OS temp dir
    json list = recentProjects();
    json out = json::array();
    out.push_back(json{{"path", path}, {"name", name}, {"mtime", nowUnixSeconds()}});
    for (const json& e : list) {
        if (iequals(normPath(getOr(e, "path", "")), normPath(path)))
            continue; // dedupe
        out.push_back(e);
        if (out.size() >= kMaxRecent)
            break;
    }
    std::string err;
    if (!writeTextFileAtomic(recentJsonPath(),
                             out.dump(2, ' ', false, json::error_handler_t::replace), err))
        Log::warn("ProjectIO: cannot write recent.json (%s)", err.c_str());
    // Keep connected UIs live — hello only delivers the list at connect time, so an
    // import/save mid-session would otherwise stay invisible until the next restart.
    if (eventBus_)
        eventBus_->broadcast("event/recentProjects", json{{"recentProjects", recentProjects()}});
}

// ----- relink -----------------------------------------------------------------

bool ProjectIO::relink(Model& model, uint64_t assetId, const std::string& newPath,
                       std::string& err) {
    Asset* a = model.assetById(assetId);
    if (!a) {
        err = "unknown assetId";
        return false;
    }
    if (!fileExists(newPath)) {
        err = "file not found: " + newPath;
        return false;
    }
    a->originalPath = newPath;
    if (hasPath() && pathStartsWithDir(newPath, projectDir_)) {
        // Inside the project folder -> store relative (forward slashes, SPEC §6 style).
        std::string rel = newPath.substr(projectDir_.size());
        while (!rel.empty() && (rel.front() == '\\' || rel.front() == '/'))
            rel.erase(rel.begin());
        for (char& c : rel)
            if (c == '\\')
                c = '/';
        a->file = rel;
    } else {
        a->file = newPath; // external until the next save copies it into audio/
    }
    a->missing = false;
    if (assets_) {
        assets_->loadAsync(*a, std::function<void(bool)>());
        assets_->ensurePeaks(*a);
    }
    markDirty();
    Log::info("ProjectIO: relinked asset %llu -> %s",
              static_cast<unsigned long long>(assetId), newPath.c_str());
    return true;
}

} // namespace mydaw
