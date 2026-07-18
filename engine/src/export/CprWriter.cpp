// MyDAW — export/CprWriter.cpp. See CprWriter.h.
//
// FAITHFUL PORT of the validated Node reference implementation:
//   scripts/cpr-container.mjs  — container/record layer (parse -> tree, serialize ->
//                                bytes, interning-id/size recomputation, era detection)
//   scripts/cpr-write.mjs      — PIPELINE v2 writer (donor splice keeping donor track 1,
//                                in-place tempo patch, ref healing, stored-offset-id
//                                rebase + verification gate, post-splice self checks)
// The correctness bar is BYTE PARITY with the Node writer for the same model JSON +
// donor (mydaw-engine --cpr-write; docs/CPR_WRITER_M3_NOTES.md §"C++ port"). Keep any
// change here in lockstep with the .mjs files — including quirks ported on purpose
// (JS Math.round tie-breaking, the `v < 0x40` stored-id scan floor, the exact walk
// order of the speculative header scanner).
//
// All structural integers are big-endian. Everything the scanner does not positively
// recognize stays a verbatim raw span; sizes/ids/lengths are recomputed on serialize.

#include "export/CprWriter.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

#include "export/CprDonor.gen.h"
#include "project/Model.h"
#include "util/Paths.h"

namespace mydaw {

namespace {

constexpr int64_t kMaxName = 100;
constexpr int kMaxDepth = 96;
constexpr double kPpq = 480.0;

using Err = std::runtime_error;

std::string hex(int64_t v) {
    char buf[24];
    std::snprintf(buf, sizeof(buf), "0x%llx", static_cast<unsigned long long>(v));
    return buf;
}

// ---------------------------------------------------------------------------
// big-endian primitives
// ---------------------------------------------------------------------------

uint32_t readU32(const uint8_t* p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) |
           uint32_t(p[3]);
}
uint16_t readU16(const uint8_t* p) { return uint16_t((p[0] << 8) | p[1]); }
void writeU32(uint8_t* p, uint32_t v) {
    p[0] = uint8_t(v >> 24);
    p[1] = uint8_t(v >> 16);
    p[2] = uint8_t(v >> 8);
    p[3] = uint8_t(v);
}
void writeU16(uint8_t* p, uint16_t v) {
    p[0] = uint8_t(v >> 8);
    p[1] = uint8_t(v);
}
void writeF32(uint8_t* p, double v) {
    const float f = static_cast<float>(v); // Node writeFloatBE: nearest-float conversion
    uint32_t bits;
    static_assert(sizeof(bits) == sizeof(f));
    std::memcpy(&bits, &f, 4);
    writeU32(p, bits);
}
void writeF64(uint8_t* p, double v) {
    uint64_t bits;
    std::memcpy(&bits, &v, 8);
    for (int i = 0; i < 8; ++i)
        p[i] = uint8_t(bits >> (56 - 8 * i));
}

// ---------------------------------------------------------------------------
// container tree (cpr-container.mjs node shapes)
// ---------------------------------------------------------------------------

// elem (full): { full:true, name, ver, origId } — origId < 0 on generated elems
// elem (ref):  { full:false, refOrigId }
struct Elem {
    bool full = true;
    std::string name;      // raw latin1/utf8 bytes as stored
    uint16_t ver = 0;
    int64_t origId = -1;   // parse-time id of the name's length field; -1 = generated
    int64_t refOrigId = -1;
};

struct Anchor {
    int64_t origId = 0;
    int64_t delta = 0;
};

struct Node;
using NodePtr = std::unique_ptr<Node>;

struct Node {
    bool isRec = false;
    // raw
    std::vector<uint8_t> bytes;
    int64_t start = 0; // parse-time absolute offset (raw nodes)
    // rec
    bool hasChain = false;
    std::vector<Elem> chain;
    Elem cls;
    std::vector<NodePtr> children;
    std::vector<Anchor> anchors;
    int64_t hdrOff = 0, dataStart = 0, dataEnd = 0; // parse-time absolute offsets
};

struct Arch {
    std::vector<NodePtr> nodes;
};

struct Chunk {
    std::string id; // 4cc
    int64_t dataOff = 0;
    std::vector<uint8_t> data; // verbatim payload (opaque emit + era detection)
    bool hasRoot = false;
    std::vector<std::vector<uint8_t>> rootParts;
    std::string streamName;
    std::unique_ptr<Arch> arch;
};

struct Tree {
    std::string form;
    std::vector<Chunk> chunks;
    std::vector<uint8_t> tail;
    uint32_t origRiffSize = 0;
    bool riffSizeStored = false; // JS riffSizeMode: 'stored' vs 'computed'
};

NodePtr makeRaw(std::vector<uint8_t> bytes) {
    auto n = std::make_unique<Node>();
    n->isRec = false;
    n->bytes = std::move(bytes);
    return n;
}

NodePtr makeRec(std::string name, uint16_t ver, std::vector<NodePtr> children,
                std::vector<std::pair<std::string, uint16_t>> chain = {}) {
    auto n = std::make_unique<Node>();
    n->isRec = true;
    n->hasChain = !chain.empty();
    for (auto& [cn, cv] : chain) {
        Elem e;
        e.full = true;
        e.name = std::move(cn);
        e.ver = cv;
        n->chain.push_back(std::move(e));
    }
    n->cls.full = true;
    n->cls.name = std::move(name);
    n->cls.ver = ver;
    n->children = std::move(children);
    return n;
}

// ---------------------------------------------------------------------------
// parse (cpr-container.mjs parse/parseRoot/parseArch)
// ---------------------------------------------------------------------------

// ROOT data = sequence of (u32be len + len bytes) strings tiling the payload exactly.
bool parseRoot(const std::vector<uint8_t>& data, std::vector<std::vector<uint8_t>>& parts) {
    parts.clear();
    int64_t p = 0;
    const int64_t n = int64_t(data.size());
    while (p + 4 <= n) {
        const int64_t len = readU32(data.data() + p);
        if (p + 4 + len > n)
            return false;
        parts.emplace_back(data.begin() + (p + 4), data.begin() + (p + 4 + len));
        p += 4 + len;
    }
    return p == n;
}

// ARCH object-stream walker — faithful port incl. the reference scanner's side effects
// (speculative header attempts register class names even when the attempt fails).
std::unique_ptr<Arch> parseArch(const uint8_t* buf, int64_t bufLen, int64_t dataOff,
                                int64_t size) {
    const int64_t base = dataOff + 4;
    const int64_t end = dataOff + size;
    std::unordered_set<int64_t> names;         // origId set (offset is identity)
    std::vector<int64_t> refIds;               // referenced origIds, insertion order
    std::unordered_set<int64_t> refIdSet;

    auto addRef = [&](int64_t id) {
        if (refIdSet.insert(id).second)
            refIds.push_back(id);
    };
    auto isNameChar = [](uint8_t c) { return c >= 0x20 && c < 0x7f; };

    struct NameRead {
        std::string name;
        uint16_t ver;
        int64_t id;
        int64_t next;
    };
    auto readName = [&](int64_t p) -> std::optional<NameRead> {
        if (p + 4 > end)
            return std::nullopt;
        const int64_t len = readU32(buf + p);
        if (len < 2 || len > kMaxName || p + 4 + len + 2 > end)
            return std::nullopt;
        if (buf[p + 4 + len - 1] != 0)
            return std::nullopt;
        for (int64_t j = 0; j < len - 1; ++j)
            if (!isNameChar(buf[p + 4 + j]))
                return std::nullopt;
        NameRead n;
        n.name.assign(reinterpret_cast<const char*>(buf + p + 4), size_t(len - 1));
        n.ver = readU16(buf + p + 4 + len);
        n.id = p - base;
        n.next = p + 4 + len + 2;
        return n;
    };

    struct Header {
        bool hasChain = false;
        std::vector<Elem> chain;
        Elem cls;
        int64_t dataStart = 0, dataEnd = 0;
    };

    // Attempt to parse a record header at p; mirrors the reference bounds exactly.
    std::function<std::optional<Header>(int64_t, int64_t)> tryHeader =
        [&](int64_t p, int64_t parentEnd) -> std::optional<Header> {
        if (p + 8 > parentEnd || p + 8 > bufLen)
            return std::nullopt;
        const uint32_t v = readU32(buf + p);
        if (v == 0xfffffffeu) {
            int64_t q = p;
            std::vector<Elem> chain;
            while (q + 8 <= bufLen && q + 4 <= parentEnd && readU32(buf + q) == 0xfffffffeu) {
                const uint32_t w = readU32(buf + q + 4);
                if (w >= 0x80000000u && w != 0xfffffffeu && w != 0xffffffffu) {
                    const int64_t id = int64_t(w) - 0x80000000ll;
                    if (!names.count(id))
                        return std::nullopt;
                    addRef(id);
                    Elem e;
                    e.full = false;
                    e.refOrigId = id;
                    chain.push_back(std::move(e));
                    q += 8;
                } else {
                    const auto n = readName(q + 4);
                    if (!n)
                        return std::nullopt;
                    names.insert(n->id); // side effect kept: registered even if chain fails
                    Elem e;
                    e.full = true;
                    e.name = n->name;
                    e.ver = n->ver;
                    e.origId = n->id;
                    chain.push_back(std::move(e));
                    q = n->next;
                }
            }
            if (q + 4 > parentEnd || q + 4 > bufLen || readU32(buf + q) != 0xffffffffu)
                return std::nullopt;
            auto r = tryHeader(q, parentEnd);
            if (!r)
                return std::nullopt;
            r->hasChain = true;
            r->chain = std::move(chain);
            return r;
        }
        if (v == 0xffffffffu) {
            const auto n = readName(p + 4);
            if (!n || n->next + 4 > parentEnd)
                return std::nullopt;
            const int64_t sz = readU32(buf + n->next);
            if (n->next + 4 + sz > parentEnd)
                return std::nullopt;
            names.insert(n->id);
            Header h;
            h.cls.full = true;
            h.cls.name = n->name;
            h.cls.ver = n->ver;
            h.cls.origId = n->id;
            h.dataStart = n->next + 4;
            h.dataEnd = n->next + 4 + sz;
            return h;
        }
        if (v >= 0x80000000u) {
            const int64_t id = int64_t(v) - 0x80000000ll;
            if (!names.count(id))
                return std::nullopt;
            const int64_t sz = readU32(buf + p + 4);
            if (p + 8 + sz > parentEnd)
                return std::nullopt;
            addRef(id);
            Header h;
            h.cls.full = false;
            h.cls.refOrigId = id;
            h.dataStart = p + 8;
            h.dataEnd = p + 8 + sz;
            return h;
        }
        return std::nullopt;
    };

    std::function<std::vector<NodePtr>(int64_t, int64_t, int)> walk =
        [&](int64_t s, int64_t e, int depth) -> std::vector<NodePtr> {
        std::vector<NodePtr> nodes;
        int64_t p = s, gapStart = s;
        while (p < e) {
            std::optional<Header> h =
                depth < kMaxDepth ? tryHeader(p, e) : std::nullopt;
            if (h) {
                if (gapStart < p) {
                    auto r = makeRaw(std::vector<uint8_t>(buf + gapStart, buf + p));
                    r->start = gapStart;
                    nodes.push_back(std::move(r));
                }
                auto n = std::make_unique<Node>();
                n->isRec = true;
                n->hasChain = h->hasChain;
                n->chain = std::move(h->chain);
                n->cls = std::move(h->cls);
                if (h->dataEnd > h->dataStart)
                    n->children = walk(h->dataStart, h->dataEnd, depth + 1);
                n->hdrOff = p;
                n->dataStart = h->dataStart;
                n->dataEnd = h->dataEnd;
                nodes.push_back(std::move(n));
                p = h->dataEnd;
                gapStart = p;
            } else {
                ++p;
            }
        }
        if (gapStart < e) {
            auto r = makeRaw(std::vector<uint8_t>(buf + gapStart, buf + e));
            r->start = gapStart;
            nodes.push_back(std::move(r));
        }
        return nodes;
    };

    auto arch = std::make_unique<Arch>();
    arch->nodes = walk(dataOff, end, 0);

    // Anchor every referenced name definition to its containing atom (header span of a
    // rec, or a raw span) as (node, delta) so serialize can recompute its id.
    struct Atom {
        int64_t start, end;
        Node* node;
    };
    std::vector<Atom> atoms;
    std::function<void(std::vector<NodePtr>&)> collect = [&](std::vector<NodePtr>& list) {
        for (auto& n : list) {
            if (!n->isRec) {
                atoms.push_back({n->start, n->start + int64_t(n->bytes.size()), n.get()});
            } else {
                atoms.push_back({n->hdrOff, n->dataStart, n.get()});
                collect(n->children);
            }
        }
    };
    collect(arch->nodes);
    // atoms are in ascending, non-overlapping order by construction
    for (const int64_t origId : refIds) {
        const int64_t abs = base + origId;
        int64_t lo = 0, hi = int64_t(atoms.size()) - 1;
        Node* found = nullptr;
        int64_t foundStart = 0;
        while (lo <= hi) {
            const int64_t mid = (lo + hi) >> 1;
            if (abs < atoms[mid].start)
                hi = mid - 1;
            else if (abs >= atoms[mid].end)
                lo = mid + 1;
            else {
                found = atoms[mid].node;
                foundStart = atoms[mid].start;
                break;
            }
        }
        if (!found)
            throw Err("unanchorable back-ref target id=" + hex(origId));
        found->anchors.push_back({origId, abs - foundStart});
    }
    return arch;
}

// forward decls for parse<->serialize helpers
int64_t archLength(const std::vector<NodePtr>& nodes);

int64_t chunkPayloadLength(const Chunk& c) {
    if (c.id == "ARCH" && c.arch)
        return archLength(c.arch->nodes);
    if (c.id == "ROOT" && c.hasRoot) {
        int64_t n = 0;
        for (const auto& part : c.rootParts)
            n += 4 + int64_t(part.size());
        return n;
    }
    return int64_t(c.data.size());
}

int64_t computedRiffSize(const Tree& tree) {
    int64_t sz = 0;
    for (const Chunk& c : tree.chunks)
        sz += 8 + chunkPayloadLength(c);
    return sz + int64_t(tree.tail.size());
}

Tree parse(const uint8_t* buf, size_t bufSize) {
    const int64_t len = int64_t(bufSize);
    if (len < 12 || std::memcmp(buf, "RIFF", 4) != 0)
        throw Err("not RIFF");
    Tree tree;
    tree.form.assign(reinterpret_cast<const char*>(buf + 8), 4);
    if (tree.form != "NUND")
        throw Err("not NUND (form=\"" + tree.form + "\")");
    tree.origRiffSize = readU32(buf + 4);

    // --- chunk layer ---
    const int64_t limit = std::min<int64_t>(12 + tree.origRiffSize, len);
    int64_t p = 12;
    while (p + 8 <= limit) {
        Chunk c;
        c.id.assign(reinterpret_cast<const char*>(buf + p), 4);
        const int64_t size = readU32(buf + p + 4);
        if (p + 8 + size > len)
            break; // corrupt/truncated chunk: keep the rest verbatim, don't guess
        c.dataOff = p + 8;
        c.data.assign(buf + p + 8, buf + p + 8 + size);
        tree.chunks.push_back(std::move(c));
        p += 8 + size;
    }
    tree.tail.assign(buf + p, buf + len);

    if (computedRiffSize(tree) != int64_t(tree.origRiffSize))
        tree.riffSizeStored = true;

    // --- name each chunk / pair ROOT->ARCH ---
    for (size_t i = 0; i < tree.chunks.size(); ++i) {
        Chunk& c = tree.chunks[i];
        if (c.id != "ROOT")
            continue;
        c.hasRoot = parseRoot(c.data, c.rootParts);
        if (c.hasRoot && i + 1 < tree.chunks.size() && tree.chunks[i + 1].id == "ARCH") {
            std::string name;
            for (size_t k = 0; k < c.rootParts.size(); ++k) {
                if (k)
                    name += '|';
                name.append(reinterpret_cast<const char*>(c.rootParts[k].data()),
                            c.rootParts[k].size());
            }
            tree.chunks[i + 1].streamName = name;
        }
    }

    // --- ARCH record layer (always 'records' level in this port) ---
    for (Chunk& c : tree.chunks)
        if (c.id == "ARCH")
            c.arch = parseArch(buf, len, c.dataOff, int64_t(c.data.size()));
    return tree;
}

// ---------------------------------------------------------------------------
// serialize (cpr-container.mjs serialize/emitArch)
// ---------------------------------------------------------------------------

int64_t elemLength(const Elem& e, bool concrete) {
    // concrete full: FFFFFFFF + len + name + NUL + ver; chain full: FFFFFFFE + ...
    // concrete ref: (0x80000000|id); chain ref: FFFFFFFE + (0x80000000|id)
    if (e.full)
        return 4 + 4 + int64_t(e.name.size()) + 1 + 2;
    return concrete ? 4 : 8;
}

int64_t nodeLength(const Node& n) {
    if (!n.isRec)
        return int64_t(n.bytes.size());
    int64_t len = 0;
    if (n.hasChain)
        for (const Elem& e : n.chain)
            len += elemLength(e, false);
    len += elemLength(n.cls, true) + 4; // + u32 size field
    for (const NodePtr& ch : n.children)
        len += nodeLength(*ch);
    return len;
}

int64_t archLength(const std::vector<NodePtr>& nodes) {
    int64_t len = 0;
    for (const NodePtr& n : nodes)
        len += nodeLength(*n);
    return len;
}

int64_t emitArch(std::vector<uint8_t>& out, int64_t start, const std::vector<NodePtr>& nodes) {
    // ids are relative to (archDataOff + 4); a length field emitted at payload-relative
    // offset rel has id = rel - 4.
    std::unordered_map<int64_t, int64_t> newId; // origId -> recomputed id
    int64_t p = start;

    std::function<void(const Elem&, bool)> emitElem = [&](const Elem& e, bool concrete) {
        if (e.full) {
            writeU32(out.data() + p, concrete ? 0xffffffffu : 0xfffffffeu);
            writeU32(out.data() + p + 4, uint32_t(e.name.size() + 1));
            std::memcpy(out.data() + p + 8, e.name.data(), e.name.size());
            out[p + 8 + e.name.size()] = 0;
            writeU16(out.data() + p + 8 + e.name.size() + 1, e.ver);
            p += 4 + 4 + int64_t(e.name.size()) + 1 + 2;
        } else {
            const auto it = newId.find(e.refOrigId);
            if (it == newId.end())
                throw Err("back-ref to unemitted name id=" + hex(e.refOrigId));
            if (!concrete) {
                writeU32(out.data() + p, 0xfffffffeu);
                p += 4;
            }
            writeU32(out.data() + p, uint32_t(0x80000000ll | it->second));
            p += 4;
        }
    };

    std::function<void(const Node&)> emitNode = [&](const Node& n) {
        // register anchored name definitions at their recomputed offsets first — their
        // bytes are about to be emitted as part of this atom, and any ref to them
        // occurs strictly later in the stream
        for (const Anchor& a : n.anchors)
            newId[a.origId] = (p - start) + a.delta - 4;
        if (!n.isRec) {
            std::memcpy(out.data() + p, n.bytes.data(), n.bytes.size());
            p += int64_t(n.bytes.size());
            return;
        }
        if (n.hasChain)
            for (const Elem& e : n.chain)
                emitElem(e, false);
        emitElem(n.cls, true);
        const int64_t sizePos = p;
        p += 4;
        const int64_t dataStart = p;
        for (const NodePtr& ch : n.children)
            emitNode(*ch);
        writeU32(out.data() + sizePos, uint32_t(p - dataStart)); // recomputed record size
    };

    for (const NodePtr& n : nodes)
        emitNode(*n);
    return p;
}

std::vector<uint8_t> serialize(const Tree& tree) {
    const int64_t total = 12 + computedRiffSize(tree);
    std::vector<uint8_t> out(size_t(total), 0);
    std::memcpy(out.data(), "RIFF", 4);
    writeU32(out.data() + 4,
             tree.riffSizeStored ? tree.origRiffSize : uint32_t(total - 12));
    std::memcpy(out.data() + 8, tree.form.data(), 4);
    int64_t p = 12;
    for (const Chunk& c : tree.chunks) {
        std::memcpy(out.data() + p, c.id.data(), 4);
        const int64_t payloadLen = chunkPayloadLength(c);
        writeU32(out.data() + p + 4, uint32_t(payloadLen));
        p += 8;
        if (c.id == "ARCH" && c.arch) {
            p = emitArch(out, p, c.arch->nodes);
        } else if (c.id == "ROOT" && c.hasRoot) {
            for (const auto& part : c.rootParts) {
                writeU32(out.data() + p, uint32_t(part.size()));
                std::memcpy(out.data() + p + 4, part.data(), part.size());
                p += 4 + int64_t(part.size());
            }
        } else {
            std::memcpy(out.data() + p, c.data.data(), c.data.size());
            p += int64_t(c.data.size());
        }
    }
    std::memcpy(out.data() + p, tree.tail.data(), tree.tail.size());
    p += int64_t(tree.tail.size());
    if (p != total)
        throw Err("serialize length mismatch: wrote " + std::to_string(p) + ", expected " +
                  std::to_string(total));
    return out;
}

int64_t firstDiff(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
    const size_t n = std::min(a.size(), b.size());
    for (size_t i = 0; i < n; ++i)
        if (a[i] != b[i])
            return int64_t(i);
    return a.size() == b.size() ? -1 : int64_t(n);
}

// ---------------------------------------------------------------------------
// era detection (cpr-container.mjs detectEra; docs/CPR_MIXER_FORMAT.md §0)
// ---------------------------------------------------------------------------

struct LpStr {
    std::string text;
    int64_t next;
};
std::optional<LpStr> lpstrAt(const std::vector<uint8_t>& data, int64_t p) {
    if (p + 4 > int64_t(data.size()))
        return std::nullopt;
    const int64_t len = readU32(data.data() + p);
    if (len == 0 || len > 4096 || p + 4 + len > int64_t(data.size()))
        return std::nullopt;
    const uint8_t* b = data.data() + p + 4;
    int64_t nul = -1;
    for (int64_t i = 0; i < len; ++i)
        if (b[i] == 0) {
            nul = i;
            break;
        }
    LpStr s;
    s.text.assign(reinterpret_cast<const char*>(b), size_t(nul >= 0 ? nul : len));
    s.next = p + 4 + len;
    return s;
}

// /\bS[XLE]\b/ on latin1 text
bool hasSxleWord(const std::string& app) {
    auto isWord = [](char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
               c == '_';
    };
    for (size_t i = 0; i + 1 < app.size(); ++i) {
        if (app[i] != 'S')
            continue;
        const char c2 = app[i + 1];
        if (c2 != 'X' && c2 != 'L' && c2 != 'E')
            continue;
        const bool okBefore = i == 0 || !isWord(app[i - 1]);
        const bool okAfter = i + 2 >= app.size() || !isWord(app[i + 2]);
        if (okBefore && okAfter)
            return true;
    }
    return false;
}

// first /(\d+)\./ match
int majorFrom(const std::string& version) {
    for (size_t i = 0; i < version.size(); ++i) {
        if (version[i] < '0' || version[i] > '9')
            continue;
        size_t j = i;
        long v = 0;
        while (j < version.size() && version[j] >= '0' && version[j] <= '9') {
            v = v * 10 + (version[j] - '0');
            ++j;
        }
        if (j < version.size() && version[j] == '.')
            return int(v);
        i = j;
    }
    return 0;
}

std::string detectEra(const Tree& tree) {
    std::string app, version;
    static const char kNeedle[] = "PAppVersion\0"; // 12 bytes incl. NUL
    for (const Chunk& c : tree.chunks) {
        if (c.id != "ARCH" || c.streamName != "Version|PAppVersion")
            continue;
        const auto it = std::search(c.data.begin(), c.data.end(), kNeedle, kNeedle + 12);
        if (it == c.data.end())
            continue;
        const int64_t idx = it - c.data.begin();
        const auto s1 = lpstrAt(c.data, idx + 12 + 2 + 4);
        if (s1) {
            app = s1->text;
            const auto s2 = lpstrAt(c.data, s1->next);
            if (s2)
                version = s2->text;
        }
    }
    bool hasGuid = false;
    std::string devClass;
    for (const Chunk& c : tree.chunks) {
        if (c.streamName == "ComputerGuid|CmString")
            hasGuid = true;
        if (devClass.empty() && c.streamName.rfind("Devices|", 0) == 0) {
            const size_t bar = c.streamName.find('|');
            const size_t bar2 = c.streamName.find('|', bar + 1);
            devClass = c.streamName.substr(bar + 1, bar2 == std::string::npos
                                                        ? std::string::npos
                                                        : bar2 - bar - 1);
        }
    }
    const int major = majorFrom(version);
    if (hasSxleWord(app) || (major != 0 && major <= 3) || devClass == "FMemoryStream")
        return "sx";
    if (hasGuid || major >= 12)
        return "c12";
    if (major >= 4 || devClass == "FAttributes")
        return "c5";
    return "unknown";
}

// ---------------------------------------------------------------------------
// byte builders (cpr-write.mjs Bytes / fullRecordBytes)
// ---------------------------------------------------------------------------

class Bytes {
public:
    Bytes& u8(uint32_t v) {
        b_.push_back(uint8_t(v & 0xff));
        return *this;
    }
    Bytes& u16(uint32_t v) {
        b_.push_back(uint8_t(v >> 8));
        b_.push_back(uint8_t(v));
        return *this;
    }
    Bytes& u32(uint32_t v) {
        for (int i = 24; i >= 0; i -= 8)
            b_.push_back(uint8_t(v >> i));
        return *this;
    }
    Bytes& i64(double v) {
        const int64_t t = int64_t(std::trunc(v)); // Node: BigInt(Math.trunc(v))
        for (int i = 56; i >= 0; i -= 8)
            b_.push_back(uint8_t(uint64_t(t) >> i));
        return *this;
    }
    Bytes& f32(double v) {
        uint8_t tmp[4];
        writeF32(tmp, v);
        b_.insert(b_.end(), tmp, tmp + 4);
        return *this;
    }
    Bytes& f64(double v) {
        uint8_t tmp[8];
        writeF64(tmp, v);
        b_.insert(b_.end(), tmp, tmp + 8);
        return *this;
    }
    Bytes& buf(const uint8_t* p, size_t n) {
        b_.insert(b_.end(), p, p + n);
        return *this;
    }
    Bytes& buf(const std::vector<uint8_t>& v) { return buf(v.data(), v.size()); }
    Bytes& zeros(size_t n) {
        b_.insert(b_.end(), n, 0);
        return *this;
    }
    // lpstr with UTF-8 BOM suffix (record-data strings: u32 len INCL. NUL+BOM, chars,
    // NUL, EF BB BF). `text` is UTF-8 already.
    Bytes& lpstrBom(const std::string& text) {
        u32(uint32_t(text.size() + 4));
        buf(reinterpret_cast<const uint8_t*>(text.data()), text.size());
        u8(0);
        u8(0xef).u8(0xbb).u8(0xbf);
        return *this;
    }
    // plain lpstr (attr-tree keys: u32 len INCL. NUL, chars, NUL)
    Bytes& lpstr(const std::string& text) {
        u32(uint32_t(text.size() + 1));
        buf(reinterpret_cast<const uint8_t*>(text.data()), text.size());
        u8(0);
        return *this;
    }
    std::vector<uint8_t> out() { return std::move(b_); }

private:
    std::vector<uint8_t> b_;
};

// full-form archive record header bytes (used only inside raw spans, e.g. the MMidiPart
// class registry): [FFFFFFFE len base NUL ver]* FFFFFFFF len name NUL ver, u32 size, data
std::vector<uint8_t> fullRecordBytes(
    const std::vector<std::pair<std::string, uint16_t>>& chain, const std::string& name,
    uint16_t ver, const std::vector<uint8_t>& data) {
    Bytes b;
    for (const auto& [cn, cv] : chain) {
        b.u32(0xfffffffeu).u32(uint32_t(cn.size() + 1));
        b.buf(reinterpret_cast<const uint8_t*>(cn.data()), cn.size());
        b.u8(0).u16(cv);
    }
    b.u32(0xffffffffu).u32(uint32_t(name.size() + 1));
    b.buf(reinterpret_cast<const uint8_t*>(name.data()), name.size());
    b.u8(0).u16(ver);
    b.u32(uint32_t(data.size())).buf(data);
    return b.out();
}

// ---------------------------------------------------------------------------
// fader taper (inverse of scripts/cpr-taper.mjs — calibrated exact) + JS helpers
// ---------------------------------------------------------------------------

// fdlibm log/log10 — the exact implementation V8 uses for Math.log10
// (v8/src/base/ieee754.cc: the classic SunSoft e_log.c + e_log10.c). Ported verbatim
// for BYTE PARITY with the Node reference writer: MSVC's std::log10 differs from V8 by
// 1-2 ulp on some inputs (measured: gain 10^(3.5/20) and 10^(-6.02/20)), which changed
// the emitted AnchorValue f64 bytes. Verified bit-exact against Node 22 on the parity
// corpus gains (scratch log10test).
// Copyright (C) 1993 by Sun Microsystems, Inc. Developed at SunSoft, a Sun Microsystems
// business. Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
namespace fdlibm {

uint64_t bitsOf(double d) {
    uint64_t u;
    std::memcpy(&u, &d, 8);
    return u;
}
double fromBits(uint64_t u) {
    double d;
    std::memcpy(&d, &u, 8);
    return d;
}
int32_t highWord(double d) { return int32_t(uint32_t(bitsOf(d) >> 32)); }
uint32_t lowWord(double d) { return uint32_t(bitsOf(d)); }
double setHighWord(double d, int32_t hi) {
    return fromBits((uint64_t(uint32_t(hi)) << 32) | lowWord(d));
}

// e_log.c
double fdLog(double x) {
    static constexpr double ln2_hi = 6.93147180369123816490e-01,
                            ln2_lo = 1.90821492927058770002e-10,
                            two54 = 1.80143985094819840000e+16,
                            Lg1 = 6.666666666666735130e-01,
                            Lg2 = 3.999999999940941908e-01,
                            Lg3 = 2.857142874366239149e-01,
                            Lg4 = 2.222219843214978396e-01,
                            Lg5 = 1.818357216161805012e-01,
                            Lg6 = 1.531383769920937332e-01,
                            Lg7 = 1.479819860511658591e-01;
    double hfsq, f, s, z, R, w, t1, t2, dk;
    int32_t k, hx, i, j;
    uint32_t lx;
    hx = highWord(x);
    lx = lowWord(x);
    k = 0;
    if (hx < 0x00100000) { /* x < 2**-1022 */
        if (((hx & 0x7fffffff) | int32_t(lx)) == 0)
            return -std::numeric_limits<double>::infinity(); /* log(+-0) = -inf */
        if (hx < 0)
            return std::numeric_limits<double>::quiet_NaN(); /* log(-#) = NaN */
        k -= 54;
        x *= two54; /* subnormal number, scale up x */
        hx = highWord(x);
    }
    if (hx >= 0x7ff00000)
        return x + x;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = setHighWord(x, hx | (i ^ 0x3ff00000)); /* normalize x or x/2 */
    k += (i >> 20);
    f = x - 1.0;
    if ((0x000fffff & (2 + hx)) < 3) { /* -2**-20 <= f < 2**-20 */
        if (f == 0) {
            if (k == 0)
                return 0.0;
            dk = double(k);
            return dk * ln2_hi + dk * ln2_lo;
        }
        R = f * f * (0.5 - 0.33333333333333333 * f);
        if (k == 0)
            return f - R;
        dk = double(k);
        return dk * ln2_hi - ((R - dk * ln2_lo) - f);
    }
    s = f / (2.0 + f);
    dk = double(k);
    z = s * s;
    i = hx - 0x6147a;
    w = z * z;
    j = 0x6b851 - hx;
    t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    i |= j;
    R = t2 + t1;
    if (i > 0) {
        hfsq = 0.5 * f * f;
        if (k == 0)
            return f - (hfsq - s * (hfsq + R));
        return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
    } else {
        if (k == 0)
            return f - s * (f - R);
        return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
    }
}

// e_log10.c
double log10(double x) {
    static constexpr double two54 = 1.80143985094819840000e+16,
                            ivln10 = 4.34294481903251816668e-01,
                            log10_2hi = 3.01029995663611771306e-01,
                            log10_2lo = 3.69423907715893078616e-13;
    double y, z;
    int32_t i, k, hx;
    uint32_t lx;
    hx = highWord(x);
    lx = lowWord(x);
    k = 0;
    if (hx < 0x00100000) { /* x < 2**-1022 */
        if (((hx & 0x7fffffff) | int32_t(lx)) == 0)
            return -std::numeric_limits<double>::infinity(); /* log(+-0) = -inf */
        if (hx < 0)
            return std::numeric_limits<double>::quiet_NaN(); /* log(-#) = NaN */
        k -= 54;
        x *= two54; /* subnormal number, scale up x */
        hx = highWord(x);
    }
    if (hx >= 0x7ff00000)
        return x + x;
    k += (hx >> 20) - 1023;
    i = int32_t((uint32_t(k) & 0x80000000u) >> 31);
    hx = (hx & 0x000fffff) | ((0x3ff - i) << 20);
    y = double(k + i);
    x = setHighWord(x, hx);
    z = y * log10_2lo + ivln10 * fdLog(x);
    return z + y * log10_2hi;
}

} // namespace fdlibm

double gainToCubaseValue(double g) {
    if (!std::isfinite(g) || g <= 0)
        return -1.0; // modern -inf sentinel (Value -1)
    if (g >= 1)
        return 25856.0 + (g - 1.0) * 6911.0;
    if (g >= 0.5)
        return 18688.0 + (g - 0.5) * 14336.0;
    return 18688.0 * std::sqrt(2.0 * g); // std::sqrt is IEEE-exact, like JS Math.sqrt
}

double gainToDb(double g) {
    return g > 0 ? 20.0 * fdlibm::log10(g) : -200.0; // -200 = modern -inf AnchorValue
}

// JS Math.round: ties round toward +infinity (std::round ties away from zero — differs
// at negative .5 values, so mirror the JS semantics exactly).
double jsRound(double x) { return std::floor(x + 0.5); }

// ---------------------------------------------------------------------------
// writer model (the cpr-write.mjs model JSON shape)
// ---------------------------------------------------------------------------

struct WriterNote {
    int pitch = 60;
    int velocity = 100;
    double startBeat = 0.0;   // CLIP-relative
    double lengthBeats = 1.0;
};
struct WriterClip {
    double startBeat = 0.0;
    double lengthBeats = 4.0;
    std::vector<WriterNote> notes;
};
// One channel insert, ready to emit: identity GUID + framed state blobs (the exact
// shapes CprImportProvider's AttrTreeScan/modToXPlugin parse back).
struct WriterInsert {
    std::string guid;    // 32-hex "Plugin UID" GUID
    std::string name;
    std::string version; // may be empty (member omitted)
    std::vector<uint8_t> ac; // audioComponent blob (fxb image / MD3S component)
    std::vector<uint8_t> ed; // editController blob (vst3 controller; usually empty)
};
// One audio event: an INLINE PAudioClip (FNPath file reference) under an MAudioEvent.
struct WriterAudioClip {
    std::string clipName;
    std::string fileName; // "kick.wav"
    std::string dirPath;  // "C:\proj\audio\" — trailing separator, drive-letter form
    double startBeat = 0.0;
    double lengthSamples = 0.0;
    double offsetSamples = 0.0;
};
struct WriterTrack {
    std::string name;
    double volumeGain = 1.0;
    double pan = 0.0;
    std::vector<WriterClip> clips;
    bool isAudio = false;                    // emit MAudioTrackEvent instead of MIDI
    std::vector<WriterAudioClip> audioClips; // audio tracks only
    std::vector<WriterInsert> inserts;       // channel insert chain (audio/instrument)
    std::optional<WriterInsert> instrument;  // instrument tracks: the Synth Slot VSTi
    // MIDI tracks routed to an instrument track (Track::midiTarget): the routing
    // survives the round-trip as the same "<32-hex GUID>-<slot>" connection string
    // modern Cubase writes — slot = ordinal of the target instrument track.
    int routeSlot = -1;
    std::string routeGuid; // 32 hex ("0"*32 when the instrument had no exportable GUID)
};
struct WriterModel {
    double tempo = 120.0;
    std::vector<WriterTrack> tracks;
};

// ---------------------------------------------------------------------------
// insert identity/state framing (inverse of CprImportProvider's identityFromGuid /
// fxbExtract / packMd3s — keep in lockstep with those)
// ---------------------------------------------------------------------------

// Modern "Plugin UID" GUID for a VST2 plugin: 16 bytes 'V','S','T', fourcc BE, then up
// to 9 plugin-name bytes (zero padded), rendered as 32 uppercase hex chars.
std::string vst2Guid(uint32_t fourcc, const std::string& name) {
    uint8_t bytes[16] = {'V', 'S', 'T'};
    bytes[3] = uint8_t(fourcc >> 24);
    bytes[4] = uint8_t(fourcc >> 16);
    bytes[5] = uint8_t(fourcc >> 8);
    bytes[6] = uint8_t(fourcc);
    for (size_t i = 0; i < 9 && i < name.size(); ++i)
        bytes[7 + i] = uint8_t(name[i]);
    static const char* kHex = "0123456789ABCDEF";
    std::string out(32, '0');
    for (int i = 0; i < 16; ++i) {
        out[size_t(2 * i)] = kHex[bytes[i] >> 4];
        out[size_t(2 * i) + 1] = kHex[bytes[i] & 0xf];
    }
    return out;
}

// Wrap a raw effGetChunk BANK chunk in the 'CcnK'/'FBCh' fxb image fxbExtract reads:
// 0 'CcnK', +4 u32 byteSize (total-8), +8 'FBCh', +12 version 2, +16 fxID, +20
// fxVersion 1, +24 numPrograms 1, +28 zeros[128], +156 u32 chunkSize, +160 chunk.
std::vector<uint8_t> wrapFxbChunk(uint32_t fxId, const std::vector<uint8_t>& chunk) {
    Bytes b;
    const uint32_t total = uint32_t(160 + chunk.size());
    b.u8('C').u8('c').u8('n').u8('K').u32(total - 8);
    b.u8('F').u8('B').u8('C').u8('h').u32(2).u32(fxId).u32(1).u32(1);
    b.zeros(128);
    b.u32(uint32_t(chunk.size()));
    b.buf(chunk);
    return b.out();
}

// Split the host's 'MD3S' VST3 state container (packMd3s framing, all LE) into the
// component/controller streams the cpr stores separately. False = not MD3S.
bool splitMd3s(const std::vector<uint8_t>& s, std::vector<uint8_t>& comp,
               std::vector<uint8_t>& ctrl) {
    auto rdLe = [&](size_t off, uint32_t& v) {
        if (off + 4 > s.size())
            return false;
        v = uint32_t(s[off]) | (uint32_t(s[off + 1]) << 8) | (uint32_t(s[off + 2]) << 16) |
            (uint32_t(s[off + 3]) << 24);
        return true;
    };
    uint32_t magic = 0, lenA = 0, lenB = 0;
    if (!rdLe(0, magic) || magic != 0x5333444Du || !rdLe(4, lenA))
        return false;
    const size_t compEnd = 8ull + lenA;
    if (compEnd + 4 > s.size() || !rdLe(compEnd, lenB) || compEnd + 4 + lenB > s.size())
        return false;
    comp.assign(s.begin() + 8, s.begin() + ptrdiff_t(compEnd));
    ctrl.assign(s.begin() + ptrdiff_t(compEnd + 4), s.begin() + ptrdiff_t(compEnd + 4 + lenB));
    return true;
}

// ---------------------------------------------------------------------------
// generated record content (cpr-write.mjs REGISTRY/noteBytes/buildPartNode/
// channelTreeBytes/buildTrackNode — PIPELINE v2 shapes only: donor track 1 is always
// kept, so generated tracks never carry tempo/signature records)
// ---------------------------------------------------------------------------

// MMidiPart event-class registry: 7 empty full-form records (byte shape copied from a
// native C5 5.1.1 save — all names full-form, so the bytes are position-independent).
const std::vector<uint8_t>& registryBytes() {
    static const std::vector<uint8_t> reg = [] {
        std::vector<uint8_t> r;
        auto add = [&](const std::vector<uint8_t>& b) { r.insert(r.end(), b.begin(), b.end()); };
        add(fullRecordBytes({{"MMidiEvent", 2}}, "MMidiNote", 1, {}));
        add(fullRecordBytes({}, "MMidiPolyPressure", 0, {}));
        add(fullRecordBytes({}, "MMidiAfterTouch", 0, {}));
        add(fullRecordBytes({}, "MMidiProgramChange", 0, {}));
        add(fullRecordBytes({}, "MMidiController", 0, {}));
        add(fullRecordBytes({}, "MMidiPitchBend", 0, {}));
        add(fullRecordBytes({}, "MMidiSysex", 0, {}));
        return r;
    }();
    return reg;
}

// compact note event (43 B): u8 0x90, f64 tick, u8 ch, u8 pitch, u8 vel, u32 flags,
// u16 nExt=0, f64 lengthTicks, f64 0, u8[9] 0. flags 0x02000000 = the constant every
// corpus note carries (meaning unknown — donor-copied).
std::vector<uint8_t> noteBytes(const WriterNote& n) {
    return Bytes()
        .u8(0x90)
        .f64(n.startBeat * kPpq)
        .u8(0)
        .u8(uint32_t(n.pitch) & 0x7f)
        .u8(uint32_t(n.velocity) & 0x7f)
        .u32(0x02000000)
        .u16(0)
        .f64(n.lengthBeats * kPpq)
        .f64(0)
        .zeros(9)
        .out();
}

// MMidiPartEvent { raw 26B: u16 flags, f64 startTick, f64 lengthTicks, f64 offsetTick;
//   MMidiPart:MPartNode { lpstr name, u32 0, u32 0x208, u32 0x24F, u32 evCount,
//     u8 7 + registry, evCount compact notes } }
NodePtr buildPartNode(const std::string& partName, const WriterClip& clip) {
    std::vector<WriterNote> notes = clip.notes;
    std::stable_sort(notes.begin(), notes.end(),
                     [](const WriterNote& a, const WriterNote& b) {
                         return a.startBeat < b.startBeat;
                     });
    Bytes body;
    body.lpstrBom(partName).u32(0).u32(0x208).u32(0x24f).u32(uint32_t(notes.size()));
    if (!notes.empty()) {
        // NOTE: the u8 registry-count byte is absent when the part is empty
        // (importer contract).
        body.u8(7).buf(registryBytes());
        for (const WriterNote& n : notes)
            body.buf(noteBytes(n));
    }
    auto evHead = makeRaw(Bytes()
                              .u16(0)
                              .f64(clip.startBeat * kPpq)
                              .f64(clip.lengthBeats * kPpq)
                              .f64(0)
                              .out());
    std::vector<NodePtr> partChildren;
    partChildren.push_back(makeRaw(body.out()));
    std::vector<NodePtr> evChildren;
    evChildren.push_back(std::move(evHead));
    evChildren.push_back(
        makeRec("MMidiPart", 2, std::move(partChildren), {{"MPartNode", 0}}));
    return makeRec("MMidiPartEvent", 2, std::move(evChildren));
}

// Standard Panner channel member — byte-replica of the C5 donor's own channel-level
// Panner (cpr-donor-c5.cpr @0x232d, 17 members) with the pan written into the
// component state. The 20-byte audioComponent blob is LITTLE-endian (plugin-private
// state): f32 pos (0 = hard L, 0.5 = C, 1 = hard R; Cubase UI shows (pos-0.5)*200),
// f32 rightPos (0.5 = balance panner), u32 mode 4 (engaged — donor channel value),
// u32 channelCount 2, u32 0. Modern Cubase (13+) reads the channel pan ONLY from
// this blob (CPR_MIXER_FORMAT.md §5a); C5-era readers use the Pan member.
void appendPannerMember(Bytes& b, double pan) {
    const auto arrangement = [&](const char* key) {
        b.lpstr(key).u16(0x0002).u16(0x0005).u32(1); // array, 1 item
        b.u32(1);                                    // 1 member in the item
        b.lpstr("Type").u16(0x0002).u16(0x0002).u32(2).i64(1).i64(2); // i64s [1, 2]
    };
    b.lpstr("Panner").u16(0x0002).u16(0x0006).u32(17);
    b.lpstr("Default SurroundPan UID").u16(0x0002).u16(0x0006).u32(1);
    b.lpstr("GUID").u16(0x0008).lpstrBom("56535453506132737572726F756E6470");
    b.lpstr("PannerType").u16(0x0002).u16(0x0006).u32(3);
    b.lpstr("Value").u16(0x0001).i64(2);
    b.lpstr("Min").u16(0x0001).i64(0);
    b.lpstr("Max").u16(0x0001).i64(11);
    b.lpstr("Plugin UID").u16(0x0002).u16(0x0006).u32(1);
    b.lpstr("GUID").u16(0x0008).lpstrBom("44E1149EDB3E4387BDD827FEA3A39EE7");
    b.lpstr("Plugin Name").u16(0x0008).lpstrBom("Standard Panner");
    b.lpstr("Audio Input Count").u16(0x0001).i64(1);
    arrangement("Audio Input Arrangement");
    b.lpstr("Audio Output Count").u16(0x0001).i64(1);
    arrangement("Audio Output Arrangement");
    b.lpstr("Event Input Count").u16(0x0001).i64(0);
    b.lpstr("Event Output Count").u16(0x0001).i64(0);
    b.lpstr("audioComponent").u16(0x0002).u16(0x0007).u32(20);
    const uint32_t pos = std::bit_cast<uint32_t>(
        static_cast<float>(0.5 + std::clamp(pan, -1.0, 1.0) * 0.5));
    b.u8(pos).u8(pos >> 8).u8(pos >> 16).u8(pos >> 24); // f32le pan position
    b.u8(0x00).u8(0x00).u8(0x00).u8(0x3f);              // f32le 0.5 right position
    b.u8(0x04).u8(0).u8(0).u8(0);                       // u32le mode 4 (engaged)
    b.u8(0x02).u8(0).u8(0).u8(0);                       // u32le channelCount 2
    b.zeros(4);
    b.lpstr("editController").u16(0x0002).u16(0x0007).u32(0);
    b.lpstr("Editor Width").u16(0x0001).i64(0);
    b.lpstr("Editor Height").u16(0x0001).i64(0);
    b.lpstr("Active").u16(0x0001).i64(1);
    b.lpstr("IDString").u16(0x0008).lpstrBom("Panner");
    b.lpstr("Bay Program").u16(0x0008).u32(0); // empty plain lpstr (donor byte-exact)
}

// One {Plugin isA, Plugin{...}} pair — the exact gate + identity/state fields
// AttrTreeScan's insert capture requires (CprImportProvider.cpp pluginObj/noteString/
// noteBlob).
void appendPluginEntry(Bytes& b, const WriterInsert& ins) {
    b.lpstr("Plugin isA").u16(0x0008).lpstrBom("VstCtrlInternalEffect");
    const uint32_t members = 4u + (ins.version.empty() ? 0u : 1u);
    b.lpstr("Plugin").u16(0x0002).u16(0x0006).u32(members);
    b.lpstr("Plugin UID").u16(0x0002).u16(0x0006).u32(1);
    b.lpstr("GUID").u16(0x0008).lpstrBom(ins.guid);
    b.lpstr("Plugin Name").u16(0x0008).lpstrBom(ins.name);
    if (!ins.version.empty())
        b.lpstr("Version").u16(0x0008).lpstrBom(ins.version);
    b.lpstr("audioComponent").u16(0x0002).u16(0x0007).u32(uint32_t(ins.ac.size()));
    b.buf(ins.ac);
    b.lpstr("editController").u16(0x0002).u16(0x0007).u32(uint32_t(ins.ed.size()));
    b.buf(ins.ed);
}

// Channel insert chain: InsertFolder{Slot[]} where every slot is one plugin entry —
// path ["InsertFolder","Slot"[i]] as the importer's insert capture expects.
void appendInsertsMember(Bytes& b, const std::vector<WriterInsert>& inserts) {
    b.lpstr("InsertFolder").u16(0x0002).u16(0x0006).u32(1); // object, 1 member
    b.lpstr("Slot").u16(0x0002).u16(0x0005).u32(uint32_t(inserts.size())); // obj array
    for (const WriterInsert& ins : inserts) {
        b.u32(2); // array item: { Plugin isA, Plugin }
        appendPluginEntry(b, ins);
    }
}

// Instrument-track VSTi: a top-level "Synth Slot" object — path ["Synth Slot"], which
// the importer attaches as the track's instrument (promoting the track to Instrument).
void appendSynthSlotMember(Bytes& b, const WriterInsert& ins) {
    b.lpstr("Synth Slot").u16(0x0002).u16(0x0006).u32(2);
    appendPluginEntry(b, ins);
}

// Synthetic modern channel attr tree: FF FE A4 C8, u32 topCount, then self-labeled
// entries (CPR_MIXER_FORMAT.md §5): Volume{Value (25856-taper), AnchorValue (dB)},
// when pan != 0 the Standard Panner member carrying the pan in its component blob
// (§5a), and — when the track has exportable inserts — the InsertFolder chain. NO era
// of native Cubase writes a channel-level Pan{Value} member (C5.1.1,
// C12 and C13 labeled fixtures are all blob-only), so neither do we: the blob is the
// one store every Cubase reads. Omitted when centered (Cubase defaults to center).
// Human-validated in Cubase 5.1.1 (ladder v2 stage 22, docs/CPR_WRITER_M3_NOTES.md);
// the Panner member is byte-identical to the C5 fixtures' native channel Panner.
std::vector<uint8_t> channelTreeBytes(const WriterTrack& track) {
    Bytes b;
    b.u8(0xff).u8(0xfe).u8(0xa4).u8(0xc8);
    const bool hasPan = std::isfinite(track.pan) && track.pan != 0.0;
    const bool hasRoute = track.routeSlot >= 0 && track.routeGuid.size() == 32;
    b.u32(1u + (hasPan ? 1u : 0u) + (track.inserts.empty() ? 0u : 1u) +
          (track.instrument ? 1u : 0u) + (hasRoute ? 1u : 0u));
    // Volume (type 0x02 container, sub 0x06 named object, 2 members)
    b.lpstr("Volume").u16(0x0002).u16(0x0006).u32(2);
    b.lpstr("Value").u16(0x0004).f64(gainToCubaseValue(track.volumeGain));
    b.lpstr("AnchorValue").u16(0x0004).f64(gainToDb(track.volumeGain));
    if (hasPan)
        appendPannerMember(b, track.pan);
    if (track.instrument)
        appendSynthSlotMember(b, *track.instrument);
    if (!track.inserts.empty())
        appendInsertsMember(b, track.inserts);
    if (hasRoute) {
        // MIDI output routing, PLAIN lpstr value (matches the native modern shape the
        // importer's routing scan expects: "<32 hex>-<slot>").
        char slotBuf[8];
        std::snprintf(slotBuf, sizeof(slotBuf), "%d", track.routeSlot);
        b.lpstr("Output Connection").u16(0x0008).lpstr(track.routeGuid + "-" + slotBuf);
    }
    return b.out();
}

// One audio event record (all shapes evidenced from a native Cubase 7 project):
// MAudioEvent v4 {
//   raw 26B: u16 0, f64 startTick, f64 lengthSamples, f64 offsetSamples;
//   PAudioClip v4 : PMediaDescriptor v1 (INLINE — its record header doubles as the
//     clip "link" u32 at +26, >= 0x80000000) {
//       raw: lpstr clipName;
//       FNPath v0 : FPath v0 { lpstr fileName, lpstr ext, lpstr ext, lpstr "Wave
//         File", u32 1, lpstr dirPath (drive-letter, trailing separator) } } }
// No AudioCluster/AudioFile pool records — those carry stored offset-ids (the rebase
// machinery's domain); the importer treats them as optional metadata.
NodePtr buildAudioEventNode(const WriterAudioClip& c) {
    std::vector<NodePtr> clipChildren;
    clipChildren.push_back(makeRaw(Bytes().lpstrBom(c.clipName).out()));
    Bytes fn;
    fn.lpstrBom(c.fileName).lpstrBom("wav").lpstrBom("wav").lpstrBom("Wave File");
    fn.u32(1).lpstrBom(c.dirPath);
    std::vector<NodePtr> fnpChildren;
    fnpChildren.push_back(makeRaw(fn.out()));
    clipChildren.push_back(makeRec("FNPath", 0, std::move(fnpChildren), {{"FPath", 0}}));
    std::vector<NodePtr> evChildren;
    evChildren.push_back(makeRaw(Bytes()
                                     .u16(0)
                                     .f64(c.startBeat * kPpq)
                                     .f64(c.lengthSamples)
                                     .f64(c.offsetSamples)
                                     .out()));
    evChildren.push_back(
        makeRec("PAudioClip", 4, std::move(clipChildren), {{"PMediaDescriptor", 1}}));
    return makeRec("MAudioEvent", 4, std::move(evChildren));
}

// One generated track record:
// MMidiTrackEvent v3 / MAudioTrackEvent v1 (no chain — matches native bytes) {
//   raw 26B: u16 0, f64 0, f64 576000 (donor track-event length), f64 0;
//   MListNode v0 { lpstr name, u32 0, u32 0x208, u32 0x24F, u32 n, events… };
//   raw: synthetic channel tree (Volume/Pan/Inserts) }
NodePtr buildTrackNode(const WriterTrack& track) {
    std::vector<NodePtr> listChildren;
    listChildren.push_back(
        makeRaw(Bytes().lpstrBom(track.name).u32(0).u32(0x208).u32(0x24f).out()));
    if (track.isAudio) {
        listChildren.push_back(
            makeRaw(Bytes().u32(uint32_t(track.audioClips.size())).out()));
        for (const WriterAudioClip& c : track.audioClips)
            listChildren.push_back(buildAudioEventNode(c));
    } else {
        listChildren.push_back(makeRaw(Bytes().u32(uint32_t(track.clips.size())).out()));
        for (const WriterClip& clip : track.clips)
            listChildren.push_back(buildPartNode(track.name, clip));
    }
    std::vector<NodePtr> children;
    children.push_back(makeRaw(Bytes().u16(0).f64(0).f64(576000).f64(0).out()));
    children.push_back(makeRec("MListNode", 0, std::move(listChildren)));
    children.push_back(makeRaw(channelTreeBytes(track)));
    return makeRec(track.isAudio ? "MAudioTrackEvent" : "MMidiTrackEvent",
                   track.isAudio ? 1 : 3, std::move(children));
}

// ---------------------------------------------------------------------------
// donor-tree surgery (cpr-write.mjs buildIdInfo/clsName/healArch)
// ---------------------------------------------------------------------------

// origId -> {name, ver} from every full elem; fallback reads the name straight out of
// the donor buffer at base+origId (covers defs registered by speculative scans).
struct IdInfo {
    std::unordered_map<int64_t, std::pair<std::string, uint16_t>> map;
    const uint8_t* buf = nullptr;
    int64_t base = 0;

    static IdInfo build(const Arch& arch, const uint8_t* buf, int64_t base) {
        IdInfo info;
        info.buf = buf;
        info.base = base;
        std::function<void(const std::vector<NodePtr>&)> walk =
            [&](const std::vector<NodePtr>& list) {
                for (const NodePtr& n : list) {
                    if (!n->isRec)
                        continue;
                    auto reg = [&](const Elem& e) {
                        if (e.full && e.origId >= 0)
                            info.map[e.origId] = {e.name, e.ver};
                    };
                    for (const Elem& e : n->chain)
                        reg(e);
                    reg(n->cls);
                    walk(n->children);
                }
            };
        walk(arch.nodes);
        return info;
    }

    std::pair<std::string, uint16_t> get(int64_t origId) const {
        const auto it = map.find(origId);
        if (it != map.end())
            return it->second;
        const int64_t p = base + origId;
        const int64_t len = readU32(buf + p);
        if (len < 2 || len > 100)
            throw Err("unresolvable name def id=" + hex(origId));
        return {std::string(reinterpret_cast<const char*>(buf + p + 4), size_t(len - 1)),
                readU16(buf + p + 4 + len)};
    }
};

std::string clsName(const Node& n, const IdInfo& idInfo) {
    return n.cls.full ? n.cls.name : idInfo.get(n.cls.refOrigId).first;
}

// offset (from record-header start) of the u32 name-length field of elems[i]
// (elems = [...chain, cls]; must mirror emitElem exactly)
int64_t elemLenFieldDelta(const std::vector<Elem*>& elems, size_t i) {
    int64_t off = 0;
    for (size_t k = 0; k < i; ++k) {
        const Elem* e = elems[k];
        off += e->full ? 4 + 4 + int64_t(e->name.size()) + 1 + 2 : 8; // k<i => chain elem
    }
    return off + 4; // marker (FFFFFFFE/FFFFFFFF), then the len field
}

// Heal pass: refs whose interned definition no longer precedes them (deleted with the
// donor tracks) are converted to full-form definitions in place; rec-node anchors are
// rebuilt so the serializer can recompute every surviving back-ref id.
int healArch(Arch& arch, const IdInfo& idInfo) {
    // 1. which origIds are still referenced anywhere (post-mutation)
    std::unordered_set<int64_t> needed;
    std::function<void(const std::vector<NodePtr>&)> collect =
        [&](const std::vector<NodePtr>& list) {
            for (const NodePtr& n : list) {
                if (!n->isRec)
                    continue;
                for (const Elem& e : n->chain)
                    if (!e.full)
                        needed.insert(e.refOrigId);
                if (!n->cls.full)
                    needed.insert(n->cls.refOrigId);
                collect(n->children);
            }
        };
    collect(arch.nodes);

    std::unordered_set<int64_t> live;
    int healed = 0;
    std::function<void(std::vector<NodePtr>&)> walk = [&](std::vector<NodePtr>& list) {
        for (NodePtr& n : list) {
            if (!n->isRec) {
                for (const Anchor& a : n->anchors)
                    live.insert(a.origId); // raw bytes unchanged, deltas valid
                continue;
            }
            std::vector<Elem*> elems;
            for (Elem& e : n->chain)
                elems.push_back(&e);
            elems.push_back(&n->cls);
            // rec-node anchors always sit on header name defs => rebuild below; anything
            // else would mean a speculative def inside a header span, absent from this
            // donor.
            for (const Anchor& a : n->anchors) {
                bool onElem = false;
                for (const Elem* e : elems)
                    if (e->full && e->origId == a.origId)
                        onElem = true;
                if (!onElem)
                    throw Err("unexpected non-elem anchor on rec @" + hex(n->hdrOff));
            }
            for (Elem* e : elems) {
                if (!e->full && !live.count(e->refOrigId)) {
                    const auto info = idInfo.get(e->refOrigId); // def deleted — re-define
                    e->full = true;
                    e->name = info.first;
                    e->ver = info.second;
                    e->origId = e->refOrigId;
                    e->refOrigId = -1;
                    ++healed;
                }
                if (e->full && e->origId >= 0)
                    live.insert(e->origId);
            }
            n->anchors.clear();
            for (size_t i = 0; i < elems.size(); ++i) {
                const Elem* e = elems[i];
                if (e->full && e->origId >= 0 && needed.count(e->origId))
                    n->anchors.push_back({e->origId, elemLenFieldDelta(elems, i)});
            }
            walk(n->children);
        }
    };
    walk(arch.nodes);
    return healed;
}

// ---------------------------------------------------------------------------
// writeCpr (cpr-write.mjs writeCpr — PIPELINE v2 defaults: keepDonorTracks 1,
// channel tree on, stored-id rebase + verification gate, MRoot table untouched)
// ---------------------------------------------------------------------------

// record classes whose raw bodies are KNOWN to store archive-offset object ids
// (decoded 2026-07-16 from tapetim/isi-good; docs/CPR_WRITER_M3_NOTES.md). Only these
// owners get their stored ids rebased/verified — value-matches inside other classes are
// treated as coincidences (e.g. editor-geometry u32 pairs matching low record ids).
bool isStoredIdOwner(const std::string& cls) {
    return cls == "AudioCluster" || cls == "AudioFile" || cls == "AClusterSegment" ||
           cls == "GTreeEntry" || cls == "PAudioProcessCommand" || cls == "MAudioEvent";
}

struct WriteStats {
    int64_t bytes = 0, donorBytes = 0;
    int tracks = 0, keptDonorTracks = 0, parts = 0, notes = 0;
    int healedRefs = 0, rebasedIds = 0, verifiedIds = 0, staleTableIds = 0,
        ignoredIdMatches = 0;
};

std::vector<uint8_t> writeCprBytes(const WriterModel& model, const uint8_t* donorBuf,
                                   size_t donorLen, WriteStats& stats) {
    if (!std::isfinite(model.tempo) || model.tempo < 20 || model.tempo > 400)
        throw Err("model.tempo out of range: " + std::to_string(model.tempo));
    if (model.tracks.empty())
        throw Err("model.tracks must be a non-empty array");

    Tree tree = parse(donorBuf, donorLen);
    Chunk* archChunk = nullptr;
    for (Chunk& c : tree.chunks) {
        const std::string& sn = c.streamName;
        const bool isArrangement = sn.size() >= 13 &&
            sn.compare(sn.size() - 13, 13, "|PArrangement") == 0;
        if (c.id == "ARCH" && isArrangement && !archChunk)
            archChunk = &c;
    }
    if (!archChunk || !archChunk->arch)
        throw Err("donor has no parsed Arrangement ARCH");
    Arch& arch = *archChunk->arch;
    const int64_t base = archChunk->dataOff + 4;
    const IdInfo idInfo = IdInfo::build(arch, donorBuf, base);

    // find the MTrackList record (first, pre-order)
    Node* trackList = nullptr;
    {
        std::function<void(std::vector<NodePtr>&)> find = [&](std::vector<NodePtr>& list) {
            for (NodePtr& n : list) {
                if (!n->isRec)
                    continue;
                if (!trackList && clsName(*n, idInfo) == "MTrackList")
                    trackList = n.get();
                find(n->children);
            }
        };
        find(arch.nodes);
    }
    if (!trackList)
        throw Err("donor has no MTrackList");

    // MTrackList children = [raw 22B header, track records...]; the header's trailing
    // u16 is the track count (donor: 7).
    Node* head = trackList->children.empty() ? nullptr : trackList->children[0].get();
    if (!head || head->isRec || head->bytes.size() != 22)
        throw Err("unexpected MTrackList header shape");
    const int donorCount = readU16(head->bytes.data() + 20);
    std::vector<Node*> donorRecs;
    for (NodePtr& c : trackList->children)
        if (c->isRec)
            donorRecs.push_back(c.get());
    if (donorCount != int(donorRecs.size()))
        throw Err("MTrackList count u16 " + std::to_string(donorCount) + " != " +
                  std::to_string(donorRecs.size()) + " track records");
    const int keep = 1; // PIPELINE v2 base (real-Cubase-validated; M3 notes)
    if (keep > int(donorRecs.size()))
        throw Err("keepDonorTracks out of range");
    std::vector<Node*> keptRecs(donorRecs.begin(), donorRecs.begin() + keep);
    std::vector<Node*> removedRecs(donorRecs.begin() + keep, donorRecs.end());

    // --- stored-offset-id inventory (BEFORE mutation) -------------------------------
    std::unordered_map<int64_t, std::string> donorRecords; // id -> class name
    {
        std::function<void(const std::vector<NodePtr>&)> inv =
            [&](const std::vector<NodePtr>& list) {
                for (const NodePtr& n : list) {
                    if (!n->isRec)
                        continue;
                    donorRecords[n->dataStart - base] = clsName(*n, idInfo);
                    inv(n->children);
                }
            };
        inv(arch.nodes);
    }
    const int64_t boundaryId = trackList->dataEnd - base; // ids >= boundary shift
    std::vector<std::pair<int64_t, int64_t>> removedSpans;
    for (const Node* n : removedRecs)
        removedSpans.push_back({n->hdrOff - base, n->dataEnd - base});
    auto isRemovedId = [&](int64_t id) {
        for (const auto& [a, b] : removedSpans)
            if (id >= a && id < b)
                return true;
        return false;
    };
    std::unordered_set<const Node*> removedNodes(removedRecs.begin(), removedRecs.end());

    // Donor MAudioEvent / MAudioTrackEvent records that SURVIVE the splice (outside the
    // removed tracks) — the post-splice count checks expect donor survivors + generated.
    int donorAudioEvents = 0, donorAudioTracks = 0;
    {
        std::function<void(const std::vector<NodePtr>&)> count =
            [&](const std::vector<NodePtr>& list) {
                for (const NodePtr& n : list) {
                    if (!n->isRec || removedNodes.count(n.get()))
                        continue;
                    const std::string nm = clsName(*n, idInfo);
                    if (nm == "MAudioEvent")
                        ++donorAudioEvents;
                    else if (nm == "MAudioTrackEvent")
                        ++donorAudioTracks;
                    count(n->children);
                }
            };
        count(arch.nodes);
    }

    // scan raw spans (skipping the MTrackList head we replace and the removed tracks)
    // for u32be values equal to a known record id
    struct Site {
        Node* node;
        int64_t off;
        int64_t oldId;
        std::string targetCls;
        std::string owner;
    };
    std::vector<Site> sites;
    {
        std::function<void(std::vector<NodePtr>&, const std::string&)> scan =
            [&](std::vector<NodePtr>& list, const std::string& owner) {
                for (NodePtr& n : list) {
                    if (removedNodes.count(n.get()) || n.get() == head)
                        continue;
                    if (!n->isRec) {
                        for (int64_t i = 0; i + 4 <= int64_t(n->bytes.size()); ++i) {
                            const uint32_t v = readU32(n->bytes.data() + i);
                            if (v < 0x40)
                                continue;
                            const auto it = donorRecords.find(int64_t(v));
                            if (it == donorRecords.end())
                                continue;
                            sites.push_back({n.get(), i, int64_t(v), it->second, owner});
                            i += 3;
                        }
                        continue;
                    }
                    scan(n->children, clsName(*n, idInfo));
                }
            };
        scan(arch.nodes, "TOP");
    }

    // --- model.tempo onto the kept donor tempo carrier (same-length float patch) ----
    {
        Node* tempoRec = nullptr;
        std::function<void(std::vector<NodePtr>&)> find = [&](std::vector<NodePtr>& list) {
            for (NodePtr& n : list) {
                if (!n->isRec)
                    continue;
                if (!tempoRec && clsName(*n, idInfo) == "MTempoTrackEvent")
                    tempoRec = n.get();
                find(n->children);
            }
        };
        find(keptRecs[0]->children);
        if (!tempoRec)
            throw Err("kept donor track 1 has no MTempoTrackEvent to carry model.tempo");
        Node* traw =
            tempoRec->children.empty() ? nullptr : tempoRec->children[0].get();
        if (!traw || traw->isRec || traw->bytes.size() != 36 ||
            readU32(traw->bytes.data()) != 1)
            throw Err("unexpected donor MTempoTrackEvent shape (want 36B, u32 pointCount 1)");
        writeF32(traw->bytes.data() + 4, 60.0 / model.tempo); // point 0 secondsPerQuarter
        writeF32(traw->bytes.data() + 26, model.tempo);       // fixed/rehearsal BPM
    }

    // Rename the kept donor carrier "Track1" -> "~MyDAW" (same length — a pure byte
    // patch like the tempo write). The importer skips this sentinel so round-trips
    // don't grow a ghost empty audio track; Cubase just shows a track named ~MyDAW.
    {
        Node* ml = nullptr;
        std::function<void(std::vector<NodePtr>&)> find = [&](std::vector<NodePtr>& list) {
            for (NodePtr& n : list) {
                if (!n->isRec)
                    continue;
                if (!ml && clsName(*n, idInfo) == "MListNode")
                    ml = n.get();
                find(n->children);
            }
        };
        find(keptRecs[0]->children);
        if (ml && !ml->children.empty() && !ml->children[0]->isRec) {
            std::vector<uint8_t>& nb = ml->children[0]->bytes;
            if (nb.size() >= 10 && readU32(nb.data()) >= 7 &&
                std::memcmp(nb.data() + 4, "Track1", 6) == 0)
                std::memcpy(nb.data() + 4, "~MyDAW", 6);
        }
    }

    std::vector<uint8_t> newHead = head->bytes;
    writeU16(newHead.data() + 20, uint16_t(keep + int(model.tracks.size())));

    // replace the track list: [new 22B head, kept donor track(s), generated tracks]
    {
        std::vector<NodePtr> newChildren;
        newChildren.push_back(makeRaw(std::move(newHead)));
        for (NodePtr& c : trackList->children)
            if (c->isRec && std::find(keptRecs.begin(), keptRecs.end(), c.get()) !=
                                keptRecs.end())
                newChildren.push_back(std::move(c));
        for (const WriterTrack& t : model.tracks)
            newChildren.push_back(buildTrackNode(t));
        trackList->children = std::move(newChildren);
        head = nullptr; // destroyed with the old children vector
    }

    const int healed = healArch(arch, idInfo);

    std::vector<uint8_t> out = serialize(tree);

    // --- stored-offset-id rebase + verification gate --------------------------------
    // classify sites; patch known-owner ids past the boundary by the (uniform) edit delta
    const int64_t delta = int64_t(out.size()) - int64_t(donorLen);
    int rebasedIds = 0, staleTableIds = 0, ignoredIdMatches = 0;
    struct VerifySite {
        int64_t newId;
        std::string targetCls;
        std::string owner;
    };
    std::vector<VerifySite> verifySites;
    for (const Site& s : sites) {
        if (isRemovedId(s.oldId)) {
            // target record was deleted with the donor tracks
            if (s.owner == "MRoot") {
                ++staleTableIds; // C5-tolerated stale table
                continue;
            }
            if (isStoredIdOwner(s.owner))
                throw Err("stored " + s.owner + " id " + hex(s.oldId) +
                          " targets a deleted track record — donor unsupported without "
                          "deep rebase");
            ++ignoredIdMatches; // value coincidence inside an unknown owner
            continue;
        }
        if (!isStoredIdOwner(s.owner)) {
            if (s.owner != "MRoot") {
                ++ignoredIdMatches;
                continue;
            }
            verifySites.push_back({s.oldId, s.targetCls, s.owner}); // table entry, kept
            continue;
        }
        if (s.oldId >= boundaryId) {
            if (healed > 0)
                throw Err("stored-id rebase with healed refs is unsupported "
                          "(non-uniform shift)");
            const int64_t newId = s.oldId + delta;
            if (newId < 0 || newId > 0xffffffffll)
                throw Err("rebased stored id out of u32 range");
            writeU32(s.node->bytes.data() + s.off, uint32_t(newId));
            ++rebasedIds;
            verifySites.push_back({newId, s.targetCls, s.owner});
        } else {
            verifySites.push_back({s.oldId, s.targetCls, s.owner});
        }
    }
    if (rebasedIds > 0) {
        std::vector<uint8_t> out2 = serialize(tree);
        if (out2.size() != out.size())
            throw Err("rebase changed layout length");
        out = std::move(out2);
    }

    // --- self-checks (the post-splice verifier: throw rather than ship a bad file) ---
    // byte sanity: the output must re-parse and re-serialize byte-identically, stay C5,
    // and contain exactly the generated track records.
    const Tree re = parse(out.data(), out.size());
    const int64_t diff = firstDiff(out, serialize(re));
    if (diff >= 0)
        throw Err("written file not re-serialize-stable (first diff @" + hex(diff) + ")");
    if (detectEra(re) != "c5")
        throw Err("written file no longer detects as C5");
    const Chunk* reArch = nullptr;
    for (const Chunk& c : re.chunks) {
        const std::string& sn = c.streamName;
        const bool isArrangement = sn.size() >= 13 &&
            sn.compare(sn.size() - 13, 13, "|PArrangement") == 0;
        if (c.id == "ARCH" && isArrangement && !reArch)
            reArch = &c;
    }
    if (!reArch || !reArch->arch)
        throw Err("written file has no parsed Arrangement ARCH");
    const IdInfo reIdInfo = IdInfo::build(*reArch->arch, out.data(), reArch->dataOff + 4);
    int reTracks = 0, reParts = 0, reTempo = 0, reAudioEvents = 0;
    {
        std::function<void(const std::vector<NodePtr>&)> count =
            [&](const std::vector<NodePtr>& list) {
                for (const NodePtr& n : list) {
                    if (!n->isRec)
                        continue;
                    const std::string nm = clsName(*n, reIdInfo);
                    if (nm == "MMidiTrackEvent" || nm == "MAudioTrackEvent")
                        ++reTracks;
                    else if (nm == "MMidiPartEvent")
                        ++reParts;
                    else if (nm == "MTempoTrackEvent")
                        ++reTempo;
                    else if (nm == "MAudioEvent")
                        ++reAudioEvents;
                    count(n->children);
                }
            };
        count(reArch->arch->nodes);
    }
    int wantParts = 0, wantNotes = 0, wantAudioEvents = 0;
    for (const WriterTrack& t : model.tracks) {
        wantParts += int(t.clips.size());
        for (const WriterClip& c : t.clips)
            wantNotes += int(c.notes.size());
        wantAudioEvents += int(t.audioClips.size());
    }
    wantAudioEvents += donorAudioEvents; // donor survivors keep their events
    const int wantTracks = int(model.tracks.size()) + donorAudioTracks;
    if (reTracks != wantTracks || reParts != wantParts || reTempo != 1 ||
        reAudioEvents != wantAudioEvents)
        throw Err("re-parse structure mismatch: tracks " + std::to_string(reTracks) + "/" +
                  std::to_string(wantTracks) + ", parts " +
                  std::to_string(reParts) + "/" + std::to_string(wantParts) +
                  ", audio events " + std::to_string(reAudioEvents) + "/" +
                  std::to_string(wantAudioEvents) + ", tempo " +
                  std::to_string(reTempo) + "/1");

    // stored-id verification: every known-owner site (and every MRoot table entry whose
    // target survived) must resolve, in the EMITTED bytes, to a record of the class it
    // pointed at in the donor. Throws rather than ship a dangling/mistyped pool link.
    const int64_t reBase = reArch->dataOff + 4;
    std::unordered_map<int64_t, std::string> outById; // id -> class
    {
        std::function<void(const std::vector<NodePtr>&)> collect =
            [&](const std::vector<NodePtr>& list) {
                for (const NodePtr& n : list) {
                    if (!n->isRec)
                        continue;
                    outById[n->dataStart - reBase] = clsName(*n, reIdInfo);
                    collect(n->children);
                }
            };
        collect(reArch->arch->nodes);
    }
    for (const VerifySite& v : verifySites) {
        const auto it = outById.find(v.newId);
        const std::string got = it == outById.end() ? std::string() : it->second;
        if (got != v.targetCls)
            throw Err("stored-id verify failed: " + v.owner + " id " + hex(v.newId) +
                      " resolves to " + (got.empty() ? "NOTHING" : got) + ", expected " +
                      v.targetCls);
    }

    stats.bytes = int64_t(out.size());
    stats.donorBytes = int64_t(donorLen);
    stats.tracks = int(model.tracks.size());
    stats.keptDonorTracks = keep;
    stats.parts = wantParts;
    stats.notes = wantNotes;
    stats.healedRefs = healed;
    stats.rebasedIds = rebasedIds;
    stats.verifiedIds = int(verifySites.size());
    stats.staleTableIds = staleTableIds;
    stats.ignoredIdMatches = ignoredIdMatches;
    return out;
}

// ---------------------------------------------------------------------------
// MyDAW model -> writer model mapping (see CprWriter.h header comment)
// ---------------------------------------------------------------------------

std::string fmtNum(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%g", v);
    return buf;
}

bool isDrivePath(const std::string& s) {
    return s.size() >= 3 && ((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z')) &&
           s[1] == ':' && (s[2] == '\\' || s[2] == '/');
}

std::string stemOf(const std::string& fileName) {
    const size_t dot = fileName.find_last_of('.');
    return dot == std::string::npos ? fileName : fileName.substr(0, dot);
}

bool mapModel(const Project& p, WriterModel& wm, std::vector<std::string>& warnings,
              std::string& err, const std::string& projectDir,
              const CprWriter::StateFn& stateFor) {
    auto warn = [&](std::string msg) { warnings.push_back(std::move(msg)); };

    wm.tempo = p.tempoMap.empty() ? 120.0 : p.tempoMap.front().bpm;
    if (p.tempoMap.size() > 1)
        warn("tempo map has " + std::to_string(p.tempoMap.size()) +
             " entries — exported the first only (" + fmtNum(wm.tempo) + " bpm at beat 0)");
    if (!p.timeSigMap.empty() &&
        (p.timeSigMap.front().num != 4 || p.timeSigMap.front().den != 4))
        warn("time signature " + std::to_string(p.timeSigMap.front().num) + "/" +
             std::to_string(p.timeSigMap.front().den) +
             " not exported (the donor project carries 4/4)");
    if (!p.masterTrack.inserts.empty() || p.masterTrack.volume != 1.0 ||
        p.masterTrack.pan != 0.0)
        warn("master bus settings not exported (the donor's master channel is used)");

    int audioClipsSkipped = 0, ccSkipped = 0, builtinInsertsSkipped = 0, sendsSkipped = 0,
        automationSkipped = 0, eqSkipped = 0, takeFoldersSkipped = 0,
        mutedClipsExported = 0, channelNotes = 0, statelessInserts = 0,
        unresolvedAudioClips = 0, mutedAudioExported = 0, audioClipMixSkipped = 0,
        routedLinked = 0, midiInsertsSkipped = 0;

    // Instrument-track ordinals + GUIDs (identity only), so routed MIDI tracks can
    // reference their target with the "<GUID>-<slot>" connection string. Ordinals
    // count exported instrument tracks in model order — the importer resolves them
    // against Synth-Slot instrument tracks in the same order.
    struct InstRef {
        int ordinal = -1;
        std::string guid = std::string(32, '0');
    };
    std::unordered_map<uint64_t, InstRef> instRefByModelId;
    {
        int ordinal = 0;
        for (const Track& t : p.tracks) {
            if (t.kind != TrackKind::Instrument)
                continue;
            InstRef ref;
            ref.ordinal = ordinal++;
            if (!t.inserts.empty()) {
                const PluginInstance& pi = t.inserts.front();
                if (pi.format == "vst2") {
                    const long long v = std::strtoll(pi.uid.c_str(), nullptr, 10);
                    ref.guid = vst2Guid(uint32_t(int32_t(v)), pi.name);
                } else if (pi.format == "vst3" && pi.uid.size() == 32) {
                    ref.guid = pi.uid;
                    for (char& ch : ref.guid)
                        if (ch >= 'a' && ch <= 'z')
                            ch = char(ch - 'a' + 'A');
                }
            }
            instRefByModelId[t.id] = std::move(ref);
        }
    }

    // One insert → WriterInsert (identity + framed state). Built-ins and unknown
    // formats are counted/skipped; a missing state chunk still exports the identity.
    auto mapOne = [&](const PluginInstance& pi, WriterInsert& wi) -> bool {
        if (pi.format == "builtin") {
            ++builtinInsertsSkipped;
            return false;
        }
        wi.name = pi.name;
        wi.version = pi.version;
        std::vector<uint8_t> chunk;
        const bool hasState = stateFor && stateFor(pi.instanceId, chunk) && !chunk.empty();
        if (pi.format == "vst2") {
            const long long v = std::strtoll(pi.uid.c_str(), nullptr, 10);
            const uint32_t fourcc = uint32_t(int32_t(v));
            wi.guid = vst2Guid(fourcc, pi.name);
            if (hasState)
                wi.ac = wrapFxbChunk(fourcc, chunk);
        } else if (pi.format == "vst3") {
            bool hexOk = pi.uid.size() == 32;
            for (const char ch : pi.uid)
                hexOk = hexOk && ((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F') ||
                                  (ch >= 'a' && ch <= 'f'));
            if (!hexOk) {
                warn("insert '" + pi.name + "' skipped (unrecognized VST3 uid)");
                return false;
            }
            wi.guid = pi.uid;
            for (char& ch : wi.guid)
                if (ch >= 'a' && ch <= 'z')
                    ch = char(ch - 'a' + 'A');
            if (hasState && !splitMd3s(chunk, wi.ac, wi.ed)) {
                warn("insert '" + pi.name +
                     "': unrecognized VST3 state container — exported without settings");
                wi.ac.clear();
                wi.ed.clear();
            }
        } else {
            warn("insert '" + pi.name + "' skipped (format " + pi.format + ")");
            return false;
        }
        if (!hasState)
            ++statelessInserts;
        return true;
    };
    auto mapInserts = [&](const Track& t, WriterTrack& wt, size_t firstIdx) {
        for (size_t i = firstIdx; i < t.inserts.size(); ++i) {
            WriterInsert wi;
            if (mapOne(t.inserts[i], wi))
                wt.inserts.push_back(std::move(wi));
        }
    };

    for (const Track& t : p.tracks) {
        switch (t.kind) {
            case TrackKind::Bus:
                warn("bus track '" + t.name + "' skipped (mixer routing is not exported)");
                continue;
            case TrackKind::Folder:
                warn("folder track '" + t.name + "' skipped (tracks are exported flat)");
                continue;
            case TrackKind::Master:
                continue; // never appears in p.tracks; defensive
            case TrackKind::Audio:
            case TrackKind::Midi:
            case TrackKind::Instrument:
                break;
        }

        WriterTrack wt;
        wt.name = t.name;
        wt.volumeGain = t.volume;
        wt.pan = t.pan;

        if (t.kind == TrackKind::Instrument) {
            // Slot 0 is the instrument itself — exported into the channel's Synth Slot
            // (the importer promotes the track back to an Instrument track from it).
            if (!t.inserts.empty()) {
                WriterInsert wi;
                if (mapOne(t.inserts.front(), wi))
                    wt.instrument = std::move(wi);
                else
                    warn("track '" + t.name + "': instrument '" + t.inserts.front().name +
                         "' not exported (track exported as a plain MIDI track)");
            }
            mapInserts(t, wt, 1);
        } else if (t.kind == TrackKind::Audio) {
            mapInserts(t, wt, 0);
        } else {
            // MIDI channels cannot host audio plugins (Cubase semantics) — any legacy
            // model inserts are counted and dropped rather than emitted.
            midiInsertsSkipped += int(t.inserts.size());
        }
        sendsSkipped += int(t.sends.size());
        automationSkipped += int(t.automation.size());
        if (t.eq.isActive())
            ++eqSkipped;
        takeFoldersSkipped += int(t.takeFolders.size());

        if (t.kind == TrackKind::Audio) {
            wt.isAudio = true;
            for (const Clip& c : t.clips) {
                const AudioClip* ac = asAudio(&c);
                if (!ac)
                    continue;
                // Resolve the clip's wav to an absolute drive-letter path — the form
                // the importer's FNPath scan (and Cubase) can locate.
                const Asset* asset = nullptr;
                for (const Asset& a : p.assets)
                    if (a.id == ac->assetId) {
                        asset = &a;
                        break;
                    }
                std::string abs;
                if (asset) {
                    if (!asset->file.empty())
                        abs = isDrivePath(asset->file)
                                  ? asset->file
                                  : (projectDir.empty() ? std::string()
                                                        : projectDir + "\\" + asset->file);
                    if ((abs.empty() || !isDrivePath(abs)) && !asset->originalPath.empty())
                        abs = asset->originalPath;
                }
                for (char& ch : abs)
                    if (ch == '/')
                        ch = '\\';
                const size_t sep = abs.find_last_of('\\');
                if (!isDrivePath(abs) || sep == std::string::npos ||
                    sep + 1 >= abs.size()) {
                    ++unresolvedAudioClips;
                    continue;
                }
                WriterAudioClip wc;
                wc.dirPath = abs.substr(0, sep + 1); // keep the trailing separator
                wc.fileName = abs.substr(sep + 1);
                wc.clipName = !ac->name.empty() ? ac->name : stemOf(wc.fileName);
                wc.startBeat = ac->startBeat;
                wc.lengthSamples = double(ac->lengthSamples);
                wc.offsetSamples = double(ac->srcOffsetSamples);
                if (ac->muted)
                    ++mutedAudioExported;
                if (ac->gain != 1.0 || ac->fadeInSec != 0.0 || ac->fadeOutSec != 0.0)
                    ++audioClipMixSkipped;
                wt.audioClips.push_back(std::move(wc));
            }
        } else {
            for (const Clip& c : t.clips) {
                const MidiClip* mc = asMidi(&c);
                if (!mc) {
                    ++audioClipsSkipped;
                    continue;
                }
                if (mc->muted)
                    ++mutedClipsExported;
                ccSkipped += int(mc->cc.size());
                WriterClip wc;
                wc.startBeat = mc->startBeat;
                wc.lengthBeats = mc->lengthBeats;
                for (const Note& n : mc->notes) {
                    if (n.channel != 0)
                        ++channelNotes;
                    wc.notes.push_back({n.pitch, n.velocity, n.startBeat, n.lengthBeats});
                }
                wt.clips.push_back(std::move(wc));
            }
        }
        if (t.kind == TrackKind::Midi && t.midiTarget != 0) {
            // Keep the MIDI track SEPARATE (N:1 routing must survive — two MIDI tracks
            // feeding one instrument stay two tracks) and write the connection string.
            const auto it = instRefByModelId.find(t.midiTarget);
            if (it != instRefByModelId.end()) {
                wt.routeSlot = it->second.ordinal;
                wt.routeGuid = it->second.guid;
                ++routedLinked;
            }
        }
        wm.tracks.push_back(std::move(wt));
    }
    if (routedLinked)
        warn(std::to_string(routedLinked) +
             " routed MIDI track(s) exported with their instrument connection");
    if (midiInsertsSkipped)
        warn(std::to_string(midiInsertsSkipped) +
             " insert(s) on MIDI tracks skipped (MIDI channels cannot host audio plugins)");

    if (audioClipsSkipped)
        warn(std::to_string(audioClipsSkipped) + " audio clip(s) skipped");
    if (unresolvedAudioClips)
        warn(std::to_string(unresolvedAudioClips) +
             " audio clip(s) skipped (source wav path could not be resolved to a "
             "drive-letter path)");
    if (mutedAudioExported)
        warn(std::to_string(mutedAudioExported) + " muted audio clip(s) exported unmuted");
    if (audioClipMixSkipped)
        warn(std::to_string(audioClipMixSkipped) +
             " audio clip gain/fade setting(s) not exported");
    if (ccSkipped)
        warn(std::to_string(ccSkipped) + " MIDI CC event(s) skipped");
    if (builtinInsertsSkipped)
        warn(std::to_string(builtinInsertsSkipped) +
             " built-in insert(s) skipped (MyDAW stock effects have no Cubase equivalent)");
    if (statelessInserts)
        warn(std::to_string(statelessInserts) +
             " insert(s) exported without settings (no state chunk available)");
    if (sendsSkipped)
        warn(std::to_string(sendsSkipped) + " send(s) skipped");
    if (automationSkipped)
        warn(std::to_string(automationSkipped) + " automation lane(s) skipped");
    if (eqSkipped)
        warn(std::to_string(eqSkipped) + " track EQ chain(s) skipped");
    if (takeFoldersSkipped)
        warn(std::to_string(takeFoldersSkipped) + " take folder(s) skipped");
    if (mutedClipsExported)
        warn(std::to_string(mutedClipsExported) + " muted MIDI clip(s) exported unmuted");
    if (channelNotes)
        warn(std::to_string(channelNotes) +
             " note(s) on a non-default MIDI channel written on channel 1");

    if (wm.tracks.empty()) {
        err = "project has no exportable tracks — nothing to write";
        return false;
    }
    warn("the exported file keeps one hidden donor track ('~MyDAW') as the tempo "
         "carrier — Cubase requires at least one track; MyDAW skips it on re-import");
    return true;
}

bool writeFileBytes(const std::string& path, const std::vector<uint8_t>& bytes,
                    std::string& err) {
    std::ofstream f(utf8ToWide(path).c_str(), std::ios::binary | std::ios::trunc);
    if (!f.is_open()) {
        err = "cannot open '" + path + "' for writing";
        return false;
    }
    f.write(reinterpret_cast<const char*>(bytes.data()),
            std::streamsize(bytes.size()));
    f.close();
    if (!f) {
        err = "write failed for '" + path + "'";
        return false;
    }
    return true;
}

} // namespace

// ---------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------

bool CprWriter::write(const Model& model, const std::string& path,
                      std::vector<std::string>& warnings, std::string& err,
                      const std::string& projectDir, const StateFn& stateFor) {
    WriterModel wm;
    if (!mapModel(model.project, wm, warnings, err, projectDir, stateFor))
        return false;
    std::vector<uint8_t> bytes;
    try {
        WriteStats stats;
        bytes = writeCprBytes(wm, cprdonor::kDonorC5, cprdonor::kDonorC5Size, stats);
    } catch (const std::exception& e) {
        err = std::string("cpr writer: ") + e.what();
        return false;
    }
    return writeFileBytes(path, bytes, err);
}

bool CprWriter::writeModelJson(const json& model, std::vector<uint8_t>& out,
                               std::string& err) {
    WriterModel wm;
    try {
        if (!model.is_object())
            throw Err("model must be a JSON object");
        wm.tempo = getOr<double>(model, "tempo", std::nan(""));
        const json tracks = getOr<json>(model, "tracks", json::array());
        if (!tracks.is_array())
            throw Err("model.tracks must be an array");
        for (const json& t : tracks) {
            const std::string kind = getOr(t, "kind", "");
            if (kind != "midi")
                throw Err("M2 writes only kind:\"midi\" tracks (got " + kind + ")");
            WriterTrack wt;
            wt.name = getOr(t, "name", "");
            wt.volumeGain = getOr<double>(t, "volumeGain", 1.0);
            wt.pan = getOr<double>(t, "pan", 0.0);
            for (const json& c : getOr<json>(t, "clips", json::array())) {
                WriterClip wc;
                wc.startBeat = getOr<double>(c, "startBeat", 0.0);
                wc.lengthBeats = getOr<double>(c, "lengthBeats", 0.0);
                for (const json& n : getOr<json>(c, "notes", json::array())) {
                    wc.notes.push_back({getOr<int>(n, "pitch", 0),
                                        getOr<int>(n, "velocity", 0),
                                        getOr<double>(n, "startBeat", 0.0),
                                        getOr<double>(n, "lengthBeats", 0.0)});
                }
                wt.clips.push_back(std::move(wc));
            }
            wm.tracks.push_back(std::move(wt));
        }
        WriteStats stats;
        out = writeCprBytes(wm, cprdonor::kDonorC5, cprdonor::kDonorC5Size, stats);
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
    return true;
}

} // namespace mydaw
