// MyDAW — import/SmfImportProvider.h
// Standard MIDI File project import (.mid/.midi/.smf/.rmi). Unlike media/import (which
// drops clips into the EXISTING project), this builds a whole new project: the file's
// FULL tempo and time-signature maps are adopted, one MIDI track + clip is created per
// SMF track with notes (controller/pitch-bend/aftertouch events become MidiClip.cc), and
// the loop region spans the song. Format-1 tracks sharing a (sanitized name, primary
// channel) key are CONSOLIDATED via midi/SmfTrackPlan — one track, one clip per source
// chunk at its region position (emagic Logic exports one MTrk per region). RMID containers (RIFF....RMID) are unwrapped to the
// embedded SMF before parsing.
// Reuses midi/SmfReader for all SMF parsing.

#pragma once

#include "import/ImportProvider.h"

namespace mydaw {

class SmfImportProvider : public ImportProvider {
public:
    std::string id() const override { return "smf"; }
    std::string displayName() const override { return "Standard MIDI File"; }
    std::vector<std::string> extensions() const override {
        return {"mid", "midi", "smf", "rmi"};
    }
    // Accepts a leading "MThd" (plain SMF) or "RIFF"...."RMID" (RMID container);
    // anything else is rejected with a clear whyNot.
    bool probe(const std::string& absPath, std::string& whyNot) const override;
    bool import(const std::string& absPath, const ImportContext& ctx, Model& out,
                std::string& err) override;
};

} // namespace mydaw
