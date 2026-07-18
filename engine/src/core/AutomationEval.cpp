// MyDAW — core/AutomationEval.cpp (E2)

#include "core/AutomationEval.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace mydaw {

ParamRef parseParamRef(const std::string& ref) {
    ParamRef r;
    if (ref == "volume") {
        r.kind = ParamRef::Kind::Volume;
        return r;
    }
    if (ref == "pan") {
        r.kind = ParamRef::Kind::Pan;
        return r;
    }
    if (ref.rfind("send:", 0) == 0) {
        const char* s = ref.c_str() + 5;
        char* end = nullptr;
        const long idx = std::strtol(s, &end, 10);
        if (end != s && *end == '\0' && idx >= 0) {
            r.kind = ParamRef::Kind::Send;
            r.sendIndex = static_cast<int>(idx);
        }
        return r;
    }
    if (ref.rfind("plugin:", 0) == 0) {
        const char* s = ref.c_str() + 7;
        char* end = nullptr;
        const unsigned long long inst = std::strtoull(s, &end, 10);
        if (end == s || *end != ':')
            return r;
        const char* s2 = end + 1;
        char* end2 = nullptr;
        const unsigned long pid = std::strtoul(s2, &end2, 10);
        if (end2 == s2 || *end2 != '\0' || inst == 0)
            return r;
        r.kind = ParamRef::Kind::Plugin;
        r.instanceId = static_cast<uint64_t>(inst);
        r.paramId = static_cast<uint32_t>(pid);
        return r;
    }
    return r;
}

double evalAutomation(const std::vector<AutomationPoint>& pts, double beat) noexcept {
    if (pts.empty())
        return 0.0;
    if (beat <= pts.front().beat)
        return pts.front().value;
    if (beat >= pts.back().beat)
        return pts.back().value;

    // First point with .beat > beat (binary search; pts sorted by beat).
    size_t lo = 0;
    size_t hi = pts.size();
    while (lo < hi) {
        const size_t mid = (lo + hi) / 2;
        if (pts[mid].beat <= beat)
            lo = mid + 1;
        else
            hi = mid;
    }
    const AutomationPoint& p1 = pts[lo];
    const AutomationPoint& p0 = pts[lo - 1];
    const double span = p1.beat - p0.beat;
    if (span <= 0.0)
        return p1.value;
    double t = (beat - p0.beat) / span;
    t = std::clamp(t, 0.0, 1.0);
    const double curve = std::clamp(p0.curve, -1.0, 1.0);
    const double shaped = (curve == 0.0) ? t : std::pow(t, std::exp2(curve));
    return p0.value + (p1.value - p0.value) * shaped;
}

} // namespace mydaw
