// MyDAW — project/ModelOps.h (E3)
// Model-level helper functions shared by the command processor, persistence and the
// serializer. Pure functions over Model/Project — no engine dependencies beyond TempoMap.
// Definitions live in project/Model.cpp. Main-thread only (SPEC §7).

#pragma once

#include <cstdint>
#include <utility>
#include <vector>

#include "project/Model.h"

namespace mydaw {

class TempoMap;

// Length of a clip in beats at its current timeline position. Midi clips carry
// lengthBeats directly; audio clips convert their sample length through the tempo map
// at the clip's absolute position (piecewise-constant tempo, SPEC §7).
double clipLengthBeats(const Clip& c, const TempoMap& tm);

// clipStartBeat(c) + clipLengthBeats(c, tm).
double clipEndBeat(const Clip& c, const TempoMap& tm);

// Latest clip end (beats) across the track's clips; 0.0 for an empty track.
double trackEndBeat(const Track& t, const TempoMap& tm);

// Solo-in-place effective mute set (SPEC §7): when any track is soloed, the audible set
// is the soloed tracks plus their routing closure (outputTarget chain + Track::midiTarget
// feeder->instrument edges + enabled send destinations, transitively) plus master; a
// soloed Instrument track also pulls in its MIDI feeders (midiTarget) so it keeps
// sounding. Every other track is implicitly muted.
// With no solo anywhere, effective mute == Track::mute.
// Returns (trackId, effectiveMute) for every track including master, in model order.
std::vector<std::pair<uint64_t, bool>> computeEffectiveMutes(const Model& m);

// Highest id referenced anywhere in the project (tracks, clips, notes, markers,
// automation points, assets, plugin instances, frozenAssetId). Used to sanity-fix
// Project::nextId after a tolerant load.
uint64_t maxIdInProject(const Project& p);

} // namespace mydaw
