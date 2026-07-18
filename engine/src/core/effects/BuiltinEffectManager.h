// MyDAW — core/effects/BuiltinEffectManager.h
// Lifecycle owner for in-engine built-in effect insert nodes, parallel to HostProcessManager
// (out-of-process plugins). Keyed by PluginInstance::instanceId; instance ids are unique across
// both managers, so the graph resolves an insert by trying host->node() then builtin->node().
// Main-thread only for create/destroy/node/getParams; the RT thread only dereferences the raw
// IInsertNode* pointers the render plan captured (stable between rebuilds, exactly like the
// host proxy nodes).
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "core/IInsertNode.h"
#include "core/effects/BuiltinEffectNode.h"
#include "plugins/PluginRegistry.h" // PluginInfo
#include "util/Json.h"              // json

namespace mydaw {

struct PluginInstance; // project/Model.h
class AssetStore;      // media/AssetStore.h

class BuiltinEffectManager {
public:
    // Wire the asset store so samplers can resolve their PCM (main thread). Optional.
    void setAssetStore(AssetStore* a) { assets_ = a; }

    // Bind the PCM of `assetId` into the built-in sampler at `instanceId` (no-op for non-
    // sampler nodes / unknown asset). Main thread. Returns true if a node was found.
    bool bindSample(uint64_t instanceId, uint64_t assetId);

    // Instantiate the built-in effect named by pi.uid, seed it from pi.paramValues/bypass/wetDry,
    // and register it under pi.instanceId. False + err if uid is not a built-in.
    bool create(const PluginInstance& pi, int sampleRate, int maxBlock, std::string& err);

    // Remove an instance from the live set. The node is NOT freed immediately — a still-live
    // or being-retired RenderPlan may hold its raw pointer (the graph rebuilds only AFTER the
    // command handler runs). It is moved to a graveyard and freed at destroyAll() (project
    // teardown, after the graph is torn down), which is unconditionally safe for these tiny
    // in-engine nodes. HostProcessManager solves the same lifetime problem with a drain sleep.
    void destroy(uint64_t instanceId);
    void destroyAll();

    // Stable RT node pointer (create()..destroy()); nullptr if unknown.
    IInsertNode* node(uint64_t instanceId);
    bool has(uint64_t instanceId) const;

    // Generic-editor param list for instanceId: [{id,name,label,value,defaultValue,steps?,valueText}].
    // Empty array if unknown.
    json getParams(uint64_t instanceId) const;

    // PluginInfo entries (format="builtin") for seeding the registry so the effects appear in
    // the picker/browser. Static — does not depend on any live instance.
    static std::vector<PluginInfo> builtinPluginInfos();

private:
    std::map<uint64_t, std::unique_ptr<BuiltinEffectNode>> nodes_;
    std::vector<std::unique_ptr<BuiltinEffectNode>> retired_; // kept alive until destroyAll()
    AssetStore* assets_ = nullptr;
};

} // namespace mydaw
