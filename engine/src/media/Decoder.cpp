// MyDAW — media/Decoder.cpp (E4)
// Media Foundation Source Reader decode (any MF-supported format) + direct RIFF/WAVE
// fallback parser + import-time linear resampler. See Decoder.h for the contract.

#include "media/Decoder.h"

#include "media/AssetStore.h" // PcmData
#include "util/Log.h"
#include "util/Paths.h"
#include "util/Strings.h"

#include <windows.h>
#include <objbase.h>

#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")

namespace mydaw {

namespace {

constexpr int64_t kMaxFrames = static_cast<int64_t>(1) << 30; // ~6.2 h @ 48 kHz
constexpr int kMaxChannels = 64;

std::string hrText(const char* stage, HRESULT hr) {
    char buf[160];
    std::snprintf(buf, sizeof(buf), "%s failed (hr=0x%08lX)", stage,
                  static_cast<unsigned long>(hr));
    return std::string(buf);
}

// Minimal COM smart pointer (local to this TU; we do not pull in <wrl/client.h>).
template <typename T>
class ComPtr {
public:
    ComPtr() = default;
    ~ComPtr() { reset(); }
    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;
    T** put() {
        reset();
        return &p_;
    }
    T* get() const { return p_; }
    T* operator->() const { return p_; }
    explicit operator bool() const { return p_ != nullptr; }
    void reset() {
        if (p_) {
            p_->Release();
            p_ = nullptr;
        }
    }

private:
    T* p_ = nullptr;
};

// Per-thread COM init. RPC_E_CHANGED_MODE means the thread already has COM in another
// mode — usable as-is, and we must not CoUninitialize in that case.
class ComInit {
public:
    ComInit() { hr_ = CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
    ~ComInit() {
        if (SUCCEEDED(hr_))
            CoUninitialize();
    }

private:
    HRESULT hr_ = E_FAIL;
};

// Ref-counted MFStartup/MFShutdown (SPEC: "MFStartup once, ref-counted").
std::mutex g_mfMutex;
int g_mfRefs = 0;

class MfScope {
public:
    MfScope() {
        std::lock_guard<std::mutex> lock(g_mfMutex);
        if (g_mfRefs == 0) {
            const HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
            if (FAILED(hr)) {
                err_ = hrText("MFStartup", hr);
                return;
            }
        }
        ++g_mfRefs;
        ok_ = true;
    }
    ~MfScope() {
        if (!ok_)
            return;
        std::lock_guard<std::mutex> lock(g_mfMutex);
        if (--g_mfRefs == 0)
            MFShutdown();
    }
    bool ok() const { return ok_; }
    const std::string& error() const { return err_; }

private:
    bool ok_ = false;
    std::string err_;
};

// ---------------------------------------------------------------------------
// Media Foundation decode
// ---------------------------------------------------------------------------

bool decodeMf(const std::string& absPath, PcmData& out, std::string& err) {
    ComInit com;
    MfScope mf;
    if (!mf.ok()) {
        err = mf.error();
        return false;
    }

    const std::wstring wide = utf8ToWide(absPath);
    ComPtr<IMFSourceReader> reader;
    HRESULT hr = MFCreateSourceReaderFromURL(wide.c_str(), nullptr, reader.put());
    if (FAILED(hr)) {
        err = hrText("MFCreateSourceReaderFromURL", hr);
        return false;
    }

    reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE);
    hr = reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM),
                                    TRUE);
    if (FAILED(hr)) {
        err = hrText("no audio stream (SetStreamSelection)", hr);
        return false;
    }

    // Ask the reader to decode + convert to float32 PCM (it inserts decoder/converter MFTs).
    ComPtr<IMFMediaType> want;
    hr = MFCreateMediaType(want.put());
    if (SUCCEEDED(hr))
        hr = want->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    if (SUCCEEDED(hr))
        hr = want->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
    if (SUCCEEDED(hr))
        hr = reader->SetCurrentMediaType(
            static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM), nullptr, want.get());
    if (FAILED(hr)) {
        err = hrText("SetCurrentMediaType(float32)", hr);
        return false;
    }

    auto queryFormat = [&](UINT32& channels, UINT32& sampleRate) -> HRESULT {
        ComPtr<IMFMediaType> actual;
        HRESULT h = reader->GetCurrentMediaType(
            static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM), actual.put());
        if (FAILED(h))
            return h;
        channels = 0;
        sampleRate = 0;
        actual->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels);
        actual->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &sampleRate);
        return S_OK;
    };

    UINT32 channels = 0, sampleRate = 0;
    hr = queryFormat(channels, sampleRate);
    if (FAILED(hr)) {
        err = hrText("GetCurrentMediaType", hr);
        return false;
    }
    if (channels < 1 || channels > kMaxChannels || sampleRate < 1000 ||
        sampleRate > 768000) {
        err = "unsupported audio format (channels=" + std::to_string(channels) +
              ", sampleRate=" + std::to_string(sampleRate) + ")";
        return false;
    }

    out.channels = static_cast<int>(channels);
    out.sampleRate = static_cast<int>(sampleRate);
    out.frames = 0;
    out.planes.assign(channels, {});

    for (;;) {
        DWORD streamFlags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        hr = reader->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM), 0,
                                nullptr, &streamFlags, &timestamp, sample.put());
        if (FAILED(hr)) {
            err = hrText("ReadSample", hr);
            return false;
        }
        if (streamFlags & MF_SOURCE_READERF_ENDOFSTREAM)
            break;
        if (streamFlags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
            UINT32 newCh = 0, newSr = 0;
            if (FAILED(queryFormat(newCh, newSr))) {
                err = "media type changed mid-decode and could not be re-queried";
                return false;
            }
            if (out.frames == 0) {
                // No data yet — adopt the corrected format.
                if (newCh < 1 || newCh > kMaxChannels || newSr < 1000 || newSr > 768000) {
                    err = "unsupported audio format after media type change";
                    return false;
                }
                channels = newCh;
                out.channels = static_cast<int>(newCh);
                out.sampleRate = static_cast<int>(newSr);
                out.planes.assign(channels, {});
            } else if (newCh != channels || newSr != static_cast<UINT32>(out.sampleRate)) {
                err = "audio format changed mid-stream (unsupported)";
                return false;
            }
        }
        if (!sample)
            continue;

        ComPtr<IMFMediaBuffer> buffer;
        hr = sample->ConvertToContiguousBuffer(buffer.put());
        if (FAILED(hr)) {
            err = hrText("ConvertToContiguousBuffer", hr);
            return false;
        }
        BYTE* data = nullptr;
        DWORD maxLen = 0, curLen = 0;
        hr = buffer->Lock(&data, &maxLen, &curLen);
        if (FAILED(hr)) {
            err = hrText("IMFMediaBuffer::Lock", hr);
            return false;
        }
        const size_t newFrames = curLen / (sizeof(float) * channels);
        if (newFrames > 0) {
            if (out.frames + static_cast<int64_t>(newFrames) > kMaxFrames) {
                buffer->Unlock();
                err = "audio file too long (frame cap exceeded)";
                return false;
            }
            const float* src = reinterpret_cast<const float*>(data);
            const size_t base = static_cast<size_t>(out.frames);
            for (UINT32 c = 0; c < channels; ++c) {
                std::vector<float>& plane = out.planes[c];
                plane.resize(base + newFrames);
                float* dst = plane.data() + base;
                const float* s = src + c;
                for (size_t f = 0; f < newFrames; ++f, s += channels)
                    dst[f] = *s;
            }
            out.frames += static_cast<int64_t>(newFrames);
        }
        buffer->Unlock();
    }

    if (out.frames <= 0) {
        err = "decoded zero audio frames";
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// RIFF/WAVE fallback parser
// ---------------------------------------------------------------------------

uint32_t rdU32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
uint16_t rdU16(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}

bool looksLikeRiffWave(const std::string& absPath) {
    FILE* f = _wfopen(utf8ToWide(absPath).c_str(), L"rb");
    if (!f)
        return false;
    uint8_t hdr[12] = {};
    const size_t n = std::fread(hdr, 1, sizeof(hdr), f);
    std::fclose(f);
    return n == 12 && std::memcmp(hdr, "RIFF", 4) == 0 && std::memcmp(hdr + 8, "WAVE", 4) == 0;
}

} // namespace

bool Decoder::decodeWavRiff(const std::string& absPath, PcmData& out, std::string& err) {
    FILE* f = _wfopen(utf8ToWide(absPath).c_str(), L"rb");
    if (!f) {
        err = "cannot open file: " + absPath;
        return false;
    }
    struct Closer {
        FILE* f;
        ~Closer() { std::fclose(f); }
    } closer{f};

    uint8_t hdr[12];
    if (std::fread(hdr, 1, 12, f) != 12 || std::memcmp(hdr, "RIFF", 4) != 0 ||
        std::memcmp(hdr + 8, "WAVE", 4) != 0) {
        err = "not a RIFF/WAVE file";
        return false;
    }

    _fseeki64(f, 0, SEEK_END);
    const int64_t fileSize = _ftelli64(f);
    _fseeki64(f, 12, SEEK_SET);

    uint16_t fmtTag = 0, numCh = 0, bits = 0;
    uint32_t sr = 0;
    bool haveFmt = false, isFloat = false;
    int64_t dataOffset = -1;
    int64_t dataSize = 0;

    // Chunk walk.
    for (;;) {
        uint8_t chdr[8];
        if (std::fread(chdr, 1, 8, f) != 8)
            break;
        const uint32_t chunkSize = rdU32(chdr + 4);
        const int64_t payload = _ftelli64(f);
        if (std::memcmp(chdr, "fmt ", 4) == 0) {
            uint8_t fmt[40] = {};
            const size_t want = std::min<size_t>(chunkSize, sizeof(fmt));
            if (std::fread(fmt, 1, want, f) != want || want < 16) {
                err = "malformed fmt chunk";
                return false;
            }
            fmtTag = rdU16(fmt + 0);
            numCh = rdU16(fmt + 2);
            sr = rdU32(fmt + 4);
            bits = rdU16(fmt + 14);
            if (fmtTag == 0xFFFE /*WAVE_FORMAT_EXTENSIBLE*/ && want >= 40) {
                fmtTag = rdU16(fmt + 24); // first 2 bytes of the SubFormat GUID
            }
            isFloat = (fmtTag == 3 /*WAVE_FORMAT_IEEE_FLOAT*/);
            haveFmt = true;
        } else if (std::memcmp(chdr, "data", 4) == 0) {
            dataOffset = payload;
            dataSize = chunkSize;
            // 0 / 0xFFFFFFFF size (streamed writers): clamp to the rest of the file.
            if (dataSize == 0 || dataSize == 0xFFFFFFFFll || payload + dataSize > fileSize)
                dataSize = fileSize - payload;
        }
        // Next chunk (sizes are padded to even byte counts).
        const int64_t next = payload + chunkSize + (chunkSize & 1);
        if (next <= payload || next >= fileSize)
            break;
        _fseeki64(f, next, SEEK_SET);
    }

    if (!haveFmt || dataOffset < 0) {
        err = "missing fmt or data chunk";
        return false;
    }
    if (fmtTag != 1 && fmtTag != 3) {
        err = "unsupported wav format tag " + std::to_string(fmtTag) +
              " (PCM/float only in fallback)";
        return false;
    }
    if (numCh < 1 || numCh > kMaxChannels || sr < 1000 || sr > 768000) {
        err = "unsupported wav format (channels=" + std::to_string(numCh) +
              ", sampleRate=" + std::to_string(sr) + ")";
        return false;
    }
    const bool ok16 = (!isFloat && bits == 16);
    const bool ok24 = (!isFloat && bits == 24);
    const bool ok32i = (!isFloat && bits == 32);
    const bool ok32f = (isFloat && bits == 32);
    if (!ok16 && !ok24 && !ok32i && !ok32f) {
        err = "unsupported wav sample format (" + std::to_string(bits) +
              (isFloat ? "-bit float)" : "-bit PCM)");
        return false;
    }

    const int bytesPerSample = bits / 8;
    const int64_t blockAlign = static_cast<int64_t>(numCh) * bytesPerSample;
    const int64_t frames = dataSize / blockAlign;
    if (frames <= 0) {
        err = "wav data chunk holds no frames";
        return false;
    }
    if (frames > kMaxFrames) {
        err = "audio file too long (frame cap exceeded)";
        return false;
    }

    out.channels = numCh;
    out.sampleRate = static_cast<int>(sr);
    out.frames = frames;
    out.planes.assign(numCh, std::vector<float>(static_cast<size_t>(frames)));

    _fseeki64(f, dataOffset, SEEK_SET);
    const int64_t chunkFrames = 65536 / std::max<int64_t>(1, blockAlign) + 1;
    std::vector<uint8_t> buf(static_cast<size_t>(chunkFrames * blockAlign));
    int64_t done = 0;
    while (done < frames) {
        const int64_t n = std::min<int64_t>(chunkFrames, frames - done);
        const size_t bytes = static_cast<size_t>(n * blockAlign);
        if (std::fread(buf.data(), 1, bytes, f) != bytes) {
            err = "short read in wav data chunk";
            return false;
        }
        const uint8_t* p = buf.data();
        for (int64_t fIdx = 0; fIdx < n; ++fIdx) {
            for (int c = 0; c < numCh; ++c) {
                float v = 0.0f;
                if (ok16) {
                    const int16_t s = static_cast<int16_t>(rdU16(p));
                    v = static_cast<float>(s) / 32768.0f;
                } else if (ok24) {
                    int32_t s = static_cast<int32_t>(p[0]) |
                                (static_cast<int32_t>(p[1]) << 8) |
                                (static_cast<int32_t>(p[2]) << 16);
                    if (s & 0x800000)
                        s |= ~0xFFFFFF; // sign extend
                    v = static_cast<float>(s) / 8388608.0f;
                } else if (ok32i) {
                    const int32_t s = static_cast<int32_t>(rdU32(p));
                    v = static_cast<float>(static_cast<double>(s) / 2147483648.0);
                } else { // ok32f
                    std::memcpy(&v, p, sizeof(float));
                }
                out.planes[static_cast<size_t>(c)][static_cast<size_t>(done + fIdx)] = v;
                p += bytesPerSample;
            }
        }
        done += n;
    }
    return true;
}

bool Decoder::decodeFile(const std::string& absPath, PcmData& out, std::string& err) {
    out = PcmData{};
    err.clear();
    if (!fileExists(absPath)) {
        err = "file not found: " + absPath;
        return false;
    }

    std::string mfErr;
    if (decodeMf(absPath, out, mfErr))
        return true;

    // Plain-PCM RIFF/WAVE fallback so wav import works even if MF chokes (or the Media
    // Feature Pack is missing on N editions).
    if (looksLikeRiffWave(absPath)) {
        out = PcmData{};
        std::string wavErr;
        if (decodeWavRiff(absPath, out, wavErr)) {
            Log::info("Decoder: MF failed for '%s' (%s); RIFF fallback succeeded",
                      absPath.c_str(), mfErr.c_str());
            return true;
        }
        err = mfErr + "; wav fallback: " + wavErr;
        return false;
    }

    err = mfErr;
    return false;
}

void Decoder::resampleLinear(PcmData& pcm, int targetSampleRate) {
    if (targetSampleRate <= 0 || pcm.sampleRate <= 0)
        return;
    if (pcm.sampleRate == targetSampleRate)
        return;
    if (pcm.frames <= 0 || pcm.channels <= 0) {
        pcm.sampleRate = targetSampleRate;
        return;
    }

    // NOTE(spec): linear interpolation per SPEC §4 — resampling happens once at import
    // time (never at playback); linear is the documented v1 quality tradeoff.
    const int64_t srcFrames = pcm.frames;
    int64_t dstFrames = static_cast<int64_t>(
        std::llround(static_cast<double>(srcFrames) *
                     static_cast<double>(targetSampleRate) / pcm.sampleRate));
    if (dstFrames < 1)
        dstFrames = 1;
    const double ratio = static_cast<double>(pcm.sampleRate) / targetSampleRate;

    for (int c = 0; c < pcm.channels; ++c) {
        const std::vector<float>& src = pcm.planes[static_cast<size_t>(c)];
        std::vector<float> dst(static_cast<size_t>(dstFrames));
        const int64_t lastIdx = srcFrames - 1;
        for (int64_t i = 0; i < dstFrames; ++i) {
            const double pos = static_cast<double>(i) * ratio;
            int64_t idx = static_cast<int64_t>(pos);
            if (idx > lastIdx)
                idx = lastIdx;
            const double frac = pos - static_cast<double>(idx);
            const float a = src[static_cast<size_t>(idx)];
            const float b = src[static_cast<size_t>(std::min<int64_t>(idx + 1, lastIdx))];
            dst[static_cast<size_t>(i)] = static_cast<float>(a + (b - a) * frac);
        }
        pcm.planes[static_cast<size_t>(c)] = std::move(dst);
    }
    pcm.frames = dstFrames;
    pcm.sampleRate = targetSampleRate;
}

} // namespace mydaw
