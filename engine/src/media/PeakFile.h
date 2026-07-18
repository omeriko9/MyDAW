// MyDAW — media/PeakFile.h (E4)
// Waveform peak files. The NORMATIVE byte layout lives in ui/src/lib/peaks.ts — this
// implementation matches it byte-for-byte (little-endian):
//
//   u32  magic 'MPK1' (LE u32 0x314B504D)
//   u32  numLods
//   per lod:
//     u32 samplesPerBucket
//     u32 numBuckets
//     i8[numBuckets * channels * 2]  bucket-major; per bucket, per channel [min, max]
//                                    (bucket b, channel c: index = (b*channels + c) * 2)
//
// The channel count is NOT stored — it comes from the Asset record. int8 values are the
// per-bucket sample min/max scaled by 127 (value/127.0 ~= linear amplitude). The lod
// table is samplesPerBucket = 256 * 4^n for n = 0..3 -> [256, 1024, 4096, 16384].
//
// Non-RT only (file IO, allocation).

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace mydaw {

struct PcmData; // defined in media/AssetStore.h

class PeakFile {
public:
    static constexpr uint32_t kMagic = 0x314B504Du; // 'MPK1' little-endian
    static constexpr int kNumLods = 4;
    static constexpr uint32_t samplesPerBucket(int lod) {
        return 256u << (2 * lod); // 256 * 4^lod
    }

    // Serialize ALL kNumLods lods of `pcm` as one MPK1 blob (the exact on-disk bytes).
    // Returns false on empty/invalid pcm (logged).
    static bool serialize(const PcmData& pcm, std::vector<uint8_t>& out);

    // serialize() + atomic publish at `path` (per-call-unique temp + rename, so two
    // concurrent writers of the same path can never tear the file). Returns false on
    // empty/invalid pcm or IO failure (logged).
    static bool generate(const PcmData& pcm, const std::string& path);

    // Two-phase publish, for callers that must re-validate state between writing the
    // bytes and making them visible (AssetStore's generation check: asset ids recycle
    // per model, so a straggler must not publish a torn-down model's peaks under a
    // recycled id). writeTemp writes `bytes` to a per-call-unique sibling temp of
    // `path` (returned via tempOut; deleted again on failure). commitTemp renames the
    // temp onto `path` (MOVEFILE_REPLACE_EXISTING — a fast metadata op, fine while a
    // lock is held; the temp is deleted on failure). discardTemp deletes an
    // uncommitted temp (no-op when it is already gone).
    static bool writeTemp(const std::string& path, const std::vector<uint8_t>& bytes,
                          std::string& tempOut);
    static bool commitTemp(const std::string& tempPath, const std::string& path);
    static void discardTemp(const std::string& tempPath);

    // Read one lod from `path` and re-pack it as a self-contained single-lod MPK1 blob
    // (lod clamped to what the file holds). `channels` must be the asset's channel count;
    // if channels <= 0 the lods cannot be sliced (the format does not store the channel
    // count) and the WHOLE file is returned instead — also a valid payload, the client
    // handles both (ui/src/lib/peaks.ts). nullopt on missing/malformed file.
    static std::optional<std::vector<uint8_t>> read(const std::string& path, int lod,
                                                    int channels);

    // As read(), but slices from an in-memory MPK1 blob — callers that already hold
    // validated/just-serialized bytes serve from them instead of re-reading a file a
    // concurrent writer (recycled asset id) may have swapped in the meantime.
    static std::optional<std::vector<uint8_t>> sliceLod(const std::vector<uint8_t>& bytes,
                                                        int lod, int channels);
};

} // namespace mydaw
