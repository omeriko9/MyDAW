// MyDAW — midi/SmfReader.cpp
// Standard MIDI File parser. See SmfReader.h for scope and tolerances.

#include "midi/SmfReader.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>

#include "util/Log.h"
#include "util/Paths.h"
#include "util/Utf8.h"

namespace mydaw {

namespace {

constexpr double kMinNoteLenBeats = 1.0 / 128.0;

uint32_t be16(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 8) | static_cast<uint32_t>(p[1]);
}
uint32_t be32(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

// Bounds-checked forward cursor over one track chunk.
struct Cursor {
    const uint8_t* p;
    const uint8_t* end;
    bool ok = true;

    size_t remaining() const { return static_cast<size_t>(end - p); }
    bool need(size_t n) {
        if (remaining() < n) {
            ok = false;
            return false;
        }
        return true;
    }
    uint8_t u8() { return need(1) ? *p++ : 0; }
    // Variable-length quantity: 1..4 bytes, 7 bits each, MSB = continuation.
    bool vlq(uint32_t& v) {
        v = 0;
        for (int i = 0; i < 4; ++i) {
            if (!need(1))
                return false;
            const uint8_t b = *p++;
            v = (v << 7) | static_cast<uint32_t>(b & 0x7Fu);
            if (!(b & 0x80u))
                return true;
        }
        ok = false; // > 4 bytes: malformed
        return false;
    }
};

// Time-signature meta at a beat position; converted to bars after all tracks parsed.
struct RawSig {
    double beat = 0.0;
    int num = 4;
    int den = 4;
};

// Track-name sanitizer (header contract): truncate at the first control byte (< 0x20 —
// Logic Platinum embeds NULs mid-name and CR/LF have no business in a track name), trim
// trailing whitespace, then strip a trailing Logic region-operation suffix
// ("*recorded" etc., case-insensitive — the corpus carries all five forms), trim
// again, and finally GUARANTEE valid UTF-8. May return "" (caller applies fallback).
std::string sanitizeTrackName(const std::string& raw) {
    std::string s;
    for (const char ch : raw) {
        if (static_cast<unsigned char>(ch) < 0x20)
            break; // bytes >= 0x80 handled by the UTF-8 step below
        s.push_back(ch);
    }
    const auto rtrim = [](std::string& v) {
        while (!v.empty() && (v.back() == ' ' || v.back() == '\t'))
            v.pop_back();
    };
    rtrim(s);
    static constexpr const char* kLogicSuffixes[] = {"recorded", "copied", "merged",
                                                     "divided", "created"};
    const size_t star = s.find_last_of('*');
    if (star != std::string::npos) {
        const std::string tail = s.substr(star + 1);
        for (const char* suf : kLogicSuffixes) {
            if (tail.size() == std::strlen(suf) &&
                std::equal(tail.begin(), tail.end(), suf, [](char a, char b) {
                    return std::tolower(static_cast<unsigned char>(a)) == b;
                })) {
                s.resize(star);
                rtrim(s);
                break;
            }
        }
    }
    // Guarantee valid UTF-8: nlohmann::json's strict dump THROWS on invalid UTF-8, so
    // an unsanitized name would crash project save/autosave (util/Utf8.h — same
    // invariant as cpr import). Names that fail validation are legacy 8-bit (the
    // Latin-1/cp1252-era exports this parser targets): transcode byte -> U+00XX, which
    // always yields valid UTF-8 and keeps Western-European accents readable; other
    // codepages degrade to wrong-but-valid glyphs instead of a crash.
    if (!isValidUtf8(s))
        s = latin1ToUtf8(s);
    return s;
}

// Parses one MTrk chunk body; appends an ImportedTrack to `out` when it contains notes
// or cc. Tempo metas go straight into out.tempoMap; time-signature metas into rawSigs.
void parseTrack(const uint8_t* data, size_t len, int trackOrdinal, int division,
                std::vector<RawSig>& rawSigs, SmfData& out) {
    Cursor c{data, data + len};
    int64_t tick = 0;
    uint8_t running = 0;
    std::string name;
    int channelPrefix = -1;  // first FF 20 meta
    int primaryChannel = -1; // channel of the first channel-voice event
    int program = -1;        // first program change (C0) value
    std::vector<Note> notes;
    std::vector<MidiCc> cc;
    int pending[16][128]; // [channel][pitch] -> index into notes, -1 = none
    for (auto& chRow : pending)
        for (int& v : chRow)
            v = -1;

    const auto beatAt = [division](int64_t t) {
        return static_cast<double>(t) / static_cast<double>(division);
    };
    const auto closeAt = [&](int ch, int pitch, double beat) {
        const int idx = pending[ch][pitch];
        if (idx < 0)
            return;
        Note& n = notes[static_cast<size_t>(idx)];
        double l = beat - n.startBeat;
        if (l < kMinNoteLenBeats)
            l = kMinNoteLenBeats;
        n.lengthBeats = l;
        pending[ch][pitch] = -1;
    };

    bool ended = false;
    while (!ended && c.ok && c.p < c.end) {
        uint32_t delta = 0;
        if (!c.vlq(delta))
            break;
        tick += delta;
        if (!c.need(1))
            break;
        const uint8_t b = *c.p;

        if (b == 0xFF) { // ---- meta event ------------------------------------
            ++c.p;
            const uint8_t type = c.u8();
            uint32_t mlen = 0;
            if (!c.vlq(mlen) || !c.need(mlen))
                break;
            const uint8_t* md = c.p;
            c.p += mlen;
            running = 0; // meta/sysex clears running status
            switch (type) {
                case 0x2F: // end of track
                    ended = true;
                    break;
                case 0x51: // set tempo (microseconds per quarter note)
                    if (mlen >= 3) {
                        const uint32_t usPerQn = (static_cast<uint32_t>(md[0]) << 16) |
                                                 (static_cast<uint32_t>(md[1]) << 8) |
                                                 static_cast<uint32_t>(md[2]);
                        if (usPerQn > 0)
                            out.tempoMap.push_back(TempoEntry{
                                beatAt(tick), 60000000.0 / static_cast<double>(usPerQn)});
                    }
                    break;
                case 0x58: // time signature {num, log2(den), clocks, 32nds}
                    if (mlen >= 2 && md[0] > 0 && md[1] <= 7)
                        rawSigs.push_back(
                            RawSig{beatAt(tick), static_cast<int>(md[0]), 1 << md[1]});
                    break;
                case 0x03: // sequence/track name
                    if (name.empty() && mlen > 0)
                        name.assign(reinterpret_cast<const char*>(md), mlen);
                    break;
                case 0x20: // MIDI channel prefix
                    if (channelPrefix < 0 && mlen >= 1)
                        channelPrefix = static_cast<int>(md[0] & 0x0Fu);
                    break;
                default:
                    break; // other meta events skipped
            }
        } else if (b == 0xF0 || b == 0xF7) { // ---- sysex: skipped ------------
            ++c.p;
            uint32_t slen = 0;
            if (!c.vlq(slen) || !c.need(slen))
                break;
            c.p += slen;
            running = 0;
        } else { // ---- channel voice message (possibly via running status) ----
            uint8_t status = 0;
            if (b & 0x80u) {
                status = b;
                ++c.p;
                if (status >= 0xF0) { // stray system-common byte: bail on this track
                    c.ok = false;
                    break;
                }
                running = status;
            } else {
                if (!running) { // data byte with no running status: malformed
                    c.ok = false;
                    break;
                }
                status = running;
            }
            const uint8_t hi = static_cast<uint8_t>(status & 0xF0u);
            const int nData = (hi == 0xC0 || hi == 0xD0) ? 1 : 2;
            if (!c.need(static_cast<size_t>(nData)))
                break;
            const uint8_t d1 = static_cast<uint8_t>(*c.p++ & 0x7Fu);
            const uint8_t d2 = (nData == 2) ? static_cast<uint8_t>(*c.p++ & 0x7Fu)
                                            : static_cast<uint8_t>(0);
            const int ch = status & 0x0F;
            if (primaryChannel < 0)
                primaryChannel = ch;

            if (hi == 0x90 && d2 > 0) { // note on
                const double beat = beatAt(tick);
                closeAt(ch, d1, beat); // overlapping retrigger: close the previous note
                Note n;
                n.id = 0; // importer allocates real ids (Model::nextId)
                n.pitch = d1;
                n.velocity = d2;
                n.startBeat = beat;
                n.lengthBeats = 0.0; // open until the matching note-off
                n.channel = ch;
                pending[ch][d1] = static_cast<int>(notes.size());
                notes.push_back(n);
            } else if (hi == 0x80 || (hi == 0x90 && d2 == 0)) { // note off
                closeAt(ch, d1, beatAt(tick));
            } else if (hi == 0xB0) { // control change (incl. channel-mode 120..127)
                cc.push_back(MidiCc{0, static_cast<int>(d1), beatAt(tick),
                                    static_cast<double>(d2) / 127.0});
            } else if (hi == 0xE0) { // pitch bend -> controller 128 (0.5 = center)
                const int raw = (static_cast<int>(d2) << 7) | static_cast<int>(d1);
                cc.push_back(
                    MidiCc{0, 128, beatAt(tick), static_cast<double>(raw) / 16383.0});
            } else if (hi == 0xD0) { // channel aftertouch -> controller 129
                cc.push_back(
                    MidiCc{0, 129, beatAt(tick), static_cast<double>(d1) / 127.0});
            } else if (hi == 0xC0) { // program change: first one recorded, rest skipped
                if (program < 0)
                    program = d1;
            }
            // Poly aftertouch: skipped.
        }
    }

    if (!c.ok)
        Log::warn("SmfReader: malformed data in track %d — keeping %zu note%s parsed so far",
                  trackOrdinal, notes.size(), notes.size() == 1 ? "" : "s");

    // Close notes left hanging at end of track.
    const double endBeat = beatAt(tick);
    for (int ch = 0; ch < 16; ++ch)
        for (int p = 0; p < 128; ++p)
            if (pending[ch][p] >= 0)
                closeAt(ch, p, endBeat);

    if (notes.empty() && cc.empty())
        return; // empty tracks skipped (e.g. format-1 conductor track)

    std::stable_sort(notes.begin(), notes.end(), [](const Note& a, const Note& b) {
        if (a.startBeat != b.startBeat)
            return a.startBeat < b.startBeat;
        return a.pitch < b.pitch;
    });
    std::stable_sort(cc.begin(), cc.end(), [](const MidiCc& a, const MidiCc& b) {
        if (a.controller != b.controller)
            return a.controller < b.controller;
        return a.beat < b.beat;
    });
    double lengthBeats = 0.0;
    double firstEventBeat = notes.empty() && cc.empty() ? 0.0 : 1e300;
    for (const Note& n : notes) {
        lengthBeats = std::max(lengthBeats, n.startBeat + n.lengthBeats);
        firstEventBeat = std::min(firstEventBeat, n.startBeat);
    }
    for (const MidiCc& p : cc) {
        lengthBeats = std::max(lengthBeats, p.beat);
        firstEventBeat = std::min(firstEventBeat, p.beat);
    }

    SmfData::ImportedTrack t;
    const std::string clean = sanitizeTrackName(name);
    t.name = clean.empty() ? ("Track " + std::to_string(trackOrdinal)) : clean;
    t.rawName = std::move(name);
    t.notes = std::move(notes);
    t.cc = std::move(cc);
    t.lengthBeats = lengthBeats;
    t.firstEventBeat = firstEventBeat;
    t.channelPrefix = channelPrefix;
    t.primaryChannel = primaryChannel;
    t.program = program;
    out.tracks.push_back(std::move(t));
}

} // namespace

bool SmfReader::read(const std::string& path, SmfData& out, std::string& err) {
    out = SmfData{};
    err.clear();

    // Load the whole file (SMFs are small).
    std::vector<uint8_t> buf;
    {
        FILE* f = _wfopen(utf8ToWide(path).c_str(), L"rb");
        if (!f) {
            err = "cannot open file: " + path;
            return false;
        }
        std::fseek(f, 0, SEEK_END);
        const long size = std::ftell(f);
        std::fseek(f, 0, SEEK_SET);
        if (size <= 0) {
            std::fclose(f);
            err = "empty or unreadable file: " + path;
            return false;
        }
        buf.resize(static_cast<size_t>(size));
        const size_t got = std::fread(buf.data(), 1, buf.size(), f);
        std::fclose(f);
        if (got != buf.size()) {
            err = "read error: " + path;
            return false;
        }
    }

    // ---- MThd ----------------------------------------------------------------
    if (buf.size() < 14 || std::memcmp(buf.data(), "MThd", 4) != 0) {
        err = "not a Standard MIDI File (missing MThd header)";
        return false;
    }
    const uint32_t headerLen = be32(buf.data() + 4);
    if (headerLen < 6 || 8 + static_cast<size_t>(headerLen) > buf.size()) {
        err = "corrupt MThd header";
        return false;
    }
    const int format = static_cast<int>(be16(buf.data() + 8));
    const uint32_t division = be16(buf.data() + 12);
    if (format != 0 && format != 1) {
        err = "unsupported SMF format " + std::to_string(format) + " (only 0 and 1)";
        return false;
    }
    if (division & 0x8000u) {
        err = "SMPTE time division is not supported (PPQN files only)";
        return false;
    }
    if (division == 0) {
        err = "invalid time division (0 ticks per quarter note)";
        return false;
    }
    out.format = format;

    // ---- chunks ---------------------------------------------------------------
    size_t pos = 8 + headerLen; // MThd may legally be longer than 6 bytes
    int trackOrdinal = 0;
    std::vector<RawSig> rawSigs;
    while (pos + 8 <= buf.size()) {
        const uint8_t* chunk = buf.data() + pos;
        uint32_t chunkLen = be32(chunk + 4);
        const size_t bodyPos = pos + 8;
        if (bodyPos + chunkLen > buf.size()) {
            Log::warn("SmfReader: truncated chunk in '%s' — salvaging what is present",
                      path.c_str());
            chunkLen = static_cast<uint32_t>(buf.size() - bodyPos);
        }
        if (std::memcmp(chunk, "MTrk", 4) == 0) {
            ++trackOrdinal;
            parseTrack(buf.data() + bodyPos, chunkLen, trackOrdinal,
                       static_cast<int>(division), rawSigs, out);
        } // unknown chunk types are skipped per the SMF spec
        pos = bodyPos + chunkLen;
    }

    if (trackOrdinal == 0) {
        err = "no MTrk chunks found";
        return false;
    }

    // ---- tempo map: sort, collapse same-beat metas (last wins), anchor at beat 0 ----
    std::stable_sort(out.tempoMap.begin(), out.tempoMap.end(),
                     [](const TempoEntry& a, const TempoEntry& b) {
                         return a.beat < b.beat;
                     });
    {
        std::vector<TempoEntry> dedup;
        dedup.reserve(out.tempoMap.size());
        for (const TempoEntry& e : out.tempoMap) {
            if (!dedup.empty() && std::fabs(e.beat - dedup.back().beat) < 1e-9)
                dedup.back() = e;
            else
                dedup.push_back(e);
        }
        out.tempoMap = std::move(dedup);
    }
    if (out.tempoMap.empty())
        out.tempoMap.push_back(TempoEntry{0.0, 120.0});
    else if (out.tempoMap.front().beat < 1e-9)
        out.tempoMap.front().beat = 0.0;
    else
        out.tempoMap.insert(out.tempoMap.begin(),
                            TempoEntry{0.0, out.tempoMap.front().bpm});
    out.bpm = out.tempoMap.front().bpm;

    // ---- time-signature map: meta beats -> bars (changes land on bar lines) ---------
    std::stable_sort(rawSigs.begin(), rawSigs.end(),
                     [](const RawSig& a, const RawSig& b) { return a.beat < b.beat; });
    double segStartBeat = 0.0; // beat position of segStartBar
    int segStartBar = 0;
    double bpb = 4.0; // implied 4/4 before the first meta
    for (const RawSig& rs : rawSigs) {
        int bar = segStartBar +
                  static_cast<int>(std::llround((rs.beat - segStartBeat) / bpb));
        if (bar < segStartBar)
            bar = segStartBar;
        if (!out.timeSigMap.empty() && out.timeSigMap.back().bar == bar)
            out.timeSigMap.back() = TimeSigEntry{bar, rs.num, rs.den}; // last wins
        else
            out.timeSigMap.push_back(TimeSigEntry{bar, rs.num, rs.den});
        segStartBeat += static_cast<double>(bar - segStartBar) * bpb;
        segStartBar = bar;
        bpb = static_cast<double>(rs.num) * 4.0 / static_cast<double>(rs.den);
    }
    if (out.timeSigMap.empty())
        out.timeSigMap.push_back(TimeSigEntry{0, 4, 4});
    else if (out.timeSigMap.front().bar != 0)
        out.timeSigMap.insert(out.timeSigMap.begin(), TimeSigEntry{0, 4, 4});
    out.tsNum = out.timeSigMap.front().num;
    out.tsDen = out.timeSigMap.front().den;

    size_t totalNotes = 0;
    size_t totalCc = 0;
    for (const auto& t : out.tracks) {
        totalNotes += t.notes.size();
        totalCc += t.cc.size();
    }
    Log::info("SmfReader: '%s' — format %d, %d track chunk%s, %zu imported, %zu note%s, "
              "%zu cc point%s, %zu tempo / %zu timesig entr%s, %.2f bpm, %d/%d",
              path.c_str(), format, trackOrdinal, trackOrdinal == 1 ? "" : "s",
              out.tracks.size(), totalNotes, totalNotes == 1 ? "" : "s", totalCc,
              totalCc == 1 ? "" : "s", out.tempoMap.size(), out.timeSigMap.size(),
              out.timeSigMap.size() == 1 ? "y" : "ies", out.bpm, out.tsNum, out.tsDen);
    return true;
}

} // namespace mydaw
