// MyDAW — midi/SmfWriter.cpp
// Standard MIDI File writer. See SmfWriter.h for the layout contract.

#include "midi/SmfWriter.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

#include "core/TempoMap.h"
#include "project/Model.h"
#include "util/Log.h"
#include "util/Paths.h"

namespace mydaw {

namespace {

constexpr int kPpqn = 480;

int64_t tickAt(double beat) {
    if (beat <= 0.0)
        return 0;
    return static_cast<int64_t>(std::llround(beat * kPpqn));
}

// Variable-length quantity: 1..4 bytes, 7 bits each, MSB = continuation.
void putVlq(std::vector<uint8_t>& v, uint32_t value) {
    if (value > 0x0FFFFFFFu)
        value = 0x0FFFFFFFu; // VLQ ceiling (~155 h at 480 PPQN / 120 bpm)
    uint8_t bytes[4];
    int n = 0;
    do {
        bytes[n++] = static_cast<uint8_t>(value & 0x7Fu);
        value >>= 7;
    } while (value != 0);
    for (int i = n - 1; i >= 0; --i)
        v.push_back(i == 0 ? bytes[i] : static_cast<uint8_t>(bytes[i] | 0x80u));
}

// One track event: complete message bytes (incl. meta length VLQs) at an absolute tick.
// prio breaks ties at equal ticks: name meta < note-off < cc < note-on.
struct TEvent {
    int64_t tick = 0;
    int prio = 0;
    std::vector<uint8_t> bytes;
};

void sortEvents(std::vector<TEvent>& evs) {
    std::stable_sort(evs.begin(), evs.end(), [](const TEvent& a, const TEvent& b) {
        if (a.tick != b.tick)
            return a.tick < b.tick;
        return a.prio < b.prio;
    });
}

// Delta-encodes sorted events into an MTrk body and appends the end-of-track meta.
std::vector<uint8_t> buildBody(const std::vector<TEvent>& evs) {
    std::vector<uint8_t> body;
    int64_t lastTick = 0;
    for (const TEvent& e : evs) {
        putVlq(body, static_cast<uint32_t>(std::max<int64_t>(0, e.tick - lastTick)));
        body.insert(body.end(), e.bytes.begin(), e.bytes.end());
        lastTick = e.tick;
    }
    putVlq(body, 0);
    body.push_back(0xFF);
    body.push_back(0x2F);
    body.push_back(0x00);
    return body;
}

bool writeChunk(FILE* f, const char tag[4], const std::vector<uint8_t>& body) {
    const uint32_t len = static_cast<uint32_t>(body.size());
    const uint8_t be[4] = {static_cast<uint8_t>((len >> 24) & 0xFF),
                           static_cast<uint8_t>((len >> 16) & 0xFF),
                           static_cast<uint8_t>((len >> 8) & 0xFF),
                           static_cast<uint8_t>(len & 0xFF)};
    return std::fwrite(tag, 1, 4, f) == 4 && std::fwrite(be, 1, 4, f) == 4 &&
           (body.empty() || std::fwrite(body.data(), 1, body.size(), f) == body.size());
}

uint8_t u7(double normalized) { // 0..1 -> 0..127
    const long v = std::lround(std::clamp(normalized, 0.0, 1.0) * 127.0);
    return static_cast<uint8_t>(std::clamp<long>(v, 0, 127));
}

} // namespace

bool SmfWriter::write(const Model& model, const std::string& absPath, std::string& err) {
    err.clear();
    const Project& p = model.project;

    TempoMap map; // bar -> beat for time-signature metas (sample rate irrelevant)
    map.setMap(p.tempoMap, p.timeSigMap);

    // ---- track 0: tempo + time-signature metas ---------------------------------
    std::vector<TEvent> conductor;
    for (const TempoEntry& te : p.tempoMap) {
        const double bpm = std::clamp(te.bpm, 1.0, 1000.0);
        const int64_t usPerQn =
            std::clamp<int64_t>(static_cast<int64_t>(std::llround(60000000.0 / bpm)), 1,
                                0xFFFFFF);
        TEvent e;
        e.tick = tickAt(te.beat);
        e.bytes = {0xFF, 0x51, 0x03, static_cast<uint8_t>((usPerQn >> 16) & 0xFF),
                   static_cast<uint8_t>((usPerQn >> 8) & 0xFF),
                   static_cast<uint8_t>(usPerQn & 0xFF)};
        conductor.push_back(std::move(e));
    }
    for (const TimeSigEntry& ts : p.timeSigMap) {
        uint8_t lg = 0; // log2(den); den is a power of two per SPEC §6
        for (int d = ts.den; d > 1 && lg < 7; d >>= 1)
            ++lg;
        TEvent e;
        e.tick = tickAt(map.beatAtBar(ts.bar));
        e.prio = 1;
        e.bytes = {0xFF, 0x58, 0x04,
                   static_cast<uint8_t>(std::clamp(ts.num, 1, 255)), lg,
                   24, 8}; // MIDI clocks/metronome click, 32nds per quarter (defaults)
        conductor.push_back(std::move(e));
    }
    sortEvents(conductor);

    // ---- one MTrk per midi/instrument track, model order -----------------------
    std::vector<std::vector<uint8_t>> bodies;
    bodies.push_back(buildBody(conductor));
    size_t totalNotes = 0;
    size_t totalCc = 0;
    for (const Track& t : p.tracks) {
        if (t.kind != TrackKind::Midi && t.kind != TrackKind::Instrument)
            continue;
        std::vector<TEvent> evs;
        if (!t.name.empty()) {
            TEvent e;
            e.prio = -1;
            e.bytes = {0xFF, 0x03};
            putVlq(e.bytes, static_cast<uint32_t>(t.name.size()));
            e.bytes.insert(e.bytes.end(), t.name.begin(), t.name.end());
            evs.push_back(std::move(e));
        }
        for (const Clip& c : t.clips) {
            const MidiClip* mc = asMidi(&c);
            if (!mc || mc->muted)
                continue;
            const double clipEnd = mc->startBeat + mc->lengthBeats;
            for (const Note& n : mc->notes) {
                if (n.startBeat < 0.0 || n.startBeat >= mc->lengthBeats)
                    continue;
                const double onB = mc->startBeat + n.startBeat;
                const double offB = std::min(onB + n.lengthBeats, clipEnd);
                if (offB <= onB)
                    continue;
                const int64_t on = tickAt(onB);
                int64_t off = tickAt(offB);
                if (off <= on)
                    off = on + 1;
                const uint8_t pitch =
                    static_cast<uint8_t>(std::clamp(n.pitch, 0, 127));
                const uint8_t vel =
                    static_cast<uint8_t>(std::clamp(n.velocity, 1, 127));
                evs.push_back(TEvent{on, 2, {0x90, pitch, vel}});
                evs.push_back(TEvent{off, 0, {0x80, pitch, 0}});
                ++totalNotes;
            }
            for (const MidiCc& pt : mc->cc) {
                if (pt.controller < 0 || pt.controller > 129)
                    continue;
                if (pt.beat < 0.0 || pt.beat >= mc->lengthBeats)
                    continue;
                const int64_t tick = tickAt(mc->startBeat + pt.beat);
                TEvent e;
                e.tick = tick;
                e.prio = 1;
                if (pt.controller == 128) { // pitch bend, 14-bit (0.5 = center)
                    const long raw = std::lround(
                        std::clamp(pt.value, 0.0, 1.0) * 16383.0);
                    e.bytes = {0xE0, static_cast<uint8_t>(raw & 0x7F),
                               static_cast<uint8_t>((raw >> 7) & 0x7F)};
                } else if (pt.controller == 129) { // channel aftertouch
                    e.bytes = {0xD0, u7(pt.value)};
                } else {
                    e.bytes = {0xB0, static_cast<uint8_t>(pt.controller),
                               u7(pt.value)};
                }
                evs.push_back(std::move(e));
                ++totalCc;
            }
        }
        sortEvents(evs);
        bodies.push_back(buildBody(evs));
    }

    // ---- file -------------------------------------------------------------------
    FILE* f = _wfopen(utf8ToWide(absPath).c_str(), L"wb");
    if (!f) {
        err = "cannot create file: " + absPath;
        return false;
    }
    const uint16_t ntrks = static_cast<uint16_t>(bodies.size());
    const uint8_t header[6] = {0x00, 0x01, // format 1
                               static_cast<uint8_t>((ntrks >> 8) & 0xFF),
                               static_cast<uint8_t>(ntrks & 0xFF),
                               static_cast<uint8_t>((kPpqn >> 8) & 0xFF),
                               static_cast<uint8_t>(kPpqn & 0xFF)};
    bool ok = writeChunk(f, "MThd", std::vector<uint8_t>(header, header + 6));
    for (const auto& body : bodies)
        if (ok)
            ok = writeChunk(f, "MTrk", body);
    if (std::fclose(f) != 0)
        ok = false;
    if (!ok) {
        err = "write error: " + absPath;
        return false;
    }

    Log::info("SmfWriter: '%s' — %u track%s (%zu note%s, %zu cc point%s, %zu tempo / "
              "%zu timesig entr%s)",
              absPath.c_str(), static_cast<unsigned>(ntrks), ntrks == 1 ? "" : "s",
              totalNotes, totalNotes == 1 ? "" : "s", totalCc, totalCc == 1 ? "" : "s",
              p.tempoMap.size(), p.timeSigMap.size(),
              p.timeSigMap.size() == 1 ? "y" : "ies");
    return true;
}

} // namespace mydaw
