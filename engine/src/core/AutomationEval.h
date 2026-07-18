// MyDAW — core/AutomationEval.h (E2)
// Automation evaluation (SPEC §7) + paramRef grammar parsing (SPEC §5.3).
//
// evalAutomation() interpolates a sorted point list piecewise-linearly with the curve
// bend of the PRECEDING point: t' = t^(2^curve), v = v0 + (v1 - v0) * t'
// (curve in [-1, 1]: -1 = fast start/slow end, 0 = linear, +1 = slow start/fast end).
// RT-safe: no allocation, no locks — the graph bakes point copies into TrackNodes at
// rebuild time (the live Model is never read on the RT thread).

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "project/Model.h" // AutomationPoint

namespace mydaw {

// Parsed paramRef: "volume" | "pan" | "send:<index>" | "plugin:<instanceId>:<paramId>".
struct ParamRef {
    enum class Kind { Volume, Pan, Send, Plugin, Invalid };
    Kind kind = Kind::Invalid;
    int sendIndex = -1;      // Kind::Send
    uint64_t instanceId = 0; // Kind::Plugin
    uint32_t paramId = 0;    // Kind::Plugin
};

// Main thread (rebuild). Returns Kind::Invalid for malformed refs.
ParamRef parseParamRef(const std::string& ref);

// RT-safe. `pts` must be sorted by beat. Empty list -> 0.0; before the first /
// after the last point the edge value holds.
double evalAutomation(const std::vector<AutomationPoint>& pts, double beat) noexcept;

} // namespace mydaw
