// MyDAW — import/CprImportProvider.cpp. See CprImportProvider.h.
//
// Format reference (empirical, validated on an 18-sample corpus 2004-2026 plus ~650
// archive projects; reference tooling: scripts/cpr-analyze.mjs):
//
//   Container:  "RIFF" u32be totalSize "NUND", then chunks {4cc, u32be size, data}
//               with NO even-padding. Chunks come in ROOT/ARCH pairs; ROOT data is two
//               strings (u32be len + chars, no NUL) naming the next ARCH. The project
//               content lives in the ARCH whose ROOT second string is "PArrangement".
//
//   ARCH object stream (identical 2004->2026):
//     first occurrence of a class:
//       [FFFFFFFE nameField u16 ver]*  FFFFFFFF nameField u16 ver  u32 size  data[size]
//     later occurrences:
//       u32 (0x80000000|id)  u32 size  data[size]
//     nameField: u32 len (incl. trailing NUL) + chars + NUL, or u32 (0x80000000|id)
//     back-reference. id of a name = offset of its u32 len field - (archDataOff + 4).
//     `size` includes nested child records, so subtree skipping is exact.
//
//   Strings in record data ("lpstr"): u32be len + bytes; text = bytes up to first NUL.
//   If the 3 bytes after the NUL are EF BB BF the text is UTF-8 (Cubase >= ~4); else it
//   is ANSI in the writing machine's codepage (Windows-1255 transcoding fallback here).
//
//   PPQN is a constant 480; positions/lengths are f64 ticks (fractional for live takes).
//
// Every read is bounds-checked. Unknown/undecodable structures are skipped with
// Log::warn; nothing is fabricated.

#include "import/CprImportProvider.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "media/AssetStore.h"
#include "project/Model.h"
#include "util/Log.h"
#include "util/Paths.h"
#include "util/Utf8.h"

namespace mydaw {

namespace {

constexpr double kPpq = 480.0; // ticks per quarter note, constant across all versions
constexpr size_t kMaxRecords = 2'000'000;
constexpr int kMaxWalkDepth = 48;
constexpr size_t kMaxChunks = 4096;
constexpr uint32_t kMaxLpstr = 4096;
// Global ceiling on tracks materialized from one import. The rack paths create one track
// per matched slot, bounded only by attacker-controlled rackLen / attr budget — without a
// hard cap a crafted .cpr can drive unbounded allocation (parser DoS).
constexpr size_t kMaxImportTracks = 4096;

// 12-color track palette — mirrors project/Commands.cpp kTrackColors (ui canvas.ts).
constexpr const char* kTrackColors[] = {
    "#e25d5d", "#e2814d", "#d8a14a", "#bdb84f", "#8fc457", "#56c596",
    "#4dc3cd", "#54a3e8", "#7a82f0", "#a06ee8", "#d165d6", "#e0639c",
};
constexpr size_t kNumTrackColors = sizeof(kTrackColors) / sizeof(kTrackColors[0]);

// ---------------------------------------------------------------------------
// File helpers (codebase pattern: UTF-8 strings, wide CRT)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Bounds-checked big-endian reads (absolute offset, exclusive end)
// ---------------------------------------------------------------------------

bool rdU8(const std::vector<uint8_t>& b, size_t off, size_t end, uint8_t& v) {
    if (off >= end || off >= b.size())
        return false;
    v = b[off];
    return true;
}

bool rdU16(const std::vector<uint8_t>& b, size_t off, size_t end, uint16_t& v) {
    if (off + 2 > end || off + 2 > b.size())
        return false;
    v = static_cast<uint16_t>((b[off] << 8) | b[off + 1]);
    return true;
}

bool rdU32(const std::vector<uint8_t>& b, size_t off, size_t end, uint32_t& v) {
    if (off + 4 > end || off + 4 > b.size())
        return false;
    v = (static_cast<uint32_t>(b[off]) << 24) | (static_cast<uint32_t>(b[off + 1]) << 16) |
        (static_cast<uint32_t>(b[off + 2]) << 8) | static_cast<uint32_t>(b[off + 3]);
    return true;
}

bool rdU64(const std::vector<uint8_t>& b, size_t off, size_t end, uint64_t& v) {
    uint32_t hi = 0, lo = 0;
    if (!rdU32(b, off, end, hi) || !rdU32(b, off + 4, end, lo))
        return false;
    v = (static_cast<uint64_t>(hi) << 32) | lo;
    return true;
}

bool rdF32(const std::vector<uint8_t>& b, size_t off, size_t end, float& v) {
    uint32_t u = 0;
    if (!rdU32(b, off, end, u))
        return false;
    v = std::bit_cast<float>(u);
    return true;
}

bool rdF64(const std::vector<uint8_t>& b, size_t off, size_t end, double& v) {
    uint64_t u = 0;
    if (!rdU64(b, off, end, u))
        return false;
    v = std::bit_cast<double>(u);
    return true;
}

// LITTLE-endian readers — used only inside plugin-component blobs (opaque plugin state
// serialized by the plugin itself, e.g. the Standard Panner), never for attr-tree fields.
bool rdU32le(const std::vector<uint8_t>& b, size_t off, size_t end, uint32_t& v) {
    if (off + 4 > end || off + 4 > b.size())
        return false;
    v = static_cast<uint32_t>(b[off]) | (static_cast<uint32_t>(b[off + 1]) << 8) |
        (static_cast<uint32_t>(b[off + 2]) << 16) | (static_cast<uint32_t>(b[off + 3]) << 24);
    return true;
}

bool rdF32le(const std::vector<uint8_t>& b, size_t off, size_t end, float& v) {
    uint32_t u = 0;
    if (!rdU32le(b, off, end, u))
        return false;
    v = std::bit_cast<float>(u);
    return true;
}

// ---------------------------------------------------------------------------
// String decoding + sanitization. nlohmann::json THROWS on invalid UTF-8, so no
// string may reach the Model unsanitized. The UTF-8 validator/sanitizer is shared
// engine-wide (util/Utf8.h — SMF import enforces the same invariant); the cp1255
// transcode below is cpr-specific (ANSI lpstrs from this corpus's writing machine).
// ---------------------------------------------------------------------------

// ANSI fallback (no UTF-8 BOM after the NUL): Windows-1255 Hebrew letters 0xE0..0xFA map
// to U+05D0..U+05EA; other high bytes (cp1255 punctuation/diacritics) become '?'.
std::string cp1255ToUtf8(const uint8_t* p, size_t n) {
    std::string out;
    out.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        const uint8_t c = p[i];
        if (c >= 0x20 && c < 0x7F)
            out.push_back(static_cast<char>(c));
        else if (c >= 0xE0 && c <= 0xFA)
            appendCodepointUtf8(out, 0x05D0 + (c - 0xE0));
        else if (c == '\t')
            out.push_back(' ');
        else
            out.push_back('?');
    }
    return out;
}

struct LpStr {
    std::string text;
    size_t next = 0;
    bool ok = false;
};

// lpstr: u32be len + bytes; logical text up to first NUL; EF BB BF after NUL => UTF-8.
LpStr readLpstr(const std::vector<uint8_t>& b, size_t p, size_t end) {
    LpStr r;
    uint32_t len = 0;
    if (!rdU32(b, p, end, len))
        return r;
    if (len == 0) {
        r.next = p + 4;
        r.ok = true;
        return r;
    }
    if (len > kMaxLpstr || p + 4 + len > end || p + 4 + len > b.size()) {
        r.next = p + 4;
        return r;
    }
    const uint8_t* bytes = b.data() + p + 4;
    size_t nul = 0;
    while (nul < len && bytes[nul] != 0)
        ++nul;
    const bool isUtf8 = nul + 3 < len && bytes[nul] == 0 && bytes[nul + 1] == 0xEF &&
                        bytes[nul + 2] == 0xBB && bytes[nul + 3] == 0xBF;
    r.text = isUtf8 ? sanitizeUtf8(bytes, nul) : cp1255ToUtf8(bytes, nul);
    r.next = p + 4 + len;
    r.ok = true;
    return r;
}

// ---------------------------------------------------------------------------
// ARCH object-stream walker (port of scripts/cpr-analyze.mjs walkArch — that script is
// the validated reference implementation for this grammar)
// ---------------------------------------------------------------------------

struct Rec {
    std::string name;
    uint16_t ver = 0;
    size_t hdrOff = 0;
    size_t dataStart = 0;
    size_t dataEnd = 0;
};

class ArchWalker {
public:
    ArchWalker(const std::vector<uint8_t>& b, size_t archOff, size_t archSize)
        : b_(b), start_(archOff), end_(archOff + archSize), base_(archOff + 4) {}

    void run() { walk(start_, end_, 0); }

    std::vector<Rec> recs;                          // pre-order => ascending hdrOff
    std::unordered_map<uint32_t, std::string> names; // id -> class name
    size_t base() const { return base_; }
    bool truncated = false;

private:
    struct Name {
        std::string name;
        uint16_t ver = 0;
        uint32_t id = 0;
        size_t next = 0;
        bool ok = false;
    };

    struct Hdr {
        std::string name;
        uint16_t ver = 0;
        size_t dataStart = 0;
        size_t dataEnd = 0;
        bool ok = false;
    };

    static bool isNameChar(uint8_t c) { return c >= 0x20 && c < 0x7F; }

    Name readName(size_t p) const {
        Name n;
        uint32_t len = 0;
        if (!rdU32(b_, p, end_, len))
            return n;
        if (len < 2 || len > 100 || p + 4 + len + 2 > end_)
            return n;
        if (b_[p + 4 + len - 1] != 0)
            return n;
        for (uint32_t j = 0; j + 1 < len; ++j)
            if (!isNameChar(b_[p + 4 + j]))
                return n;
        n.name.assign(reinterpret_cast<const char*>(b_.data() + p + 4), len - 1);
        uint16_t ver = 0;
        rdU16(b_, p + 4 + len, end_, ver);
        n.ver = ver;
        n.id = static_cast<uint32_t>(p - base_);
        n.next = p + 4 + len + 2;
        n.ok = true;
        return n;
    }

    Hdr tryHeader(size_t p, size_t parentEnd) {
        Hdr h;
        uint32_t v = 0;
        if (p + 8 > parentEnd || !rdU32(b_, p, parentEnd, v))
            return h;
        if (v == 0xFFFFFFFEu) {
            // Base-class declaration chain, then the concrete FFFFFFFF record.
            size_t q = p;
            uint32_t cur = 0;
            while (q + 4 <= parentEnd && rdU32(b_, q, parentEnd, cur) && cur == 0xFFFFFFFEu) {
                uint32_t w = 0;
                if (!rdU32(b_, q + 4, parentEnd, w))
                    return h;
                if (w >= 0x80000000u && w != 0xFFFFFFFEu && w != 0xFFFFFFFFu) {
                    if (names.find(w - 0x80000000u) == names.end())
                        return h;
                    q += 8;
                } else {
                    Name n = readName(q + 4);
                    if (!n.ok)
                        return h;
                    names[n.id] = n.name;
                    q = n.next;
                }
            }
            uint32_t marker = 0;
            if (q + 4 > parentEnd || !rdU32(b_, q, parentEnd, marker) || marker != 0xFFFFFFFFu)
                return h;
            return tryHeader(q, parentEnd); // concrete record (depth <= 1 recursion)
        }
        if (v == 0xFFFFFFFFu) {
            Name n = readName(p + 4);
            if (!n.ok || n.next + 4 > parentEnd)
                return h;
            uint32_t size = 0;
            if (!rdU32(b_, n.next, parentEnd, size) || n.next + 4 + size > parentEnd)
                return h;
            names[n.id] = n.name;
            h.name = std::move(n.name);
            h.ver = n.ver;
            h.dataStart = n.next + 4;
            h.dataEnd = n.next + 4 + size;
            h.ok = true;
            return h;
        }
        if (v >= 0x80000000u) {
            const auto it = names.find(v - 0x80000000u);
            if (it == names.end())
                return h;
            uint32_t size = 0;
            if (!rdU32(b_, p + 4, parentEnd, size) || p + 8 + size > parentEnd)
                return h;
            h.name = it->second;
            h.dataStart = p + 8;
            h.dataEnd = p + 8 + size;
            h.ok = true;
            return h;
        }
        return h;
    }

    void walk(size_t s, size_t e, int depth) {
        size_t p = s;
        while (p < e) {
            if (recs.size() >= kMaxRecords) {
                truncated = true;
                return;
            }
            Hdr h = tryHeader(p, e);
            if (h.ok) {
                Rec r;
                r.name = h.name;
                r.ver = h.ver;
                r.hdrOff = p;
                r.dataStart = h.dataStart;
                r.dataEnd = h.dataEnd;
                recs.push_back(std::move(r));
                if (h.dataEnd > h.dataStart && depth < kMaxWalkDepth)
                    walk(h.dataStart, h.dataEnd, depth + 1);
                p = h.dataEnd;
            } else {
                ++p;
            }
        }
    }

    const std::vector<uint8_t>& b_;
    size_t start_, end_, base_;
};

// ---------------------------------------------------------------------------
// MIDI part event stream (two encodings: compact + record-form)
// ---------------------------------------------------------------------------

struct StreamEv {
    enum Kind { Note, Short, Skip } kind = Skip;
    uint8_t tag = 0;     // MIDI status nibble: 0x90 note, 0xA0..0xE0 short
    double tick = 0.0;
    uint8_t ch = 0, d1 = 0, d2 = 0;
    double lenTicks = 0.0; // notes only
    size_t next = 0;
};

uint8_t tagForClass(const std::string& n) {
    if (n == "MMidiNote") return 0x90;
    if (n == "MMidiPolyPressure") return 0xA0;
    if (n == "MMidiController") return 0xB0;
    if (n == "MMidiProgramChange") return 0xC0;
    if (n == "MMidiAfterTouch") return 0xD0;
    if (n == "MMidiPitchBend") return 0xE0;
    return 0; // MMidiSysex / unknown
}

// Decode one event at p. Compact: u8 statusTag + body. Record-form: u8 0x00 + archive
// record header + u32 size + body (same layout minus the tag byte) — size makes skipping
// of unknown record classes safe; unknown compact tags abort the stream (return false).
bool readStreamEvent(const std::vector<uint8_t>& b, size_t p, size_t end,
                     const std::unordered_map<uint32_t, std::string>& names, StreamEv& ev) {
    uint8_t tag = 0;
    if (!rdU8(b, p, end, tag))
        return false;
    size_t body = 0, recEnd = 0;
    bool isRecord = false;
    if (tag == 0x00) {
        isRecord = true;
        size_t q = p + 1;
        uint32_t v = 0;
        if (!rdU32(b, q, end, v))
            return false;
        // skip base-class declarations
        int guard = 0;
        while (v == 0xFFFFFFFEu) {
            if (++guard > 16)
                return false;
            uint32_t w = 0;
            if (!rdU32(b, q + 4, end, w))
                return false;
            if (w >= 0x80000000u) {
                q += 8;
            } else {
                uint32_t len = w;
                if (len < 2 || len > 100 || q + 8 + len + 2 > end)
                    return false;
                q += 4 + 4 + len + 2;
            }
            if (!rdU32(b, q, end, v))
                return false;
        }
        std::string recName;
        if (v == 0xFFFFFFFFu) {
            uint32_t len = 0;
            if (!rdU32(b, q + 4, end, len) || len < 2 || len > 100 || q + 8 + len + 2 > end)
                return false;
            recName.assign(reinterpret_cast<const char*>(b.data() + q + 8), len - 1);
            q += 8 + len + 2;
        } else if (v >= 0x80000000u) {
            const auto it = names.find(v - 0x80000000u);
            if (it == names.end())
                return false;
            recName = it->second;
            q += 4;
        } else {
            return false;
        }
        uint32_t size = 0;
        if (!rdU32(b, q, end, size) || q + 4 + size > end)
            return false;
        body = q + 4;
        recEnd = q + 4 + size;
        tag = tagForClass(recName);
        if (tag == 0) { // sysex / unknown record class: skip exactly by size
            ev.kind = StreamEv::Skip;
            ev.next = recEnd;
            return true;
        }
    } else {
        body = p + 1;
        recEnd = end;
    }

    // Body layout (both forms): f64 tick, u8 ch, u8 d1, u8 d2, u32 flags, u16 nExt,
    // nExt x 14B tagged extensions; notes continue with f64 lengthTicks, f64, u8[9].
    uint16_t nExt = 0;
    double tick = 0.0;
    uint8_t ch = 0, d1 = 0, d2 = 0;
    if (!rdF64(b, body, recEnd, tick) || !rdU8(b, body + 8, recEnd, ch) ||
        !rdU8(b, body + 9, recEnd, d1) || !rdU8(b, body + 10, recEnd, d2) ||
        !rdU16(b, body + 15, recEnd, nExt))
        return false;
    const size_t afterExt = body + 17 + 14u * nExt;

    if (tag == 0x90) {
        double lenTicks = 0.0;
        if (!rdF64(b, afterExt, recEnd, lenTicks))
            return false;
        ev.kind = StreamEv::Note;
        ev.next = isRecord ? recEnd : afterExt + 25; // f64 len + f64 + 8B + 1B
        if (!isRecord && ev.next > end)
            return false;
        ev.tag = tag;
        ev.tick = tick;
        ev.ch = ch;
        ev.d1 = d1; // pitch
        ev.d2 = d2; // velocity
        ev.lenTicks = lenTicks;
        return true;
    }
    if (tag == 0xA0 || tag == 0xB0 || tag == 0xC0 || tag == 0xD0 || tag == 0xE0) {
        ev.kind = StreamEv::Short;
        ev.next = isRecord ? recEnd : afterExt;
        if (ev.next > end)
            return false;
        ev.tag = tag;
        ev.tick = tick;
        ev.ch = ch;
        ev.d1 = d1;
        ev.d2 = d2;
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Conversion context
// ---------------------------------------------------------------------------

struct CprClipInfo {
    std::string name;       // PAudioClip display name (sanitized)
    std::string fileName;   // wav file name from FNPath
    std::string absPath;    // directory + fileName from FNPath ("" if no dir found)
    int channels = 0;       // from AudioFile record (0 = unknown)
    double fileSr = 0.0;    // source sample rate (0 = unknown)
    uint64_t totalSamples = 0;
    // Filled on first use:
    bool assetCreated = false;
    uint64_t assetId = 0;
    int64_t assetLenSamples = 0;
    double scale = 1.0; // sessionSR / fileSR (positions/lengths in the cpr are at fileSR)
};

// One track record's byte range -> imported model track (0 = track was skipped). Used to
// assign mixer-channel data (inserts/instruments) to the innermost containing track.
struct TrackSpan {
    size_t lo = 0, hi = 0;  // track record dataStart/dataEnd
    uint64_t trackId = 0;   // model track id, 0 = not imported (device/marker/... track)
};

struct CprCtx {
    const std::vector<uint8_t>& b;
    const std::vector<Rec>& recs;
    const std::unordered_map<uint32_t, std::string>& names;
    size_t base;
    Model& model;
    const ImportContext& ictx;
    std::string cprDir;
    std::map<uint32_t, CprClipInfo> clips; // PAudioClip dataStart - base -> info
    std::vector<TrackSpan> trackSpans;     // every track record (incl. skipped ones)
    bool isSxEra = false;
    // Modern Devices Synth Rack: slot index -> created Instrument track id, for the
    // modern MIDI->rack routing pass (wireModernMidiRouting).
    std::map<int, uint64_t> modernRackSlotTrack;
    // Synth-Slot instrument tracks in channel-scan (= track) order — routing-slot
    // fallback for MyDAW's own exports, which have no Devices rack (their connection
    // strings index instrument tracks by ordinal).
    std::vector<uint64_t> synthSlotTracks;
    // TRUE when MIDI routing was wired via the Synth-Slot ORDINAL fallback — i.e. this
    // .cpr is a MyDAW export (no Devices rack). Only then do feeder MIDI tracks collapse
    // into their instrument tracks (restoring the original Instrument-track shape);
    // native Cubase projects keep the MIDI-track + rack-instrument split as separate
    // tracks routed via Track::midiTarget (the corpus tests' shape).
    bool synthSlotOrdinalRouting = false;
    // Instrument tracks created FROM a rack slot (SX + modern). Feederless ones are
    // dropped at collapse time — Cubase's arrangement never showed them either.
    std::set<uint64_t> rackCreatedTracks;

    // Source-project metadata: provenance stamped on every dormant insert
    // (PluginInstance.sourceHint, e.g. "Cubase 5.1.1 project, 2009; 32-bit era"), and the
    // transport click state ('clickEnable', -1 = not found) surfaced through
    // Model::importMetronomeEnabled for Api::importForeignPath to apply.
    std::string sourceHint;
    int clickEnable = -1;

    // SX MIDI-track -> rack-instrument output routing (CPR_MIXER_FORMAT.md §7.7). Decoded
    // from each MMidiTrackEvent's "Track Device" (MMidiTrack) sub-object: the Device Name
    // lpstr = the target rack instrument's name. sxExtractVstiRack matches by name and
    // points each routed MIDI track's Track::midiTarget at the rack instrument's ONE
    // standalone Instrument track (shared instance; N:1 needs no duplication).
    struct MidiRoute {
        uint64_t trackId = 0; // imported MIDI track id
        std::string device;   // target rack-instrument name (output Device Name)
        int channel = -1;     // decoded MIDI channel (0..15), -1 = undecoded.
                              // Captured but UNUSED: 1:1 slot routing needs no channel
                              // split (§7.7); kept for a future channel-filter feature.
    };
    std::vector<MidiRoute> midiRoutes;

    // Lazily-built recursive index of audio files under cprDir (lowercase basename ->
    // first matching full path). Lets ensureAsset relink audio in arbitrary subfolders, not
    // just <cprDir>/ and <cprDir>/Audio/. Built once on the first ensureAsset call; bounded
    // (file/depth caps) so a pathological tree can't stall import.
    std::unordered_map<std::string, std::string> audioIndex;
    bool audioIndexBuilt = false;
    int audioResolvedByScan = 0; // referenced wavs found ONLY via the recursive index

    // stats
    int tracksImported = 0, tracksSkipped = 0, foldersDropped = 0;
    int notes = 0, ccEvents = 0, droppedNotes = 0, skippedMidiEvents = 0;
    int partAborts = 0, audioClips = 0, unresolvedAudio = 0, missingAudioFiles = 0;
    int insertsImported = 0, instrumentsImported = 0, instrumentTracksCreated = 0;
    int insertsSkippedNonTrack = 0, channelParseFails = 0, channelsSeen = 0;
    int routedInstruments = 0;   // SX rack instruments with >=1 routed MIDI track
    int routedMidiTracks = 0;    // MIDI tracks whose midiTarget was set to a rack track
    int mergedFeederTracks = 0;  // first feeders merged into their instrument track
    int clonedInstrumentTracks = 0; // extra N:1 feeders promoted w/ cloned chains
    int convertedMidiTracks = 0;    // unrouted MIDI tracks -> empty Instrument tracks
    int unroutedInstruments = 0; // SX rack instruments with no matching MIDI track
    int statelessPlugins = 0;
    int volumesImported = 0, pansImported = 0, gainsClamped = 0;
    int eqsImported = 0, eqsSkipped = 0; // channel EQ: mapped into Track.eq vs not decodable
    int eqTypeLogs = 0;                  // throttle for unverified-Type info logs
    int eqShapeWarns = 0;                // throttle for unverified Type->shape warnings
    int sendsSkipped = 0;                // honest count (sends not modeled in v1)
    int pannerAsymWarns = 0;             // throttle for combined-panner approximations
    int inputBusPanWarns = 0;            // throttle for unmappable input-bus pans
    bool sxPanWarned = false;             // SX pan field not identified — warn once
    bool trackCeilingWarned = false; // kMaxImportTracks reached — warn once
    double songEndBeats = 0.0;
    size_t colorIdx = 0;
    double bpm0 = 120.0; // first tempo entry (for sample->beat song-end estimate)
};

const Rec* firstRecIn(const CprCtx& c, const char* name, size_t lo, size_t hi,
                      size_t hdrAfter) {
    for (const Rec& r : c.recs)
        if (r.hdrOff >= hdrAfter && r.hdrOff >= lo && r.dataEnd <= hi && r.name == name)
            return &r;
    return nullptr;
}

// ---------------------------------------------------------------------------
// Channel volume / pan -> Track.volume (linear) / Track.pan (-1..1)
// (CPR_MIXER_FORMAT.md §1/§5: modern Volume.AnchorValue dB; SX/C5 f32 25856-taper
//  decoded via the CALIBRATED piecewise law in applyVolumeValue25856)
// ---------------------------------------------------------------------------

// Max linear gain a channel fader may set (+12 dB ≈ 3.98). Anything past this is treated as
// corrupt/out-of-range and clamped, never fabricated past a sane ceiling.
constexpr double kMaxChannelGain = 4.0;

// Apply a modern-era fader: AnchorValue is the gain in dB (byte-exact f64). Returns true if
// a finite value was applied (so callers can count it).
bool applyVolumeDb(CprCtx& c, Track& t, double db) {
    if (!std::isfinite(db))
        return false;
    double gain = std::pow(10.0, db / 20.0);
    if (!std::isfinite(gain) || gain < 0.0) {
        Log::warn("cpr import: channel '%s' volume %.3f dB decoded to non-finite gain — "
                  "left at 0 dB",
                  t.name.c_str(), db);
        return false;
    }
    if (gain > kMaxChannelGain) {
        Log::warn("cpr import: channel '%s' volume %.3f dB (%.3f linear) above +12 dB — "
                  "clamped",
                  t.name.c_str(), db, gain);
        gain = kMaxChannelGain;
        ++c.gainsClamped;
    }
    t.volume = gain;
    ++c.volumesImported;
    return true;
}

// Apply a fader from the raw 25856-based "Volume Value" taper (25856 = 0 dB). Decode law is
// the CALIBRATED Cubase fader taper — piecewise in LINEAR GAIN with round hex knots:
//   Value 32767 (0x7fff) -> gain 2.0 (+6.02 dB, fader top)   slope 1/6911 above 25856
//   Value 25856 (0x6500) -> gain 1.0 (0 dB)                  slope 1/14336 above 18688
//   Value 18688 (0x4900) -> gain 0.5                          parabola 0.5*(v/18688)^2 below
//   Value 0              -> gain 0  (-inf; modern saves mark -inf as Value -1 / Anchor -200)
// Calibrated 2026-06-12 from 700+ modern corpus (Value, AnchorValue-dB) pairs — ALL match
// this closed form to < 1e-6 dB (scripts/cpr-taper-harvest.mjs / scripts/cpr-taper.mjs,
// the single .mjs source of truth; CPR_MIXER_FORMAT.md §1/§5). The historical (Value/25856)^2
// square law is CONFIRMED WRONG (up to ~0.4 dB off near -7 dB, ~1.9 dB at the +6 dB top).
// Above 32767 (never observed) the top line extrapolates; kMaxChannelGain clamps at +12 dB.
// Used by the SX binary path AND as the Cubase-5 modern fallback (AnchorValue unpopulated).
// `era` labels logs.
bool applyVolumeValue25856(CprCtx& c, Track& t, double value, const char* era) {
    if (!std::isfinite(value))
        return false;
    if (value <= 0.0) { // fader pulled to -inf
        t.volume = 0.0;
        ++c.volumesImported;
        return true;
    }
    double gain;
    if (value >= 25856.0)
        gain = 1.0 + (value - 25856.0) / 6911.0;
    else if (value >= 18688.0)
        gain = 0.5 + (value - 18688.0) / 14336.0;
    else
        gain = 0.5 * (value / 18688.0) * (value / 18688.0);
    if (!std::isfinite(gain) || gain < 0.0)
        return false;
    if (gain > kMaxChannelGain) {
        Log::warn("cpr import: %s channel '%s' volume %.1f (%.3f linear) above +12 dB — "
                  "clamped",
                  era, t.name.c_str(), value, gain);
        gain = kMaxChannelGain;
        ++c.gainsClamped;
    }
    t.volume = gain;
    ++c.volumesImported;
    return true;
}

inline bool applySxVolumeF32(CprCtx& c, Track& t, float value) {
    return applyVolumeValue25856(c, t, static_cast<double>(value), "SX");
}

// Apply a modern-era channel fader. Volume.AnchorValue is the gain in dB and is authoritative
// when populated; Cubase 5 leaves AnchorValue at 0 and stores the fader only in Volume.Value,
// so when AnchorValue looks unpopulated (exactly 0 dB while Value is NOT the 25856 unity point)
// fall back to the calibrated 25856-taper (applyVolumeValue25856 — the two encodings agree to
// < 1e-6 dB on modern saves, so the fallback is exact). Returns true if a value was applied.
bool applyModernVolume(CprCtx& c, Track& t, bool hasAnchor, double anchorDb,
                       bool hasValue, double value) {
    const bool anchorMeaningful =
        hasAnchor && (std::fabs(anchorDb) > 1e-4 || !hasValue ||
                      std::fabs(value - 25856.0) < 1.0);
    if (anchorMeaningful)
        return applyVolumeDb(c, t, anchorDb);
    if (hasValue)
        return applyVolumeValue25856(c, t, value, "C5"); // AnchorValue unpopulated (Cubase 5)
    return false;
}

// Pan.Value (raw int -64..63) -> MyDAW pan: v<0 ? v/64 : v/63, clamped [-1,1].
double panRawToModel(int64_t v) {
    const double pan = v < 0 ? static_cast<double>(v) / 64.0 : static_cast<double>(v) / 63.0;
    return std::clamp(pan, -1.0, 1.0);
}

// Standard Panner component position (f32 0..1, 0.5 = center; Cubase UI shows
// (pos-0.5)*200) -> MyDAW pan (-1..1). See CPR_MIXER_FORMAT.md §5a.
double pannerPosToModel(double pos) {
    return std::clamp((pos - 0.5) * 2.0, -1.0, 1.0);
}

// ---------------------------------------------------------------------------
// Tempo / time signature
// ---------------------------------------------------------------------------

// MTempoTrackEvent: u32 n; n x 22B { f32 secondsPerQuarter, f64 cachedTimeSec,
// f64 positionTicks, u16 curveType }; f32 fixedModeBPM; u16 modeFlag (1 => fixed).
bool parseTempo(const CprCtx& c, const Rec& te, std::vector<TempoEntry>& out) {
    const size_t d = te.dataStart, end = te.dataEnd;
    uint32_t n = 0;
    if (!rdU32(c.b, d, end, n))
        return false;
    if (n > (end - d) / 22)
        return false;
    size_t p = d + 4;
    std::vector<TempoEntry> pts;
    for (uint32_t i = 0; i < n; ++i) {
        float spq = 0.0f;
        double ticks = 0.0;
        if (!rdF32(c.b, p, end, spq) || !rdF64(c.b, p + 12, end, ticks))
            return false;
        if (spq > 1e-6f && std::isfinite(static_cast<double>(spq)) && std::isfinite(ticks)) {
            const double bpm = std::clamp(60.0 / static_cast<double>(spq), 20.0, 400.0);
            pts.push_back(TempoEntry{std::max(0.0, ticks / kPpq), bpm});
        }
        p += 22;
    }
    float fixedBpm = 0.0f;
    uint16_t flag = 0;
    if (!rdF32(c.b, p, end, fixedBpm) || !rdU16(c.b, p + 4, end, flag))
        return false;

    if (flag == 1) { // fixed ("rehearsal") tempo mode — the tempo track is inactive
        if (!(fixedBpm >= 1.0f && fixedBpm <= 1000.0f))
            return false;
        out = {TempoEntry{0.0, std::clamp(static_cast<double>(fixedBpm), 20.0, 400.0)}};
        return true;
    }
    if (pts.empty()) {
        if (fixedBpm >= 1.0f && fixedBpm <= 1000.0f) {
            out = {TempoEntry{0.0, std::clamp(static_cast<double>(fixedBpm), 20.0, 400.0)}};
            return true;
        }
        return false;
    }
    std::stable_sort(pts.begin(), pts.end(),
                     [](const TempoEntry& a, const TempoEntry& b2) { return a.beat < b2.beat; });
    if (pts.front().beat > 1e-9)
        pts.insert(pts.begin(), TempoEntry{0.0, pts.front().bpm});
    // drop duplicate beats (keep the last entry at a position, matching Cubase override)
    std::vector<TempoEntry> dedup;
    for (const TempoEntry& e : pts) {
        if (!dedup.empty() && std::abs(dedup.back().beat - e.beat) < 1e-9)
            dedup.back() = e;
        else
            dedup.push_back(e);
    }
    out = std::move(dedup);
    return true;
}

// MSignatureTrackEvent: u32 n; n x 16B { u32 positionTicks, u16 num, u16 den, u32, u32 }.
// Ticks are converted to 0-based bar numbers walking the map itself.
bool parseSignature(const CprCtx& c, const Rec& se, std::vector<TimeSigEntry>& out) {
    const size_t d = se.dataStart, end = se.dataEnd;
    uint32_t n = 0;
    if (!rdU32(c.b, d, end, n))
        return false;
    if (n == 0 || n > (end - d) / 16)
        return false;
    size_t p = d + 4;
    std::vector<TimeSigEntry> sigs;
    double prevBeat = 0.0, bpb = 4.0;
    int prevBar = 0;
    for (uint32_t i = 0; i < n; ++i) {
        uint32_t ticks = 0;
        uint16_t num = 0, den = 0;
        if (!rdU32(c.b, p, end, ticks) || !rdU16(c.b, p + 4, end, num) ||
            !rdU16(c.b, p + 6, end, den))
            return false;
        p += 16;
        const int nNum = std::clamp(static_cast<int>(num), 1, 99);
        const int nDen = std::clamp(static_cast<int>(den), 1, 64);
        const double beat = static_cast<double>(ticks) / kPpq;
        int bar = 0;
        if (sigs.empty()) {
            bar = 0; // first entry MUST be bar 0
            if (ticks != 0)
                Log::warn("cpr import: first time-signature point at tick %u moved to bar 0",
                          ticks);
        } else {
            bar = prevBar + static_cast<int>(std::llround((beat - prevBeat) / bpb));
            if (bar <= prevBar)
                continue; // out-of-order/duplicate point — skip
        }
        sigs.push_back(TimeSigEntry{bar, nNum, nDen});
        prevBar = bar;
        prevBeat = beat;
        bpb = nNum * 4.0 / nDen;
    }
    if (sigs.empty())
        return false;
    out = std::move(sigs);
    return true;
}

// ---------------------------------------------------------------------------
// Audio clips / assets
// ---------------------------------------------------------------------------

// PAudioClip data: lpstr name; ...; children: FNPath (wav reference), AudioFile metadata.
// FNPath: lpstr fileName, 4cc, lpstr ext, lpstr ext2, lpstr typeName, u32, u32,
// lpstr directory — the directory is found by scanning for a drive-letter lpstr.
void parseAudioClipRecord(CprCtx& c, const Rec& r) {
    const uint32_t key = static_cast<uint32_t>(r.dataStart - c.base);
    if (c.clips.count(key))
        return;
    CprClipInfo info;
    info.name = readLpstr(c.b, r.dataStart, r.dataEnd).text;

    if (const Rec* fnp = firstRecIn(c, "FNPath", r.dataStart, r.dataEnd, r.dataStart + 1)) {
        info.fileName = readLpstr(c.b, fnp->dataStart, fnp->dataEnd).text;
        std::string dir;
        for (size_t p = fnp->dataStart; p + 8 < fnp->dataEnd; ++p) {
            uint32_t len = 0;
            if (!rdU32(c.b, p, fnp->dataEnd, len))
                break;
            if (len <= 4 || len >= 300 || p + 4 + len > fnp->dataEnd)
                continue;
            const LpStr s = readLpstr(c.b, p, fnp->dataEnd);
            if (s.ok && s.text.size() >= 3 &&
                ((s.text[0] >= 'A' && s.text[0] <= 'Z') || (s.text[0] >= 'a' && s.text[0] <= 'z')) &&
                s.text[1] == ':' && (s.text[2] == '\\' || s.text[2] == '/'))
                dir = s.text; // last drive-letter string wins (matches reference tool)
        }
        if (!dir.empty() && !info.fileName.empty())
            info.absPath = dir + info.fileName;
    }
    if (const Rec* af = firstRecIn(c, "AudioFile", r.dataStart, r.dataEnd, r.dataStart + 1)) {
        // AudioFile (v0 22B, v1 26B — shared prefix): u64 totalSamples, u16 bitDepth,
        // u16 bytesPerFrame, u16 channels, f32 sampleRate, ... (verified against the
        // referenced wav files: 16-bit stereo => 16/4/2, 24-bit mono => 24/3/1).
        uint64_t total = 0;
        uint16_t chans = 0;
        float sr = 0.0f;
        if (rdU64(c.b, af->dataStart, af->dataEnd, total))
            info.totalSamples = total;
        if (rdU16(c.b, af->dataStart + 12, af->dataEnd, chans) && chans >= 1 && chans <= 64)
            info.channels = chans;
        if (rdF32(c.b, af->dataStart + 14, af->dataEnd, sr) && sr >= 1000.0f && sr <= 1000000.0f)
            info.fileSr = static_cast<double>(sr);
    }
    c.clips.emplace(key, std::move(info));
}

// ASCII-lowercase a basename for case-insensitive index keys (audio file names are ASCII
// in practice; non-ASCII bytes pass through unchanged, still a consistent key).
std::string lowerAscii(std::string s) {
    for (char& ch : s)
        if (ch >= 'A' && ch <= 'Z')
            ch = static_cast<char>(ch - 'A' + 'a');
    return s;
}

bool isAudioExt(const std::string& extNoDot) {
    static const char* kAudio[] = {"wav", "aif", "aiff", "aifc", "flac",
                                   "mp3", "w64", "bwf",  "ogg",  "m4a"};
    for (const char* a : kAudio)
        if (extNoDot == a)
            return true;
    return false;
}

// Build (once per import) the recursive audio index under c.cprDir. Bounded: caps total
// files visited and directory depth; per-entry errors (permission/IO) are swallowed so the
// walk never throws out of import. First match for a given basename wins.
void buildAudioIndex(CprCtx& c) {
    if (c.audioIndexBuilt)
        return;
    c.audioIndexBuilt = true;
    if (c.cprDir.empty())
        return;

    constexpr size_t kMaxScanFiles = 200'000;
    constexpr int kMaxScanDepth = 12;
    size_t visited = 0;

    namespace fs = std::filesystem;
    std::error_code root_ec;
    const fs::path rootPath = fs::path(utf8ToWide(c.cprDir));
    if (!fs::exists(rootPath, root_ec))
        return;

    fs::recursive_directory_iterator it(
        rootPath, fs::directory_options::skip_permission_denied, root_ec);
    const fs::recursive_directory_iterator end;
    for (; it != end; it.increment(root_ec)) {
        if (root_ec) { // a bad entry: skip it, keep walking
            root_ec.clear();
            continue;
        }
        if (it.depth() > kMaxScanDepth) {
            it.disable_recursion_pending();
            continue;
        }
        if (++visited > kMaxScanFiles)
            break;

        std::error_code e;
        if (!it->is_regular_file(e) || e)
            continue;
        const std::string name = wideToUtf8(it->path().filename().wstring());
        std::string ext = fileExtension(name); // ".wav"
        if (ext.size() > 1 && ext.front() == '.')
            ext.erase(ext.begin());
        if (!isAudioExt(ext))
            continue;
        const std::string key = lowerAscii(name);
        c.audioIndex.emplace(key, wideToUtf8(it->path().wstring())); // first wins
    }
}

// Create (once) the Asset for a referenced wav: import into the project folder when one
// exists, otherwise reference the source in place; keep originalPath for relink when the
// file is missing entirely.
void ensureAsset(CprCtx& c, CprClipInfo& info) {
    if (info.assetCreated)
        return;
    info.assetCreated = true;

    std::vector<std::string> candidates;
    if (!info.absPath.empty())
        candidates.push_back(info.absPath);
    if (!info.fileName.empty()) {
        candidates.push_back(pathJoin(c.cprDir, info.fileName));
        candidates.push_back(pathJoin(pathJoin(c.cprDir, "Audio"), info.fileName));
    }
    std::string found;
    for (const std::string& cand : candidates)
        if (fileExists(cand)) {
            found = cand;
            break;
        }

    // Recursive auto-relink: the direct candidates (original path, <cprDir>/, <cprDir>/Audio/)
    // missed — scan the cpr's folder area for a file with the same basename (any subfolder).
    if (found.empty() && !info.fileName.empty()) {
        buildAudioIndex(c);
        const auto hit = c.audioIndex.find(lowerAscii(fileName(info.fileName)));
        if (hit != c.audioIndex.end()) {
            found = hit->second;
            ++c.audioResolvedByScan;
        }
    }

    Asset asset;
    asset.id = c.model.nextId(); // BEFORE importFile — enables peaks + PCM caching
    const int sessionSr = c.ictx.sessionSampleRate > 0 ? c.ictx.sessionSampleRate : 48000;
    info.scale = info.fileSr > 0.0 ? static_cast<double>(sessionSr) / info.fileSr : 1.0;

    if (!found.empty() && c.ictx.assetStore && !c.ictx.projectDirHint.empty()) {
        std::string aerr;
        Asset imported = asset;
        if (c.ictx.assetStore->importFile(found, c.ictx.projectDirHint, sessionSr, imported,
                                          aerr)) {
            info.assetId = imported.id;
            info.assetLenSamples = imported.lengthSamples;
            if (info.fileSr <= 0.0 && info.totalSamples > 0 && imported.lengthSamples > 0)
                info.scale = static_cast<double>(imported.lengthSamples) /
                             static_cast<double>(info.totalSamples);
            c.model.project.assets.push_back(std::move(imported));
            return;
        }
        Log::warn("cpr import: importFile failed for '%s' (%s) — referencing in place",
                  found.c_str(), aerr.c_str());
    }

    // In-place reference / missing-file placeholder (relinkable via originalPath).
    asset.file = "";
    asset.originalPath = !found.empty()
                             ? found
                             : (!info.absPath.empty() ? info.absPath : info.fileName);
    asset.sampleRate = sessionSr; // loadAsync resamples to Asset.sampleRate on decode
    asset.channels = info.channels > 0 ? info.channels : 2;
    asset.lengthSamples =
        info.totalSamples > 0
            ? static_cast<int64_t>(std::llround(static_cast<double>(info.totalSamples) *
                                                info.scale))
            : 0;
    asset.missing = found.empty();
    if (asset.missing) {
        ++c.missingAudioFiles;
        Log::warn("cpr import: audio file not found: '%s' (clip '%s') — kept as missing asset",
                  asset.originalPath.c_str(), info.name.c_str());
    }
    info.assetId = asset.id;
    info.assetLenSamples = asset.lengthSamples;
    c.model.project.assets.push_back(std::move(asset));
}

// MAudioEvent data: u16 flags, f64 startTick, f64 lengthSamples, f64 offsetSamples, then
// at +26 the clip link: u32 >= 0x80000000 => inline PAudioClip record (first use), else
// u32 clipId = (clip record dataStart) - (archDataOff + 4). addTicks shifts events that
// live inside an MAudioPartEvent (their startTick is part-content-relative).
void importAudioEvent(CprCtx& c, const Rec& ae, Track& t, double addTicks) {
    const size_t d = ae.dataStart, end = ae.dataEnd;
    double startTick = 0.0, lenSamp = 0.0, offSamp = 0.0;
    uint32_t link = 0;
    if (!rdF64(c.b, d + 2, end, startTick) || !rdF64(c.b, d + 10, end, lenSamp) ||
        !rdF64(c.b, d + 18, end, offSamp) || !rdU32(c.b, d + 26, end, link)) {
        ++c.unresolvedAudio;
        return;
    }
    if (!std::isfinite(startTick) || !std::isfinite(lenSamp) || !std::isfinite(offSamp)) {
        ++c.unresolvedAudio;
        return;
    }

    CprClipInfo* info = nullptr;
    if (link < 0x80000000u) {
        auto it = c.clips.find(link);
        if (it != c.clips.end())
            info = &it->second;
    } else if (const Rec* cr = firstRecIn(c, "PAudioClip", d + 26, end, d + 26)) {
        auto it = c.clips.find(static_cast<uint32_t>(cr->dataStart - c.base));
        if (it != c.clips.end())
            info = &it->second;
    }
    if (!info) {
        ++c.unresolvedAudio;
        Log::warn("cpr import: audio event on track '%s' references an unknown clip — skipped",
                  t.name.c_str());
        return;
    }
    ensureAsset(c, *info);

    AudioClip clip;
    clip.id = c.model.nextId();
    clip.name = !info->name.empty()
                    ? info->name
                    : (!info->fileName.empty() ? fileStem(info->fileName) : t.name);
    clip.startBeat = std::max(0.0, (startTick + addTicks) / kPpq);
    clip.assetId = info->assetId;
    clip.srcOffsetSamples = static_cast<int64_t>(std::llround(std::max(0.0, offSamp) * info->scale));
    clip.lengthSamples = static_cast<int64_t>(std::llround(std::max(0.0, lenSamp) * info->scale));
    if (info->assetLenSamples > 0) {
        clip.srcOffsetSamples = std::min(clip.srcOffsetSamples, info->assetLenSamples);
        clip.lengthSamples =
            std::min(clip.lengthSamples, info->assetLenSamples - clip.srcOffsetSamples);
    }
    clip.gain = 1.0;

    const int sessionSr = c.ictx.sessionSampleRate > 0 ? c.ictx.sessionSampleRate : 48000;
    const double lenBeats = static_cast<double>(clip.lengthSamples) / sessionSr * c.bpm0 / 60.0;
    c.songEndBeats = std::max(c.songEndBeats, clip.startBeat + lenBeats);
    ++c.audioClips;
    t.clips.emplace_back(std::move(clip));
}

// ---------------------------------------------------------------------------
// MIDI parts
// ---------------------------------------------------------------------------

// MMidiPartEvent data: u16 flags, f64 startTick, f64 lengthTicks, f64 offsetTick, then a
// nested MMidiPart record: lpstr name, u32, u32, u32, u32 eventCount,
// [u8 nReg + nReg empty class-registry records when eventCount > 0], then the stream.
// Absolute event time = part.startTick + (event.tick - part.offsetTick).
void importMidiPart(CprCtx& c, const Rec& pe, Track& t) {
    const size_t d = pe.dataStart, end = pe.dataEnd;
    double startTick = 0.0, lengthTicks = 0.0, offsetTick = 0.0;
    if (!rdF64(c.b, d + 2, end, startTick) || !rdF64(c.b, d + 10, end, lengthTicks) ||
        !rdF64(c.b, d + 18, end, offsetTick) || !std::isfinite(startTick) ||
        !std::isfinite(lengthTicks) || !std::isfinite(offsetTick)) {
        Log::warn("cpr import: malformed MIDI part header on track '%s' — skipped",
                  t.name.c_str());
        return;
    }

    MidiClip clip;
    clip.id = c.model.nextId();
    clip.name = t.name;
    clip.startBeat = std::max(0.0, startTick / kPpq);
    clip.lengthBeats = std::max(lengthTicks / kPpq, 0.25);

    const Rec* mp = nullptr;
    for (const Rec& r : c.recs)
        if (r.name == "MMidiPart" && r.hdrOff >= d + 26 && r.hdrOff < end && r.dataEnd <= end) {
            mp = &r;
            break;
        }
    if (mp) {
        size_t p = mp->dataStart;
        const size_t pend = mp->dataEnd;
        const LpStr nm = readLpstr(c.b, p, pend);
        bool ok = nm.ok;
        if (ok && !nm.text.empty())
            clip.name = nm.text;
        p = nm.next;
        uint32_t evCount = 0;
        ok = ok && rdU32(c.b, p + 12, pend, evCount);
        p += 16;
        if (ok && evCount > 0) {
            // registry-count byte is absent when the part is empty
            uint8_t nReg = 0;
            ok = rdU8(c.b, p, pend, nReg);
            p += 1;
            for (uint8_t i = 0; ok && i < nReg; ++i) {
                // each registry entry is itself an (empty) archive record — skip it
                uint32_t v = 0;
                ok = rdU32(c.b, p, pend, v);
                if (!ok)
                    break;
                if (v == 0xFFFFFFFEu || v == 0xFFFFFFFFu) {
                    int guard = 0;
                    while (ok && rdU32(c.b, p, pend, v) && v == 0xFFFFFFFEu) {
                        if (++guard > 16) { ok = false; break; }
                        uint32_t w = 0;
                        ok = rdU32(c.b, p + 4, pend, w);
                        if (!ok)
                            break;
                        if (w >= 0x80000000u)
                            p += 8;
                        else {
                            if (w < 2 || w > 100 || p + 8 + w + 2 > pend) { ok = false; break; }
                            p += 4 + 4 + w + 2;
                        }
                    }
                    if (!ok)
                        break;
                    uint32_t w = 0, sz = 0;
                    ok = rdU32(c.b, p + 4, pend, w);
                    if (!ok)
                        break;
                    if (w >= 0x80000000u) {
                        ok = rdU32(c.b, p + 8, pend, sz);
                        p += 12 + sz;
                    } else {
                        if (w < 2 || w > 100 || p + 8 + w + 2 + 4 > pend) { ok = false; break; }
                        ok = rdU32(c.b, p + 8 + w + 2, pend, sz);
                        p += 4 + 4 + w + 2 + 4 + sz;
                    }
                } else if (v >= 0x80000000u) {
                    uint32_t sz = 0;
                    ok = rdU32(c.b, p + 4, pend, sz);
                    p += 8 + sz;
                } else {
                    ok = false;
                }
                if (p > pend)
                    ok = false;
            }
        }
        if (!ok) {
            ++c.partAborts;
            Log::warn("cpr import: cannot parse MIDI part header '%s' on track '%s' — part "
                      "imported empty",
                      clip.name.c_str(), t.name.c_str());
            evCount = 0;
        }
        if (evCount > (pend > p ? (pend - p) / 18 + 1 : 0)) {
            Log::warn("cpr import: implausible event count %u in part '%s' — clamped",
                      evCount, clip.name.c_str());
            evCount = pend > p ? static_cast<uint32_t>((pend - p) / 18 + 1) : 0;
        }
        for (uint32_t i = 0; i < evCount; ++i) {
            if (p >= pend) {
                ++c.partAborts;
                Log::warn("cpr import: event stream overrun in part '%s' at event %u/%u — "
                          "remaining events skipped",
                          clip.name.c_str(), i, evCount);
                break;
            }
            StreamEv ev;
            if (!readStreamEvent(c.b, p, pend, c.names, ev)) {
                ++c.partAborts;
                Log::warn("cpr import: undecodable event (tag 0x%02x) in part '%s' at event "
                          "%u/%u — remaining events skipped",
                          c.b[p], clip.name.c_str(), i, evCount);
                break;
            }
            const double relTick = ev.tick - offsetTick;
            if (ev.kind == StreamEv::Note) {
                if (relTick < -1.0) { // hidden: starts before the (trimmed) part
                    ++c.droppedNotes;
                } else if (ev.d1 <= 127) {
                    Note n;
                    n.id = c.model.nextId();
                    n.pitch = std::clamp(static_cast<int>(ev.d1), 0, 127);
                    n.velocity = std::clamp(static_cast<int>(ev.d2), 1, 127);
                    n.startBeat = std::max(0.0, relTick) / kPpq;
                    n.lengthBeats = std::max(ev.lenTicks / kPpq, 1.0 / kPpq);
                    n.channel = ev.ch & 0x0F;
                    clip.lengthBeats = std::max(clip.lengthBeats, n.startBeat + n.lengthBeats);
                    clip.notes.push_back(n);
                    ++c.notes;
                }
            } else if (ev.kind == StreamEv::Short && relTick >= -1.0) {
                MidiCc cc;
                cc.id = 0; // assigned below only if kept
                cc.beat = std::max(0.0, relTick) / kPpq;
                bool keep = true;
                if (ev.tag == 0xB0) { // controller
                    cc.controller = std::clamp(static_cast<int>(ev.d1), 0, 127);
                    cc.value = std::clamp(ev.d2 / 127.0, 0.0, 1.0);
                } else if (ev.tag == 0xE0) { // pitch bend: d1=LSB, d2=MSB -> 14-bit 0..1
                    cc.controller = 128;
                    const int v14 = ((ev.d2 & 0x7F) << 7) | (ev.d1 & 0x7F);
                    cc.value = std::clamp(v14 / 16383.0, 0.0, 1.0);
                } else if (ev.tag == 0xD0) { // channel aftertouch
                    cc.controller = 129;
                    cc.value = std::clamp(ev.d1 / 127.0, 0.0, 1.0);
                } else {
                    keep = false; // program change / poly pressure: no model representation
                    ++c.skippedMidiEvents;
                }
                if (keep) {
                    cc.id = c.model.nextId();
                    clip.lengthBeats = std::max(clip.lengthBeats, cc.beat);
                    clip.cc.push_back(cc);
                    ++c.ccEvents;
                }
            } else if (ev.kind == StreamEv::Skip) {
                ++c.skippedMidiEvents;
            } else {
                ++c.skippedMidiEvents; // short event hidden before part start
            }
            p = ev.next;
        }
    } else {
        Log::warn("cpr import: MIDI part without MMidiPart payload on track '%s'",
                  t.name.c_str());
    }

    std::stable_sort(clip.notes.begin(), clip.notes.end(),
                     [](const Note& a, const Note& b2) { return a.startBeat < b2.startBeat; });
    std::stable_sort(clip.cc.begin(), clip.cc.end(), [](const MidiCc& a, const MidiCc& b2) {
        return a.controller != b2.controller ? a.controller < b2.controller : a.beat < b2.beat;
    });
    c.songEndBeats = std::max(c.songEndBeats, clip.startBeat + clip.lengthBeats);
    t.clips.emplace_back(std::move(clip));
}

// ---------------------------------------------------------------------------
// Track tree
// ---------------------------------------------------------------------------

enum class CprTrackKind { Midi, Instrument, Audio, Folder, Skip };

CprTrackKind classifyTrack(const std::string& cls) {
    if (cls == "MMidiTrackEvent")
        return CprTrackKind::Midi;
    if (cls == "MInstrumentTrackEvent") // Cubase 4+: carries its VSTi in a "Synth Slot"
        return CprTrackKind::Instrument;
    if (cls == "MAudioTrackEvent")
        return CprTrackKind::Audio;
    if (cls == "MFolderTrack")
        return CprTrackKind::Folder;
    // MDeviceTrackEvent (device/FX/group channels), MPlayRangeTrackEvent (arranger),
    // MMarkerTrackEvent (all corpus marker tracks are empty), MVideoTrackEvent, ...
    return CprTrackKind::Skip;
}

bool isTrackRecord(const std::string& n) {
    if (n == "MFolderTrack")
        return true;
    if (n.size() < 10 || n.compare(n.size() - 10, 10, "TrackEvent") != 0)
        return false;
    return n != "MTempoTrackEvent" && n != "MSignatureTrackEvent" &&
           n != "MAutomationTrackEvent";
}

// Decode an SX MIDI track's output routing (CPR_MIXER_FORMAT.md §7.7). The "Track Device"
// sub-object is the direct-child MMidiTrack record of the MMidiTrackEvent; its body is:
//   u16 connectionType(=3), lpstr Device Name, <3 B pad>, lpstr Port Name,
//   u16 inputType(=3), lpstr Input Device Name, u16 0x0002, lpstr Input Port Name,
//   u32 Midi Channel, ... (then the PMixerChannel/PDevice sub-tree)
// Device Name = the target rack-instrument name (the routing key). Both Device Name and the
// MIDI channel decode byte-exact on the corpus oracle. Modern MInstrumentTrackEvent files are
// self-contained and never reach this path.
void decodeSxMidiRoute(CprCtx& c, const Rec& mte, std::string& deviceOut, int& channelOut) {
    deviceOut.clear();
    channelOut = -1;
    // The MMidiTrack "Track Device" object is the first MMidiTrack inside the MMidiTrackEvent.
    const Rec* mt = nullptr;
    for (const Rec& r : c.recs)
        if (r.name == "MMidiTrack" && r.hdrOff > mte.dataStart && r.dataEnd <= mte.dataEnd) {
            mt = &r;
            break;
        }
    if (!mt)
        return;
    const size_t hi = mt->dataEnd;
    size_t p = mt->dataStart;
    uint16_t connType = 0;
    if (!rdU16(c.b, p, hi, connType))
        return;
    p += 2;
    // Device Name = first lpstr (the output instrument).
    const LpStr dev = readLpstr(c.b, p, hi);
    if (!dev.ok || dev.text.empty())
        return;
    deviceOut = dev.text;

    // Best-effort MIDI channel (structural, byte-verified on jazz with omri.cpr). After the
    // Device Name the input section is:
    //   Port Name (lpstr, == device, after a 3-byte pad), u16 inputType(=3),
    //   Input Device Name (lpstr), u16 0x0002, Input Port Name (lpstr), u32 Midi Channel.
    // i.e. the Midi Channel is the u32 directly after the SECOND input-section lpstr (Input
    // Port Name). We skip the Port Name, take the next two printable lpstrs (Input Device Name,
    // Input Port Name), and read the u32 after the second. Channel stays -1 if the layout
    // doesn't validate — the device name is the essential routing key and is already captured.
    auto firstStrFrom = [&](size_t from, size_t window) -> LpStr {
        for (size_t s = from; s + 4 <= hi && s <= from + window; ++s) {
            const LpStr v = readLpstr(c.b, s, hi);
            if (v.ok && v.text.size() >= 3) {
                bool printable = true;
                for (char ch : v.text)
                    if (static_cast<unsigned char>(ch) < 0x20) { printable = false; break; }
                if (printable)
                    return v;
            }
        }
        return LpStr{};
    };
    size_t q = dev.next;
    for (size_t s = q; s + 4 <= hi && s <= q + 8; ++s) { // skip Port Name (== device)
        const LpStr port = readLpstr(c.b, s, hi);
        if (port.ok && port.text == deviceOut) {
            q = port.next;
            break;
        }
    }
    const LpStr inDev = firstStrFrom(q, 8);            // Input Device Name
    const LpStr inPort = inDev.ok ? firstStrFrom(inDev.next, 8) : LpStr{}; // Input Port Name
    uint32_t ch = 0;
    if (inPort.ok && rdU32(c.b, inPort.next, hi, ch) && ch <= 15)
        channelOut = static_cast<int>(ch);
}

// Iterate top-level track records in [rangeStart, rangeEnd) by byte-range containment
// (a cursor skips records nested inside a previously consumed track). Folders recurse.
void buildTracks(CprCtx& c, const std::vector<const Rec*>& trackRecs, size_t rangeStart,
                 size_t rangeEnd, uint64_t parentId, int depth) {
    if (depth > 16)
        return;
    size_t pos = rangeStart;
    for (const Rec* k : trackRecs) {
        if (k->hdrOff < pos || k->dataEnd > rangeEnd)
            continue;
        pos = k->dataEnd;

        const CprTrackKind kind = classifyTrack(k->name);
        if (kind == CprTrackKind::Skip) {
            ++c.tracksSkipped;
            c.trackSpans.push_back(TrackSpan{k->dataStart, k->dataEnd, 0});
            continue;
        }

        // Track name: first MListNode (non-folder) / MTrackList (folder) inside.
        std::string name;
        for (const Rec& r : c.recs) {
            if (r.hdrOff > k->dataStart && r.dataEnd <= k->dataEnd &&
                (r.name == "MListNode" || r.name == "MTrackList")) {
                name = readLpstr(c.b, r.dataStart, r.dataEnd).text;
                break;
            }
        }

        // MyDAW's own .cpr exports rename the donor's tempo-carrier track to this
        // sentinel — it exists only because Cubase refuses a trackless project. Skip
        // it so a MyDAW->cpr->MyDAW round-trip doesn't grow a ghost audio track.
        if (kind == CprTrackKind::Audio && name == "~MyDAW") {
            ++c.tracksSkipped;
            c.trackSpans.push_back(TrackSpan{k->dataStart, k->dataEnd, 0});
            continue;
        }

        Track t;
        t.id = c.model.nextId();
        t.parentId = parentId;
        t.color = kTrackColors[c.colorIdx++ % kNumTrackColors];

        if (kind == CprTrackKind::Folder) {
            t.kind = TrackKind::Folder;
            t.name = !name.empty() ? name : "Folder";
            const uint64_t folderId = t.id;
            c.trackSpans.push_back(TrackSpan{k->dataStart, k->dataEnd, 0}); // no inserts
            c.model.project.tracks.push_back(std::move(t));
            const size_t before = c.model.project.tracks.size();
            buildTracks(c, trackRecs, k->dataStart, k->dataEnd, folderId, depth + 1);
            if (c.model.project.tracks.size() == before) {
                // Nothing importable inside (e.g. Cubase device/IO folders) — drop it.
                c.model.project.tracks.pop_back();
                ++c.foldersDropped;
            } else {
                ++c.tracksImported;
            }
            continue;
        }

        if (kind == CprTrackKind::Midi || kind == CprTrackKind::Instrument) {
            t.kind = kind == CprTrackKind::Instrument ? TrackKind::Instrument
                                                      : TrackKind::Midi;
            t.name = !name.empty()
                         ? name
                         : ("Track " + std::to_string(c.tracksImported + 1));
            for (const Rec& r : c.recs)
                if (r.name == "MMidiPartEvent" && r.hdrOff > k->dataStart &&
                    r.dataEnd <= k->dataEnd)
                    importMidiPart(c, r, t);
            // SX MIDI tracks route to a rack instrument by output Device Name (the rack
            // instrument lives in the Devices "VST Mixer" blob). Capture the routing now
            // so sxExtractVstiRack can point THIS track's midiTarget at the instrument's
            // standalone track. Modern MInstrumentTrackEvent tracks are self-contained —
            // skip the decode there.
            if (c.isSxEra && kind == CprTrackKind::Midi) {
                std::string device;
                int channel = -1;
                decodeSxMidiRoute(c, *k, device, channel);
                if (!device.empty())
                    c.midiRoutes.push_back(CprCtx::MidiRoute{t.id, device, channel});
            }
        } else { // Audio
            t.kind = TrackKind::Audio;
            t.name = !name.empty()
                         ? name
                         : ("Track " + std::to_string(c.tracksImported + 1));
            // Audio parts group events; events inside one are part-content-relative.
            std::vector<const Rec*> parts;
            for (const Rec& r : c.recs)
                if (r.name == "MAudioPartEvent" && r.hdrOff > k->dataStart &&
                    r.dataEnd <= k->dataEnd)
                    parts.push_back(&r);
            for (const Rec& r : c.recs) {
                if (r.name != "MAudioEvent" || r.hdrOff <= k->dataStart ||
                    r.dataEnd > k->dataEnd)
                    continue;
                double addTicks = 0.0;
                for (const Rec* pp : parts) {
                    if (r.hdrOff > pp->dataStart && r.dataEnd <= pp->dataEnd) {
                        double ps = 0.0, po = 0.0;
                        if (rdF64(c.b, pp->dataStart + 2, pp->dataEnd, ps) &&
                            rdF64(c.b, pp->dataStart + 18, pp->dataEnd, po) &&
                            std::isfinite(ps) && std::isfinite(po))
                            addTicks = ps - po;
                        break;
                    }
                }
                importAudioEvent(c, r, t, addTicks);
            }
        }

        std::stable_sort(t.clips.begin(), t.clips.end(), [](const Clip& a, const Clip& b2) {
            return clipStartBeat(a) < clipStartBeat(b2);
        });
        c.trackSpans.push_back(TrackSpan{k->dataStart, k->dataEnd, t.id});
        c.model.project.tracks.push_back(std::move(t));
        ++c.tracksImported;
    }
}

// Innermost track record containing `off`; returns the model track id (0 = none/skipped).
uint64_t trackForOffset(const CprCtx& c, size_t off) {
    const TrackSpan* best = nullptr;
    for (const TrackSpan& s : c.trackSpans)
        if (off >= s.lo && off < s.hi && (!best || s.hi - s.lo < best->hi - best->lo))
            best = &s;
    return best ? best->trackId : 0;
}

// ===========================================================================
// Plugin insert / instrument extraction (docs/CPR_MIXER_FORMAT.md)
// ===========================================================================
//
// Plugins are imported as DORMANT PluginInstance inserts: identity (uid/format/name) +
// state chunk, but NO path — nothing is loaded at import time. project/getUnresolvedPlugins
// lists them and plugins/recreate resolves them against the live PluginRegistry (SPEC
// §5.6). State bytes are stored in ImportContext::pluginStates in the exact form the
// plugin host's setState expects:
//   vst2 chunked (FBCh)  -> the inner opaque chunk (Vst2Host::setState -> effSetChunk raw)
//   vst2 param  (FxBk)   -> NO chunk; PluginInstance::paramValues from program-0 params
//   vst3                 -> 'MD3S' container (component + controller state, Vst3Utils.h)

// One extracted plugin, identity-normalized to PluginRegistry uid format.
struct XPlugin {
    std::string format;  // "vst2" | "vst3"
    std::string uid;     // vst2: decimal uniqueID; vst3: class GUID (32 uppercase hex)
    std::string name;
    // SX VSTi-rack slot-tail displayName (CPR_MIXER_FORMAT.md §2/§7.7). For a rack instrument
    // this carries the DISAMBIGUATED device name MIDI tracks route to ("PS03 - Drums&Percs 2"),
    // whereas `name` is the bare plugin display name (all duplicates share it). Empty = use name.
    std::string routeName;
    std::string version; // modern per-plugin Version key ("" = unknown)
    std::vector<uint8_t> state; // host-ready setState bytes (empty = none)
    std::map<uint32_t, double> paramValues; // FxBk fallback
    bool valid() const { return !uid.empty() && !format.empty(); }
};

// SX empty-audio-insert placeholder idString prefix (CPR_MIXER_FORMAT.md §3).
constexpr const char* kSxPlaceholderId = "22334455";

std::string trimSpaces(const std::string& s) {
    size_t a = 0, b2 = s.size();
    while (a < b2 && (s[a] == ' ' || s[a] == '\t')) ++a;
    while (b2 > a && (s[b2 - 1] == ' ' || s[b2 - 1] == '\t')) --b2;
    return s.substr(a, b2 - a);
}

// ----- VST2 .fxb image (big-endian, CPR_MIXER_FORMAT.md §4) -----------------
// ck points at 'CcnK'; stateEnd bounds the image. Fills state/paramValues and the
// authoritative fxID. Unknown fxMagic: no state (storing a raw fxb image would feed
// effSetChunk garbage with the wrong framing).
bool fxbExtract(const std::vector<uint8_t>& b, size_t ck, size_t stateEnd, XPlugin& out,
                uint32_t& fxIdOut) {
    if (ck + 160 > stateEnd || std::memcmp(b.data() + ck, "CcnK", 4) != 0)
        return false;
    uint32_t fxId = 0;
    if (!rdU32(b, ck + 16, stateEnd, fxId))
        return false;
    fxIdOut = fxId;
    char magic[5] = {};
    std::memcpy(magic, b.data() + ck + 8, 4);
    if (std::memcmp(magic, "FBCh", 4) == 0) {
        uint32_t chunkSize = 0;
        if (!rdU32(b, ck + 156, stateEnd, chunkSize))
            return true; // identity still valid, state unusable
        const size_t chunkEnd = ck + 160 + chunkSize;
        if (chunkEnd > stateEnd) {
            // A truncated opaque chunk is exactly the effSetChunk garbage we must never
            // store: a partial chunk fed to effSetChunk corrupts the plugin. Drop the
            // state entirely; identity stays valid so the insert is still recreatable.
            Log::warn("cpr import: FBCh chunk size %u overruns state (%zu avail) — "
                      "state dropped (no partial chunk)",
                      chunkSize, stateEnd - (ck + 160));
            return true;
        }
        if (chunkEnd > ck + 160)
            out.state.assign(b.begin() + static_cast<ptrdiff_t>(ck + 160),
                             b.begin() + static_cast<ptrdiff_t>(chunkEnd));
        return true;
    }
    if (std::memcmp(magic, "FxBk", 4) == 0) {
        // Program 0 record at +156: 'CcnK' u32 byteSize 'FxCk' u32 ver u32 fxID
        // u32 fxVersion u32 numParams char[28] name f32be params[].
        const size_t pr = ck + 156;
        uint32_t numParams = 0;
        if (pr + 56 <= stateEnd && std::memcmp(b.data() + pr, "CcnK", 4) == 0 &&
            std::memcmp(b.data() + pr + 8, "FxCk", 4) == 0 &&
            rdU32(b, pr + 24, stateEnd, numParams) && numParams <= 4096 &&
            pr + 56 + 4ull * numParams <= stateEnd) {
            for (uint32_t i = 0; i < numParams; ++i) {
                float v = 0.0f;
                if (rdF32(b, pr + 56 + 4ull * i, stateEnd, v) && std::isfinite(v))
                    out.paramValues[i] = std::clamp(static_cast<double>(v), 0.0, 1.0);
            }
        } else {
            Log::warn("cpr import: malformed FxBk program record — parameters not imported");
        }
        return true;
    }
    Log::warn("cpr import: unknown fx state magic '%.4s' — state not imported", magic);
    return true;
}

// ----- identity helpers ------------------------------------------------------
// SX idString "11"+%08X is the byte-swapped (LE memory order) uniqueID; the fxb fxID is
// authoritative when present (both verified equal across the corpus).
uint32_t sxUidFromIdString(const std::string& id) {
    if (id.size() < 10 || id.compare(0, 2, "11") != 0)
        return 0;
    uint32_t v = 0;
    for (int i = 0; i < 8; ++i) {
        const char ch = id[2 + static_cast<size_t>(i)];
        uint32_t d = 0;
        if (ch >= '0' && ch <= '9') d = static_cast<uint32_t>(ch - '0');
        else if (ch >= 'A' && ch <= 'F') d = static_cast<uint32_t>(ch - 'A' + 10);
        else if (ch >= 'a' && ch <= 'f') d = static_cast<uint32_t>(ch - 'a' + 10);
        else return 0;
        v = (v << 4) | d;
    }
    // hex shows LE memory order -> swap to the native big-endian uniqueID
    return ((v & 0xFFu) << 24) | ((v & 0xFF00u) << 8) | ((v >> 8) & 0xFF00u) | (v >> 24);
}

bool hexNibble(char c, uint8_t& out) {
    if (c >= '0' && c <= '9') { out = static_cast<uint8_t>(c - '0'); return true; }
    if (c >= 'A' && c <= 'F') { out = static_cast<uint8_t>(c - 'A' + 10); return true; }
    if (c >= 'a' && c <= 'f') { out = static_cast<uint8_t>(c - 'a' + 10); return true; }
    return false;
}

// Modern Plugin UID GUID (32 hex chars). Wrapped VST2 = 'VST'+fourcc+name bytes -> vst2
// decimal uid; anything else = real VST3 class GUID, passed through normalized (uppercase
// hex — the corpus GUIDs are valid v4 UUIDs as written, i.e. already in the COM string
// form VST3::UID::toString() produces on Windows, which is what PluginRegistry stores).
bool identityFromGuid(const std::string& guid, XPlugin& out) {
    if (guid.size() != 32)
        return false;
    uint8_t bytes[16] = {};
    for (int i = 0; i < 16; ++i) {
        uint8_t hi = 0, lo = 0;
        if (!hexNibble(guid[2 * static_cast<size_t>(i)], hi) ||
            !hexNibble(guid[2 * static_cast<size_t>(i) + 1], lo))
            return false;
        bytes[i] = static_cast<uint8_t>((hi << 4) | lo);
    }
    if (bytes[0] == 'V' && bytes[1] == 'S' && bytes[2] == 'T') {
        const uint32_t fourcc = (static_cast<uint32_t>(bytes[3]) << 24) |
                                (static_cast<uint32_t>(bytes[4]) << 16) |
                                (static_cast<uint32_t>(bytes[5]) << 8) |
                                static_cast<uint32_t>(bytes[6]);
        out.format = "vst2";
        // Registry stores std::to_string(VstInt32 uniqueID) — the SIGNED int32 decimal
        // (Vst2Host.cpp:665). Emit the same signed form so PluginRegistry::byUid's exact
        // string compare matches plugins whose uniqueID has the high bit set.
        out.uid = std::to_string(static_cast<int32_t>(fourcc));
        return true;
    }
    out.format = "vst3";
    out.uid.reserve(32);
    for (char ch : guid)
        out.uid.push_back(ch >= 'a' && ch <= 'z' ? static_cast<char>(ch - 'a' + 'A') : ch);
    return true;
}

// 'MD3S' container expected by Vst3Host::setState (plugin-host/src/Vst3Utils.h):
// u32le magic + u32le lenA + component + u32le lenB + controller.
std::vector<uint8_t> packMd3s(const uint8_t* comp, uint32_t compLen, const uint8_t* ctrl,
                              uint32_t ctrlLen) {
    std::vector<uint8_t> out;
    out.reserve(12u + compLen + ctrlLen);
    auto pushLe = [&out](uint32_t v) {
        out.push_back(static_cast<uint8_t>(v));
        out.push_back(static_cast<uint8_t>(v >> 8));
        out.push_back(static_cast<uint8_t>(v >> 16));
        out.push_back(static_cast<uint8_t>(v >> 24));
    };
    pushLe(0x5333444Du); // "MD3S" in memory
    pushLe(compLen);
    if (compLen)
        out.insert(out.end(), comp, comp + compLen);
    pushLe(ctrlLen);
    if (ctrlLen)
        out.insert(out.end(), ctrl, ctrl + ctrlLen);
    return out;
}

// ----- model attach ----------------------------------------------------------

void addDormantInsert(CprCtx& c, Track& t, XPlugin&& xp, bool isInstrument) {
    PluginInstance pi;
    pi.instanceId = c.model.nextId();
    pi.uid = xp.uid;
    pi.format = xp.format;
    pi.path = ""; // dormant — resolved from the registry by plugins/recreate
    pi.bitness = c.isSxEra ? 32 : 64; // era default; refreshed from registry at recreation
    pi.name = !xp.name.empty() ? xp.name
                               : (xp.format + " " + xp.uid);
    pi.version = xp.version; // exact plugin version when the source recorded it ("" = unknown)
    pi.sourceHint = c.sourceHint; // source-project provenance for the Recreate dialog
    pi.paramValues = std::move(xp.paramValues);
    if (!xp.state.empty()) {
        if (c.ictx.pluginStates)
            (*c.ictx.pluginStates)[pi.instanceId] = std::move(xp.state);
        else
            Log::warn("cpr import: no pluginStates sink — state of '%s' dropped",
                      pi.name.c_str());
    } else if (pi.paramValues.empty()) {
        ++c.statelessPlugins;
    }
    if (isInstrument)
        ++c.instrumentsImported;
    else
        ++c.insertsImported;
    t.inserts.push_back(std::move(pi));
}

// Trim + collapse internal whitespace + lowercase, for the routing name-match fallback.
std::string normalizeName(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    bool prevSpace = false;
    for (char ch : trimSpaces(s)) {
        const char lc = (ch >= 'A' && ch <= 'Z') ? static_cast<char>(ch - 'A' + 'a') : ch;
        if (lc == ' ' || lc == '\t') {
            if (!prevSpace) out.push_back(' ');
            prevSpace = true;
        } else {
            out.push_back(lc);
            prevSpace = false;
        }
    }
    return out;
}

// All imported MIDI tracks that route to `instrument` (output Device Name), in import order.
// Exact match first; if none, a normalized (trim/case/whitespace) match. Each route is
// consumed at most once (consumed[] guards against re-routing the same track to two slots).
std::vector<uint64_t> routedMidiTracksFor(CprCtx& c, const std::string& instrument,
                                          std::vector<bool>& consumed) {
    std::vector<uint64_t> exact, fuzzy;
    const std::string norm = normalizeName(instrument);
    for (size_t i = 0; i < c.midiRoutes.size(); ++i) {
        if (consumed[i])
            continue;
        if (c.midiRoutes[i].device == instrument)
            exact.push_back(i);
        else if (normalizeName(c.midiRoutes[i].device) == norm)
            fuzzy.push_back(i);
    }
    std::vector<uint64_t>& pick = !exact.empty() ? exact : fuzzy;
    std::vector<uint64_t> ids;
    for (uint64_t idx : pick) {
        consumed[idx] = true;
        ids.push_back(c.midiRoutes[idx].trackId);
    }
    return ids;
}

// EVERY rack instrument becomes exactly one fresh Instrument-kind track (no clips)
// carrying the dormant instrument insert (+ its output-channel inserts) — one shared
// VSTi instance. Routed MIDI tracks then point Track::midiTarget at it
// (CPR_MIXER_FORMAT.md §7.7); unrouted instruments keep the standalone track and warn.
// Returns nullptr when the global import-track ceiling is reached; callers must stop
// creating tracks. The pointer is invalidated by a later push_back — re-resolve by id.
Track* createInstrumentTrack(CprCtx& c, const std::string& name) {
    if (c.model.project.tracks.size() >= kMaxImportTracks) {
        if (!c.trackCeilingWarned) {
            c.trackCeilingWarned = true;
            Log::warn("cpr import: import-track ceiling (%zu) reached — remaining racked "
                      "instruments dropped",
                      kMaxImportTracks);
        }
        return nullptr;
    }
    Track t;
    t.id = c.model.nextId();
    t.kind = TrackKind::Instrument;
    t.name = !name.empty() ? name : "Instrument";
    t.color = kTrackColors[c.colorIdx++ % kNumTrackColors];
    c.model.project.tracks.push_back(std::move(t));
    ++c.instrumentTracksCreated;
    ++c.tracksImported;
    return &c.model.project.tracks.back();
}

// ---------------------------------------------------------------------------
// SX era (CPR_MIXER_FORMAT.md §1-§4)
// ---------------------------------------------------------------------------

// Parse one SX insert slot at `p` (u32 tag=2, u32 payloadSize, payload). Returns the
// offset after the slot, or 0 on structural failure. Loaded slots append to `out`.
size_t sxParseSlot(CprCtx& c, size_t p, size_t end, std::vector<XPlugin>& out) {
    uint32_t tag = 0, size = 0;
    if (!rdU32(c.b, p, end, tag) || !rdU32(c.b, p + 4, end, size) || tag != 2)
        return 0;
    const size_t pay = p + 8, payEnd = pay + size;
    if (size < 9 || payEnd > end)
        return 0;
    uint16_t occupied = 0;
    if (size == 9 || !rdU16(c.b, pay, payEnd, occupied) || occupied != 1)
        return payEnd; // empty slot
    const LpStr id = readLpstr(c.b, pay + 2, payEnd);
    if (!id.ok || id.text.size() < 10 ||
        id.text.compare(0, 8, kSxPlaceholderId) == 0)
        return payEnd;
    XPlugin xp;
    xp.format = "vst2";
    if (id.text.size() > 34)
        xp.name = trimSpaces(id.text.substr(34));
    // State: u32 stateLen directly precedes the 'CcnK' fxb image; the pre-state field
    // count differs across saves (12-13 B), so anchor on 'CcnK' within a small window.
    uint32_t fxId = 0;
    size_t ck = 0;
    for (size_t s = id.next; s + 4 <= payEnd && s <= id.next + 24; ++s)
        if (std::memcmp(c.b.data() + s, "CcnK", 4) == 0) {
            ck = s;
            break;
        }
    size_t stateEnd = ck; // for the slot-tail displayName scan below
    if (ck >= 4) {
        uint32_t stateLen = 0;
        rdU32(c.b, ck - 4, payEnd, stateLen);
        stateEnd = ck + stateLen;
        if (stateEnd > payEnd || stateLen < 160) {
            Log::warn("cpr import: SX slot state length %u out of bounds — clamped",
                      stateLen);
            stateEnd = payEnd;
        }
        fxbExtract(c.b, ck, stateEnd, xp, fxId);
    }
    // Slot-tail displayName (CPR_MIXER_FORMAT.md §2): the LAST printable lpstr in the slot
    // tail (after the state chunk) is the routing/connection display name. For a VSTi rack
    // slot this carries the DISAMBIGUATED device name MIDI tracks route to ("PS03 - Drums&Percs
    // 2"); the bare idString display name (`xp.name`) drops the duplicate suffix. The tail is
    // small (~110-125 B) and bounded, so scanning from stateEnd is cheap even for 415 KB slots.
    {
        const size_t tailStart = (stateEnd > pay && stateEnd < payEnd) ? stateEnd : pay + 2;
        for (size_t s = tailStart; s + 4 <= payEnd; ++s) {
            const LpStr nm = readLpstr(c.b, s, payEnd);
            if (!nm.ok || nm.text.size() < 3 || nm.text.size() > 128)
                continue;
            bool hasAlpha = false, printable = true;
            for (char ch : nm.text) {
                if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) hasAlpha = true;
                if (static_cast<unsigned char>(ch) < 0x20) { printable = false; break; }
            }
            if (hasAlpha && printable)
                xp.routeName = trimSpaces(nm.text); // last wins = the slot-tail displayName
        }
    }
    if (fxId == 0)
        fxId = sxUidFromIdString(id.text);
    if (fxId == 0) {
        Log::warn("cpr import: SX insert with undecodable identity (id '%s') — skipped",
                  id.text.c_str());
        return payEnd;
    }
    // Signed int32 decimal to match the registry (Vst2Host.cpp:665 / byUid exact compare).
    xp.uid = std::to_string(static_cast<int32_t>(fxId));
    out.push_back(std::move(xp));
    return payEnd;
}

// Find an SX insert rack header within [lo,hi): u32 Bypass=0, u32 SeparationPosition=6,
// u32 slotCount(1..maxSlots), then the first slot tag (=2). Sends use the same 0/6/count
// header but slot tag 1, so the trailing tag disambiguates. Returns offset of the Bypass
// field or 0.
size_t sxFindInsertArea(const CprCtx& c, size_t lo, size_t hi, uint32_t maxSlots) {
    for (size_t s = lo; s + 16 <= hi; ++s) {
        uint32_t a = 0, b2 = 0, n = 0, t = 0;
        if (rdU32(c.b, s, hi, a) && a == 0 && rdU32(c.b, s + 4, hi, b2) && b2 == 6 &&
            rdU32(c.b, s + 8, hi, n) && n >= 1 && n <= maxSlots &&
            rdU32(c.b, s + 12, hi, t) && t == 2)
            return s;
    }
    return 0;
}

// SX channel fader: the body carries `f32 16383.5 (InputGain) + u32 0 (separator) + f32
// Volume` (CPR_MIXER_FORMAT.md §1; decode spec §4, byte-verified InputGain anchor 0x467FFE00
// = 16383.5). Find that anchor inside [bodyStart, bodyEnd) and return the Volume f32 at +8.
// Returns false if the anchor is absent (channel layout variant). The read is anchor-
// verified, so any finite Volume is a REAL fader state: a fader pulled to the bottom is
// stored as 0.0 (and the migrated/modern -inf sentinel is -1) — both must reach
// applyVolumeValue25856's value <= 0 -> gain 0 (-inf) branch rather than be rejected here,
// which would leave the silenced channel at unity. Pan is NOT decoded — no reliable SX pan
// field has been identified in the corpus.
bool sxReadVolumeF32(const CprCtx& c, size_t bodyStart, size_t bodyEnd, float& volOut) {
    // 16383.5f big-endian = 46 7F FE 00.
    for (size_t s = bodyStart; s + 12 <= bodyEnd; ++s) {
        if (c.b[s] != 0x46 || c.b[s + 1] != 0x7F || c.b[s + 2] != 0xFE || c.b[s + 3] != 0x00)
            continue;
        uint32_t sep = 0;
        if (!rdU32(c.b, s + 4, bodyEnd, sep) || sep != 0)
            continue; // not the InputGain/separator pair
        float v = 0.0f;
        if (!rdF32(c.b, s + 8, bodyEnd, v) || !std::isfinite(v))
            return false;
        volOut = std::max(v, 0.0f); // <= 0 (incl. the -1 sentinel) decodes to -inf
        return true;
    }
    return false;
}

// Audio-track insert racks (8 slots) inside MAudioTrack channel records. The outer record
// may contain stale bytes from a previous save past the inner bodySize — every scan stays
// inside the bodySize bounds (reader hazard, CPR_MIXER_FORMAT.md §6).
void sxExtractTrackInserts(CprCtx& c) {
    static const uint8_t kVmt[] = "VST Multitrack";
    for (const Rec& r : c.recs) {
        if (r.name != "MAudioTrack")
            continue;
        ++c.channelsSeen;
        // locate the lpstr "VST Multitrack" (15 bytes incl. NUL)
        size_t vm = 0;
        for (size_t s = r.dataStart; s + 15 <= r.dataEnd; ++s)
            if (std::memcmp(c.b.data() + s, kVmt, 15) == 0) {
                vm = s;
                break;
            }
        if (!vm)
            continue;
        // u32 1, u32 recordRemainder, lpstr trackName, u8 0x60, u16 0, u8 version
        // (4 = SX2/3, 8 = late SX-era saves), u32 bodySize.
        const LpStr tn = readLpstr(c.b, vm + 15 + 8, r.dataEnd);
        size_t q = tn.ok ? tn.next : vm + 23;
        size_t bodyStart = 0;
        uint32_t bodySize = 0;
        for (size_t s = q; s + 8 <= r.dataEnd && s < q + 8; ++s)
            if (c.b[s] == 0x60 && c.b[s + 1] == 0 && c.b[s + 2] == 0 && c.b[s + 3] >= 1 &&
                c.b[s + 3] <= 16) {
                rdU32(c.b, s + 4, r.dataEnd, bodySize);
                bodyStart = s + 8;
                break;
            }
        if (!bodyStart) {
            ++c.channelParseFails;
            Log::warn("cpr import: SX channel record without body marker — inserts skipped");
            continue;
        }
        const size_t bodyEnd = std::min(bodyStart + bodySize, r.dataEnd);

        // Channel fader (independent of whether an insert rack is present). SX has no
        // AnchorValue — the f32 Volume is the only encoding, decoded with the CALIBRATED
        // piecewise taper (applyVolumeValue25856; CPR_MIXER_FORMAT.md §1).
        const uint64_t chTrackId = trackForOffset(c, r.hdrOff);
        Track* chTrack = chTrackId ? c.model.trackById(chTrackId) : nullptr;
        if (chTrack && chTrack->kind != TrackKind::Folder) {
            float volF32 = 0.0f;
            if (sxReadVolumeF32(c, bodyStart, bodyEnd, volF32))
                applySxVolumeF32(c, *chTrack, volF32);
            if (!c.sxPanWarned) {
                c.sxPanWarned = true;
                Log::info("cpr import: SX-era channel pan not imported — no reliable SX pan "
                          "field identified in the corpus (channels left centered)");
            }
        }

        const size_t ia = sxFindInsertArea(c, bodyStart, bodyEnd, 8);
        if (!ia)
            continue; // no rack found (channel layout variant) — nothing to import
        uint32_t slotCount = 0;
        rdU32(c.b, ia + 8, bodyEnd, slotCount);
        slotCount = std::min(slotCount, 8u); // 8-slot insert rack — clamp the loop bound
        std::vector<XPlugin> plugs;
        size_t sp = ia + 12;
        for (uint32_t i = 0; i < slotCount && sp; ++i)
            sp = sxParseSlot(c, sp, bodyEnd, plugs);
        if (plugs.empty())
            continue;
        const uint64_t trackId = trackForOffset(c, r.hdrOff);
        Track* t = trackId ? c.model.trackById(trackId) : nullptr;
        if (!t || t->kind == TrackKind::Folder) {
            c.insertsSkippedNonTrack += static_cast<int>(plugs.size());
            continue;
        }
        for (XPlugin& xp : plugs)
            addDormantInsert(c, *t, std::move(xp), false);
    }
}

// SX VSTi rack in the Devices "VST Mixer" blob: magic 0xAB19CD2B, u32 1, u32 rackLen,
// u32 0, u32 6, u32 64 slots. Loaded rack slots are followed by output-channel blocks of
// only-partially-decoded layout, so the walk is a bounded signature scan: loaded-slot
// records are validated structurally (tag/size/occupied/hex idString); slots that sit
// inside a nested 8-slot channel insert area are that instrument's output-channel
// inserts and attach to the same created track.
void sxExtractVstiRack(CprCtx& c, size_t archOff, size_t archSize) {
    static const uint8_t kMagic[] = {0xAB, 0x19, 0xCD, 0x2B};
    const size_t archEnd = archOff + archSize;
    size_t m = 0;
    for (size_t s = archOff; s + 24 <= archEnd; ++s)
        if (std::memcmp(c.b.data() + s, kMagic, 4) == 0) {
            m = s;
            break;
        }
    if (!m)
        return;
    uint32_t rackLen = 0;
    rdU32(c.b, m + 8, archEnd, rackLen);
    const size_t rackEnd = std::min(m + 12 + static_cast<size_t>(rackLen), archEnd);

    // Pass 1: mark nested 8-slot channel insert areas (slot chains must walk cleanly).
    std::vector<std::pair<size_t, size_t>> chanAreas;
    for (size_t s = m + 24; s + 16 <= rackEnd; ++s) {
        uint32_t a = 0, b2 = 0, n = 0, t = 0;
        if (!(rdU32(c.b, s, rackEnd, a) && a == 0 && rdU32(c.b, s + 4, rackEnd, b2) &&
              b2 == 6 && rdU32(c.b, s + 8, rackEnd, n) && n >= 1 && n <= 8 &&
              rdU32(c.b, s + 12, rackEnd, t) && t == 2))
            continue;
        size_t p = s + 12;
        bool ok = true;
        for (uint32_t k = 0; k < n; ++k) {
            uint32_t tag = 0, sz = 0;
            if (!rdU32(c.b, p, rackEnd, tag) || tag != 2 ||
                !rdU32(c.b, p + 4, rackEnd, sz) || sz < 9 || p + 8 + sz > rackEnd) {
                ok = false;
                break;
            }
            p += 8 + sz;
        }
        if (ok) {
            chanAreas.emplace_back(s + 12, p);
            s = p - 1;
        }
    }
    auto inChanArea = [&chanAreas](size_t off) {
        for (const auto& [a2, b3] : chanAreas)
            if (off >= a2 && off < b3)
                return true;
        return false;
    };

    // Pass 2: loaded-slot signature scan in byte order. (Track pointers are re-resolved
    // by id — createInstrumentTrack may reallocate project.tracks.)
    uint64_t curInstTrackId = 0;
    int orphanEffects = 0;
    // Each MIDI route is merged at most once (guards N:1 + repeated rack scans).
    std::vector<bool> routeConsumed(c.midiRoutes.size(), false);
    for (size_t s = m + 12; s + 16 <= rackEnd; ++s) {
        uint32_t tag = 0, size = 0;
        if (!rdU32(c.b, s, rackEnd, tag) || tag != 2 ||
            !rdU32(c.b, s + 4, rackEnd, size) || size <= 9 || s + 8 + size > rackEnd)
            continue;
        uint16_t occupied = 0;
        if (!rdU16(c.b, s + 8, rackEnd, occupied) || occupied != 1)
            continue;
        const LpStr id = readLpstr(c.b, s + 10, s + 8 + size);
        if (!id.ok || id.text.size() < 34)
            continue;
        bool hexId = true;
        for (int i = 0; i < 10 && hexId; ++i) {
            uint8_t nb = 0;
            hexId = hexNibble(id.text[static_cast<size_t>(i)], nb);
        }
        if (!hexId || id.text.compare(0, 8, kSxPlaceholderId) == 0)
            continue;
        std::vector<XPlugin> one;
        const size_t next = sxParseSlot(c, s, rackEnd, one);
        if (!next || one.empty()) {
            continue;
        }
        XPlugin xp = std::move(one.front());
        if (inChanArea(s)) {
            // output-channel insert of the most recent rack instrument
            Track* t = curInstTrackId ? c.model.trackById(curInstTrackId) : nullptr;
            if (t) {
                addDormantInsert(c, *t, std::move(xp), false);
            } else {
                ++orphanEffects;
                Log::warn("cpr import: VSTi-rack channel insert '%s' precedes any "
                          "instrument — skipped",
                          xp.name.c_str());
            }
        } else {
            // SX MIDI-track -> rack-instrument routing (CPR_MIXER_FORMAT.md §7.7): the
            // rack instrument ALWAYS becomes ONE standalone Instrument track (one shared
            // VSTi instance, original project structure preserved). Every imported MIDI
            // track whose output Device Name matches the instrument's slot-tail
            // displayName (routeName; bare plugin name as fallback) gets Track::midiTarget
            // pointed at that track — real MIDI routing, so N:1 needs no instance/state
            // duplication. The decoded MIDI channel stays captured-but-unused (1:1 slot
            // routing needs no channel split; CprCtx::MidiRoute).
            const std::string& matchName = !xp.routeName.empty() ? xp.routeName : xp.name;
            const std::vector<uint64_t> routed =
                routedMidiTracksFor(c, matchName, routeConsumed);
            // Routed instruments take the DISAMBIGUATED rack device name ("PS03 -
            // Drums&Percs 2") so N rack instances of one plugin stay tellable apart;
            // unrouted ones keep the bare plugin display name (pre-routing behavior).
            const std::string trackName = !routed.empty() ? matchName : xp.name;
            Track* t = createInstrumentTrack(c, trackName);
            if (!t)
                break; // import-track ceiling reached
            curInstTrackId = t->id; // output-channel inserts land here too
            c.rackCreatedTracks.insert(t->id);
            addDormantInsert(c, *t, std::move(xp), true);
            if (routed.empty()) {
                // counted (and dropped) later by collapseFeederTracks' feederless pass
            } else {
                ++c.routedInstruments;
                for (const uint64_t midiId : routed) {
                    Track* f = c.model.trackById(midiId);
                    if (!f)
                        continue;
                    f->midiTarget = curInstTrackId;
                    ++c.routedMidiTracks;
                    Log::info("cpr import: MIDI track '%s' -> rack instrument '%s' "
                              "(midiTarget routing, shared instance)",
                              f->name.c_str(), trackName.c_str());
                }
            }
        }
        s = next - 1;
    }
    (void)orphanEffects;
}

// ---------------------------------------------------------------------------
// Modern era (C5/C12) attribute tree (CPR_MIXER_FORMAT.md §5)
// ---------------------------------------------------------------------------
// entry := lpstr key + u16 type. 0x01 i64BE, 0x03 f32BE, 0x04 f64BE, 0x08 lpstr,
// 0x05 u32 len + raw bytes, 0x02 container -> u16 sub:
//   0x06 u32 n + n entries; 0x05 u32 n + n x { u32 m, m entries }; 0x02/0x03 u32 n +
//   n x i64/f64; 0x04/0x08 u32 n + n lpstrs; 0x07 u32 n + n raw bytes;
//   0x14 lpstr className + u32 0 + u32 objectId + u32 n + n entries (owned object);
//   0x15 u32 0 + u32 objectId (object reference);
//   0xC9 u32 n + n x { u16 0x14 -> owned object | u16 0 -> null }.
// (0x14/0x15/0xC9 decoded from corpus QCDestinations/filterDefaults hexdumps, 2026-06.)

struct PathEl {
    std::string key;
    int idx = -1; // array element index, -1 = object
};

struct ModPlugin {
    std::vector<PathEl> path; // containers above the "Plugin" object
    std::string guid, name, version;
    size_t acOff = 0;
    uint32_t acLen = 0;
    bool hasAc = false;
    size_t edOff = 0;
    uint32_t edLen = 0;
    bool hasEd = false;
};

class AttrTreeScan {
public:
    AttrTreeScan(const std::vector<uint8_t>& b, size_t end) : b_(b), end_(end) {}

    // Channel tree: sentinel already consumed; p at u32 topCount.
    bool parseTree(size_t p, std::string& err) {
        uint32_t n = 0;
        if (!rdU32(b_, p, end_, n) || n > 4096)
            return fail(err, p, "bad top count");
        p += 4;
        const bool ok = entries(p, n, 0, err);
        endOff = p;
        return ok;
    }
    // Single entry anchored at a key (e.g. "Synth Rack" in the Devices tree).
    bool parseSingleEntry(size_t p, std::string& err) {
        const bool ok = entry(p, 0, err);
        endOff = p;
        return ok;
    }

    std::vector<ModPlugin> plugins;
    size_t endOff = 0; // first offset past the parsed region (valid when parse succeeded)

    // Channel-strip fader/pan, captured from the TOP-LEVEL Volume/Pan members of the
    // channel attr tree (siblings of InsertFolder). Only valid after parseTree succeeds.
    // hasVolumeDb: Volume.AnchorValue (f64 dB). hasVolumeValue: the Volume.Value taper
    // (25856 = 0 dB), used as the fallback for Cubase 5, which leaves AnchorValue at 0.
    // hasPan: Pan.Value (i64 -64..63).
    bool hasVolumeDb = false;
    double volumeDb = 0.0;
    bool hasVolumeValue = false;
    double volumeValue = 0.0;
    bool hasPan = false;
    int64_t panRaw = 0;
    // Standard Panner component blob (top-level Panner.audioComponent — sibling of
    // Volume/InsertFolder). 20 bytes LITTLE-endian: f32 pos [0..1] (0 = hard L,
    // 0.5 = C, 1 = hard R; Cubase UI shows (pos-0.5)*200), f32 pos2 (right-channel
    // position, 0.5 unless a stereo-combined panner moved it), u32 mode (1 = factory
    // default, 4 = engaged), u32 channelCount, u32 0. EVERY native Cubase era (C5.1.1,
    // C12, C13 — labeled fixtures) stores the channel pan ONLY here; no era writes a
    // channel-level Pan member (CPR_MIXER_FORMAT §5a).
    bool hasPannerPos = false;
    double pannerPos = 0.5;
    double pannerPos2 = 0.5;
    // Channel display name — Devices-tree bus channels carry Name{String} ("Stereo In"
    // etc.); arrangement track strips don't (their name lives on the track record).
    std::string channelName;
    // Top-level 'clickEnable' (metronome click, i64 0/1) — present on VST Mixer output
    // channels in the Devices tree, absent from arrangement track strips.
    bool hasClick = false;
    bool clickEnabled = false;
    bool hasEq = false;        // a top-level EQ member is present
    bool eqBypass = false;     // EQ.Bypass (i64, top-level EQ child)
    // Decoded EQ bands (EQ.Band[]{Enable,Type,Gain,Freq,Q}). Indexed by array position;
    // grown on demand as fields arrive. Imported into Track.eq (mapped + clamped).
    struct EqBandRaw {
        bool enable = false;
        int64_t type = -1; // raw Cubase Type (mapped to MyDAW enum at apply time)
        double gain = 0.0; // dB
        double freq = 1000.0;
        double q = 1.0;
    };
    std::vector<EqBandRaw> eqBands;
    int sendSlots = 0;         // SendFolder.Slot count (all empty in corpus; not imported)

private:
    bool fail(std::string& err, size_t p, const char* what) {
        char buf[96];
        std::snprintf(buf, sizeof(buf), "%s @0x%zx", what, p);
        err = buf;
        return false;
    }

    bool entries(size_t& p, uint32_t n, int depth, std::string& err) {
        for (uint32_t i = 0; i < n; ++i)
            if (!entry(p, depth, err))
                return false;
        return true;
    }

    // Parses the entry at p, advancing p past it.
    bool entry(size_t& p, int depth, std::string& err) {
        if (depth > 64 || ++budget_ > 4'000'000)
            return fail(err, p, "depth/budget exceeded");
        const LpStr k = readLpstr(b_, p, end_);
        if (!k.ok || k.text.empty() || k.text.size() > 64)
            return fail(err, p, "bad key");
        p = k.next;
        uint16_t type = 0;
        if (!rdU16(b_, p, end_, type))
            return fail(err, p, "truncated type");
        p += 2;
        switch (type) {
            case 0x01: { // i64
                if (p + 8 > end_) return fail(err, p, "truncated i64");
                // Pan.Value: the i64 inside a TOP-LEVEL "Pan" channel member. Never
                // written by native Cubase (§5a) — fallback for old MyDAW exports.
                if (k.text == "Value" && path_.size() == 1 && path_.back().key == "Pan" &&
                    !hasPan) {
                    uint64_t u = 0;
                    if (rdU64(b_, p, end_, u)) {
                        panRaw = static_cast<int64_t>(u);
                        hasPan = true;
                    }
                }
                // EQ.Bypass (i64 directly under the top-level EQ member).
                else if (k.text == "Bypass" && path_.size() == 1 &&
                         path_.back().key == "EQ") {
                    uint64_t u = 0;
                    if (rdU64(b_, p, end_, u))
                        eqBypass = (static_cast<int64_t>(u) != 0);
                }
                // EQ.Band[i].Enable / .Type (i64s inside an EQ band array element).
                else if (path_.size() == 2 && path_.back().key == "Band" &&
                         path_[0].key == "EQ") {
                    uint64_t u = 0;
                    if (rdU64(b_, p, end_, u)) {
                        EqBandRaw& bnd = eqBandAt(path_.back().idx);
                        if (k.text == "Enable")
                            bnd.enable = (static_cast<int64_t>(u) != 0);
                        else if (k.text == "Type")
                            bnd.type = static_cast<int64_t>(u);
                    }
                }
                // clickEnable: top-level metronome click flag (output-bus channels only).
                else if (k.text == "clickEnable" && path_.empty() && !hasClick) {
                    uint64_t u = 0;
                    if (rdU64(b_, p, end_, u)) {
                        clickEnabled = (u != 0);
                        hasClick = true;
                    }
                }
                p += 8;
                return true;
            }
            case 0x04: { // f64
                if (p + 8 > end_) return fail(err, p, "truncated f64");
                // Channel fader, from the TOP-LEVEL "Volume" member (sibling of InsertFolder).
                // AnchorValue = gain in dB (authoritative when populated). Value = the 25856-
                // based taper; Cubase 5 leaves AnchorValue 0 and stores the fader only in Value,
                // so we keep both and decide at apply time (applyModernVolume).
                if (path_.size() == 1 && path_.back().key == "Volume") {
                    if (k.text == "AnchorValue" && !hasVolumeDb) {
                        double v = 0.0;
                        if (rdF64(b_, p, end_, v)) {
                            volumeDb = v;
                            hasVolumeDb = true;
                        }
                    } else if (k.text == "Value" && !hasVolumeValue) {
                        double v = 0.0;
                        if (rdF64(b_, p, end_, v)) {
                            volumeValue = v;
                            hasVolumeValue = true;
                        }
                    }
                }
                // EQ.Band[i].Gain / .Freq / .Q (f64s inside an EQ band array element).
                else if (path_.size() == 2 && path_.back().key == "Band" &&
                         path_[0].key == "EQ") {
                    double v = 0.0;
                    if (rdF64(b_, p, end_, v)) {
                        EqBandRaw& bnd = eqBandAt(path_.back().idx);
                        if (k.text == "Gain")
                            bnd.gain = v;
                        else if (k.text == "Freq")
                            bnd.freq = v;
                        else if (k.text == "Q")
                            bnd.q = v;
                    }
                }
                p += 8;
                return true;
            }
            case 0x03: { // f32
                if (p + 4 > end_) return fail(err, p, "truncated f32");
                p += 4;
                return true;
            }
            case 0x08: { // lpstr
                const LpStr v = readLpstr(b_, p, end_);
                if (!v.ok) return fail(err, p, "bad string");
                if (k.text == "Plugin isA")
                    lastIsA_ = v.text;
                // Channel display name (Devices bus channels: top-level Name{String}).
                if (k.text == "String" && channelName.empty() && !capture_ &&
                    path_.size() == 1 && path_.back().key == "Name")
                    channelName = v.text;
                noteString(k.text, v.text);
                p = v.next;
                return true;
            }
            case 0x05: { // raw binary: u32 len + bytes
                uint32_t len = 0;
                if (!rdU32(b_, p, end_, len) || p + 4 + len > end_)
                    return fail(err, p, "bad binary");
                p += 4 + len;
                return true;
            }
            case 0x02:
                return container(k.text, p, depth, err);
            default:
                return fail(err, p, "unknown type");
        }
    }

    bool container(const std::string& key, size_t& p, int depth, std::string& err) {
        uint16_t sub = 0;
        if (!rdU16(b_, p, end_, sub))
            return fail(err, p, "truncated subtype");
        p += 2;
        switch (sub) {
            case 0x06: { // named object
                uint32_t n = 0;
                if (!rdU32(b_, p, end_, n) || n > 100000)
                    return fail(err, p, "bad obj count");
                p += 4;
                // Top-level EQ member of a channel strip — not imported (no MyDAW target),
                // counted so the importer can report it honestly.
                if (key == "EQ" && path_.empty())
                    hasEq = true;
                if (key == "Plugin" && lastIsA_ == "VstCtrlInternalEffect") {
                    lastIsA_.clear();
                    ModPlugin mp;
                    mp.path = path_;
                    if (!pluginObj(p, n, depth + 1, mp, err))
                        return false;
                    plugins.push_back(std::move(mp));
                    return true;
                }
                path_.push_back(PathEl{key, -1});
                const bool ok = entries(p, n, depth + 1, err);
                path_.pop_back();
                return ok;
            }
            case 0x05: { // array of objects
                uint32_t n = 0;
                if (!rdU32(b_, p, end_, n) || n > 100000)
                    return fail(err, p, "bad arr count");
                p += 4;
                // SendFolder.Slot of a channel strip — all empty/inactive in the corpus;
                // destinations resolve to FX/group channels not modeled in v1. Counted,
                // not imported.
                if (key == "Slot" && path_.size() == 1 && path_.back().key == "SendFolder")
                    sendSlots = static_cast<int>(n);
                for (uint32_t i = 0; i < n; ++i) {
                    uint32_t m = 0;
                    if (!rdU32(b_, p, end_, m) || m > 100000)
                        return fail(err, p, "bad arr item count");
                    p += 4;
                    path_.push_back(PathEl{key, static_cast<int>(i)});
                    const bool ok = entries(p, m, depth + 1, err);
                    path_.pop_back();
                    if (!ok)
                        return false;
                }
                return true;
            }
            case 0x02: // i64 array
            case 0x03: { // f64 array
                uint32_t n = 0;
                if (!rdU32(b_, p, end_, n) || p + 4 + 8ull * n > end_)
                    return fail(err, p, "bad numeric array");
                p += 4 + 8ull * n;
                return true;
            }
            case 0x04:
            case 0x08: { // string array
                uint32_t n = 0;
                if (!rdU32(b_, p, end_, n) || n > 100000)
                    return fail(err, p, "bad str array");
                p += 4;
                for (uint32_t i = 0; i < n; ++i) {
                    const LpStr v = readLpstr(b_, p, end_);
                    if (!v.ok)
                        return fail(err, p, "bad str array item");
                    p = v.next;
                }
                return true;
            }
            case 0x07: { // blob
                uint32_t n = 0;
                if (!rdU32(b_, p, end_, n) || p + 4 + n > end_)
                    return fail(err, p, "bad blob");
                p += 4;
                noteBlob(key, p, n);
                // Channel pan: the Standard Panner's component state (see the field doc
                // above). Only the TOP-LEVEL Panner member is the channel pan — send
                // panners (SendFolder.Slot[i].Panner) and track-variation snapshots live
                // deeper and don't match this path.
                if (key == "audioComponent" && !hasPannerPos && n >= 8 && !capture_ &&
                    path_.size() == 1 && path_.back().key == "Panner") {
                    float f1 = 0.0f, f2 = 0.0f;
                    if (rdF32le(b_, p, end_, f1) && rdF32le(b_, p + 4, end_, f2) &&
                        std::isfinite(f1) && f1 >= 0.0f && f1 <= 1.0f &&
                        std::isfinite(f2) && f2 >= 0.0f && f2 <= 1.0f) {
                        pannerPos = static_cast<double>(f1);
                        pannerPos2 = static_cast<double>(f2);
                        hasPannerPos = true;
                    }
                }
                p += n;
                return true;
            }
            case 0x14: // owned object
                return typedObj(p, depth, err);
            case 0x15: { // object reference: u32 0 + u32 objectId
                if (p + 8 > end_)
                    return fail(err, p, "truncated objref");
                p += 8;
                return true;
            }
            case 0xC9: { // owned-object list
                uint32_t n = 0;
                if (!rdU32(b_, p, end_, n) || n > 100000)
                    return fail(err, p, "bad ownedlist count");
                p += 4;
                for (uint32_t i = 0; i < n; ++i) {
                    uint16_t tag = 0;
                    if (!rdU16(b_, p, end_, tag))
                        return fail(err, p, "truncated ownedlist tag");
                    p += 2;
                    if (tag == 0x14) {
                        if (!typedObj(p, depth, err))
                            return false;
                    } else if (tag != 0) {
                        return fail(err, p, "unknown ownedlist tag");
                    }
                }
                return true;
            }
            default:
                return fail(err, p, "unknown subtype");
        }
    }

    bool typedObj(size_t& p, int depth, std::string& err) {
        const LpStr cn = readLpstr(b_, p, end_);
        if (!cn.ok || cn.text.empty() || cn.text.size() > 64)
            return fail(err, p, "bad owned-object class");
        p = cn.next + 8; // u32 0 + u32 objectId
        uint32_t n = 0;
        if (!rdU32(b_, p, end_, n) || n > 100000)
            return fail(err, p, "bad owned-object count");
        p += 4;
        return entries(p, n, depth + 1, err);
    }

    // Inside a "Plugin" object: same grammar, capturing identity/state fields.
    bool pluginObj(size_t& p, uint32_t n, int depth, ModPlugin& mp, std::string& err) {
        capture_ = &mp;
        captureUidDepth_ = 0;
        path_.push_back(PathEl{"Plugin", -1});
        const bool ok = entries(p, n, depth, err);
        path_.pop_back();
        capture_ = nullptr;
        return ok;
    }

    void noteString(const std::string& key, const std::string& val) {
        if (!capture_)
            return;
        if (key == "GUID" && capture_->guid.empty() && !path_.empty() &&
            path_.back().key == "Plugin UID")
            capture_->guid = val;
        else if (key == "Plugin Name" && capture_->name.empty())
            capture_->name = val;
        else if (key == "Version" && capture_->version.empty())
            capture_->version = val;
    }

    // Get/create the EQ band record at array index `idx` (grown on demand).
    EqBandRaw& eqBandAt(int idx) {
        if (idx < 0)
            idx = 0;
        if (idx >= static_cast<int>(eqBands.size()))
            eqBands.resize(static_cast<size_t>(idx) + 1);
        return eqBands[static_cast<size_t>(idx)];
    }

    void noteBlob(const std::string& key, size_t off, uint32_t len) {
        if (!capture_)
            return;
        if (key == "audioComponent" && !capture_->hasAc) {
            capture_->acOff = off;
            capture_->acLen = len;
            capture_->hasAc = true;
        } else if (key == "editController" && !capture_->hasEd) {
            capture_->edOff = off;
            capture_->edLen = len;
            capture_->hasEd = true;
        }
    }

    const std::vector<uint8_t>& b_;
    size_t end_;
    std::vector<PathEl> path_;
    std::string lastIsA_;
    ModPlugin* capture_ = nullptr;
    int captureUidDepth_ = 0;
    size_t budget_ = 0;
};

// Normalize one ModPlugin (identity + host-ready state) into an XPlugin.
bool modToXPlugin(CprCtx& c, const ModPlugin& mp, XPlugin& out) {
    if (!identityFromGuid(mp.guid, out)) {
        Log::warn("cpr import: undecodable Plugin UID '%s' (%s) — skipped",
                  mp.guid.c_str(), mp.name.c_str());
        return false;
    }
    out.name = mp.name;
    out.version = mp.version;
    if (out.format == "vst2" && mp.hasAc && mp.acLen >= 4) {
        const size_t a = mp.acOff;
        const bool isVstW =
            mp.acLen >= 20 && std::memcmp(c.b.data() + a, "VstW", 4) == 0;
        const bool isFxb = std::memcmp(c.b.data() + a, "CcnK", 4) == 0;
        if (!isVstW && !isFxb) {
            // 'VST'+fourcc class id but NON-fxb state: a real VST3 plugin whose vendor
            // reuses the vst2-wrapper id scheme for project migration (e.g. Waves
            // WaveShell-VST3). The state is a raw VST3 component stream.
            out.format = "vst3";
            out.uid.clear();
            out.uid.reserve(32);
            for (char ch : mp.guid)
                out.uid.push_back(ch >= 'a' && ch <= 'z' ? static_cast<char>(ch - 'a' + 'A')
                                                         : ch);
        }
    }
    if (out.format == "vst2") {
        if (mp.hasAc && mp.acLen >= 4) {
            const size_t a = mp.acOff;
            uint32_t fxId = 0;
            if (mp.acLen >= 20 && std::memcmp(c.b.data() + a, "VstW", 4) == 0) {
                // 'VstW' u32be 8 u32be version u32be bypass, then the fxb image
                fxbExtract(c.b, a + 16, a + mp.acLen, out, fxId);
            } else { // 'CcnK': unloaded plugin — SX-era fxb copied verbatim
                fxbExtract(c.b, a, a + mp.acLen, out, fxId);
            }
        }
    } else { // vst3: raw component (+ controller) packed as the host's 'MD3S' container
        if ((mp.hasAc && mp.acLen > 0) || (mp.hasEd && mp.edLen > 0))
            out.state = packMd3s(c.b.data() + mp.acOff, mp.hasAc ? mp.acLen : 0,
                                 c.b.data() + mp.edOff, mp.hasEd ? mp.edLen : 0);
    }
    return true;
}

// Map a raw Cubase channel-EQ Type to the MyDAW band-type enum
// (0=peak 1=lowShelf 2=highShelf 3=highCut 4=lowCut 5=notch). Cubase's 4-band channel EQ
// stores per-band shape codes (bands 1/4 are shelf/cut-capable, 2/3 are peaks). The exact
// integer mapping is NOT verified against the corpus (docs/CPR_MIXER_FORMAT.md §6 TOP
// UNKNOWN 4), so we pass through 0..5 (which match the MyDAW enum) and DEFAULT to peak(0)
// for anything else — the raw Type is logged so the mapping can be refined later. Sets
// `unknown` when the raw value was not in 0..5.
int mapCubaseEqType(int64_t raw, bool& unknown) {
    unknown = (raw < 0 || raw > 5);
    return unknown ? 0 : static_cast<int>(raw);
}

// Map decoded channel-EQ bands into Track.eq (mapped + clamped to the contract ranges).
// Bands carry their Enable flag into EqBand.enabled (disabled bands kept but inert) so the
// user can re-enable them; EQ.Bypass -> Track.eq.bypass. Most corpus channel EQs are fully
// disabled — that is fine: they import bypassed/disabled, nothing is fabricated.
void applyEq(CprCtx& c, Track& t, bool bypass,
             const std::vector<AttrTreeScan::EqBandRaw>& bands) {
    if (bands.empty()) {
        // EQ member present but no decodable bands. A bypassed-empty eq is functionally
        // identical to no EQ at all, so don't materialize one (it would only serialize a
        // dead block) — count this channel as skipped, honestly.
        ++c.eqsSkipped;
        return;
    }
    TrackEq eq;
    eq.bypass = bypass;
    int unknownTypes = 0;
    int enabledBands = 0;
    std::string raws;
    for (const AttrTreeScan::EqBandRaw& br : bands) {
        // Reject non-finite raw values before clamping (std::clamp is a NaN no-op, so a
        // poisoned value would otherwise reach the live filter state). Skip the band.
        if (!std::isfinite(br.freq) || !std::isfinite(br.gain) || !std::isfinite(br.q)) {
            Log::warn("cpr import: dropping channel EQ band on track '%s' with non-finite "
                      "freq/gain/q",
                      t.name.c_str());
            continue;
        }
        EqBand b;
        b.enabled = br.enable;
        bool unknown = false;
        b.type = mapCubaseEqType(br.type, unknown);
        if (unknown)
            ++unknownTypes;
        if (b.enabled)
            ++enabledBands;
        b.freqHz = std::clamp(br.freq, 20.0, 20000.0);
        b.gainDb = std::clamp(br.gain, -24.0, 24.0);
        b.q = std::clamp(br.q, 0.1, 18.0);
        eq.bands.push_back(b);
        if (!raws.empty())
            raws += ",";
        raws += std::to_string(br.type);
    }
    if (eq.bands.empty()) {
        // Every band was dropped (all non-finite) — nothing audible to keep.
        ++c.eqsSkipped;
        return;
    }
    t.eq = std::move(eq);
    ++c.eqsImported;
    if (unknownTypes > 0 && c.eqTypeLogs < 8) {
        ++c.eqTypeLogs;
        Log::info("cpr import: channel EQ on track '%s' has unverified Type code(s) [%s] — "
                  "imported as peak(0); refine mapCubaseEqType if needed",
                  t.name.c_str(), raws.c_str());
    }
    // The Cubase Type->shape mapping (mapCubaseEqType) is UNVERIFIED. We keep the band data
    // (and the user's enable intent), but an ENABLED band may render a different response
    // than the source. Be honest about it rather than silently mis-shaping the sound.
    if (enabledBands > 0 && c.eqShapeWarns < 8) {
        ++c.eqShapeWarns;
        Log::warn("cpr import: channel EQ on track '%s' has %d enabled band(s); the Cubase "
                  "Type->filter-shape mapping is UNVERIFIED — the EQ response may differ "
                  "from the source",
                  t.name.c_str(), enabledBands);
    }
}

// Effective pan of a scanned channel tree in MyDAW units (-1..1); false when the tree
// carries no pan at all. Two encodings (CPR_MIXER_FORMAT.md §5/§5a):
//   - the Standard Panner component blob — the ONLY place native Cubase stores the
//     channel pan in EVERY observed era (C5.1.1, C12 and C13 labeled fixtures);
//   - Pan{Value i64 -64..63} — never written by native Cubase on audio channels (only
//     MIDI-splitter pans use that shape); kept as a FALLBACK for pre-2026-07-17 MyDAW
//     exports, which emitted it instead of the blob.
// When both are present and agree the blob wins (full f32 precision vs a 127-step int);
// on disagreement the explicit Pan member wins (stay conservative on unseen shapes).
bool scanChannelPan(const AttrTreeScan& scan, double& out) {
    const double blobPan = pannerPosToModel(scan.pannerPos);
    if (scan.hasPan) {
        const double rawPan = panRawToModel(scan.panRaw);
        out = (scan.hasPannerPos && std::fabs(blobPan - rawPan) <= 1.5 / 64.0) ? blobPan
                                                                               : rawPan;
        return true;
    }
    if (scan.hasPannerPos) {
        out = blobPan;
        return true;
    }
    return false;
}

// Apply a scanned channel pan to the owning track strip. A stereo-combined panner with
// the right channel moved off-center cannot be represented by MyDAW's single balance
// pan — approximate with the left/main position and say so.
void applyChannelPan(CprCtx& c, Track& t, const AttrTreeScan& scan) {
    double pan = 0.0;
    if (!scanChannelPan(scan, pan))
        return;
    if (scan.hasPannerPos && std::fabs(scan.pannerPos2 - 0.5) > 1e-3 &&
        c.pannerAsymWarns < 4) {
        ++c.pannerAsymWarns;
        Log::warn("cpr import: channel '%s' uses a stereo-combined panner (positions "
                  "%.3f / %.3f) — approximated as balance %.3f",
                  t.name.c_str(), scan.pannerPos, scan.pannerPos2, pan);
    }
    t.pan = pan;
    ++c.pansImported;
}

// Modern channel trees: sentinel FF FE A4 C8 inside each track record. Collected per
// innermost track: /InsertFolder/Slot[i] inserts + /Synth Slot instrument. Mirrored
// copies under Output Channels are ignored. Native strip modules never match (their
// "Plugin isA" is VstCtrlEQ etc., and panners carry no isA at all).
void modernExtractTracks(CprCtx& c, size_t arrOff, size_t arrEnd) {
    static const uint8_t kSentinel[] = {0xFF, 0xFE, 0xA4, 0xC8};
    for (size_t s = arrOff; s + 8 <= arrEnd; ++s) {
        if (std::memcmp(c.b.data() + s, kSentinel, 4) != 0)
            continue;
        const uint64_t trackId = trackForOffset(c, s);
        ++c.channelsSeen;
        Track* t = trackId ? c.model.trackById(trackId) : nullptr;
        // Bound the tree by the innermost track record (or the archive).
        size_t hi = arrEnd;
        for (const TrackSpan& sp : c.trackSpans)
            if (s >= sp.lo && s < sp.hi && sp.hi < hi)
                hi = sp.hi;
        AttrTreeScan scan(c.b, hi);
        std::string perr;
        if (!scan.parseTree(s + 4, perr)) {
            ++c.channelParseFails;
            if (c.channelParseFails <= 8)
                Log::warn("cpr import: channel tree parse failed (%s) — inserts of this "
                          "channel skipped",
                          perr.c_str());
            continue;
        }
        const size_t treeEnd = scan.endOff;
        // Channel fader/pan apply to the OWNING track strip (not folders/buses-as-skip).
        // Applies even when the channel has no inserts (a bare fader move).
        if (t && t->kind != TrackKind::Folder) {
            if (scan.hasVolumeDb || scan.hasVolumeValue)
                applyModernVolume(c, *t, scan.hasVolumeDb, scan.volumeDb,
                                  scan.hasVolumeValue, scan.volumeValue);
            applyChannelPan(c, *t, scan);
            if (scan.hasEq) {
                if (!scan.eqBands.empty() || scan.eqBypass)
                    applyEq(c, *t, scan.eqBypass, scan.eqBands);
                else
                    ++c.eqsSkipped; // EQ member present but no decodable bands/bypass
            }
            c.sendsSkipped += scan.sendSlots; // all empty in corpus — counted, not imported
        }
        if (scan.plugins.empty()) {
            if (treeEnd > s)
                s = treeEnd - 1; // don't re-trigger on stray sentinel bytes inside blobs
            continue;
        }
        if (!t || t->kind == TrackKind::Folder) {
            c.insertsSkippedNonTrack += static_cast<int>(scan.plugins.size());
            if (treeEnd > s)
                s = treeEnd - 1;
            continue;
        }
        // instrument first, then inserts in slot order
        std::vector<std::pair<int, XPlugin>> inserts;
        for (const ModPlugin& mp : scan.plugins) {
            bool underOutput = false;
            for (const PathEl& el : mp.path)
                if (el.key == "Output Channels")
                    underOutput = true;
            if (underOutput)
                continue; // mirror of the track channel itself
            XPlugin xp;
            if (mp.path.size() == 1 && mp.path[0].key == "Synth Slot") {
                if (modToXPlugin(c, mp, xp)) {
                    // A synth-slot instrument makes the owning track an Instrument
                    // track. Native modern Cubase instrument tracks are classified via
                    // MInstrumentTrackEvent already; a Synth Slot on a plain MIDI track
                    // is how MyDAW's own .cpr export round-trips instruments.
                    if (t->kind == TrackKind::Midi)
                        t->kind = TrackKind::Instrument;
                    c.synthSlotTracks.push_back(t->id); // ordinal routing fallback
                    addDormantInsert(c, *t, std::move(xp), true);
                }
            } else if (mp.path.size() == 2 && mp.path[0].key == "InsertFolder" &&
                       mp.path[1].key == "Slot") {
                if (modToXPlugin(c, mp, xp))
                    inserts.emplace_back(mp.path[1].idx, std::move(xp));
            } else {
                ++c.insertsSkippedNonTrack; // unexpected location — not a track insert
            }
        }
        std::stable_sort(inserts.begin(), inserts.end(),
                         [](const auto& a, const auto& b2) { return a.first < b2.first; });
        if (t->kind == TrackKind::Midi) {
            // A MIDI channel's InsertFolder holds MIDI effects (arpeggiators etc.) —
            // NOT audio plugins. MyDAW can't host those; importing them as audio
            // inserts on a MIDI track was wrong on both counts. Count + skip.
            c.insertsSkippedNonTrack += static_cast<int>(inserts.size());
        } else {
            for (auto& [idx, xp] : inserts) {
                (void)idx;
                addDormantInsert(c, *t, std::move(xp), false);
            }
        }
        if (treeEnd > s)
            s = treeEnd - 1;
    }
}

// Modern Devices "Synth Rack" (64 slots): each loaded slot = rack instrument (+ its
// output-channel InsertFolder inserts). One Instrument track per instrument. Other
// Devices InsertFolders (VST Mixer input/output/group channels) have no model track in
// v1 — they are counted and skipped.
void modernExtractSynthRack(CprCtx& c, size_t devOff, size_t devEnd,
                            std::pair<size_t, size_t>& rackRange) {
    static const uint8_t kKey[] = {0, 0, 0, 11, 'S', 'y', 'n', 't', 'h', ' ', 'R',
                                   'a', 'c', 'k', 0};
    for (size_t s = devOff; s + sizeof(kKey) + 6 <= devEnd; ++s) {
        if (std::memcmp(c.b.data() + s, kKey, sizeof(kKey)) != 0)
            continue;
        AttrTreeScan scan(c.b, devEnd);
        std::string perr;
        if (!scan.parseSingleEntry(s, perr)) {
            Log::warn("cpr import: Synth Rack parse failed (%s)", perr.c_str());
            continue;
        }
        rackRange = {s, scan.endOff};
        // slot index -> created track id (instruments precede their channel inserts in
        // tree order, but stay defensive and key by slot index).
        std::map<int, uint64_t> trackBySlot;
        for (const ModPlugin& mp : scan.plugins) {
            int slot = -1;
            bool underOutput = false, underInsertFolder = false;
            for (const PathEl& el : mp.path) {
                if (el.key == "Slot" && slot < 0)
                    slot = el.idx;
                if (el.key == "Output Channels")
                    underOutput = true;
                if (el.key == "InsertFolder")
                    underInsertFolder = true;
            }
            if (slot < 0)
                continue;
            XPlugin xp;
            if (!underOutput && !underInsertFolder && mp.path.size() == 2 &&
                mp.path[0].key == "Synth Rack") {
                if (!modToXPlugin(c, mp, xp))
                    continue;
                Track* t = createInstrumentTrack(c, xp.name);
                if (!t)
                    break; // import-track ceiling reached
                trackBySlot[slot] = t->id;
                c.modernRackSlotTrack[slot] = t->id; // for MIDI-routing wiring
                c.rackCreatedTracks.insert(t->id);
                addDormantInsert(c, *t, std::move(xp), true);
            } else if (underOutput && underInsertFolder) {
                const auto it = trackBySlot.find(slot);
                if (it == trackBySlot.end()) {
                    ++c.insertsSkippedNonTrack;
                    continue;
                }
                if (Track* t = c.model.trackById(it->second))
                    if (modToXPlugin(c, mp, xp))
                        addDormantInsert(c, *t, std::move(xp), false);
            }
        }
        return; // the rack is a singleton — first successful parse wins
    }
}

// Modern MIDI-track -> Synth Rack routing. Each routed MMidiTrackEvent stores an
// output-connection lpstr "<32-hex Plugin GUID>-<slotIndex>" inside the track record
// (evidenced in a Cubase 7 project, near the channel "Sel Channel" block). Point the
// MIDI track's Track::midiTarget at that rack slot's Instrument track — the same
// shared-instance semantics as the SX path (CPR_MIXER_FORMAT.md §7.7).
void wireModernMidiRouting(CprCtx& c) {
    // Slot resolution: the Devices Synth Rack when present (native Cubase projects),
    // else Synth-Slot instrument tracks by ordinal (MyDAW's own exports).
    std::map<int, uint64_t> slotTrack = c.modernRackSlotTrack;
    if (slotTrack.empty()) {
        for (size_t i = 0; i < c.synthSlotTracks.size(); ++i)
            slotTrack[static_cast<int>(i)] = c.synthSlotTracks[i];
        c.synthSlotOrdinalRouting = !slotTrack.empty(); // MyDAW export — collapse later
    }
    if (slotTrack.empty())
        return;
    std::set<uint64_t> targetsUsed;
    std::map<uint64_t, std::vector<Track*>> feedersByTarget;
    for (const TrackSpan& sp : c.trackSpans) {
        if (!sp.trackId)
            continue;
        Track* t = c.model.trackById(sp.trackId);
        if (!t || t->kind != TrackKind::Midi || t->midiTarget != 0)
            continue;
        int slot = -1;
        for (size_t p = sp.lo; p + 8 < sp.hi && slot < 0; ++p) {
            uint32_t len = 0;
            if (!rdU32(c.b, p, sp.hi, len))
                break;
            // "<32 hex>-<1..3 digits>\0" -> len 35..38 incl. the terminator
            if (len < 35 || len > 38 || p + 4 + len > sp.hi)
                continue;
            const LpStr s = readLpstr(c.b, p, sp.hi);
            if (!s.ok || s.text.size() < 34 || s.text[32] != '-')
                continue;
            bool ok = true;
            for (int i = 0; i < 32 && ok; ++i) {
                uint8_t nib = 0;
                ok = hexNibble(s.text[static_cast<size_t>(i)], nib);
            }
            if (!ok)
                continue;
            int v = 0;
            ok = s.text.size() > 33;
            for (size_t i = 33; i < s.text.size() && ok; ++i) {
                const char ch = s.text[i];
                ok = ch >= '0' && ch <= '9';
                if (ok)
                    v = v * 10 + (ch - '0');
            }
            if (ok && v >= 0 && v < 1024)
                slot = v;
        }
        if (slot < 0)
            continue;
        const auto it = slotTrack.find(slot);
        if (it == slotTrack.end())
            continue;
        t->midiTarget = it->second;
        ++c.routedMidiTracks;
        targetsUsed.insert(it->second);
        feedersByTarget[it->second].push_back(t);
        Log::info("cpr import: MIDI track '%s' -> rack slot %d (midiTarget routing, "
                  "shared instance)",
                  t->name.c_str(), slot);
    }
    c.routedInstruments += static_cast<int>(targetsUsed.size());
    // No feeder->instrument rename here: native projects keep the rack track's own
    // (plugin/slot) name next to the arrangement MIDI track; the MyDAW-export collapse
    // pass renames on merge instead.
}

// Collapse the MIDI-track / rack-instrument split for MYDAW'S OWN .cpr EXPORTS ONLY
// (Synth-Slot ordinal routing, c.synthSlotOrdinalRouting): the export lowered each
// Instrument track to a MIDI track + Synth Slot pair, so re-import must fuse them back
// into ONE Instrument track. Native Cubase projects are NOT collapsed — they keep the
// arrangement MIDI tracks (kind Midi, routed via Track::midiTarget) next to the rack's
// standalone Instrument tracks, the shape the corpus/recreate tests pin down:
//   - a rack instrument's FIRST feeder MIDI track merges into it (notes + name move
//     onto the track that hosts the VSTi);
//   - ADDITIONAL feeders (N:1, e.g. two parts driving one Ivory) each become their
//     own Instrument track with a CLONE of the instrument chain — same plugins, same
//     state bytes, independent channels;
//   - leftover unrouted MIDI tracks become empty Instrument tracks (drop a VSTi in).
// Guard: instruments that already carry clips never absorb feeders — that only
// happens to deliberate MyDAW-built routing being re-imported, which must survive.
void collapseFeederTracks(CprCtx& c) {
    auto& tracks = c.model.project.tracks;
    std::map<uint64_t, std::vector<size_t>> feeders; // instrument id -> midi indices
    for (size_t i = 0; i < tracks.size(); ++i)
        if (tracks[i].kind == TrackKind::Midi && tracks[i].midiTarget != 0)
            feeders[tracks[i].midiTarget].push_back(i);
    std::set<size_t> merged;
    for (auto& [instId, list] : feeders) {
        Track* inst = c.model.trackById(instId);
        if (!inst || inst->kind != TrackKind::Instrument || !inst->clips.empty())
            continue;
        // feeder 1 merges INTO the instrument track
        {
            Track& f = tracks[list[0]];
            for (Clip& cl : f.clips)
                inst->clips.push_back(std::move(cl));
            std::stable_sort(inst->clips.begin(), inst->clips.end(),
                             [](const Clip& a, const Clip& b2) {
                                 return clipStartBeat(a) < clipStartBeat(b2);
                             });
            if (!f.name.empty())
                inst->name = f.name;
            merged.insert(list[0]);
            Log::info("cpr import: merged MIDI track '%s' into its instrument track",
                      inst->name.c_str());
        }
        inst->midiTarget = 0;
        // feeders 2..n: own Instrument track with a cloned instrument chain
        for (size_t k = 1; k < list.size(); ++k) {
            Track& f = tracks[list[k]];
            f.kind = TrackKind::Instrument;
            f.midiTarget = 0;
            f.inserts.clear();
            for (const PluginInstance& src : inst->inserts) {
                PluginInstance pi = src;
                pi.instanceId = c.model.nextId();
                if (c.ictx.pluginStates) {
                    const auto it = c.ictx.pluginStates->find(src.instanceId);
                    if (it != c.ictx.pluginStates->end())
                        (*c.ictx.pluginStates)[pi.instanceId] = it->second;
                }
                f.inserts.push_back(std::move(pi));
            }
            ++c.clonedInstrumentTracks;
            Log::info("cpr import: MIDI track '%s' became its own instrument track "
                      "(cloned '%s' chain — %zu insert(s), same settings)",
                      f.name.c_str(), inst->name.c_str(), f.inserts.size());
        }
    }
    if (!merged.empty()) {
        std::vector<Track> next;
        next.reserve(tracks.size() - merged.size());
        for (size_t i = 0; i < tracks.size(); ++i)
            if (!merged.count(i))
                next.push_back(std::move(tracks[i]));
        tracks = std::move(next);
        c.mergedFeederTracks += static_cast<int>(merged.size());
    }
    // No MIDI-kind channels out of an import: unrouted leftovers become empty
    // Instrument tracks (routed ones — the deliberate-routing guard case — stay).
    for (Track& t : tracks)
        if (t.kind == TrackKind::Midi && t.midiTarget == 0) {
            t.kind = TrackKind::Instrument;
            ++c.convertedMidiTracks;
        }
    // Rack instruments NOTHING feeds are production leftovers living only in Cubase's
    // hidden VST rack panel — the arrangement never shows them and nothing triggers
    // them during playback. Importing them as empty tracks grew ghost channels
    // (ODLO's "PS06 - Global"); drop them with an honest warning instead.
    {
        std::set<uint64_t> fed;
        for (const auto& [instId, list] : feeders)
            if (!list.empty())
                fed.insert(instId);
        bool dropped = false;
        std::vector<Track> keep;
        keep.reserve(tracks.size());
        for (Track& t : tracks) {
            if (t.kind == TrackKind::Instrument && t.clips.empty() &&
                c.rackCreatedTracks.count(t.id) && !fed.count(t.id)) {
                Log::warn("cpr import: rack instrument '%s' has no MIDI track routed "
                          "to it — skipped (rack-only, silent in the arrangement)",
                          t.name.c_str());
                ++c.unroutedInstruments;
                dropped = true;
                continue;
            }
            keep.push_back(std::move(t));
        }
        // ALWAYS reassign: the loop above moved every kept Track into `keep`, so the
        // old vector holds moved-from husks even when nothing was dropped (skipping the
        // assignment shipped a bug that emptied every track name/color/clip list).
        (void)dropped;
        tracks = std::move(keep);
    }
}

// Count user plugins in Devices InsertFolders OUTSIDE the Synth Rack (VST Mixer input/
// output/group channel inserts — no model track in v1, skipped honestly).
void modernCountDeviceInserts(CprCtx& c, size_t devOff, size_t devEnd,
                              const std::pair<size_t, size_t>& rackRange) {
    static const uint8_t kKey[] = {0, 0, 0, 13, 'I', 'n', 's', 'e', 'r', 't', 'F',
                                   'o', 'l', 'd', 'e', 'r', 0};
    for (size_t s = devOff; s + sizeof(kKey) + 6 <= devEnd; ++s) {
        if (std::memcmp(c.b.data() + s, kKey, sizeof(kKey)) != 0)
            continue;
        if (s >= rackRange.first && s < rackRange.second)
            continue; // inside the Synth Rack — already imported with its instrument
        AttrTreeScan scan(c.b, devEnd);
        std::string perr;
        if (!scan.parseSingleEntry(s, perr))
            continue; // not a real InsertFolder entry (or undecodable) — count nothing
        c.insertsSkippedNonTrack += static_cast<int>(scan.plugins.size());
        if (scan.endOff > s)
            s = scan.endOff - 1;
    }
}

// 'clickEnable' fallback (lpstr key + u16 type 0x01 + i64): grammar-anchored byte scan
// for projects where the structured Devices parse doesn't surface it (SX-era binary
// device blobs, unusual layouts). Value-validated (must be 0/1) to reject lookalike byte
// runs inside plugin-state blobs. Returns -1 when absent — the caller then leaves the
// session's metronome state untouched.
int scanClickEnable(const CprCtx& c, size_t lo, size_t hi) {
    static const uint8_t kKey[] = {0,   0,   0,   12,  'c', 'l', 'i', 'c', 'k',
                                   'E', 'n', 'a', 'b', 'l', 'e', 0,   0,   0x01};
    hi = std::min(hi, c.b.size());
    for (size_t s = lo; s + sizeof(kKey) + 8 <= hi; ++s) {
        if (std::memcmp(c.b.data() + s, kKey, sizeof(kKey)) != 0)
            continue;
        uint64_t v = 0;
        if (rdU64(c.b, s + sizeof(kKey), hi, v) && v <= 1)
            return v ? 1 : 0;
    }
    return -1;
}

// Master/output-bus strip (modern Devices tree): "VST Mixer"/"Output Channels" is an
// array with one attr tree per output bus; each element is `u32 memberCount + members` —
// exactly the shape AttrTreeScan::parseTree expects (byte-verified: Name/Volume/
// InsertFolder/EQ/Panner/clickEnable... as top-level members, fixture offset 0xb480).
// The master is the "Default Output" element (i64 sibling of the array; first element
// when absent/out of range). Volume+pan apply to project.masterTrack — output buses never
// map to an imported Track (trackForOffset only spans arrangement records), so a real
// track can't be double-applied. Inserts seen here are NOT collected (they stay counted
// as skipped by modernCountDeviceInserts). The metronome 'clickEnable' flag lives on
// these channels too and is captured from the first channel that carries it.
void modernExtractMasterBus(CprCtx& c, size_t devOff, size_t devEnd) {
    static const uint8_t kKey[] = {0,   0,   0,   16,  'O',  'u', 't',  'p', 'u', 't', ' ',
                                   'C', 'h', 'a', 'n', 'n',  'e', 'l',  's', 0,   0,   0x02,
                                   0,   0x05};
    static const uint8_t kDef[] = {0,   0,   0,   15,  'D', 'e', 'f', 'a', 'u', 'l', 't',
                                   ' ', 'O', 'u', 't', 'p', 'u', 't', 0,   0,   0x01};
    for (size_t s = devOff; s + sizeof(kKey) + 4 <= devEnd; ++s) {
        if (std::memcmp(c.b.data() + s, kKey, sizeof(kKey)) != 0)
            continue;
        uint32_t n = 0;
        if (!rdU32(c.b, s + sizeof(kKey), devEnd, n) || n == 0 || n > 64)
            continue; // not the mixer array (lookalike bytes inside a state blob)
        // "Default Output" selects the master among several output buses.
        size_t masterIdx = 0;
        for (size_t d = devOff; d + sizeof(kDef) + 8 <= devEnd; ++d)
            if (std::memcmp(c.b.data() + d, kDef, sizeof(kDef)) == 0) {
                uint64_t v = 0;
                if (rdU64(c.b, d + sizeof(kDef), devEnd, v) && v < n)
                    masterIdx = static_cast<size_t>(v);
                break;
            }
        size_t p = s + sizeof(kKey) + 4;
        bool applied = false, parsedAny = false, broke = false;
        for (uint32_t i = 0; i < n; ++i) {
            AttrTreeScan scan(c.b, devEnd);
            std::string perr;
            if (!scan.parseTree(p, perr)) {
                if (parsedAny) // a genuine tree that broke midway — worth a note
                    Log::warn("cpr import: output-bus channel %u tree parse failed (%s)%s",
                              i, perr.c_str(),
                              i <= masterIdx && !applied ? " — master fader not imported"
                                                         : "");
                broke = true;
                break;
            }
            parsedAny = true;
            p = scan.endOff;
            if (scan.hasClick && c.clickEnable < 0)
                c.clickEnable = scan.clickEnabled ? 1 : 0;
            if (i != masterIdx)
                continue;
            Track& master = c.model.project.masterTrack;
            if (scan.hasVolumeDb || scan.hasVolumeValue)
                applied = applyModernVolume(c, master, scan.hasVolumeDb, scan.volumeDb,
                                            scan.hasVolumeValue, scan.volumeValue);
            applyChannelPan(c, master, scan);
        }
        if (broke && !parsedAny)
            continue; // element 0 didn't even parse — lookalike bytes; keep scanning
        if (applied) {
            const double g = c.model.project.masterTrack.volume;
            Log::info("cpr import: master output bus volume -> %.4f linear (%+.2f dB)", g,
                      20.0 * std::log10(std::max(g, 1e-6)));
        }
        return; // the VST Mixer output array is a singleton — first match wins
    }
}

// Input buses (Devices "VST Mixer"/"Input Channels", same channel grammar as Output
// Channels) can carry a pan — e.g. the calibration fixture's "Stereo In" panned R15
// (Panner blob pos 0.576923 @0xfff81 in C:\Temp\cpr_stereo\stereo.cpr). MyDAW has no
// input-bus strip, so a non-center input-bus pan is unrepresentable — warn about it
// honestly instead of dropping it silently. Nothing is applied to the model here.
void modernWarnInputBusPans(CprCtx& c, size_t devOff, size_t devEnd) {
    static const uint8_t kKey[] = {0,    0,   0,    15,  'I', 'n', 'p', 'u',
                                   't',  ' ', 'C',  'h', 'a', 'n', 'n', 'e',
                                   'l',  's', 0,    0,   0x02, 0,  0x05};
    for (size_t s = devOff; s + sizeof(kKey) + 4 <= devEnd; ++s) {
        if (std::memcmp(c.b.data() + s, kKey, sizeof(kKey)) != 0)
            continue;
        uint32_t n = 0;
        if (!rdU32(c.b, s + sizeof(kKey), devEnd, n) || n == 0 || n > 64)
            continue; // not the mixer array (lookalike bytes inside a state blob)
        size_t p = s + sizeof(kKey) + 4;
        bool parsedAny = false;
        for (uint32_t i = 0; i < n; ++i) {
            AttrTreeScan scan(c.b, devEnd);
            std::string perr;
            if (!scan.parseTree(p, perr))
                break;
            parsedAny = true;
            p = scan.endOff;
            double pan = 0.0;
            if (scanChannelPan(scan, pan) && std::fabs(pan) > 1e-3 &&
                c.inputBusPanWarns < 8) {
                ++c.inputBusPanWarns;
                Log::warn("cpr import: input bus '%s' is panned %s%d (%.3f) — MyDAW has "
                          "no input-bus pan, NOT imported",
                          scan.channelName.empty() ? "(unnamed)" : scan.channelName.c_str(),
                          pan < 0 ? "L" : "R",
                          static_cast<int>(std::lround(std::fabs(pan) * 100.0)), pan);
            }
        }
        if (parsedAny)
            return; // the VST Mixer input array is a singleton — first match wins
    }
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

struct CprChunk {
    char id[5] = {};
    size_t dataOff = 0;
    size_t size = 0;
};

bool parseContainer(const std::vector<uint8_t>& b, std::vector<CprChunk>& chunks,
                    std::string& err) {
    if (b.size() < 16 || std::memcmp(b.data(), "RIFF", 4) != 0 ||
        std::memcmp(b.data() + 8, "NUND", 4) != 0) {
        err = "not a Cubase project (missing RIFF/NUND header)";
        return false;
    }
    uint32_t riffSize = 0;
    rdU32(b, 4, b.size(), riffSize);
    const size_t end = std::min(b.size(), static_cast<size_t>(riffSize) + 12);
    size_t p = 12;
    while (p + 8 <= end && chunks.size() < kMaxChunks) {
        CprChunk c;
        std::memcpy(c.id, b.data() + p, 4);
        uint32_t sz = 0;
        rdU32(b, p + 4, end, sz);
        c.dataOff = p + 8;
        c.size = sz;
        if (c.dataOff + c.size > end)
            break; // truncated trailing chunk — keep what we have
        chunks.push_back(c);
        p = c.dataOff + c.size; // NO even-padding (unlike standard RIFF)
    }
    if (chunks.empty()) {
        err = "Cubase project contains no chunks";
        return false;
    }
    return true;
}

// ROOT data: two strings, each u32be len + chars (no NUL).
bool readRootNames(const std::vector<uint8_t>& b, const CprChunk& root, std::string& a,
                   std::string& cls) {
    const size_t end = root.dataOff + root.size;
    uint32_t len1 = 0;
    if (!rdU32(b, root.dataOff, end, len1) || len1 > 256 ||
        root.dataOff + 4 + len1 > end)
        return false;
    a.assign(reinterpret_cast<const char*>(b.data() + root.dataOff + 4), len1);
    const size_t p2 = root.dataOff + 4 + len1;
    uint32_t len2 = 0;
    if (!rdU32(b, p2, end, len2) || len2 > 256 || p2 + 4 + len2 > end)
        return false;
    cls.assign(reinterpret_cast<const char*>(b.data() + p2 + 4), len2);
    return true;
}

bool rootNamesArrangement(const std::vector<uint8_t>& b, const CprChunk& root) {
    std::string a, cls;
    return readRootNames(b, root, a, cls) && cls == "PArrangement";
}

} // namespace

// ===========================================================================
// Provider
// ===========================================================================

bool CprImportProvider::probe(const std::string& absPath, std::string& whyNot) const {
    uint8_t head[12] = {};
    size_t got = 0;
    if (!readHead(absPath, head, sizeof(head), got)) {
        whyNot = "cannot open file";
        return false;
    }
    if (got >= 12 && std::memcmp(head, "RIFF", 4) == 0 &&
        std::memcmp(head + 8, "NUND", 4) == 0)
        return true;
    whyNot = "not a Cubase project (missing RIFF/NUND header)";
    return false;
}

bool CprImportProvider::import(const std::string& absPath, const ImportContext& ctx,
                               Model& out, std::string& err) {
    if (ctx.progress)
        ctx.progress(0.0f);

    std::vector<uint8_t> bytes;
    if (!readAllBytes(absPath, bytes)) {
        err = "cannot open file: " + absPath;
        return false;
    }
    std::vector<CprChunk> chunks;
    if (!parseContainer(bytes, chunks, err))
        return false;
    if (ctx.progress)
        ctx.progress(0.1f);

    // The project content is the ARCH paired with the "...|PArrangement" ROOT. Fall back
    // to the first ARCH containing an MTrackList if the ROOT naming is unexpected.
    ArchWalker* walker = nullptr;
    std::unique_ptr<ArchWalker> owned;
    const CprChunk* arrChunk = nullptr;
    auto tryArch = [&](const CprChunk& c) -> bool {
        if (c.size < 8)
            return false;
        auto w = std::make_unique<ArchWalker>(bytes, c.dataOff, c.size);
        w->run();
        if (w->truncated)
            Log::warn("cpr import: archive record scan truncated at %zu records",
                      w->recs.size());
        for (const Rec& r : w->recs)
            if (r.name == "MTrackList") {
                owned = std::move(w);
                walker = owned.get();
                arrChunk = &c;
                return true;
            }
        return false;
    };
    for (size_t i = 0; !walker && i + 1 < chunks.size(); ++i)
        if (std::memcmp(chunks[i].id, "ROOT", 4) == 0 &&
            std::memcmp(chunks[i + 1].id, "ARCH", 4) == 0 &&
            rootNamesArrangement(bytes, chunks[i]))
            tryArch(chunks[i + 1]);
    for (size_t i = 0; !walker && i < chunks.size(); ++i)
        if (std::memcmp(chunks[i].id, "ARCH", 4) == 0)
            tryArch(chunks[i]);
    if (!walker) {
        err = "no Cubase arrangement found (no MTrackList in any archive) — file may be "
              "from an unsupported Cubase variant or corrupt";
        return false;
    }
    if (ctx.progress)
        ctx.progress(0.4f);

    CprCtx c{bytes, walker->recs, walker->names, walker->base(), out, ctx};
    c.cprDir = parentDir(absPath);

    // --- era detection (CPR_MIXER_FORMAT.md §0) ------------------------------
    // Authoritative: Version|PAppVersion string; structural cross-check: the Devices
    // ARCH class (SX = FMemoryStream binary device blobs, C5+ = FAttributes attr tree).
    const CprChunk* devArch = nullptr;
    bool devIsMemoryStream = false;
    std::string appVersion, appVerNum, appYear, appPlatform;
    for (size_t i = 0; i + 1 < chunks.size(); ++i) {
        if (std::memcmp(chunks[i].id, "ROOT", 4) != 0 ||
            std::memcmp(chunks[i + 1].id, "ARCH", 4) != 0)
            continue;
        std::string streamName, streamClass;
        if (!readRootNames(bytes, chunks[i], streamName, streamClass))
            continue;
        if (streamName == "Devices") {
            devArch = &chunks[i + 1];
            devIsMemoryStream = streamClass == "FMemoryStream";
        } else if (streamClass == "PAppVersion") {
            const CprChunk& va = chunks[i + 1];
            const size_t vaEnd = va.dataOff + va.size;
            for (size_t p = va.dataOff; p + 6 <= vaEnd; ++p) {
                if (std::memcmp(bytes.data() + p, "Cubase", 6) != 0)
                    continue;
                size_t e = p;
                while (e < vaEnd && bytes[e] >= 0x20 && bytes[e] < 0x7F)
                    ++e;
                appVersion = sanitizeUtf8(bytes.data() + p, e - p);
                // Provenance (byte-verified layout): the app-name lpstr is followed by
                // `lpstr "Version x.y.z"`, `lpstr "Mmm dd yyyy"` (build date), a u32 and
                // `lpstr platform` ("WIN32"/"WIN64"). Each is u32be len + chars + NUL —
                // readLpstr's exact shape. Best-effort: any mismatch leaves fields "".
                uint32_t nameLen = 0;
                if (p >= va.dataOff + 4 && rdU32(bytes, p - 4, vaEnd, nameLen) &&
                    (nameLen == e - p || nameLen == e - p + 1)) {
                    const LpStr ver = readLpstr(bytes, p + nameLen, vaEnd);
                    if (ver.ok && ver.text.rfind("Version ", 0) == 0 &&
                        ver.text.size() <= 40)
                        appVerNum = trimSpaces(ver.text.substr(8));
                    if (ver.ok) {
                        const LpStr date = readLpstr(bytes, ver.next, vaEnd);
                        if (date.ok && date.text.size() >= 4 && date.text.size() <= 24) {
                            const size_t sp = date.text.find_last_of(' ');
                            const std::string y = sp == std::string::npos
                                                      ? date.text
                                                      : date.text.substr(sp + 1);
                            if (y.size() == 4 &&
                                std::all_of(y.begin(), y.end(), [](char ch) {
                                    return ch >= '0' && ch <= '9';
                                }))
                                appYear = y;
                            // u32 (build number?) sits between date and platform.
                            const LpStr plat = readLpstr(bytes, date.next + 4, vaEnd);
                            if (plat.ok && plat.text.size() >= 3 && plat.text.size() <= 8)
                                appPlatform = plat.text;
                        }
                    }
                }
                break;
            }
        }
    }
    c.isSxEra = devArch ? devIsMemoryStream
                        : (appVersion.find(" SX") != std::string::npos ||
                           appVersion.find(" SL") != std::string::npos ||
                           appVersion.find(" VST") != std::string::npos);

    // Plugin provenance for the Recreate dialog (PluginInstance.sourceHint): vendors ship
    // identically-named plugins for decades — the source project's vintage tells the user
    // which era (and bitness) of a plugin to hunt for. Stamped on every dormant insert by
    // addDormantInsert. Fixture truth: "Cubase 5.1.1 project, 2009; 32-bit era".
    c.sourceHint = appVersion.empty() ? "Cubase" : appVersion;
    if (!appVerNum.empty())
        c.sourceHint += " " + appVerNum;
    c.sourceHint += " project";
    if (!appYear.empty())
        c.sourceHint += ", " + appYear;
    if (appPlatform == "WIN32" || appPlatform == "MAC32" ||
        (appPlatform.empty() && c.isSxEra))
        c.sourceHint += "; 32-bit era";
    else if (appPlatform == "WIN64" || appPlatform == "MAC64")
        c.sourceHint += "; 64-bit era";

    // --- project-level fields ----------------------------------------------
    out.project.name = fileStem(absPath);
    out.project.sampleRate = ctx.sessionSampleRate;

    std::vector<TempoEntry> tempo;
    const Rec* te = nullptr;
    for (const Rec& r : walker->recs)
        if (r.name == "MTempoTrackEvent") {
            te = &r;
            break;
        }
    if (te && parseTempo(c, *te, tempo)) {
        out.project.tempoMap = tempo;
    } else {
        Log::warn("cpr import: tempo %s — defaulting to 120 bpm",
                  te ? "undecodable" : "record not found");
        out.project.tempoMap = {TempoEntry{0.0, 120.0}};
    }
    c.bpm0 = out.project.tempoMap.front().bpm;

    std::vector<TimeSigEntry> sigs;
    const Rec* se = nullptr;
    for (const Rec& r : walker->recs)
        if (r.name == "MSignatureTrackEvent") {
            se = &r;
            break;
        }
    if (se && parseSignature(c, *se, sigs)) {
        out.project.timeSigMap = sigs;
    } else {
        Log::warn("cpr import: time signature %s — defaulting to 4/4",
                  se ? "undecodable" : "record not found");
        out.project.timeSigMap = {TimeSigEntry{0, 4, 4}};
    }
    if (ctx.progress)
        ctx.progress(0.5f);

    // --- audio clip pre-pass (also enables clip-id link resolution) ---------
    for (const Rec& r : walker->recs)
        if (r.name == "PAudioClip")
            parseAudioClipRecord(c, r);

    // --- track tree ----------------------------------------------------------
    const Rec* tl = nullptr;
    for (const Rec& r : walker->recs)
        if (r.name == "MTrackList") {
            tl = &r;
            break;
        }
    std::vector<const Rec*> trackRecs;
    for (const Rec& r : walker->recs)
        if (isTrackRecord(r.name) && r.hdrOff >= tl->dataStart && r.dataEnd <= tl->dataEnd)
            trackRecs.push_back(&r);
    buildTracks(c, trackRecs, tl->dataStart, tl->dataEnd, 0, 0);
    if (ctx.progress)
        ctx.progress(0.85f);

    // --- mixer: insert chains + instruments as DORMANT plugin inserts -------
    if (c.isSxEra) {
        sxExtractTrackInserts(c);
        if (devArch)
            sxExtractVstiRack(c, devArch->dataOff, devArch->size);
        else
            Log::warn("cpr import: no Devices stream — SX VSTi rack not imported");
    } else {
        modernExtractTracks(c, arrChunk->dataOff, arrChunk->dataOff + arrChunk->size);
        if (devArch) {
            std::pair<size_t, size_t> rackRange{0, 0};
            modernExtractSynthRack(c, devArch->dataOff, devArch->dataOff + devArch->size,
                                   rackRange);
            modernCountDeviceInserts(c, devArch->dataOff,
                                     devArch->dataOff + devArch->size, rackRange);
            modernExtractMasterBus(c, devArch->dataOff,
                                   devArch->dataOff + devArch->size);
            modernWarnInputBusPans(c, devArch->dataOff,
                                   devArch->dataOff + devArch->size);
        }
        // MIDI tracks -> instrument tracks (§7.7): rack slots when a Devices rack
        // exists, Synth-Slot ordinals otherwise (MyDAW's own exports) — so it must run
        // AFTER both the arrangement and Devices passes.
        wireModernMidiRouting(c);
    }
    // MyDAW's OWN exports (Synth-Slot ordinal routing, no Devices rack) collapse the
    // MIDI-track + Synth-Slot pairs back into the original Instrument tracks. Native
    // Cubase projects keep the MIDI/rack split: arrangement MIDI tracks stay kind Midi
    // and route into the rack's standalone Instrument tracks via Track::midiTarget.
    if (c.synthSlotOrdinalRouting)
        collapseFeederTracks(c);
    if (c.isSxEra)
        Log::info("cpr import: SX-era master-bus volume not imported — no verified "
                  "encoding for the SX output-channel block in the corpus (master left "
                  "at 0 dB)");

    // Metronome click state -> transient model hint (Api::importForeignPath applies it to
    // the Transport, SPEC §5.4). Modern projects: 'clickEnable' captured from the VST
    // Mixer output-bus channel above; otherwise (SX-era binary Devices blobs, unusual
    // layouts) fall back to a grammar-anchored whole-file scan — silently absent when the
    // era never wrote the key. Absent = the session's metronome state is left untouched.
    if (c.clickEnable < 0)
        c.clickEnable = scanClickEnable(c, 0, c.b.size());
    out.importMetronomeEnabled = c.clickEnable;
    if (c.clickEnable >= 0)
        Log::info("cpr import: source project metronome click %s",
                  c.clickEnable ? "enabled" : "disabled");
    if (ctx.progress)
        ctx.progress(0.9f);

    if (out.project.tracks.empty()) {
        err = "Cubase project contains no importable tracks (MIDI/instrument/audio)";
        return false;
    }
    out.project.loop = LoopRegion{0.0, std::max(c.songEndBeats, 8.0), false};

    Log::info("cpr import: '%s' (%s, %s era) -> %d tracks (%d skipped: device/arranger/"
              "marker, %d empty folders dropped), %d notes, %d cc, %d audio clips",
              fileName(absPath).c_str(),
              appVersion.empty() ? "unknown Cubase version" : appVersion.c_str(),
              c.isSxEra ? "SX" : "modern", c.tracksImported, c.tracksSkipped,
              c.foldersDropped, c.notes, c.ccEvents, c.audioClips);
    Log::info("cpr import: %d dormant inserts + %d instruments imported (%d new instrument "
              "tracks; %d feeder MIDI track(s) merged in, %d promoted with cloned chains, "
              "%d unrouted converted); %d mixer channels seen; %d plugins on non-imported "
              "channels skipped",
              c.insertsImported, c.instrumentsImported, c.instrumentTracksCreated,
              c.mergedFeederTracks, c.clonedInstrumentTracks, c.convertedMidiTracks,
              c.channelsSeen, c.insertsSkippedNonTrack);
    if (c.isSxEra && (c.routedInstruments || c.routedMidiTracks || !c.midiRoutes.empty()))
        Log::info("cpr import: SX MIDI->rack routing -> %d MIDI track(s) routed via "
                  "midiTarget to %d shared rack instrument track(s); %zu MIDI track(s) "
                  "carried an output-routing Device Name (channel captured, unused)",
                  c.routedMidiTracks, c.routedInstruments, c.midiRoutes.size());
    Log::info("cpr import: channel mixer -> %d volumes + %d pans imported (%d gains clamped "
              "to +12 dB)%s; %d channel EQs imported into Track.eq (%d EQ members had no "
              "decodable bands); sends not imported (%d send slots skipped — all empty/"
              "inactive in corpus, destinations resolve to FX/group channels not modeled in v1)",
              c.volumesImported, c.pansImported, c.gainsClamped,
              c.isSxEra ? " (SX volume decoded via the calibrated 25856-taper, exact to "
                          "<1e-6 dB on modern calibration pairs)"
                        : "",
              c.eqsImported, c.eqsSkipped, c.sendsSkipped);
    Log::info("cpr import: audio relink -> %d resolved via recursive folder scan, %d left "
              "missing (indexed %zu audio files under '%s')",
              c.audioResolvedByScan, c.missingAudioFiles, c.audioIndex.size(),
              c.cprDir.c_str());
    // Rack instruments nothing feeds (both eras) are dropped by collapseFeederTracks —
    // they live only in Cubase's hidden rack panel and are silent in the arrangement.
    if (c.unroutedInstruments > 0)
        Log::warn("cpr import: %d rack instrument(s) had no MIDI track routed to them — "
                  "skipped (rack-only, silent in the arrangement)",
                  c.unroutedInstruments);
    if (c.channelParseFails || c.statelessPlugins)
        Log::warn("cpr import: %d channel decode failures, %d plugins imported without "
                  "state",
                  c.channelParseFails, c.statelessPlugins);
    if (c.droppedNotes || c.skippedMidiEvents || c.partAborts || c.unresolvedAudio ||
        c.missingAudioFiles)
        Log::warn("cpr import: skipped %d hidden notes, %d unsupported MIDI events "
                  "(sysex/program/poly-pressure), %d part decode aborts, %d unresolved audio "
                  "events, %d missing audio files",
                  c.droppedNotes, c.skippedMidiEvents, c.partAborts, c.unresolvedAudio,
                  c.missingAudioFiles);

    if (ctx.progress)
        ctx.progress(1.0f);
    return true;
}

} // namespace mydaw
