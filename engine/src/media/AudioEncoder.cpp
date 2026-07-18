// MyDAW — media/AudioEncoder.cpp — see AudioEncoder.h.

#include "media/AudioEncoder.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "util/Log.h"
#include "util/Paths.h" // utf8ToWide

#pragma comment(lib, "mf.lib")          // MFTranscodeGetAudioOutputAvailableTypes
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")

namespace mydaw {
namespace {

constexpr int64_t kMfUnits = 10000000; // 100-ns ticks per second

template <class T>
void safeRelease(T*& p) {
    if (p) { p->Release(); p = nullptr; }
}

std::string hrText(const char* what, HRESULT hr) {
    char b[128];
    std::snprintf(b, sizeof(b), "%s failed (hr=0x%08lX)", what, static_cast<unsigned long>(hr));
    return std::string(b);
}

// Per-thread COM init (multithreaded); tolerant of a pre-inited apartment.
class ComInit {
public:
    ComInit() { hr_ = CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
    ~ComInit() { if (SUCCEEDED(hr_)) CoUninitialize(); }
private:
    HRESULT hr_ = E_FAIL;
};

// Ref-counted MFStartup/MFShutdown shared with the decoder's lifetime discipline.
std::mutex g_mfMutex;
int g_mfRefs = 0;
class MfScope {
public:
    MfScope() {
        std::lock_guard<std::mutex> lock(g_mfMutex);
        if (g_mfRefs == 0) {
            const HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
            if (FAILED(hr)) { err_ = hrText("MFStartup", hr); return; }
        }
        ++g_mfRefs;
        ok_ = true;
    }
    ~MfScope() {
        if (!ok_) return;
        std::lock_guard<std::mutex> lock(g_mfMutex);
        if (--g_mfRefs == 0) MFShutdown();
    }
    bool ok() const { return ok_; }
    const std::string& err() const { return err_; }
private:
    bool ok_ = false;
    std::string err_;
};

bool subtypeFor(const std::string& fmt, GUID& out) {
    if (fmt == "mp3") { out = MFAudioFormat_MP3; return true; }
    if (fmt == "flac") { out = MFAudioFormat_FLAC; return true; }
    if (fmt == "aac" || fmt == "m4a") { out = MFAudioFormat_AAC; return true; }
    return false;
}

// Pick, from the codec's available output types, the one closest to (sr, numCh, targetBytesPerSec).
// targetBytesPerSec <= 0 means "don't care" (lossless). Returns an AddRef'd type or nullptr.
IMFMediaType* chooseOutputType(const GUID& subtype, int sr, int numCh, int targetBytesPerSec,
                               std::string* err) {
    IMFCollection* types = nullptr;
    HRESULT hr = MFTranscodeGetAudioOutputAvailableTypes(subtype, MFT_ENUM_FLAG_ALL, nullptr, &types);
    if (FAILED(hr) || !types) {
        if (err) *err = hrText("MFTranscodeGetAudioOutputAvailableTypes", hr);
        return nullptr;
    }
    DWORD count = 0;
    types->GetElementCount(&count);
    IMFMediaType* best = nullptr;
    long bestScore = 0x7fffffffL;
    for (DWORD i = 0; i < count; ++i) {
        IUnknown* obj = nullptr;
        if (FAILED(types->GetElement(i, &obj)) || !obj) continue;
        IMFMediaType* t = nullptr;
        obj->QueryInterface(IID_PPV_ARGS(&t));
        obj->Release();
        if (!t) continue;
        UINT32 tsr = 0, tch = 0, tbps = 0, tbits = 0;
        t->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &tsr);
        t->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &tch);
        t->GetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, &tbps);
        t->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &tbits);
        // Score: heavily penalize sr/channel mismatch; prefer >=16-bit (higher for lossless);
        // then bitrate distance for lossy.
        long score = 0;
        score += (static_cast<int>(tsr) == sr) ? 0 : 1000000;
        score += (static_cast<int>(tch) == numCh) ? 0 : 500000;
        score += (tbits < 16) ? 200000 : (24 - std::min<UINT32>(24u, tbits)) * 1000;
        if (targetBytesPerSec > 0)
            score += std::abs(static_cast<long>(tbps) - targetBytesPerSec) / 16;
        if (score < bestScore) {
            bestScore = score;
            safeRelease(best);
            best = t;
            best->AddRef();
        }
        t->Release();
    }
    types->Release();
    if (!best && err) *err = "no output type advertised by the codec";
    return best;
}

} // namespace

struct MfAudioEncoder::Impl {
    ComInit com;
    MfScope mf;
    IMFSinkWriter* writer = nullptr;
    DWORD stream = 0;
    int numCh = 0;
    int sr = 0;
    int bits = 16; // input PCM bit depth chosen to match the encoder (16 or 24)
    int64_t rt = 0; // running sample time in 100-ns units
    bool failed = false;
    std::vector<uint8_t> il; // interleaved PCM scratch
};

MfAudioEncoder::MfAudioEncoder() : impl_(std::make_unique<Impl>()) {}
MfAudioEncoder::~MfAudioEncoder() {
    if (impl_ && impl_->writer) impl_->writer->Release();
}

bool MfAudioEncoder::isEncodedFormat(const std::string& fmt) {
    GUID g;
    return subtypeFor(fmt, g);
}
bool MfAudioEncoder::isOpen() const { return impl_ && impl_->writer != nullptr; }

bool MfAudioEncoder::open(const std::string& path, int numCh, int sampleRate,
                          const std::string& fmt, int kbps, std::string* err) {
    auto fail = [&](const std::string& m) { if (err) *err = m; return false; };
    if (isOpen()) return fail("encoder already open");
    if (numCh < 1 || sampleRate < 8000) return fail("bad channel/sample-rate");
    if (!impl_->mf.ok()) return fail(impl_->mf.err().empty() ? "Media Foundation unavailable" : impl_->mf.err());
    GUID subtype;
    if (!subtypeFor(fmt, subtype)) return fail("unsupported export format: " + fmt);

    const int targetBps = (fmt == "flac") ? 0 : std::max(32, kbps) * 1000 / 8;
    IMFMediaType* outType = chooseOutputType(subtype, sampleRate, numCh, targetBps, err);
    if (!outType) return false; // err set by chooseOutputType

    HRESULT hr = S_OK;
    IMFSinkWriter* writer = nullptr;
    IMFMediaType* inType = nullptr;
    auto cleanup = [&](bool ok) {
        safeRelease(outType);
        safeRelease(inType);
        if (!ok) safeRelease(writer);
        return ok;
    };

    const std::wstring wpath = utf8ToWide(path);
    hr = MFCreateSinkWriterFromURL(wpath.c_str(), nullptr, nullptr, &writer);
    if (FAILED(hr)) { if (err) *err = hrText("MFCreateSinkWriterFromURL", hr); return cleanup(false); }

    hr = writer->AddStream(outType, &impl_->stream);
    if (FAILED(hr)) { if (err) *err = hrText("AddStream", hr); return cleanup(false); }

    // Derive the input PCM format from what the encoder advertised so the two match exactly
    // (a mismatch — FLAC is often 24-bit and channel-mask-sensitive — gives MF_E_INVALIDMEDIATYPE).
    UINT32 obps = 0, osr = 0, och = 0, omask = 0;
    outType->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &obps);
    outType->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &osr);
    outType->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &och);
    outType->GetUINT32(MF_MT_AUDIO_CHANNEL_MASK, &omask);
    const int bits = (obps == 24) ? 24 : 16;
    const int inSr = osr > 0 ? static_cast<int>(osr) : sampleRate;
    const int inCh = och > 0 ? static_cast<int>(och) : numCh;
    const int bytesPerSample = bits / 8;
    const UINT32 mask = omask ? omask : (inCh == 1 ? 0x4u : 0x3u); // FC : FL|FR
    Log::info("MfAudioEncoder: out sr=%u ch=%u bits=%u -> input PCM sr=%d ch=%d bits=%d",
              osr, och, obps, inSr, inCh, bits);

    hr = MFCreateMediaType(&inType);
    if (SUCCEEDED(hr)) hr = inType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    if (SUCCEEDED(hr)) hr = inType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    if (SUCCEEDED(hr)) hr = inType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, static_cast<UINT32>(bits));
    if (SUCCEEDED(hr)) hr = inType->SetUINT32(MF_MT_AUDIO_VALID_BITS_PER_SAMPLE, static_cast<UINT32>(bits));
    if (SUCCEEDED(hr)) hr = inType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, static_cast<UINT32>(inSr));
    if (SUCCEEDED(hr)) hr = inType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, static_cast<UINT32>(inCh));
    if (SUCCEEDED(hr)) hr = inType->SetUINT32(MF_MT_AUDIO_CHANNEL_MASK, mask);
    if (SUCCEEDED(hr)) hr = inType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, static_cast<UINT32>(inCh * bytesPerSample));
    if (SUCCEEDED(hr)) hr = inType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, static_cast<UINT32>(inSr * inCh * bytesPerSample));
    if (SUCCEEDED(hr)) hr = inType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, 1);
    if (SUCCEEDED(hr)) hr = writer->SetInputMediaType(impl_->stream, inType, nullptr);
    if (FAILED(hr)) { if (err) *err = hrText("SetInputMediaType", hr); return cleanup(false); }
    impl_->bits = bits;
    impl_->numCh = inCh;
    impl_->sr = inSr;

    hr = writer->BeginWriting();
    if (FAILED(hr)) { if (err) *err = hrText("BeginWriting", hr); return cleanup(false); }

    impl_->writer = writer;
    impl_->rt = 0; // numCh/sr/bits already set from the negotiated input type above
    cleanup(true); // releases outType/inType; keeps writer (moved into impl_)
    return true;
}

bool MfAudioEncoder::appendPlanar(const float* const* ch, int frames) {
    if (!isOpen() || impl_->failed || frames <= 0) return !impl_->failed;
    const int nc = impl_->numCh;
    const int bps = impl_->bits / 8;
    impl_->il.resize(static_cast<size_t>(frames) * nc * bps);
    uint8_t* dst0 = impl_->il.data();
    for (int i = 0; i < frames; ++i)
        for (int c = 0; c < nc; ++c) {
            float v = ch[c][i];
            v = v < -1.f ? -1.f : (v > 1.f ? 1.f : v);
            uint8_t* d = dst0 + (static_cast<size_t>(i) * nc + c) * bps;
            if (impl_->bits == 24) {
                const int32_t s = static_cast<int32_t>(std::lround(v * 8388607.0f));
                d[0] = static_cast<uint8_t>(s & 0xff);
                d[1] = static_cast<uint8_t>((s >> 8) & 0xff);
                d[2] = static_cast<uint8_t>((s >> 16) & 0xff);
            } else {
                const int16_t s = static_cast<int16_t>(std::lround(v * 32767.0f));
                d[0] = static_cast<uint8_t>(s & 0xff);
                d[1] = static_cast<uint8_t>((s >> 8) & 0xff);
            }
        }
    const DWORD bytes = static_cast<DWORD>(impl_->il.size());

    IMFMediaBuffer* buf = nullptr;
    HRESULT hr = MFCreateMemoryBuffer(bytes, &buf);
    if (SUCCEEDED(hr)) {
        BYTE* dst = nullptr;
        hr = buf->Lock(&dst, nullptr, nullptr);
        if (SUCCEEDED(hr)) {
            std::memcpy(dst, impl_->il.data(), bytes);
            buf->Unlock();
            buf->SetCurrentLength(bytes);
        }
    }
    IMFSample* sample = nullptr;
    if (SUCCEEDED(hr)) hr = MFCreateSample(&sample);
    if (SUCCEEDED(hr)) hr = sample->AddBuffer(buf);
    if (SUCCEEDED(hr)) hr = sample->SetSampleTime(impl_->rt);
    const int64_t dur = static_cast<int64_t>(frames) * kMfUnits / impl_->sr;
    if (SUCCEEDED(hr)) hr = sample->SetSampleDuration(dur);
    if (SUCCEEDED(hr)) hr = impl_->writer->WriteSample(impl_->stream, sample);
    safeRelease(sample);
    safeRelease(buf);
    if (FAILED(hr)) {
        impl_->failed = true;
        Log::warn("MfAudioEncoder: WriteSample failed (hr=0x%08lX)", static_cast<unsigned long>(hr));
        return false;
    }
    impl_->rt += dur;
    return true;
}

bool MfAudioEncoder::finalize() {
    if (!isOpen()) return false;
    const HRESULT hr = impl_->writer->Finalize();
    impl_->writer->Release();
    impl_->writer = nullptr;
    if (FAILED(hr) || impl_->failed) {
        Log::warn("MfAudioEncoder: finalize hr=0x%08lX failed=%d",
                  static_cast<unsigned long>(hr), impl_->failed ? 1 : 0);
        return false;
    }
    return true;
}

} // namespace mydaw
