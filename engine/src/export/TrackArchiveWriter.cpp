// MyDAW — export/TrackArchiveWriter.cpp. See TrackArchiveWriter.h.
//
// Grammar source of truth: docs/CPR_TRACK_ARCHIVE_WRITER_SPEC.md (byte-verified against
// Reversing/CubaseFileFormat/Mixer Volume/exported_tracks/exported_tracks.xml, C5.1.1).
// EVIDENCED constructs are emitted byte-faithfully (CRLF, 3-space indents, TAB-indented
// <bin> hex at depth+1, define-on-first-use obj IDs, the 23-child DeviceAttributes order,
// default EQ/send/panner blocks as literal constants). Constructs the spec marks OPEN are
// flagged "INFERRED" in comments below and produce one warning per construct per export.

#include "export/TrackArchiveWriter.h"

#include <algorithm>
#include <bit>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>

#include "plugins/HostProcess.h"
#include "project/Model.h"
#include "util/Paths.h"

namespace mydaw {

namespace {

// ---------------------------------------------------------------------------
// Formatting helpers (spec §2.3 / §6 writer rules)
// ---------------------------------------------------------------------------

// Shortest decimal that round-trips the IEEE double, no exponent notation, no trailing
// zeros, integer-valued doubles without a decimal point (spec §2.3: std::to_chars
// reproduces every float in the sample).
std::string fmtDouble(double v) {
    if (!std::isfinite(v))
        v = 0.0; // never occurs on sane models; keep the file well-formed
    char buf[64];
    const auto res = std::to_chars(buf, buf + sizeof(buf), v);
    std::string s(buf, res.ptr);
    if (s.find('e') == std::string::npos && s.find('E') == std::string::npos)
        return s;
    // Exponent form (values far outside the corpus range): expand to the shortest fixed
    // notation that still round-trips.
    for (int prec = 0; prec <= 17; ++prec) {
        const auto r2 = std::to_chars(buf, buf + sizeof(buf), v, std::chars_format::fixed,
                                      prec);
        std::string t(buf, r2.ptr);
        double back = 0.0;
        std::from_chars(t.data(), t.data() + t.size(), back);
        if (back == v) {
            if (t.find('.') != std::string::npos) {
                while (!t.empty() && t.back() == '0')
                    t.pop_back();
                if (!t.empty() && t.back() == '.')
                    t.pop_back();
            }
            return t;
        }
    }
    return s;
}

// Standard XML attribute escaping (INFERRED per spec §2.3 — no escapes occur in the
// sample; the oracle unescapes these five).
std::string esc(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '&': out += "&amp;"; break;
            case '<': out += "&lt;"; break;
            case '>': out += "&gt;"; break;
            case '"': out += "&quot;"; break;
            case '\'': out += "&apos;"; break;
            default: out += c; break;
        }
    }
    return out;
}

std::string hexUpper(const std::vector<uint8_t>& bytes) {
    static const char* kHex = "0123456789ABCDEF";
    std::string out;
    out.reserve(bytes.size() * 2);
    for (uint8_t b : bytes) {
        out += kHex[b >> 4];
        out += kHex[b & 0x0F];
    }
    return out;
}

bool readFileBytes(const std::string& path, std::vector<uint8_t>& out) {
    out.clear();
    std::ifstream f(utf8ToWide(path).c_str(), std::ios::binary | std::ios::ate);
    if (!f.is_open())
        return false;
    const std::streamsize size = f.tellg();
    if (size <= 0)
        return false;
    out.resize(static_cast<size_t>(size));
    f.seekg(0);
    f.read(reinterpret_cast<char*>(out.data()), size);
    return f.good();
}

// ---------------------------------------------------------------------------
// Fader taper — inverse of scripts/cpr-taper.mjs (calibrated, 25856 = 0 dB).
// Piecewise in LINEAR GAIN with round hex knots (CPR_MIXER_FORMAT §1).
// ---------------------------------------------------------------------------
double gainToVolumeValue(double g) {
    if (g >= 1.0)
        return 25856.0 + (g - 1.0) * 6911.0; // 25856..32767 (gain 1..2), extrapolates above
    if (g >= 0.5)
        return 18688.0 + (g - 0.5) * 14336.0; // 18688..25856
    return 18688.0 * std::sqrt(2.0 * g);      // parabola inverse, 0..18688
}

// ---------------------------------------------------------------------------
// XML emitter — CRLF lines, 3 spaces per depth, <bin> content = depth+1 TABS (spec §1/§2.6)
// ---------------------------------------------------------------------------
struct Xw {
    std::string out;
    int depth = 0;
    uint32_t idCounter = 100000000; // any unique decimal uint32 works (spec §7.2)

    uint32_t newId() { return idCounter++; }

    void raw(const char* s) { out += s; }
    void line(const std::string& s) {
        out.append(static_cast<size_t>(depth) * 3, ' ');
        out += s;
        out += "\r\n";
    }
    void open(const std::string& tag) {
        line(tag);
        ++depth;
    }
    void close(const char* tag) {
        --depth;
        line(std::string("</") + tag + ">");
    }

    void intVal(const char* name, long long v) {
        line(std::string("<int name=\"") + name + "\" value=\"" + std::to_string(v) +
             "\"/>");
    }
    void floatVal(const char* name, double v) {
        line(std::string("<float name=\"") + name + "\" value=\"" + fmtDouble(v) + "\"/>");
    }
    // Verbatim float constant from the sample (default EQ doubles etc. — emitted as
    // literal strings so the boilerplate stays byte-identical to what C5 wrote).
    void floatLit(const char* name, const char* lit) {
        line(std::string("<float name=\"") + name + "\" value=\"" + lit + "\"/>");
    }
    void strVal(const char* name, const std::string& v, bool wide) {
        line(std::string("<string name=\"") + name + "\" value=\"" + esc(v) + "\"" +
             (wide ? " wide=\"true\"" : "") + "/>");
    }
    // <bin>: open tag CRLF, ONE content line indented with (element depth + 1) TABS,
    // close tag at normal indentation. Empty blob = open + close only (spec §2.6).
    // NOTE: line-wrap width for multi-KB blobs is NOT evidenced (spec OPEN) — we emit a
    // single line regardless of size.
    void bin(const char* name, const std::string& hex) {
        line(std::string("<bin name=\"") + name + "\">");
        if (!hex.empty()) {
            out.append(static_cast<size_t>(depth) + 1, '\t');
            out += hex;
            out += "\r\n";
        }
        line("</bin>");
    }
    void openMember(const char* name) {
        open(std::string("<member name=\"") + name + "\">");
    }
    void closeMember() { close("member"); }
    void openList(const char* name, const char* type) {
        open(std::string("<list name=\"") + name + "\" type=\"" + type + "\">");
    }
    void closeList() { close("list"); }
    // <obj class [name] ID> — attribute order class, name, ID (spec §2.1).
    uint32_t openObj(const char* cls, const char* name) {
        const uint32_t id = newId();
        std::string t = std::string("<obj class=\"") + cls + "\"";
        if (name)
            t += std::string(" name=\"") + name + "\"";
        t += " ID=\"" + std::to_string(id) + "\">";
        open(t);
        return id;
    }
    void closeObj() { close("obj"); }
    // Cross-reference: self-closing, keeps the definition's name, no class (spec §2.1).
    void objRef(const char* name, uint32_t id) {
        line(std::string("<obj name=\"") + name + "\" ID=\"" + std::to_string(id) +
             "\"/>");
    }
};

// ---------------------------------------------------------------------------
// Export context
// ---------------------------------------------------------------------------
struct Ctx {
    const Model& model;
    HostProcessManager* host = nullptr;
    std::string projectDir;
    std::vector<std::string>* warnings = nullptr;

    double bpm = 120.0;
    int tsNum = 4;
    int tsDen = 4;
    double lengthTicks = 576000.0; // track-event span, 480 PPQ (sample default = 600 s)

    uint32_t tempoId = 0;
    uint32_t sigId = 0;
    bool wroteTempoDef = false; // define-on-first-use: first track's Node > Domain

    int busUidCounter = 12;    // sample starts OwnInputBus "Bus UID" at 12
    int audioNameCounter = 1;  // "Audio N" narrow channel naming

    // per-export accumulators / once-per-construct warning latches
    int audioClipsSkipped = 0;
    int ccEventsSkipped = 0;
    int sendsSkipped = 0;
    bool warnedMidiShape = false;
    bool warnedInstShape = false;
    bool warnedBusShape = false;
    bool warnedPartShape = false;
    bool warnedInsertShape = false;

    void warn(const std::string& msg) {
        if (warnings)
            warnings->push_back(msg);
    }
};

// ---------------------------------------------------------------------------
// Shared boilerplate blocks (all EVIDENCED verbatim from the sample)
// ---------------------------------------------------------------------------

// <list name="Type" type="int"> [1,2] — stereo speaker-arrangement pair used everywhere.
// Mono form [1] is INFERRED (spec §2.5: not present in the sample).
void emitTypeIntList(Xw& x, int channels) {
    x.openList("Type", "int");
    x.line("<item value=\"1\"/>");
    if (channels >= 2)
        x.line("<item value=\"2\"/>");
    x.closeList();
}

void emitArrangement(Xw& x, const char* name, int channels) {
    x.openList(name, "list");
    x.open("<item>");
    emitTypeIntList(x, channels);
    x.close("item");
    x.closeList();
}

// Standard Panner component-state hex (CPR_MIXER_FORMAT §5a, LITTLE-endian): f32 pan
// position (0 = hard L, 0.5 = C, 1 = hard R; Cubase UI shows (pos-0.5)*200), f32 0.5
// (right position — balance panner), u32 mode (channel 4 / send 1), u32 channelCount 2,
// u32 0. Modern Cubase (13+) reads the channel pan ONLY from this blob — a
// hardcoded centered blob would erase the pan when the archive is imported into C13+.
std::string pannerComponentHex(double pan, bool channelVariant) {
    const uint32_t pos = std::bit_cast<uint32_t>(
        static_cast<float>(0.5 + std::clamp(pan, -1.0, 1.0) * 0.5));
    char buf[48];
    std::snprintf(buf, sizeof(buf), "%02X%02X%02X%02X0000003F%02X0000000200000000000000",
                  pos & 0xff, (pos >> 8) & 0xff, (pos >> 16) & 0xff, (pos >> 24) & 0xff,
                  channelVariant ? 4 : 1);
    return buf;
}

// Panner block (spec §3.4.3). channelVariant=true → PannerType 2 / Active 1 / component
// dword3 = 04 and the channel pan in the component state; false → send/foldback variant
// (PannerType 3 / Active 0 / dword3 = 01, always centered).
void emitPanner(Xw& x, bool channelVariant, int channels, double pan = 0.0) {
    x.openMember("Panner");
    x.openMember("Default SurroundPan UID");
    x.strVal("GUID", "56535453506132737572726F756E6470", true);
    x.closeMember();
    x.openMember("PannerType");
    x.intVal("Value", channelVariant ? 2 : 3);
    x.intVal("Min", 0);
    x.intVal("Max", 11);
    x.closeMember();
    x.openMember("Plugin UID");
    x.strVal("GUID", "44E1149EDB3E4387BDD827FEA3A39EE7", true);
    x.closeMember();
    x.strVal("Plugin Name", "Standard Panner", true);
    x.intVal("Audio Input Count", 1);
    emitArrangement(x, "Audio Input Arrangement", channels);
    x.intVal("Audio Output Count", 1);
    emitArrangement(x, "Audio Output Arrangement", channels);
    x.intVal("Event Input Count", 0);
    x.intVal("Event Output Count", 0);
    x.bin("audioComponent", pannerComponentHex(pan, channelVariant));
    x.bin("editController", "");
    x.intVal("Editor Width", 0);
    x.intVal("Editor Height", 0);
    x.intVal("Active", channelVariant ? 1 : 0);
    x.strVal("IDString", "Panner", true);
    x.strVal("Bay Program", "", true);
    x.closeMember();
}

// Inactive send/foldback slot (spec §3.4.2 — all sends are exported inactive; MyDAW sends
// are skipped like the importer skips them).
void emitEmptySendSlot(Xw& x, int channels) {
    x.open("<item>");
    x.openMember("Volume");
    x.floatLit("Value", "0");
    x.floatLit("AnchorValue", "0");
    x.closeMember();
    x.openMember("Output");
    x.intVal("Value", 0);
    x.closeMember();
    emitPanner(x, false, channels);
    x.close("item");
}

void emitSendFolder(Xw& x, const char* memberName, int slotCount, int channels) {
    x.openMember(memberName);
    x.intVal("Bypass", 0);
    x.intVal("SeparationPosition", 6);
    x.openList("Slot", "list");
    for (int i = 0; i < slotCount; ++i)
        emitEmptySendSlot(x, channels);
    x.closeList();
    x.closeMember();
}

// Default EQ band constants — the exact doubles C5 wrote (spec §3.4.1), emitted verbatim.
struct DefBand {
    const char* type;
    const char* freq;
    const char* q;
};
constexpr DefBand kDefBands[4] = {
    {"5", "99.999992370605469", "0.59093010425567627"},
    {"1", "799.99981689453125", "0.027763502672314644"},
    {"1", "2000", "0.027763502672314644"},
    {"5", "12000.0009765625", "0.59093010425567627"},
};

// EQ member: MyDAW TrackEq bands map 1:1 into the first N of 4 band slots (our type enum
// passes through — same convention the .cpr importer uses); unused slots keep the C5
// defaults. >4 bands → truncated with a warning.
void emitEq(Xw& x, Ctx& c, const Track& t) {
    const TrackEq& eq = t.eq;
    if (eq.bands.size() > 4)
        c.warn("track '" + t.name + "': EQ has " + std::to_string(eq.bands.size()) +
               " bands — Cubase channel EQ carries 4, extra bands truncated");
    x.openMember("EQ");
    x.intVal("Bypass", eq.bypass ? 1 : 0);
    x.openList("Band", "list");
    for (int i = 0; i < 4; ++i) {
        x.open("<item>");
        if (i < static_cast<int>(eq.bands.size())) {
            const EqBand& b = eq.bands[static_cast<size_t>(i)];
            x.intVal("Enable", b.enabled ? 1 : 0);
            x.intVal("Type", b.type);
            x.floatVal("Gain", b.gainDb);
            x.floatVal("Freq", b.freqHz);
            x.floatVal("Q", b.q);
        } else {
            x.intVal("Enable", 0);
            x.line(std::string("<int name=\"Type\" value=\"") + kDefBands[i].type +
                   "\"/>");
            x.floatLit("Gain", "0");
            x.floatLit("Freq", kDefBands[i].freq);
            x.floatLit("Q", kDefBands[i].q);
        }
        x.close("item");
    }
    x.closeList();
    x.closeMember();
}

// Volume member (spec §3.4 row 5 + writer rule 3): Value = calibrated 25856-taper of the
// linear gain, AnchorValue = 0 (the C5 quirk the sample evidences; the .cpr importer's
// applyModernVolume falls back to the taper when AnchorValue is 0). -inf fader = the
// modern Value -1 / AnchorValue -200 pair.
void emitVolume(Xw& x, Ctx& c, const Track& t) {
    double g = t.volume;
    if (g > 4.0) {
        c.warn("track '" + t.name + "': volume gain " + fmtDouble(g) +
               " clamped to 4.0 (+12 dB, Cubase fader ceiling)");
        g = 4.0;
    }
    x.openMember("Volume");
    if (g <= 0.0) {
        x.floatLit("Value", "-1");
        x.floatLit("AnchorValue", "-200");
    } else {
        x.floatVal("Value", gainToVolumeValue(g));
        x.floatLit("AnchorValue", "0");
    }
    x.closeMember();
}

// Quick Controls boilerplate (spec §3.4.5 — pure constants, 8 empty destinations).
void emitQuickControls(Xw& x) {
    x.openMember("Quick Controls");
    x.intVal("NumberOfQuickControls", 8);
    x.openObj("CmArray", "QCDestinations");
    x.intVal("ownership", 1);
    x.openList("obj", "obj");
    for (int i = 0; i < 8; ++i) {
        x.openObj("QCDestinationValue", nullptr);
        x.intVal("ParameterTag", -1);
        x.strVal("NodePath", "", true);
        x.strVal("OriginalName", "", true);
        x.intVal("IsRelativePath", 0);
        x.strVal("String", "", true);
        x.closeObj();
    }
    x.closeList();
    x.closeObj();
    x.strVal("DeviceNode Name", "Quick Controls", true);
    x.strVal("ClassName", "Quick Controls", false);
    x.strVal("IDString", "Quick Controls", false);
    x.intVal("NodeFlags", 0);
    x.intVal("NumberClassIDs", 2);
    x.openList("ClassIDs", "string");
    x.line("<item value=\"AB9705CD467B4D7A946C8860C504F492\"/>");
    x.line("<item value=\"CA1729D088FC4857937F78CC37D45B48\"/>");
    x.closeList();
    x.closeMember();
}

// ---------------------------------------------------------------------------
// Insert plugins (whole construct INFERRED — spec §5: a loaded insert slot's XML shape is
// OPEN; member names/order predicted from the binary schema
// Slot{Plugin isA:"VstCtrlInternalEffect"{UID,Name,audioComponent,...}, WasEnableBeforeFreeze,
// State:1} with the Panner block (§3.4.3) as the plugin-body grammar template. Patcher
// (routing) is deliberately NOT emitted — its shape is unknown and inventing it is riskier
// than omitting it.)
// ---------------------------------------------------------------------------

struct InsertBlob {
    std::string guid;    // 32 uppercase hex
    std::string name;    // display name
    std::string compHex; // audioComponent bytes
    std::string ctrlHex; // editController bytes ("" = empty blob)
};

void pushU32be(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back(static_cast<uint8_t>(x >> 24));
    v.push_back(static_cast<uint8_t>(x >> 16));
    v.push_back(static_cast<uint8_t>(x >> 8));
    v.push_back(static_cast<uint8_t>(x));
}
void pushTag(std::vector<uint8_t>& v, const char* t4) {
    v.insert(v.end(), t4, t4 + 4);
}

// 'VST' + fourcc + lowercased plugin name, NUL-padded to 16 bytes → 32 uppercase hex
// (CPR_MIXER_FORMAT §3 wrapper-GUID form, evidenced in XML by the surround-pan GUID).
std::string vst2WrapperGuid(uint32_t fourcc, const std::string& name) {
    std::vector<uint8_t> bytes(16, 0);
    bytes[0] = 'V';
    bytes[1] = 'S';
    bytes[2] = 'T';
    bytes[3] = static_cast<uint8_t>(fourcc >> 24);
    bytes[4] = static_cast<uint8_t>(fourcc >> 16);
    bytes[5] = static_cast<uint8_t>(fourcc >> 8);
    bytes[6] = static_cast<uint8_t>(fourcc);
    for (size_t i = 0; i < 9 && i < name.size(); ++i) {
        char ch = name[i];
        if (ch >= 'A' && ch <= 'Z')
            ch = static_cast<char>(ch - 'A' + 'a');
        bytes[7 + i] = static_cast<uint8_t>(ch);
    }
    return hexUpper(bytes);
}

// VST2 audioComponent: 'VstW' header (u32be 8, version 1, bypass 0) + fxb 'CcnK'/'FBCh'
// image wrapping our raw effGetChunk bytes (CPR_MIXER_FORMAT §4).
std::vector<uint8_t> buildVst2Component(uint32_t fxId, const std::vector<uint8_t>& chunk) {
    std::vector<uint8_t> v;
    v.reserve(chunk.size() + 176);
    pushTag(v, "VstW");
    pushU32be(v, 8);
    pushU32be(v, 1);
    pushU32be(v, 0);
    pushTag(v, "CcnK");
    // byteSize counts everything after the CcnK+byteSize fields:
    // fxMagic(4) + version(4) + fxID(4) + fxVersion(4) + numPrograms(4) + reserved(128) +
    // chunkSize(4) + chunk
    pushU32be(v, 152 + static_cast<uint32_t>(chunk.size()));
    pushTag(v, "FBCh");
    pushU32be(v, 1);    // version
    pushU32be(v, fxId); // fxID = VST2 uniqueID
    pushU32be(v, 1);    // fxVersion
    pushU32be(v, 1);    // numPrograms
    v.insert(v.end(), 128, 0);
    pushU32be(v, static_cast<uint32_t>(chunk.size()));
    v.insert(v.end(), chunk.begin(), chunk.end());
    return v;
}

// MyDAW VST3 state container: u32le 'MD3S', u32le compLen, comp, u32le ctrlLen, ctrl
// (the framing modToXPlugin/ProjectIO uses). Component → audioComponent, ctrl →
// editController.
bool unwrapMd3s(const std::vector<uint8_t>& s, std::vector<uint8_t>& comp,
                std::vector<uint8_t>& ctrl) {
    if (s.size() < 12 || s[0] != 'M' || s[1] != 'D' || s[2] != '3' || s[3] != 'S')
        return false;
    auto u32le = [&](size_t o) {
        return static_cast<uint32_t>(s[o]) | (static_cast<uint32_t>(s[o + 1]) << 8) |
               (static_cast<uint32_t>(s[o + 2]) << 16) |
               (static_cast<uint32_t>(s[o + 3]) << 24);
    };
    const size_t compLen = u32le(4);
    if (8 + compLen + 4 > s.size())
        return false;
    const size_t ctrlOff = 8 + compLen;
    const size_t ctrlLen = u32le(ctrlOff);
    if (ctrlOff + 4 + ctrlLen > s.size())
        return false;
    comp.assign(s.begin() + 8, s.begin() + 8 + static_cast<std::ptrdiff_t>(compLen));
    ctrl.assign(s.begin() + static_cast<std::ptrdiff_t>(ctrlOff + 4),
                s.begin() + static_cast<std::ptrdiff_t>(ctrlOff + 4 + ctrlLen));
    return true;
}

bool obtainState(Ctx& c, const PluginInstance& pi, std::vector<uint8_t>& chunk) {
    chunk.clear();
    if (c.host && c.host->getState(pi.instanceId, chunk) && !chunk.empty())
        return true; // live host state wins (mirrors ProjectIO::capturePluginStates)
    chunk.clear();
    if (!pi.stateFile.empty() && !c.projectDir.empty())
        readFileBytes(pathJoin(c.projectDir, pi.stateFile), chunk);
    return !chunk.empty();
}

// Prepares the GUID/state blobs for one insert. False (with a warning) = skip the slot.
bool prepareInsert(Ctx& c, const Track& t, const PluginInstance& pi, InsertBlob& out) {
    if (pi.format == "builtin") {
        c.warn("track '" + t.name + "': built-in effect '" + pi.name +
               "' skipped (no Cubase equivalent)");
        return false;
    }
    if (pi.format != "vst2" && pi.format != "vst3") {
        c.warn("track '" + t.name + "': insert '" + pi.name + "' skipped (unknown format '" +
               pi.format + "')");
        return false;
    }
    std::vector<uint8_t> chunk;
    if (!obtainState(c, pi, chunk)) {
        c.warn("track '" + t.name + "': insert '" + pi.name +
               "' skipped (no plugin state obtainable — not live and no saved state file)");
        return false;
    }
    out.name = pi.name;
    if (pi.format == "vst2") {
        // uid is the decimal SIGNED int32 stringification of the fourcc
        // (CPR_MIXER_FORMAT §3 registry-match detail).
        long long uidLL = 0;
        const auto res =
            std::from_chars(pi.uid.data(), pi.uid.data() + pi.uid.size(), uidLL);
        if (res.ec != std::errc() || res.ptr != pi.uid.data() + pi.uid.size()) {
            c.warn("track '" + t.name + "': insert '" + pi.name +
                   "' skipped (vst2 uid '" + pi.uid + "' is not a decimal int32)");
            return false;
        }
        const uint32_t fourcc = static_cast<uint32_t>(static_cast<int32_t>(uidLL));
        out.guid = vst2WrapperGuid(fourcc, pi.name);
        out.compHex = hexUpper(buildVst2Component(fourcc, chunk));
        out.ctrlHex.clear(); // C5 leaves editController empty for wrapped VST2
    } else {
        // vst3: uid is the real class GUID string — normalize to 32 uppercase hex.
        std::string guid;
        for (char ch : pi.uid) {
            if ((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F'))
                guid += ch;
            else if (ch >= 'a' && ch <= 'f')
                guid += static_cast<char>(ch - 'a' + 'A');
        }
        if (guid.size() != 32) {
            c.warn("track '" + t.name + "': insert '" + pi.name +
                   "' skipped (vst3 uid '" + pi.uid + "' is not a 32-hex class GUID)");
            return false;
        }
        out.guid = guid;
        std::vector<uint8_t> comp, ctrl;
        if (unwrapMd3s(chunk, comp, ctrl)) {
            out.compHex = hexUpper(comp);
            out.ctrlHex = hexUpper(ctrl);
        } else {
            c.warn("track '" + t.name + "': insert '" + pi.name +
                   "' state is not MD3S-framed — emitted raw as audioComponent");
            out.compHex = hexUpper(chunk);
            out.ctrlHex.clear();
        }
    }
    if (pi.bypass)
        c.warn("track '" + t.name + "': insert '" + pi.name +
               "' is bypassed — bypass state is not representable in the archive");
    return true;
}

// One loaded insert slot <item>. INFERRED shape (see block comment above).
void emitLoadedInsertSlot(Xw& x, const InsertBlob& b, int channels) {
    x.open("<item>");
    x.openObj("VstCtrlInternalEffect", "Plugin");
    x.openMember("Plugin UID");
    x.strVal("GUID", b.guid, true);
    x.closeMember();
    x.strVal("Plugin Name", b.name, true);
    x.intVal("Audio Input Count", 1);
    emitArrangement(x, "Audio Input Arrangement", channels);
    x.intVal("Audio Output Count", 1);
    emitArrangement(x, "Audio Output Arrangement", channels);
    x.intVal("Event Input Count", 0);
    x.intVal("Event Output Count", 0);
    x.bin("audioComponent", b.compHex);
    x.bin("editController", b.ctrlHex);
    x.intVal("Editor Width", 0);
    x.intVal("Editor Height", 0);
    x.intVal("Active", 1);
    // GUID + "-0" instance suffix — the insert-slot IDString convention
    // (CPR_MIXER_FORMAT §3; the channel panner's bare "Panner" shows the suffix form is
    // slot-specific).
    x.strVal("IDString", b.guid + "-0", true);
    x.strVal("Bay Program", "", true);
    x.closeObj();
    x.intVal("WasEnableBeforeFreeze", 1);
    x.intVal("State", 1);
    x.close("item");
}

// InsertFolder: 8 slots (C5 count — spec §1/§3.4 row 6); loaded slots first, then empties.
void emitInsertFolder(Xw& x, Ctx& c, const Track& t,
                      const std::vector<const PluginInstance*>& inserts) {
    std::vector<InsertBlob> blobs;
    for (const PluginInstance* pi : inserts) {
        InsertBlob b;
        if (prepareInsert(c, t, *pi, b))
            blobs.push_back(std::move(b));
    }
    if (blobs.size() > 8) {
        c.warn("track '" + t.name + "': " + std::to_string(blobs.size()) +
               " exportable inserts — C5 archives carry 8 slots, extras dropped");
        blobs.resize(8);
    }
    if (!blobs.empty() && !c.warnedInsertShape) {
        c.warnedInsertShape = true;
        c.warn("insert plugin slot XML shape inferred (VstCtrlInternalEffect) — needs "
               "Cubase import verification");
    }
    x.openMember("InsertFolder");
    x.intVal("Bypass", 0);
    x.intVal("SeparationPosition", 6);
    x.openList("Slot", "list");
    for (int i = 0; i < 8; ++i) {
        if (i < static_cast<int>(blobs.size())) {
            emitLoadedInsertSlot(x, blobs[static_cast<size_t>(i)], t.channels);
        } else {
            x.open("<item>");
            x.intVal("State", 0);
            x.close("item");
        }
    }
    x.closeList();
    x.closeMember();
}

// ---------------------------------------------------------------------------
// MIDI parts (whole construct INFERRED — spec §4: the sample has no MIDI; class names
// carry over from the binary twin 1:1 per spec §8 / CPR_MIXER_FORMAT §7.4: MMidiPart
// events with 480-PPQ tick positions, note Start/Length/Pitch/Velocity. Emitted inside
// the track's MListNode after the Domain.)
// ---------------------------------------------------------------------------
void emitMidiParts(Xw& x, Ctx& c, const Track& t) {
    std::vector<const MidiClip*> clips;
    for (const Clip& cl : t.clips)
        if (const MidiClip* m = asMidi(&cl))
            if (!m->muted)
                clips.push_back(m);
    if (clips.empty())
        return;
    if (!c.warnedPartShape) {
        c.warnedPartShape = true;
        c.warn("MIDI part/note event XML shape inferred (MMidiPart/MMidiNoteEvent) — "
               "needs Cubase import verification");
    }
    x.openList("Events", "obj");
    for (const MidiClip* m : clips) {
        x.openObj("MMidiPart", nullptr);
        x.intVal("Flags", 1);
        x.floatVal("Start", m->startBeat * 480.0);
        x.floatVal("Length", m->lengthBeats * 480.0);
        x.strVal("Name", m->name, true);
        x.openList("Events", "obj");
        for (const Note& n : m->notes) {
            x.openObj("MMidiNoteEvent", nullptr);
            x.floatVal("Start", n.startBeat * 480.0); // part-relative ticks (§7.4)
            x.floatVal("Length", n.lengthBeats * 480.0);
            x.intVal("Pitch", n.pitch);
            x.intVal("Velocity", n.velocity);
            x.closeObj();
        }
        x.closeList();
        c.ccEventsSkipped += static_cast<int>(m->cc.size());
        x.closeObj();
    }
    x.closeList();
}

// ---------------------------------------------------------------------------
// Track skeletons
// ---------------------------------------------------------------------------

// First track's Node > Domain defines the Tempo/Signature tracks; every later Domain
// references them by ID (spec §2.1/§3.2).
void emitDomain(Xw& x, Ctx& c) {
    x.openMember("Domain");
    x.intVal("Type", 0);
    if (!c.wroteTempoDef) {
        c.wroteTempoDef = true;
        c.tempoId = x.openObj("MTempoTrackEvent", "Tempo Track");
        x.openList("TempoEvent", "obj");
        x.openObj("MTempoEvent", nullptr);
        x.floatVal("BPM", c.bpm);
        x.floatLit("PPQ", "0");
        x.closeObj();
        x.closeList();
        x.floatVal("RehearsalTempo", c.bpm);
        x.closeObj();
        c.sigId = x.openObj("MSignatureTrackEvent", "Signature Track");
        x.openList("SignatureEvent", "obj");
        x.openObj("MTimeSignatureEvent", nullptr);
        x.intVal("Bar", 0);
        x.intVal("Numerator", c.tsNum);
        x.intVal("Denominator", c.tsDen);
        x.intVal("Position", 0);
        x.closeObj();
        x.closeList();
        x.closeObj();
    } else {
        x.objRef("Tempo Track", c.tempoId);
        x.objRef("Signature Track", c.sigId);
    }
    x.closeMember();
}

// MAutomationNode boilerplate (spec §3.5 — one per track, all defaults; the Track Device
// REF after the Tracks list points at the MAutomationTrack defined within it).
void emitAutomation(Xw& x, Ctx& c) {
    x.openObj("MAutomationNode", "Automation");
    x.strVal("Name", "Automation", true);
    x.openMember("Domain");
    x.intVal("Type", 0);
    x.objRef("Tempo Track", c.tempoId);
    x.objRef("Signature Track", c.sigId);
    x.closeMember();
    x.openList("Tracks", "obj");
    x.openObj("MAutomationTrackEvent", nullptr);
    x.intVal("Flags", 32);
    x.floatLit("Start", "0");
    x.floatVal("Length", c.lengthTicks);
    x.openObj("MAutoListNode", "Node");
    x.openMember("Domain");
    x.intVal("Type", 0);
    x.objRef("Tempo Track", c.tempoId);
    x.objRef("Signature Track", c.sigId);
    x.closeMember();
    x.closeObj();
    const uint32_t devId = x.openObj("MAutomationTrack", "Track Device");
    x.intVal("Connection Type", 2);
    x.intVal("Read", 0);
    x.intVal("Write", 0);
    x.closeObj();
    x.intVal("Tag", 1025);
    x.closeObj();
    x.closeList();
    x.objRef("Track Device", devId);
    x.intVal("Expanded", 0);
    x.closeObj();
}

// DeviceAttributes — 23 children in the exact spec §3.4 order. The channel pan rides in
// the Panner block's component blob (child 10) — NO era of native Cubase writes a
// channel-level Pan member (falsified 2026-07-17 by the C5.1.1 labeled archives in
// C:\Temp\cpr_stereo\cubase5: L33/R7 panned channels carry no Pan member; the only
// Pan{Value,Min,Max} in an archive is the MIDI-splitter one — CPR_MIXER_FORMAT §5a).
void emitDeviceAttributes(Xw& x, Ctx& c, const Track& t,
                          const std::vector<const PluginInstance*>& inserts) {
    const std::string busName = "Audio " + std::to_string(c.audioNameCounter++);
    const int busUid = c.busUidCounter++;

    x.openMember("DeviceAttributes");
    x.openMember("Name"); // 1
    x.strVal("String", t.name, true);
    x.closeMember();
    // 2: Type 1 = track channel; 7 = bus (INFERRED from CPR_MIXER_FORMAT §1/§5)
    x.intVal("Type", t.kind == TrackKind::Bus ? 7 : 1);
    x.openMember("InputGain"); // 3
    x.floatLit("Value", "16383.5");
    x.closeMember();
    x.intVal("InputPhase", 0); // 4
    emitVolume(x, c, t);                // 5
    emitInsertFolder(x, c, t, inserts); // 6
    x.intVal("EQPosition", 6);          // 7
    emitEq(x, c, t);                    // 8
    emitSendFolder(x, "SendFolder", 8, t.channels); // 9
    emitPanner(x, true, t.channels, t.pan);         // 10 — pan in the component state
    x.intVal("VUSelect", 1);                        // 11
    x.intVal("VURange", 0);                         // 12
    x.openMember("Monitor");                        // 13
    x.intVal("Value", 0);
    x.intVal("Min", 0);
    x.intVal("Max", 2);
    x.closeMember();
    x.openMember("OwnInputBus"); // 14
    x.strVal("Name", busName, false);
    x.intVal("Bus UID", busUid);
    x.intVal("Bus Type", 13);
    x.openMember("Input Arrangement");
    emitTypeIntList(x, t.channels);
    x.closeMember();
    x.openMember("Output Arrangement");
    emitTypeIntList(x, t.channels);
    x.closeMember();
    x.closeMember();
    x.openMember("InputBusValue"); // 15
    x.intVal("Value", 2000002);
    x.closeMember();
    x.openMember("OutputBusValue"); // 16
    x.intVal("Value", 6);
    x.closeMember();
    x.intVal("FreezePosition", 5);   // 17
    x.intVal("Listen Mode", 0);      // 18
    x.intVal("LinkedPanner", 0);     // 19
    x.strVal("IDString", busName, false); // 20 — matches OwnInputBus.Name, NOT track name
    emitSendFolder(x, "foldbackSendFolder", 4, t.channels); // 21 (cue sends, 4 slots)
    emitQuickControls(x);                                   // 22
    x.intVal("InputBusArrangementType", 1);                 // 23
    x.closeMember();
}

// One <obj class="M*TrackEvent"> per exportable track (spec §3.1 child order: Flags,
// Start, Length, Node, Additional Attributes, Track Device, Height, Automation).
void emitTrackEvent(Xw& x, Ctx& c, const Track& t) {
    const char* evCls = "MAudioTrackEvent";
    const char* devCls = "MAudioTrack";
    switch (t.kind) {
        case TrackKind::Midi:
            // INFERRED: only MAudioTrackEvent is evidenced; MIDI shape mirrors it with
            // the binary twin's class names (CPR_MIXER_FORMAT §7.4/§8).
            evCls = "MMidiTrackEvent";
            devCls = "MMidiTrack";
            if (!c.warnedMidiShape) {
                c.warnedMidiShape = true;
                c.warn("MIDI track shape inferred — needs Cubase import verification");
            }
            break;
        case TrackKind::Instrument:
            // INFERRED: same caveat as MIDI.
            evCls = "MInstrumentTrackEvent";
            devCls = "MInstrumentTrack";
            if (!c.warnedInstShape) {
                c.warnedInstShape = true;
                c.warn("Instrument track shape inferred — needs Cubase import "
                       "verification");
            }
            break;
        case TrackKind::Bus:
            // Audio-track shape with channel Type 7 (INFERRED).
            if (!c.warnedBusShape) {
                c.warnedBusShape = true;
                c.warn("bus track exported as audio-track shape with channel Type=7 "
                       "(INFERRED)");
            }
            break;
        default:
            break;
    }

    // Instrument-track instrument = first insert. The archive "Synth Slot" XML shape is
    // not evidenced (spec §5 OPEN) → skip the instrument, export the remaining inserts.
    std::vector<const PluginInstance*> inserts;
    size_t firstInsert = 0;
    if (t.kind == TrackKind::Instrument && !t.inserts.empty()) {
        c.warn("track '" + t.name + "': instrument '" + t.inserts.front().name +
               "' skipped (Synth Slot XML shape not evidenced)");
        firstInsert = 1;
    }
    for (size_t i = firstInsert; i < t.inserts.size(); ++i)
        inserts.push_back(&t.inserts[i]);

    // Content we cannot represent — counted for the export report.
    for (const Clip& cl : t.clips)
        if (clipType(cl) == ClipType::Audio)
            ++c.audioClipsSkipped;
    for (const Send& s : t.sends)
        if (s.enabled)
            ++c.sendsSkipped;

    x.openObj(evCls, nullptr);
    x.intVal("Flags", 1);
    x.floatLit("Start", "0");
    x.floatVal("Length", c.lengthTicks);
    x.openObj("MListNode", "Node");
    x.strVal("Name", t.name, true);
    emitDomain(x, c);
    if (t.kind == TrackKind::Midi || t.kind == TrackKind::Instrument)
        emitMidiParts(x, c, t); // INFERRED (see emitMidiParts)
    x.closeObj();
    x.openMember("Additional Attributes");
    x.openMember("Insp");
    x.closeMember();
    x.closeMember();
    x.openObj(devCls, "Track Device");
    x.intVal("Connection Type", 1);
    x.strVal("Device Name", "VST Multitrack", false);
    x.intVal("Channel ID", 1);
    emitDeviceAttributes(x, c, t, inserts);
    x.intVal("Flags", 0);
    x.closeObj();
    x.intVal("Height", 42);
    emitAutomation(x, c);
    x.closeObj();
}

// Musical end of the project's content, in beats (quarters).
double contentEndBeats(const Project& p, double bpm) {
    double end = 0.0;
    auto scanClips = [&](const std::vector<Clip>& clips) {
        for (const Clip& c : clips) {
            if (const MidiClip* m = asMidi(&c))
                end = std::max(end, m->startBeat + m->lengthBeats);
            else if (const AudioClip* a = asAudio(&c)) {
                const double sec =
                    p.sampleRate > 0
                        ? static_cast<double>(a->lengthSamples) / p.sampleRate
                        : 0.0;
                end = std::max(end, a->startBeat + sec * bpm / 60.0);
            }
        }
    };
    for (const Track& t : p.tracks) {
        scanClips(t.clips);
        for (const TakeFolder& f : t.takeFolders)
            end = std::max(end, f.endBeat);
    }
    return end;
}

} // namespace

// ---------------------------------------------------------------------------
// TrackArchiveWriter::write
// ---------------------------------------------------------------------------
bool TrackArchiveWriter::write(const Model& model, HostProcessManager* host,
                               const std::string& projectDir, const std::string& path,
                               std::vector<std::string>& warnings, std::string& err) {
    const Project& p = model.project;
    Ctx c{model};
    c.host = host;
    c.projectDir = projectDir;
    c.warnings = &warnings;

    // Fixed single tempo/signature from the model (spec §3.2 — one event each).
    if (!p.tempoMap.empty())
        c.bpm = p.tempoMap.front().bpm;
    if (p.tempoMap.size() > 1)
        c.warn("tempo map has " + std::to_string(p.tempoMap.size()) +
               " entries — archive carries only the first (fixed tempo " +
               fmtDouble(c.bpm) + " BPM)");
    if (!p.timeSigMap.empty()) {
        c.tsNum = p.timeSigMap.front().num;
        c.tsDen = p.timeSigMap.front().den;
    }
    if (p.timeSigMap.size() > 1)
        c.warn("time signature map has " + std::to_string(p.timeSigMap.size()) +
               " entries — archive carries only the first");

    // Track-event span: at least the sample's 1200 quarters (600 s @ 120), grown to fit
    // the content. Keeps Length(ticks) and PArrangeSetup Length.Time(seconds) in agreement
    // through the tempo (spec §3.6 consistency check).
    c.lengthTicks = std::max(576000.0, std::ceil(contentEndBeats(p, c.bpm) * 480.0));

    // Exportable tracks: order preserved; folders skipped (children stay in place —
    // project.tracks is already the flat ordered list); master is not part of a Cubase
    // Track Archive.
    std::vector<const Track*> tracks;
    for (const Track& t : p.tracks)
        if (t.kind != TrackKind::Folder)
            tracks.push_back(&t);
    if (tracks.empty())
        c.warn("project has no exportable tracks — archive contains only project setup");

    const Track& master = p.masterTrack;
    if (std::abs(master.volume - 1.0) > 1e-9 || master.pan != 0.0 ||
        master.eq.isActive() || !master.inserts.empty())
        c.warn("master bus not exported (Cubase track archives do not carry the master "
               "bus) — it has non-default volume/pan/EQ/inserts");

    Xw x;
    x.raw("<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n");
    x.open("<tracklist>");
    x.openList("track", "obj");
    for (const Track* t : tracks)
        emitTrackEvent(x, c, *t);
    x.closeList();
    // Root child #2: PArrangeSetup (spec §3.6).
    x.openObj("PArrangeSetup", "Setup");
    x.openMember("Length");
    x.floatVal("Time", (c.lengthTicks / 480.0) * 60.0 / c.bpm);
    x.openMember("Domain");
    x.intVal("Type", 1); // time-linear domain
    x.floatLit("Period", "1");
    x.closeMember();
    x.closeMember();
    x.intVal("BarOffset", 0);
    x.intVal("FrameType", 5);
    x.intVal("TimeType", 0);
    x.floatVal("SampleRate", static_cast<double>(p.sampleRate));
    x.intVal("SampleSize", 24);
    x.intVal("PanLaw", 6);
    x.closeObj();
    x.close("tracklist");

    if (c.audioClipsSkipped > 0)
        c.warn(std::to_string(c.audioClipsSkipped) +
               " audio clip(s) skipped — the Track Archive audio-event/pool XML shape is "
               "not evidenced (track shells exported only)");
    if (c.ccEventsSkipped > 0)
        c.warn(std::to_string(c.ccEventsSkipped) + " MIDI CC event(s) skipped");
    if (c.sendsSkipped > 0)
        c.warn(std::to_string(c.sendsSkipped) +
               " enabled send(s) not exported (sends are skipped, matching the importer)");

    std::ofstream f(utf8ToWide(path).c_str(), std::ios::binary | std::ios::trunc);
    if (!f.is_open()) {
        err = "cannot open '" + path + "' for writing";
        return false;
    }
    f.write(x.out.data(), static_cast<std::streamsize>(x.out.size()));
    f.flush();
    if (!f.good()) {
        err = "write failed for '" + path + "'";
        return false;
    }
    return true;
}

} // namespace mydaw
