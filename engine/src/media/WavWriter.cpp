// MyDAW — media/WavWriter.cpp (E4)
// One-shot + streaming RIFF/WAVE writing; TPDF dither for 16/24-bit PCM. See WavWriter.h.

#include "media/WavWriter.h"

#include "util/Log.h"
#include "util/Paths.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace mydaw {

namespace {

// Classic RIFF cap: keep the data chunk comfortably below 4 GiB so all u32 sizes fit.
constexpr uint64_t kMaxDataBytes = 0xFFFFFF00ull;

void putU16(uint8_t* p, uint16_t v) {
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
}
void putU32(uint8_t* p, uint32_t v) {
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
    p[2] = static_cast<uint8_t>(v >> 16);
    p[3] = static_cast<uint8_t>(v >> 24);
}

bool patchU32(FILE* f, int64_t offset, uint32_t v) {
    if (_fseeki64(f, offset, SEEK_SET) != 0)
        return false;
    uint8_t b[4];
    putU32(b, v);
    return std::fwrite(b, 1, 4, f) == 4;
}

} // namespace

WavWriter::~WavWriter() {
    if (file_)
        finalize();
}

double WavWriter::tpdf() {
    // Two xorshift32 draws -> sum of two uniforms in [0,1) minus 1 = triangular [-1,1).
    auto next01 = [this]() {
        rng_ ^= rng_ << 13;
        rng_ ^= rng_ >> 17;
        rng_ ^= rng_ << 5;
        return static_cast<double>(rng_) * (1.0 / 4294967296.0);
    };
    return next01() + next01() - 1.0;
}

bool WavWriter::open(const std::string& path, int numCh, int sampleRate, int bitDepth,
                     std::string* err) {
    if (file_)
        finalize();

    if (numCh < 1 || numCh > 64 || sampleRate <= 0 ||
        (bitDepth != 16 && bitDepth != 24 && bitDepth != 32)) {
        if (err)
            *err = "WavWriter: invalid format (channels=" + std::to_string(numCh) +
                   ", sr=" + std::to_string(sampleRate) +
                   ", bitDepth=" + std::to_string(bitDepth) + ")";
        return false;
    }

    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"wb");
    if (!f) {
        if (err)
            *err = "WavWriter: cannot open for writing: " + path;
        return false;
    }
    std::setvbuf(f, nullptr, _IOFBF, 1 << 16);

    file_ = f;
    path_ = path;
    numCh_ = numCh;
    sampleRate_ = sampleRate;
    bitDepth_ = bitDepth;
    isFloat_ = (bitDepth == 32);
    bytesPerSample_ = bitDepth / 8;
    framesWritten_ = 0;
    dataStart_ = 0;
    factPos_ = -1;
    failed_ = false;
    capWarned_ = false;

    if (!writeHeader()) {
        if (err)
            *err = "WavWriter: header write failed: " + path;
        std::fclose(f);
        file_ = nullptr;
        return false;
    }
    return true;
}

bool WavWriter::writeHeader() {
    // Sizes are placeholders (0) patched by finalize().
    uint8_t hdr[64];
    size_t off = 0;
    auto tag = [&](const char* t) {
        std::memcpy(hdr + off, t, 4);
        off += 4;
    };
    auto u32 = [&](uint32_t v) {
        putU32(hdr + off, v);
        off += 4;
    };
    auto u16 = [&](uint16_t v) {
        putU16(hdr + off, v);
        off += 2;
    };

    const uint16_t blockAlign = static_cast<uint16_t>(numCh_ * bytesPerSample_);
    const uint32_t byteRate = static_cast<uint32_t>(sampleRate_) * blockAlign;

    tag("RIFF");
    u32(0); // riff size (patched)
    tag("WAVE");

    tag("fmt ");
    u32(isFloat_ ? 18u : 16u);
    u16(isFloat_ ? 3u /*IEEE_FLOAT*/ : 1u /*PCM*/);
    u16(static_cast<uint16_t>(numCh_));
    u32(static_cast<uint32_t>(sampleRate_));
    u32(byteRate);
    u16(blockAlign);
    u16(static_cast<uint16_t>(bitDepth_));
    if (isFloat_) {
        u16(0); // cbSize
        tag("fact");
        u32(4);
        factPos_ = static_cast<int64_t>(off);
        u32(0); // dwSampleLength (patched)
    }

    tag("data");
    u32(0); // data size (patched)
    dataStart_ = static_cast<int64_t>(off);

    FILE* f = static_cast<FILE*>(file_);
    return std::fwrite(hdr, 1, off, f) == off;
}

bool WavWriter::appendInterleaved(const float* samples, int frames) {
    return appendImpl(nullptr, samples, frames);
}

bool WavWriter::appendPlanar(const float* const* ch, int frames) {
    return appendImpl(ch, nullptr, frames);
}

bool WavWriter::appendImpl(const float* const* planar, const float* interleaved,
                           int frames) {
    if (!file_ || failed_)
        return false;
    if (frames <= 0)
        return true;
    if (!planar && !interleaved)
        return false;

    const uint64_t addBytes = static_cast<uint64_t>(frames) * numCh_ * bytesPerSample_;
    const uint64_t haveBytes =
        static_cast<uint64_t>(framesWritten_) * numCh_ * bytesPerSample_;
    if (haveBytes + addBytes > kMaxDataBytes) {
        if (!capWarned_) {
            capWarned_ = true;
            Log::warn("WavWriter: 4 GiB RIFF data cap reached for '%s' — append rejected",
                      path_.c_str());
        }
        return false;
    }

    scratch_.resize(static_cast<size_t>(addBytes));
    uint8_t* p = scratch_.data();
    for (int f = 0; f < frames; ++f) {
        for (int c = 0; c < numCh_; ++c) {
            const float x = planar ? planar[c][f]
                                   : interleaved[static_cast<size_t>(f) * numCh_ + c];
            if (isFloat_) {
                std::memcpy(p, &x, 4);
                p += 4;
            } else if (bitDepth_ == 16) {
                const double d =
                    std::clamp(static_cast<double>(x), -1.0, 1.0) * 32767.0 + tpdf();
                long v = std::lround(d);
                v = std::clamp(v, -32768l, 32767l);
                p[0] = static_cast<uint8_t>(v);
                p[1] = static_cast<uint8_t>(v >> 8);
                p += 2;
            } else { // 24
                const double d =
                    std::clamp(static_cast<double>(x), -1.0, 1.0) * 8388607.0 + tpdf();
                long v = std::lround(d);
                v = std::clamp(v, -8388608l, 8388607l);
                p[0] = static_cast<uint8_t>(v);
                p[1] = static_cast<uint8_t>(v >> 8);
                p[2] = static_cast<uint8_t>(v >> 16);
                p += 3;
            }
        }
    }

    FILE* f = static_cast<FILE*>(file_);
    if (std::fwrite(scratch_.data(), 1, static_cast<size_t>(addBytes), f) !=
        static_cast<size_t>(addBytes)) {
        failed_ = true;
        Log::error("WavWriter: write failed (disk full?) for '%s'", path_.c_str());
        return false;
    }
    framesWritten_ += frames;
    return true;
}

bool WavWriter::finalize() {
    if (!file_)
        return false;
    FILE* f = static_cast<FILE*>(file_);

    const uint64_t dataBytes =
        static_cast<uint64_t>(framesWritten_) * numCh_ * bytesPerSample_;
    const uint64_t riffSize = static_cast<uint64_t>(dataStart_) + dataBytes - 8;

    bool ok = !failed_;
    ok = patchU32(f, 4, static_cast<uint32_t>(riffSize)) && ok;
    if (factPos_ >= 0)
        ok = patchU32(f, factPos_,
                      static_cast<uint32_t>(std::min<uint64_t>(
                          static_cast<uint64_t>(framesWritten_), 0xFFFFFFFFull))) &&
             ok;
    ok = patchU32(f, dataStart_ - 4, static_cast<uint32_t>(dataBytes)) && ok;
    ok = (std::fclose(f) == 0) && ok;

    file_ = nullptr;
    if (!ok)
        Log::error("WavWriter: finalize had errors for '%s'", path_.c_str());
    return ok;
}

bool WavWriter::write(const std::string& path, const float* const* ch, int numCh,
                      int64_t frames, int sampleRate, int bitDepth, std::string* err) {
    if (frames < 0 || !ch) {
        if (err)
            *err = "WavWriter: invalid arguments";
        return false;
    }
    WavWriter w;
    if (!w.open(path, numCh, sampleRate, bitDepth, err))
        return false;

    constexpr int64_t kChunk = 65536;
    std::vector<const float*> ptrs(static_cast<size_t>(numCh));
    for (int64_t off = 0; off < frames; off += kChunk) {
        const int n = static_cast<int>(std::min<int64_t>(kChunk, frames - off));
        for (int c = 0; c < numCh; ++c)
            ptrs[static_cast<size_t>(c)] = ch[c] + off;
        if (!w.appendPlanar(ptrs.data(), n)) {
            if (err)
                *err = "WavWriter: write failed: " + path;
            w.finalize();
            return false;
        }
    }
    if (!w.finalize()) {
        if (err)
            *err = "WavWriter: finalize failed: " + path;
        return false;
    }
    return true;
}

} // namespace mydaw
