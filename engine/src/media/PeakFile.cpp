// MyDAW — media/PeakFile.cpp (E4)
// MPK1 peak file generate/read — byte-for-byte per the normative format comment in
// ui/src/lib/peaks.ts (see PeakFile.h).

#include "media/PeakFile.h"

#include "media/AssetStore.h" // PcmData
#include "util/Log.h"
#include "util/Paths.h"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace mydaw {

namespace {

void putU32(std::vector<uint8_t>& out, uint32_t v) {
    out.push_back(static_cast<uint8_t>(v));
    out.push_back(static_cast<uint8_t>(v >> 8));
    out.push_back(static_cast<uint8_t>(v >> 16));
    out.push_back(static_cast<uint8_t>(v >> 24));
}

uint32_t rdU32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

int8_t toI8(float v) {
    const float c = std::clamp(v, -1.0f, 1.0f) * 127.0f;
    return static_cast<int8_t>(std::lround(c));
}

bool readWholeFile(const std::string& path, std::vector<uint8_t>& out) {
    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"rb");
    if (!f)
        return false;
    _fseeki64(f, 0, SEEK_END);
    const int64_t size = _ftelli64(f);
    if (size < 0 || size > (int64_t(1) << 31)) { // peaks are small; 2 GiB sanity cap
        std::fclose(f);
        return false;
    }
    _fseeki64(f, 0, SEEK_SET);
    out.resize(static_cast<size_t>(size));
    const bool ok =
        size == 0 || std::fread(out.data(), 1, out.size(), f) == out.size();
    std::fclose(f);
    return ok;
}

// Per-call-unique sibling temp name. A fixed "<path>.tmp" tears the file when two
// writers race the same path (main-thread ensurePeaks vs a worker's ensurePeaksFor for
// the same asset id); pid + counter keeps names unique across threads AND processes.
std::string uniqueTempPath(const std::string& path) {
    static std::atomic<uint64_t> counter{0};
    return path + "." + std::to_string(GetCurrentProcessId()) + "-" +
           std::to_string(counter.fetch_add(1, std::memory_order_relaxed)) + ".tmp";
}

} // namespace

bool PeakFile::serialize(const PcmData& pcm, std::vector<uint8_t>& out) {
    const int ch = pcm.channels;
    const int64_t frames = pcm.frames;
    if (ch <= 0 || static_cast<int>(pcm.planes.size()) < ch) {
        Log::warn("PeakFile: cannot serialize — invalid pcm (channels=%d, planes=%d)",
                  ch, static_cast<int>(pcm.planes.size()));
        return false;
    }

    // lods[i] = int8 min/max pairs, bucket-major, channel-interleaved.
    std::vector<std::vector<int8_t>> lods(kNumLods);
    std::vector<size_t> numBuckets(kNumLods, 0);

    // lod 0: scan the samples once per channel.
    {
        const uint32_t spb = samplesPerBucket(0);
        const size_t nb =
            frames > 0 ? static_cast<size_t>((frames + spb - 1) / spb) : 0;
        numBuckets[0] = nb;
        lods[0].assign(nb * static_cast<size_t>(ch) * 2, 0);
        for (int c = 0; c < ch; ++c) {
            const std::vector<float>& plane = pcm.planes[static_cast<size_t>(c)];
            const int64_t planeFrames =
                std::min<int64_t>(frames, static_cast<int64_t>(plane.size()));
            for (size_t b = 0; b < nb; ++b) {
                const int64_t begin = static_cast<int64_t>(b) * spb;
                const int64_t end = std::min<int64_t>(begin + spb, planeFrames);
                float mn = 0.0f, mx = 0.0f;
                if (begin < end) {
                    mn = mx = plane[static_cast<size_t>(begin)];
                    for (int64_t i = begin + 1; i < end; ++i) {
                        const float v = plane[static_cast<size_t>(i)];
                        if (v < mn)
                            mn = v;
                        if (v > mx)
                            mx = v;
                    }
                }
                const size_t idx = (b * static_cast<size_t>(ch) +
                                    static_cast<size_t>(c)) * 2;
                lods[0][idx] = toI8(mn);
                lods[0][idx + 1] = toI8(mx);
            }
        }
    }

    // lods 1..3: derive from the previous lod (each bucket spans 4 finer buckets;
    // ceil(ceil(frames/s)/4) == ceil(frames/(4s)) so the bucket counts line up exactly).
    for (int l = 1; l < kNumLods; ++l) {
        const size_t prevNb = numBuckets[l - 1];
        const size_t nb = (prevNb + 3) / 4;
        numBuckets[l] = nb;
        lods[l].assign(nb * static_cast<size_t>(ch) * 2, 0);
        for (size_t b = 0; b < nb; ++b) {
            for (int c = 0; c < ch; ++c) {
                int8_t mn = 127, mx = -128;
                bool any = false;
                for (size_t k = b * 4; k < std::min(prevNb, b * 4 + 4); ++k) {
                    const size_t idx = (k * static_cast<size_t>(ch) +
                                        static_cast<size_t>(c)) * 2;
                    mn = std::min(mn, lods[l - 1][idx]);
                    mx = std::max(mx, lods[l - 1][idx + 1]);
                    any = true;
                }
                if (!any) {
                    mn = 0;
                    mx = 0;
                }
                const size_t idx = (b * static_cast<size_t>(ch) +
                                    static_cast<size_t>(c)) * 2;
                lods[l][idx] = mn;
                lods[l][idx + 1] = mx;
            }
        }
    }

    // Serialize.
    size_t total = 8;
    for (int l = 0; l < kNumLods; ++l)
        total += 8 + lods[l].size();
    out.clear();
    out.reserve(total);
    putU32(out, kMagic);
    putU32(out, static_cast<uint32_t>(kNumLods));
    for (int l = 0; l < kNumLods; ++l) {
        putU32(out, samplesPerBucket(l));
        putU32(out, static_cast<uint32_t>(numBuckets[l]));
        const uint8_t* d = reinterpret_cast<const uint8_t*>(lods[l].data());
        out.insert(out.end(), d, d + lods[l].size());
    }
    return true;
}

bool PeakFile::generate(const PcmData& pcm, const std::string& path) {
    std::vector<uint8_t> bytes;
    if (!serialize(pcm, bytes))
        return false;
    std::string tmp;
    if (!writeTemp(path, bytes, tmp) || !commitTemp(tmp, path)) {
        Log::error("PeakFile: failed to write '%s'", path.c_str());
        return false;
    }
    return true;
}

bool PeakFile::writeTemp(const std::string& path, const std::vector<uint8_t>& bytes,
                         std::string& tempOut) {
    tempOut = uniqueTempPath(path);
    FILE* f = _wfopen(utf8ToWide(tempOut).c_str(), L"wb");
    if (!f) {
        tempOut.clear();
        return false;
    }
    const bool wrote =
        bytes.empty() || std::fwrite(bytes.data(), 1, bytes.size(), f) == bytes.size();
    const bool closed = std::fclose(f) == 0;
    if (!wrote || !closed) {
        DeleteFileW(utf8ToWide(tempOut).c_str());
        tempOut.clear();
        return false;
    }
    return true;
}

bool PeakFile::commitTemp(const std::string& tempPath, const std::string& path) {
    if (MoveFileExW(utf8ToWide(tempPath).c_str(), utf8ToWide(path).c_str(),
                    MOVEFILE_REPLACE_EXISTING))
        return true;
    DeleteFileW(utf8ToWide(tempPath).c_str());
    return false;
}

void PeakFile::discardTemp(const std::string& tempPath) {
    if (!tempPath.empty())
        DeleteFileW(utf8ToWide(tempPath).c_str());
}

std::optional<std::vector<uint8_t>> PeakFile::read(const std::string& path, int lod,
                                                   int channels) {
    std::vector<uint8_t> bytes;
    if (!readWholeFile(path, bytes))
        return std::nullopt;
    return sliceLod(bytes, lod, channels);
}

std::optional<std::vector<uint8_t>> PeakFile::sliceLod(const std::vector<uint8_t>& bytes,
                                                       int lod, int channels) {
    if (bytes.size() < 8 || rdU32(bytes.data()) != kMagic)
        return std::nullopt;
    const uint32_t numLods = rdU32(bytes.data() + 4);
    if (numLods == 0)
        return std::nullopt;

    // Channel count unknown: the per-lod data length cannot be computed (the format does
    // not store channels) — return the whole file, which is an equally valid payload.
    if (channels <= 0)
        return bytes;

    const uint32_t want = static_cast<uint32_t>(
        std::clamp(lod, 0, static_cast<int>(numLods) - 1));
    size_t off = 8;
    for (uint32_t i = 0; i < numLods; ++i) {
        if (off + 8 > bytes.size())
            return std::nullopt; // truncated header
        const uint32_t spb = rdU32(bytes.data() + off);
        const uint32_t nb = rdU32(bytes.data() + off + 4);
        const size_t dataLen =
            static_cast<size_t>(nb) * static_cast<size_t>(channels) * 2;
        if (off + 8 + dataLen > bytes.size())
            return std::nullopt; // truncated data
        if (i == want) {
            std::vector<uint8_t> out;
            out.reserve(16 + dataLen);
            putU32(out, kMagic);
            putU32(out, 1);
            putU32(out, spb);
            putU32(out, nb);
            out.insert(out.end(), bytes.begin() + static_cast<ptrdiff_t>(off + 8),
                       bytes.begin() + static_cast<ptrdiff_t>(off + 8 + dataLen));
            return out;
        }
        off += 8 + dataLen;
    }
    return std::nullopt;
}

} // namespace mydaw
