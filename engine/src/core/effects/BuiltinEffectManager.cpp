// MyDAW — core/effects/BuiltinEffectManager.cpp — see BuiltinEffectManager.h.

#include "core/effects/BuiltinEffectManager.h"

#include <algorithm>

#include "core/effects/Effects.h"
#include "media/AssetStore.h" // PcmData
#include "project/Model.h"     // PluginInstance

namespace mydaw {

bool BuiltinEffectManager::create(const PluginInstance& pi, int sampleRate, int maxBlock,
                                  std::string& err) {
    std::unique_ptr<IEffect> fx = makeBuiltinEffect(pi.uid);
    if (!fx) {
        err = "unknown built-in effect: " + pi.uid;
        return false;
    }
    auto node = std::make_unique<BuiltinEffectNode>(pi.instanceId, std::move(fx));
    node->prepare(sampleRate > 0 ? sampleRate : 48000, maxBlock > 0 ? maxBlock : 512);
    // Restore saved normalized params (project load / undo / duplicate) over the defaults.
    for (const auto& [id, value] : pi.paramValues)
        node->effect()->setParamNorm(id, static_cast<float>(value));
    node->setBypass(pi.bypass);
    node->setWetDry(static_cast<float>(pi.wetDry));
    nodes_[pi.instanceId] = std::move(node);
    if (pi.sampleAssetId)
        bindSample(pi.instanceId, pi.sampleAssetId); // sampler: bind its PCM
    return true;
}

bool BuiltinEffectManager::bindSample(uint64_t instanceId, uint64_t assetId) {
    const auto it = nodes_.find(instanceId);
    if (it == nodes_.end() || !it->second->effect()) return false;
    BuiltinEffectNode* node = it->second.get();
    IEffect* fx = node->effect();
    if (!assets_ || assetId == 0) {
        if (node->boundSampleAsset() != 0) { fx->setSampleData(nullptr, 0, 0); node->setBoundSampleAsset(0); }
        return true;
    }
    if (node->boundSampleAsset() == assetId) return true; // already bound (rebuild no-op)
    const PcmData* pcm = assets_->pcm(assetId);
    if (!pcm || pcm->planes.empty() || pcm->frames <= 1)
        return true; // not (yet) loaded — leave boundSampleAsset 0 so a later rebuild retries
    const int nc = std::min<int>(2, static_cast<int>(pcm->planes.size()));
    const float* planes[2] = {pcm->planes[0].data(), pcm->planes[nc >= 2 ? 1 : 0].data()};
    fx->setSampleData(planes, nc, pcm->frames);
    node->setBoundSampleAsset(assetId);
    return true;
}

void BuiltinEffectManager::destroy(uint64_t instanceId) {
    const auto it = nodes_.find(instanceId);
    if (it == nodes_.end()) return;
    retired_.push_back(std::move(it->second)); // outlive any plan still holding its pointer
    nodes_.erase(it);
}
void BuiltinEffectManager::destroyAll() {
    nodes_.clear();
    retired_.clear();
}

IInsertNode* BuiltinEffectManager::node(uint64_t instanceId) {
    const auto it = nodes_.find(instanceId);
    return it == nodes_.end() ? nullptr : it->second.get();
}

bool BuiltinEffectManager::has(uint64_t instanceId) const {
    return nodes_.find(instanceId) != nodes_.end();
}

json BuiltinEffectManager::getParams(uint64_t instanceId) const {
    json arr = json::array();
    const auto it = nodes_.find(instanceId);
    if (it == nodes_.end()) return arr;
    IEffect* fx = it->second->effect();
    if (!fx) return arr;
    for (const BuiltinParam& p : fx->params()) {
        json row{
            {"id", p.id},
            {"name", p.name},
            {"label", p.unit},
            {"value", fx->getParamNorm(p.id)},
            {"defaultValue", p.defaultNorm},
            {"valueText", fx->valueText(p.id)},
        };
        if (p.steps >= 2) row["steps"] = p.steps;
        arr.push_back(std::move(row));
    }
    return arr;
}

std::vector<PluginInfo> BuiltinEffectManager::builtinPluginInfos() {
    std::vector<PluginInfo> out;
    for (const BuiltinEffectDesc& d : builtinEffectCatalog()) {
        PluginInfo pi;
        pi.uid = d.uid;
        pi.format = "builtin";
        pi.path = "";
        pi.bitness = 64;
        pi.name = d.name;
        pi.vendor = "MyDAW";
        pi.category = d.category;
        pi.isInstrument = d.isInstrument;
        pi.numInputs = d.isInstrument ? 0 : 2; // instruments are sources
        pi.numOutputs = 2;
        out.push_back(std::move(pi));
    }
    return out;
}

} // namespace mydaw
