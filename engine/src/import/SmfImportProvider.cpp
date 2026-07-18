// MyDAW — import/SmfImportProvider.cpp. See SmfImportProvider.h.

#include "import/SmfImportProvider.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "midi/SmfReader.h"
#include "midi/SmfTrackPlan.h"
#include "project/Model.h"
#include "util/Paths.h"

namespace mydaw {

namespace {

// 12-color track palette — mirrors project/Commands.cpp kTrackColors (ui canvas.ts).
constexpr const char* kTrackColors[] = {
    "#e25d5d", "#e2814d", "#d8a14a", "#bdb84f", "#8fc457", "#56c596",
    "#4dc3cd", "#54a3e8", "#7a82f0", "#a06ee8", "#d165d6", "#e0639c",
};
constexpr size_t kNumTrackColors = sizeof(kTrackColors) / sizeof(kTrackColors[0]);

std::string fileStem(const std::string& path) {
    std::string name = fileName(path);
    const size_t dot = name.find_last_of('.');
    if (dot != std::string::npos && dot > 0)
        name.resize(dot);
    return name;
}

bool readHead(const std::string& path, uint8_t* buf, size_t want, size_t& got) {
    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"rb");
    if (!f)
        return false;
    got = std::fread(buf, 1, want, f);
    std::fclose(f);
    return true;
}

bool readAllBytes(const std::string& path, std::vector<uint8_t>& out) {
    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"rb");
    if (!f)
        return false;
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (size < 0) {
        std::fclose(f);
        return false;
    }
    out.resize(static_cast<size_t>(size));
    const size_t got = size > 0 ? std::fread(out.data(), 1, out.size(), f) : 0;
    std::fclose(f);
    out.resize(got);
    return true;
}

bool writeAllBytes(const std::string& path, const std::vector<uint8_t>& bytes) {
    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"wb");
    if (!f)
        return false;
    const size_t put = bytes.empty() ? 0 : std::fwrite(bytes.data(), 1, bytes.size(), f);
    std::fclose(f);
    return put == bytes.size();
}

uint32_t readU32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

bool isRmidHead(const uint8_t* head, size_t got) {
    return got >= 12 && std::memcmp(head, "RIFF", 4) == 0 &&
           std::memcmp(head + 8, "RMID", 4) == 0;
}

// RMID container: RIFF<size>RMID, then word-aligned chunks; the "data" chunk holds the SMF.
bool extractRmidSmf(const std::vector<uint8_t>& bytes, std::vector<uint8_t>& smf,
                    std::string& err) {
    size_t pos = 12; // past RIFF<size>RMID
    while (pos + 8 <= bytes.size()) {
        const uint32_t sz = readU32le(bytes.data() + pos + 4);
        const size_t payload = pos + 8;
        if (payload + sz > bytes.size())
            break; // truncated chunk
        if (std::memcmp(bytes.data() + pos, "data", 4) == 0) {
            if (sz < 4 || std::memcmp(bytes.data() + payload, "MThd", 4) != 0) {
                err = "RMID data chunk does not contain a Standard MIDI File";
                return false;
            }
            smf.assign(bytes.begin() + static_cast<ptrdiff_t>(payload),
                       bytes.begin() + static_cast<ptrdiff_t>(payload + sz));
            return true;
        }
        pos = payload + sz + (sz & 1); // chunks are word-aligned
    }
    err = "RMID file has no data chunk";
    return false;
}

} // namespace

bool SmfImportProvider::probe(const std::string& absPath, std::string& whyNot) const {
    uint8_t head[12] = {};
    size_t got = 0;
    if (!readHead(absPath, head, sizeof(head), got)) {
        whyNot = "cannot open file";
        return false;
    }
    if (got >= 4 && std::memcmp(head, "MThd", 4) == 0)
        return true;
    if (isRmidHead(head, got))
        return true;
    whyNot = "not a Standard MIDI File (missing MThd header)";
    return false;
}

bool SmfImportProvider::import(const std::string& absPath, const ImportContext& ctx,
                               Model& out, std::string& err) {
    if (ctx.progress)
        ctx.progress(0.0f);

    // RMID containers wrap the SMF in a RIFF "data" chunk — unwrap to a temp file so the
    // path-based SmfReader can parse it.
    std::string smfPath = absPath;
    std::string tmpPath;
    {
        uint8_t head[12] = {};
        size_t got = 0;
        if (!readHead(absPath, head, sizeof(head), got)) {
            err = "cannot open file: " + absPath;
            return false;
        }
        if (isRmidHead(head, got)) {
            std::vector<uint8_t> bytes, smf;
            if (!readAllBytes(absPath, bytes)) {
                err = "cannot read file: " + absPath;
                return false;
            }
            if (!extractRmidSmf(bytes, smf, err))
                return false;
            tmpPath = pathJoin(appDataDir(), "rmid-import.tmp.mid");
            if (!writeAllBytes(tmpPath, smf)) {
                err = "cannot write temp file: " + tmpPath;
                return false;
            }
            smfPath = tmpPath;
        }
    }

    SmfData data;
    const bool ok = SmfReader::read(smfPath, data, err);
    if (!tmpPath.empty())
        _wremove(utf8ToWide(tmpPath).c_str());
    if (!ok)
        return false;
    if (ctx.progress)
        ctx.progress(0.4f);
    if (data.tracks.empty()) {
        err = "file contains no notes";
        return false;
    }

    // The file's tempo/time-signature REPLACE the defaults — importing a foreign project
    // adopts the file's FULL musical timeline (unlike media/import into an existing
    // project). Single-value first-meta fields remain the fallback for files without maps.
    out.project.name = fileStem(absPath);
    out.project.sampleRate = ctx.sessionSampleRate;
    out.project.tempoMap = data.tempoMap.empty()
                               ? std::vector<TempoEntry>{TempoEntry{0.0, data.bpm}}
                               : data.tempoMap;
    out.project.timeSigMap =
        data.timeSigMap.empty()
            ? std::vector<TimeSigEntry>{TimeSigEntry{0, data.tsNum, data.tsDen}}
            : data.timeSigMap;

    const TimeSigEntry& sig0 = out.project.timeSigMap.front();
    double bpb = sig0.den > 0 ? sig0.num * 4.0 / sig0.den : 4.0;
    if (bpb <= 0.0)
        bpb = 4.0;

    // Logic-region consolidation (SmfTrackPlan.h): format-1 MTrks sharing a (sanitized
    // name, channel) collapse into ONE track with one clip per source MTrk at its content
    // position; single-member groups (every normal export) keep the legacy layout below.
    const std::vector<SmfTrackGroup> groups = groupSmfTracks(data);

    double songEnd = 0.0;
    int ordinal = 0;
    for (const SmfTrackGroup& g : groups) {
        ++ordinal;

        Track t;
        t.id = out.nextId();
        t.kind = TrackKind::Midi;
        t.name = g.name.empty() ? ("Track " + std::to_string(ordinal)) : g.name;
        t.color = kTrackColors[out.project.tracks.size() % kNumTrackColors];

        if (g.consolidated) {
            for (const SmfData::ImportedTrack* st : g.members) {
                MidiClip c =
                    buildConsolidatedClip(out, *st, t.name, out.project.timeSigMap);
                songEnd = std::max(songEnd, c.startBeat + c.lengthBeats);
                t.clips.emplace_back(std::move(c));
            }
            out.project.tracks.push_back(std::move(t));
            if (ctx.progress)
                ctx.progress(0.4f + 0.6f * static_cast<float>(ordinal) /
                                        static_cast<float>(groups.size()));
            continue;
        }

        const SmfData::ImportedTrack& st = *g.members.front();
        if (st.notes.empty() && st.cc.empty())
            continue; // SmfReader already skips these; belt and braces

        MidiClip c;
        c.id = out.nextId();
        c.name = t.name;
        c.startBeat = 0.0;
        c.notes.reserve(st.notes.size());
        for (const Note& src : st.notes) {
            Note n = src;
            n.id = out.nextId();
            n.pitch = std::clamp(n.pitch, 0, 127);
            n.velocity = std::clamp(n.velocity, 1, 127);
            c.notes.push_back(n);
        }
        double contentEnd = st.lengthBeats;
        c.cc.reserve(st.cc.size());
        for (const MidiCc& src : st.cc) { // absolute file beats == clip-relative here
            MidiCc cev = src;
            cev.id = out.nextId();
            cev.controller = std::clamp(cev.controller, 0, 129);
            cev.beat = std::max(0.0, cev.beat);
            cev.value = std::clamp(cev.value, 0.0, 1.0);
            contentEnd = std::max(contentEnd, cev.beat);
            c.cc.push_back(cev);
        }
        std::stable_sort(c.cc.begin(), c.cc.end(), [](const MidiCc& a, const MidiCc& b) {
            return a.controller != b.controller ? a.controller < b.controller
                                                : a.beat < b.beat;
        });
        const double len = std::max(contentEnd, bpb);
        c.lengthBeats = std::ceil(len / bpb - 1e-9) * bpb; // whole bars
        songEnd = std::max(songEnd, c.lengthBeats);
        t.clips.emplace_back(std::move(c));
        out.project.tracks.push_back(std::move(t));

        if (ctx.progress)
            ctx.progress(0.4f + 0.6f * static_cast<float>(ordinal) /
                                    static_cast<float>(groups.size()));
    }

    if (out.project.tracks.empty()) {
        err = "file contains no notes";
        return false;
    }
    out.project.loop = LoopRegion{0.0, songEnd, false};
    if (ctx.progress)
        ctx.progress(1.0f);
    return true;
}

} // namespace mydaw
