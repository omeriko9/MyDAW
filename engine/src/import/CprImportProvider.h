// MyDAW — import/CprImportProvider.h
// Cubase project (.cpr) import. Parses the Steinberg "RIFF/NUND" container and the
// serialized object stream of the PArrangement archive (empirically reverse-engineered,
// validated against Cubase SX 2 (2004) through Cubase 13 (2026) projects):
//   - tracks (MIDI / instrument / audio / folder nesting, names incl. cp1255/UTF-8)
//   - MIDI parts -> MidiClips with notes, CC, pitch bend (controller 128), aftertouch (129)
//   - tempo map (MTempoTrackEvent: fixed-mode flag or tempo-track points, PPQ 480)
//   - time-signature map (MSignatureTrackEvent)
//   - audio events -> AudioClips + Assets (wav via AssetStore::importFile when a project
//     dir exists; otherwise in-place originalPath reference; missing files stay relinkable)
//   - per-channel insert chains + instruments (docs/CPR_MIXER_FORMAT.md): SX-era binary
//     insert racks (in MAudioTrack channel records) + the Devices "VST Mixer" VSTi rack;
//     modern (C5+) attribute-tree InsertFolder/Synth Slot/Synth Rack. Plugins become
//     DORMANT PluginInstance inserts (no path — resolved later via plugins/recreate);
//     state chunks are normalized to the plugin-host setState form and returned through
//     ImportContext::pluginStates. Rack instruments become new Instrument tracks (their
//     MIDI routing is not decodable -> Log::warn).
//   - per-channel VOLUME + PAN (docs/CPR_MIXER_FORMAT.md): modern (C5+) attr tree carries
//     Volume.AnchorValue (f64 dB, byte-exact) and Pan.Value (i64 -64..63, absent = center);
//     Track.volume = pow(10, dB/20), Track.pan = v<0?v/64:v/63. SX-era channels carry the
//     fader as a bare f32 right after the InputGain/zero pair (25856 = 0 dB); decoded with
//     the documented APPROXIMATE law Track.volume = (f32/25856)^2 (≤~0.1 dB near unity).
// Not imported (undocumented or out of scope): EQ values (no MyDAW target), sends (all empty
// in the corpus; destinations resolve to FX/group channels not modeled in v1), automation,
// timeline markers (every corpus marker track is empty), sysex, fades/gain trailer.
//
// All multi-byte values in a .cpr are BIG-endian; musical positions are f64 ticks at 480
// PPQ. Every read is bounds-checked — a malformed file returns false with an error, never
// crashes. Partial decode imports what parsed and Log::warn's the rest.

#pragma once

#include "import/ImportProvider.h"

namespace mydaw {

class CprImportProvider : public ImportProvider {
public:
    std::string id() const override { return "cpr"; }
    std::string displayName() const override { return "Cubase Project"; }
    std::vector<std::string> extensions() const override { return {"cpr"}; }
    // Accepts "RIFF" magic with form "NUND" at offset 8.
    bool probe(const std::string& absPath, std::string& whyNot) const override;
    bool import(const std::string& absPath, const ImportContext& ctx, Model& out,
                std::string& err) override;
};

} // namespace mydaw
