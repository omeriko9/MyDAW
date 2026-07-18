// MyDAW — core/effects/Effects.h
// The stock ("built-in") effect catalog + factory. Each effect is pure in-engine DSP
// (core/effects/IEffect.h) hosted as an insert via BuiltinEffectNode. Identity on the wire is
// uid = "builtin:<key>", format = "builtin"; the catalog seeds the plugin registry so the
// effects appear in the picker/browser, and the factory instantiates one by uid.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "core/effects/IEffect.h"

namespace mydaw {

// One catalog entry: enough to seed the registry + drive the generic editor without a live
// instance (params carry names/units/defaults/steps).
struct BuiltinEffectDesc {
    std::string uid;       // "builtin:compressor"
    std::string name;      // "Compressor"
    std::string category;  // "Dynamics" | "Delay" | "Reverb" | "Utility" | "Instrument"
    bool isInstrument = false; // true = MIDI-driven source (goes on an instrument track)
    std::vector<BuiltinParam> params;
};

// The full stock catalog (stable order). Built once, lazily.
const std::vector<BuiltinEffectDesc>& builtinEffectCatalog();

// True if uid names a built-in effect ("builtin:*" present in the catalog).
bool isBuiltinUid(const std::string& uid);

// Instantiate the effect for uid, or nullptr if unknown. Caller must prepare() before use.
std::unique_ptr<IEffect> makeBuiltinEffect(const std::string& uid);

// One factory preset for a built-in effect: a full set of normalized param values
// (every param is listed, so switching presets never leaves stale values behind).
struct BuiltinPreset {
    std::string name;
    std::vector<std::pair<uint32_t, float>> norms; // paramId -> normalized 0..1
};

// Factory presets for uid (currently the Piano and PolySynth instruments; empty for
// the other built-ins). Stable order — preset id on the wire is the index.
const std::vector<BuiltinPreset>& builtinFactoryPresets(const std::string& uid);

} // namespace mydaw
