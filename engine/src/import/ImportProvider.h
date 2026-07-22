// MyDAW — import/ImportProvider.h
// Pluggable foreign-project import (project/importForeign, SPEC §5.1): a provider turns
// a foreign session/project file (.mid, ...) into a complete Project model which the App
// then adopts exactly like project/load (no save path, dirty — user must Save As).
// Providers are registered once at startup via registerAllImportProviders()
// (import/Providers.cpp) and looked up by case-insensitive file extension + probe().
//
// Non-RT; the registry is thread-safe, providers run wherever project/importForeign runs
// (main thread, like project/load).

#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace mydaw {

class AssetStore; // media/AssetStore.h (E4)
class Model;      // project/Model.h

struct ImportContext {
    int sessionSampleRate = 48000;
    std::string projectDirHint;          // may be empty (project not saved yet)
    AssetStore* assetStore = nullptr;    // import referenced/embedded audio via importFile(...)
    std::function<void(float)> progress; // 0..1, MAY BE NULL — always null-check
    // OPTIONAL out-param (may be null — always null-check): plugin state chunks captured
    // from the foreign project, keyed by PluginInstance::instanceId of the dormant insert
    // the provider added to `out`. Bytes must be in the exact form the plugin host's
    // setState expects (vst2: raw effSetChunk bank chunk; vst3: 'MD3S' container). The
    // caller (project/importForeign) applies them to instances that come alive and keeps
    // the rest in an orphan store so the state survives until the first save (SPEC §5.6).
    std::map<uint64_t, std::vector<uint8_t>>* pluginStates = nullptr;
    // OPTIONAL out-param (may be null — always null-check): human-readable warnings about
    // content the provider recognized but could not import (e.g. "Skipped track 'Group 01'
    // — Group channels aren't supported yet"). Surfaced to the user by the import reply.
    std::vector<std::string>* warnings = nullptr;
};

class ImportProvider {
public:
    virtual ~ImportProvider() = default;
    virtual std::string id() const = 0;          // stable lowercase id, e.g. "smf"
    virtual std::string displayName() const = 0; // e.g. "Standard MIDI File"
    virtual std::vector<std::string> extensions() const = 0; // lowercase, no dot, e.g. {"mid","midi"}
    virtual bool probe(const std::string& absPath, std::string& whyNot) const; // default: return true (extension match suffices)
    virtual bool import(const std::string& absPath, const ImportContext& ctx, Model& out,
                        std::string& err) = 0;
    // 'out' arrives as Model::defaultProject() (master track exists, 120bpm 4/4) — mutate it.
};

class ImportProviderRegistry {
public:
    static ImportProviderRegistry& instance();
    void add(std::unique_ptr<ImportProvider>);
    std::vector<const ImportProvider*> all() const;                  // registration order
    const ImportProvider* forPath(const std::string& absPath) const; // extension match, then probe(); nullptr if none

private:
    mutable std::mutex mutex_;
    std::vector<std::unique_ptr<ImportProvider>> providers_;
};

void registerAllImportProviders(); // defined in engine/src/import/Providers.cpp — providers are added HERE, one line each

} // namespace mydaw
