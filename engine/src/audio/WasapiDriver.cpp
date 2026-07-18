// MyDAW — audio/WasapiDriver.cpp (E1). See WasapiDriver.h for the contract.
//
// Drift handling (render device vs capture device clocks): the capture thread produces
// interleaved float frames into a lock-free SPSC ring (~250 ms deep). The render thread
// consumes exactly `quantum` frames per engine block. If the capture clock runs slow (or
// capture just started), the read comes up short and the missing tail is ZERO-FILLED; if
// the capture clock runs fast, the ring eventually fills and the capture thread DROPS the
// overflow. Both cases are counted (Impl::capZeroFills / capDrops) — no resampling in v1.

#include "audio/WasapiDriver.h"

#include "util/Log.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <initguid.h> // must precede the PKEY/GUID-defining headers (defines them in this TU)
#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <propkeydef.h> // DEFINE_PROPERTYKEY, required by the header below
#include <functiondiscoverykeys_devpkey.h>

#include <xmmintrin.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

// Older SDK guards (flags are Win8.1+/Win10 in audioclient.h).
#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000U
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000U
#endif

namespace mydaw {

namespace {

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

template <typename T>
void safeRelease(T*& p) {
    if (p) {
        p->Release();
        p = nullptr;
    }
}

// COM init once per thread, never uninitialized (process-lifetime threads; documented).
void ensureComInitialized() {
    thread_local bool done = false;
    if (!done) {
        (void)CoInitializeEx(nullptr, COINIT_MULTITHREADED); // RPC_E_CHANGED_MODE is fine (STA host thread)
        done = true;
    }
}

std::string utf8FromWide(const wchar_t* w) {
    if (!w || !*w)
        return {};
    const int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (len <= 1)
        return {};
    std::string out(static_cast<size_t>(len - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
    return out;
}

std::wstring wideFromUtf8(const std::string& s) {
    if (s.empty())
        return {};
    const int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    if (len <= 1)
        return {};
    std::wstring out(static_cast<size_t>(len - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), len);
    return out;
}

void setErr(std::string* errorOut, const std::string& msg) {
    if (errorOut)
        *errorOut = msg;
}

std::string hrText(const char* what, HRESULT hr) {
    char buf[160];
    std::snprintf(buf, sizeof(buf), "%s failed (hr=0x%08lX)", what,
                  static_cast<unsigned long>(hr));
    return buf;
}

void appendInfo(std::string& dst, const std::string& part) {
    if (part.empty())
        return;
    if (!dst.empty())
        dst += "; ";
    dst += part;
}

// GUIDs spelled out so we do not depend on ksmedia.h.
const GUID kSubFormatPcm = {0x00000001, 0x0000, 0x0010,
                            {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
const GUID kSubFormatFloat = {0x00000003, 0x0000, 0x0010,
                              {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

DWORD channelMaskFor(int ch) {
    switch (ch) {
        case 1: return 0x4;       // FRONT_CENTER
        case 2: return 0x3;       // FRONT_LEFT | FRONT_RIGHT
        default:
            return (ch >= 31) ? 0xFFFFFFFFu : ((1u << ch) - 1u);
    }
}

enum class DevSampleKind { Float32, Int16, Int24, Int32 };

struct DevFormat {
    DevSampleKind kind = DevSampleKind::Float32;
    int bytes = 4;      // container bytes per sample
    int validBits = 32; // for Int32 containers (24-in-32 is MSB-aligned per WAVEFORMATEXTENSIBLE)
};

WAVEFORMATEXTENSIBLE makeWf(const DevFormat& f, int ch, int sr) {
    WAVEFORMATEXTENSIBLE wf{};
    wf.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    wf.Format.nChannels = static_cast<WORD>(ch);
    wf.Format.nSamplesPerSec = static_cast<DWORD>(sr);
    wf.Format.wBitsPerSample = static_cast<WORD>(f.bytes * 8);
    wf.Format.nBlockAlign = static_cast<WORD>(ch * f.bytes);
    wf.Format.nAvgBytesPerSec = wf.Format.nSamplesPerSec * wf.Format.nBlockAlign;
    wf.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    wf.Samples.wValidBitsPerSample =
        static_cast<WORD>(f.kind == DevSampleKind::Int32 ? f.validBits : f.bytes * 8);
    wf.dwChannelMask = channelMaskFor(ch);
    wf.SubFormat = (f.kind == DevSampleKind::Float32) ? kSubFormatFloat : kSubFormatPcm;
    return wf;
}

// Sample clamps/conversions (no allocation, RT-safe).
inline float clamp1(float v) {
    return v > 1.0f ? 1.0f : (v < -1.0f ? -1.0f : v);
}
inline int32_t toI16(float v) { return static_cast<int32_t>(lrintf(clamp1(v) * 32767.0f)); }
inline int32_t toI24(float v) { return static_cast<int32_t>(lrintf(clamp1(v) * 8388607.0f)); }
inline int32_t toI32(float v) {
    return static_cast<int32_t>(llrint(static_cast<double>(clamp1(v)) * 2147483647.0));
}

// ---------------------------------------------------------------------------------------
// Lock-free SPSC float ring (capture thread -> render thread). Bulk ops, power-of-two.
// ---------------------------------------------------------------------------------------
class FloatRing {
public:
    void init(size_t capacity) {
        size_t c = 2;
        while (c < capacity)
            c <<= 1;
        buf_.assign(c, 0.0f);
        mask_ = c - 1;
        reset();
    }
    // Only when both threads are stopped.
    void reset() {
        head_.store(0, std::memory_order_relaxed);
        tail_.store(0, std::memory_order_relaxed);
    }
    size_t capacity() const { return buf_.size(); }

    // Producer. Returns the number of samples actually written (rest dropped by caller).
    size_t write(const float* src, size_t n) {
        const uint64_t h = head_.load(std::memory_order_relaxed);
        const uint64_t t = tail_.load(std::memory_order_acquire);
        const size_t freeSpace = buf_.size() - static_cast<size_t>(h - t);
        const size_t todo = n < freeSpace ? n : freeSpace;
        for (size_t i = 0; i < todo; ++i)
            buf_[static_cast<size_t>(h + i) & mask_] = src[i];
        head_.store(h + todo, std::memory_order_release);
        return todo;
    }
    size_t writeZeros(size_t n) {
        const uint64_t h = head_.load(std::memory_order_relaxed);
        const uint64_t t = tail_.load(std::memory_order_acquire);
        const size_t freeSpace = buf_.size() - static_cast<size_t>(h - t);
        const size_t todo = n < freeSpace ? n : freeSpace;
        for (size_t i = 0; i < todo; ++i)
            buf_[static_cast<size_t>(h + i) & mask_] = 0.0f;
        head_.store(h + todo, std::memory_order_release);
        return todo;
    }
    // Consumer. Returns the number of samples actually read.
    size_t read(float* dst, size_t n) {
        const uint64_t t = tail_.load(std::memory_order_relaxed);
        const uint64_t h = head_.load(std::memory_order_acquire);
        const size_t avail = static_cast<size_t>(h - t);
        const size_t todo = n < avail ? n : avail;
        for (size_t i = 0; i < todo; ++i)
            dst[i] = buf_[static_cast<size_t>(t + i) & mask_];
        tail_.store(t + todo, std::memory_order_release);
        return todo;
    }

private:
    std::vector<float> buf_;
    size_t mask_ = 0;
    alignas(64) std::atomic<uint64_t> head_{0};
    alignas(64) std::atomic<uint64_t> tail_{0};
};

// ---------------------------------------------------------------------------------------
// Single-threaded stereo FIFO (render thread only): decouples the fixed engine quantum
// from the variable device-buffer fill amount.
// ---------------------------------------------------------------------------------------
struct StereoFifo {
    std::vector<float> l, r;
    size_t mask = 0;
    uint64_t head = 0, tail = 0;

    void init(size_t capacity) {
        size_t c = 2;
        while (c < capacity)
            c <<= 1;
        l.assign(c, 0.0f);
        r.assign(c, 0.0f);
        mask = c - 1;
        head = tail = 0;
    }
    size_t count() const { return static_cast<size_t>(head - tail); }
    void push(const float* srcL, const float* srcR, size_t n) {
        for (size_t i = 0; i < n; ++i) {
            const size_t idx = static_cast<size_t>(head + i) & mask;
            l[idx] = srcL[i];
            r[idx] = srcR[i];
        }
        head += n;
    }
    void pop(float* dstL, float* dstR, size_t n) {
        for (size_t i = 0; i < n; ++i) {
            const size_t idx = static_cast<size_t>(tail + i) & mask;
            dstL[i] = l[idx];
            dstR[i] = r[idx];
        }
        tail += n;
    }
};

// Probed for the §5.4 sampleRates listing.
const int kProbeRates[] = {44100, 48000, 88200, 96000, 176400, 192000};

} // namespace

// =========================================================================================
// Impl
// =========================================================================================

struct WasapiDriver::Impl {
    // --- request / result ---------------------------------------------------------------
    AudioConfig requested{};
    AudioConfig actual{};
    AudioCallback cb = nullptr;
    void* user = nullptr;
    AudioErrorCallback errCb = nullptr;
    void* errUser = nullptr;
    std::string fallbackInfo;

    // --- COM objects (open() thread creates; render/capture threads use — WASAPI
    // interfaces are free-threaded) -------------------------------------------------------
    IMMDevice* renderDevice = nullptr;
    IAudioClient* renderClient = nullptr;
    IAudioRenderClient* renderService = nullptr;
    IMMDevice* capDevice = nullptr;
    IAudioClient* capClient = nullptr;
    IAudioCaptureClient* capService = nullptr;

    // --- events / threads -----------------------------------------------------------------
    HANDLE renderEvent = nullptr; // auto-reset
    HANDLE capEvent = nullptr;    // auto-reset
    HANDLE stopEvent = nullptr;   // manual-reset
    HANDLE faultEvent = nullptr;  // manual-reset
    std::thread renderThread;
    std::thread capThread;
    std::thread faultThread;

    // --- stream geometry ------------------------------------------------------------------
    bool exclusive = false;
    DevFormat devFmt{};   // render device sample format (always Float32 in shared mode)
    int devCh = 2;        // render device channel count
    UINT32 renderBufferFrames = 0;
    int quantum = 512;    // engine block (frames per AudioCallback)
    int sr = 48000;
    int capCh = 0;        // 0 = no capture
    UINT32 capBufferFrames = 0;
    int latencyInFrames = 0;
    int latencyOutFrames = 0;

    // --- RT state -------------------------------------------------------------------------
    std::atomic<bool> stopReq{false};
    std::atomic<bool> running{false};
    std::atomic<bool> faultFlag{false};
    std::atomic<int> xruns{0};
    std::atomic<long long> capZeroFills{0}; // engine blocks padded due to ring underflow
    std::atomic<long long> capDrops{0};     // capture samples dropped due to ring overflow
    char faultMsg[256] = {0};
    bool opened = false;

    // --- pre-allocated staging (sized at open(), never resized while running) -------------
    std::vector<float> engL, engR;             // engine output block (quantum)
    std::vector<float*> engPtrs;               // {engL,engR}
    std::vector<float> popL, popR;             // FIFO pop staging (quantum)
    std::vector<std::vector<float>> capPlanes; // capCh x quantum
    std::vector<const float*> capPtrs;
    std::vector<float> capInter;               // quantum * capCh (render side)
    std::vector<float> capThreadBuf;           // capture-thread interleave scratch
    StereoFifo fifo;
    FloatRing capRing;

    Impl() {
        renderEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        capEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        faultEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }
    ~Impl() {
        if (renderEvent) CloseHandle(renderEvent);
        if (capEvent) CloseHandle(capEvent);
        if (stopEvent) CloseHandle(stopEvent);
        if (faultEvent) CloseHandle(faultEvent);
    }

    // ------------------------------------------------------------------ open helpers -----
    static HRESULT makeEnumerator(IMMDeviceEnumerator** out) {
        return CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(out));
    }

    static HRESULT deviceById(EDataFlow flow, const std::string& id, IMMDevice** out) {
        IMMDeviceEnumerator* en = nullptr;
        HRESULT hr = makeEnumerator(&en);
        if (FAILED(hr))
            return hr;
        if (id.empty() || id == "default") {
            hr = en->GetDefaultAudioEndpoint(flow, eMultimedia, out);
        } else {
            hr = en->GetDevice(wideFromUtf8(id).c_str(), out);
        }
        safeRelease(en);
        return hr;
    }

    bool recreateRenderClient(std::string& err) {
        safeRelease(renderService);
        safeRelease(renderClient);
        const HRESULT hr = renderDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                                  reinterpret_cast<void**>(&renderClient));
        if (FAILED(hr)) {
            err = hrText("IMMDevice::Activate(IAudioClient)", hr);
            return false;
        }
        return true;
    }

    bool tryExclusive(int mixCh, std::string& reasonOut) {
        const DevFormat candidates[] = {
            {DevSampleKind::Float32, 4, 32},
            {DevSampleKind::Int32, 4, 32},
            {DevSampleKind::Int32, 4, 24}, // 24-in-32, MSB-aligned
            {DevSampleKind::Int24, 3, 24},
            {DevSampleKind::Int16, 2, 16},
        };
        int chCandidates[2] = {2, mixCh};
        const int numCh = (mixCh != 2) ? 2 : 1;

        DevFormat chosen{};
        int chosenCh = 0;
        for (int ci = 0; ci < numCh && !chosenCh; ++ci) {
            for (const DevFormat& f : candidates) {
                WAVEFORMATEXTENSIBLE wf = makeWf(f, chCandidates[ci], sr);
                const HRESULT hr = renderClient->IsFormatSupported(
                    AUDCLNT_SHAREMODE_EXCLUSIVE, &wf.Format, nullptr);
                if (hr == S_OK) {
                    chosen = f;
                    chosenCh = chCandidates[ci];
                    break;
                }
            }
        }
        if (!chosenCh) {
            char buf[128];
            std::snprintf(buf, sizeof(buf),
                          "device rejected all exclusive-mode formats at %d Hz", sr);
            reasonOut = buf;
            return false;
        }

        REFERENCE_TIME defPeriod = 0, minPeriod = 0;
        renderClient->GetDevicePeriod(&defPeriod, &minPeriod);
        REFERENCE_TIME period = static_cast<REFERENCE_TIME>(
            10000000.0 * static_cast<double>(quantum) / static_cast<double>(sr) + 0.5);
        if (period < minPeriod)
            period = minPeriod;

        WAVEFORMATEXTENSIBLE wf = makeWf(chosen, chosenCh, sr);
        HRESULT hr = renderClient->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                              AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period,
                                              period, &wf.Format, nullptr);
        if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
            UINT32 alignedFrames = 0;
            renderClient->GetBufferSize(&alignedFrames);
            std::string err;
            if (!recreateRenderClient(err)) {
                reasonOut = "exclusive re-activate failed: " + err;
                return false;
            }
            period = static_cast<REFERENCE_TIME>(
                10000000.0 * static_cast<double>(alignedFrames) / static_cast<double>(sr) +
                0.5);
            hr = renderClient->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE,
                                          AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, period,
                                          &wf.Format, nullptr);
        }
        if (FAILED(hr)) {
            reasonOut = hrText("exclusive-mode IAudioClient::Initialize", hr);
            std::string err;
            recreateRenderClient(err); // restore a fresh client for the shared fallback
            return false;
        }
        devFmt = chosen;
        devCh = chosenCh;
        exclusive = true;
        return true;
    }

    bool openRender(std::string& err) {
        HRESULT hr = deviceById(eRender, requested.deviceId, &renderDevice);
        if (FAILED(hr)) {
            err = hrText("render device lookup", hr);
            return false;
        }
        hr = renderDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                    reinterpret_cast<void**>(&renderClient));
        if (FAILED(hr)) {
            err = hrText("IMMDevice::Activate(IAudioClient)", hr);
            return false;
        }

        int mixCh = 2;
        WAVEFORMATEX* mix = nullptr;
        if (SUCCEEDED(renderClient->GetMixFormat(&mix)) && mix) {
            mixCh = std::clamp(static_cast<int>(mix->nChannels), 1, 8);
            CoTaskMemFree(mix);
        }

        exclusive = false;
        if (requested.exclusive) {
            std::string reason;
            if (!tryExclusive(mixCh, reason)) {
                appendInfo(fallbackInfo, "exclusive mode unavailable (" + reason +
                                             ") — using shared mode");
                Log::warn("WASAPI: %s", fallbackInfo.c_str());
            }
        }

        if (!exclusive) {
            devFmt = DevFormat{DevSampleKind::Float32, 4, 32};
            devCh = mixCh;
            WAVEFORMATEXTENSIBLE wf = makeWf(devFmt, devCh, sr);
            REFERENCE_TIME defPeriod = 0, minPeriod = 0;
            renderClient->GetDevicePeriod(&defPeriod, &minPeriod);
            REFERENCE_TIME dur = static_cast<REFERENCE_TIME>(
                10000000.0 * 2.0 * static_cast<double>(quantum) / static_cast<double>(sr) +
                0.5);
            if (dur < defPeriod)
                dur = defPeriod;
            hr = renderClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                          AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                              AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                          dur, 0, &wf.Format, nullptr);
            if (FAILED(hr)) {
                err = hrText("shared-mode IAudioClient::Initialize", hr);
                return false;
            }
        }

        hr = renderClient->GetBufferSize(&renderBufferFrames);
        if (FAILED(hr) || renderBufferFrames == 0) {
            err = hrText("IAudioClient::GetBufferSize", hr);
            return false;
        }
        hr = renderClient->SetEventHandle(renderEvent);
        if (FAILED(hr)) {
            err = hrText("IAudioClient::SetEventHandle", hr);
            return false;
        }
        hr = renderClient->GetService(__uuidof(IAudioRenderClient),
                                      reinterpret_cast<void**>(&renderService));
        if (FAILED(hr)) {
            err = hrText("GetService(IAudioRenderClient)", hr);
            return false;
        }

        REFERENCE_TIME streamLat = 0;
        renderClient->GetStreamLatency(&streamLat);
        const int streamLatFrames = static_cast<int>(
            static_cast<double>(streamLat) * static_cast<double>(sr) / 10000000.0 + 0.5);
        latencyOutFrames = static_cast<int>(renderBufferFrames) + quantum + streamLatFrames;
        return true;
    }

    bool openCapture(const std::string& capId, std::string& err) {
        HRESULT hr = deviceById(eCapture, capId, &capDevice);
        if (FAILED(hr)) {
            err = hrText("capture device lookup", hr);
            return false;
        }
        hr = capDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                 reinterpret_cast<void**>(&capClient));
        if (FAILED(hr)) {
            err = hrText("capture Activate(IAudioClient)", hr);
            return false;
        }
        int mixCh = 2;
        WAVEFORMATEX* mix = nullptr;
        if (SUCCEEDED(capClient->GetMixFormat(&mix)) && mix) {
            mixCh = std::clamp(static_cast<int>(mix->nChannels), 1, 8);
            CoTaskMemFree(mix);
        }
        const DevFormat f{DevSampleKind::Float32, 4, 32};
        WAVEFORMATEXTENSIBLE wf = makeWf(f, mixCh, sr);
        REFERENCE_TIME defPeriod = 0, minPeriod = 0;
        capClient->GetDevicePeriod(&defPeriod, &minPeriod);
        REFERENCE_TIME dur = 2000000; // 200 ms cushion
        if (dur < defPeriod)
            dur = defPeriod;
        hr = capClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                   AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                       AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                       AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                   dur, 0, &wf.Format, nullptr);
        if (FAILED(hr)) {
            err = hrText("capture IAudioClient::Initialize", hr);
            return false;
        }
        hr = capClient->SetEventHandle(capEvent);
        if (FAILED(hr)) {
            err = hrText("capture SetEventHandle", hr);
            return false;
        }
        hr = capClient->GetService(__uuidof(IAudioCaptureClient),
                                   reinterpret_cast<void**>(&capService));
        if (FAILED(hr)) {
            err = hrText("GetService(IAudioCaptureClient)", hr);
            return false;
        }
        capClient->GetBufferSize(&capBufferFrames);
        capCh = mixCh;
        latencyInFrames = static_cast<int>(capBufferFrames) + quantum;
        return true;
    }

    void releaseCapture() {
        safeRelease(capService);
        safeRelease(capClient);
        safeRelease(capDevice);
        capCh = 0;
        capBufferFrames = 0;
        latencyInFrames = 0;
    }

    void releaseAll() {
        safeRelease(renderService);
        safeRelease(renderClient);
        safeRelease(renderDevice);
        releaseCapture();
    }

    // ------------------------------------------------------------------- fault path ------
    // Called from the render/capture thread when the stream dies. The error callback is
    // NOT invoked here (this is the RT thread): we stash the message and signal the
    // dedicated fault thread, which invokes it (non-RT) exactly once.
    void fail(const char* what, HRESULT hr) {
        bool expected = false;
        if (faultFlag.compare_exchange_strong(expected, true)) {
            std::snprintf(faultMsg, sizeof(faultMsg), "%s (hr=0x%08lX)", what,
                          static_cast<unsigned long>(hr));
            SetEvent(faultEvent);
        }
        stopReq.store(true, std::memory_order_release);
        running.store(false, std::memory_order_release);
    }

    void faultThreadMain() {
        HANDLE hs[2] = {faultEvent, stopEvent}; // fault first: wins if both signaled
        const DWORD w = WaitForMultipleObjects(2, hs, FALSE, INFINITE);
        if (w == WAIT_OBJECT_0 && errCb)
            errCb(errUser, faultMsg);
    }

    // -------------------------------------------------------------------- engine pull ----
    void pullEngine() {
        const float* const* inArr = nullptr;
        int nIn = 0;
        if (capCh > 0) {
            const size_t want = static_cast<size_t>(quantum) * static_cast<size_t>(capCh);
            const size_t got = capRing.read(capInter.data(), want);
            if (got < want) {
                std::memset(capInter.data() + got, 0, (want - got) * sizeof(float));
                capZeroFills.fetch_add(1, std::memory_order_relaxed);
            }
            for (int c = 0; c < capCh; ++c) {
                float* dst = capPlanes[static_cast<size_t>(c)].data();
                const float* src = capInter.data() + c;
                for (int i = 0; i < quantum; ++i) {
                    dst[i] = *src;
                    src += capCh;
                }
            }
            inArr = capPtrs.data();
            nIn = capCh;
        }
        std::memset(engL.data(), 0, static_cast<size_t>(quantum) * sizeof(float));
        std::memset(engR.data(), 0, static_cast<size_t>(quantum) * sizeof(float));
        cb(user, inArr, nIn, engPtrs.data(), 2, quantum);
        fifo.push(engL.data(), engR.data(), static_cast<size_t>(quantum));
    }

    // Writes n frames (from popL/popR) into the device buffer at frameOff, converting to
    // the device format. Engine is stereo; extra device channels are zeroed, mono devices
    // get an L/R average.
    void writeDevice(BYTE* base, size_t frameOff, size_t n) {
        const int ch = devCh;
        switch (devFmt.kind) {
            case DevSampleKind::Float32: {
                float* p = reinterpret_cast<float*>(base) + frameOff * static_cast<size_t>(ch);
                for (size_t i = 0; i < n; ++i, p += ch) {
                    if (ch == 1) {
                        p[0] = 0.5f * (popL[i] + popR[i]);
                    } else {
                        p[0] = popL[i];
                        p[1] = popR[i];
                        for (int c = 2; c < ch; ++c)
                            p[c] = 0.0f;
                    }
                }
                break;
            }
            case DevSampleKind::Int16: {
                int16_t* p =
                    reinterpret_cast<int16_t*>(base) + frameOff * static_cast<size_t>(ch);
                for (size_t i = 0; i < n; ++i, p += ch) {
                    if (ch == 1) {
                        p[0] = static_cast<int16_t>(toI16(0.5f * (popL[i] + popR[i])));
                    } else {
                        p[0] = static_cast<int16_t>(toI16(popL[i]));
                        p[1] = static_cast<int16_t>(toI16(popR[i]));
                        for (int c = 2; c < ch; ++c)
                            p[c] = 0;
                    }
                }
                break;
            }
            case DevSampleKind::Int24: {
                BYTE* p = base + frameOff * static_cast<size_t>(ch) * 3;
                for (size_t i = 0; i < n; ++i) {
                    for (int c = 0; c < ch; ++c, p += 3) {
                        int32_t s = 0;
                        if (c == 0)
                            s = toI24(ch == 1 ? 0.5f * (popL[i] + popR[i]) : popL[i]);
                        else if (c == 1)
                            s = toI24(popR[i]);
                        p[0] = static_cast<BYTE>(s & 0xff);
                        p[1] = static_cast<BYTE>((s >> 8) & 0xff);
                        p[2] = static_cast<BYTE>((s >> 16) & 0xff);
                    }
                }
                break;
            }
            case DevSampleKind::Int32: {
                int32_t* p =
                    reinterpret_cast<int32_t*>(base) + frameOff * static_cast<size_t>(ch);
                const int shift = 32 - devFmt.validBits; // 24-in-32 is MSB-aligned
                for (size_t i = 0; i < n; ++i, p += ch) {
                    for (int c = 0; c < ch; ++c) {
                        int32_t s = 0;
                        if (c == 0) {
                            const float v = (ch == 1) ? 0.5f * (popL[i] + popR[i]) : popL[i];
                            s = (devFmt.validBits == 24) ? (toI24(v) << shift) : toI32(v);
                        } else if (c == 1) {
                            s = (devFmt.validBits == 24) ? (toI24(popR[i]) << shift)
                                                         : toI32(popR[i]);
                        }
                        p[c] = s;
                    }
                }
                break;
            }
        }
    }

    void fillDevice(BYTE* data, UINT32 frames) {
        size_t done = 0;
        while (done < frames) {
            if (fifo.count() == 0)
                pullEngine();
            size_t n = static_cast<size_t>(frames) - done;
            if (n > fifo.count())
                n = fifo.count();
            if (n > static_cast<size_t>(quantum))
                n = static_cast<size_t>(quantum);
            fifo.pop(popL.data(), popR.data(), n);
            writeDevice(data, done, n);
            done += n;
        }
    }

    // ------------------------------------------------------------------ render thread ----
    void renderThreadMain() {
        ensureComInitialized();
        DWORD taskIdx = 0;
        HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIdx);
        if (!mmcss)
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        _mm_setcsr(_mm_getcsr() | 0x8040u); // FTZ + DAZ

        const double bufMs = 1000.0 * static_cast<double>(renderBufferFrames) /
                             static_cast<double>(sr);
        const DWORD timeoutMs = static_cast<DWORD>(bufMs * 4.0 < 100.0 ? 100.0 : bufMs * 4.0);
        int consecTimeouts = 0;
        int warmup = 20; // skip the empty-buffer xrun heuristic for the first events

        HANDLE hs[2] = {stopEvent, renderEvent};
        while (!stopReq.load(std::memory_order_acquire)) {
            const DWORD w = WaitForMultipleObjects(2, hs, FALSE, timeoutMs);
            if (w == WAIT_OBJECT_0)
                break; // stop
            if (w == WAIT_TIMEOUT) {
                xruns.fetch_add(1, std::memory_order_relaxed);
                if (++consecTimeouts >= 8) {
                    fail("WASAPI render stream stalled (event timeout)", E_FAIL);
                    break;
                }
                continue;
            }
            if (w != WAIT_OBJECT_0 + 1) {
                fail("WASAPI render wait failed", E_FAIL);
                break;
            }
            consecTimeouts = 0;

            UINT32 frames = renderBufferFrames;
            if (!exclusive) {
                UINT32 pad = 0;
                const HRESULT hrPad = renderClient->GetCurrentPadding(&pad);
                if (FAILED(hrPad)) {
                    fail("WASAPI GetCurrentPadding", hrPad);
                    break;
                }
                if (warmup > 0)
                    --warmup;
                else if (pad == 0)
                    xruns.fetch_add(1, std::memory_order_relaxed); // fully drained = glitch
                frames = renderBufferFrames - pad;
                if (frames == 0)
                    continue;
            }

            BYTE* data = nullptr;
            const HRESULT hr = renderService->GetBuffer(frames, &data);
            if (FAILED(hr)) {
                fail("WASAPI GetBuffer (device invalidated?)", hr);
                break;
            }
            fillDevice(data, frames);
            renderService->ReleaseBuffer(frames, 0);
        }

        if (mmcss)
            AvRevertMmThreadCharacteristics(mmcss);
    }

    // ------------------------------------------------------------------ capture thread ---
    void capThreadMain() {
        ensureComInitialized();
        DWORD taskIdx = 0;
        HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIdx);
        _mm_setcsr(_mm_getcsr() | 0x8040u);

        HANDLE hs[2] = {stopEvent, capEvent};
        while (!stopReq.load(std::memory_order_acquire)) {
            const DWORD w = WaitForMultipleObjects(2, hs, FALSE, 500);
            if (w == WAIT_OBJECT_0)
                break;
            if (w == WAIT_TIMEOUT)
                continue;
            if (w != WAIT_OBJECT_0 + 1)
                break;

            UINT32 pkt = 0;
            while (SUCCEEDED(capService->GetNextPacketSize(&pkt)) && pkt > 0) {
                BYTE* data = nullptr;
                UINT32 frames = 0;
                DWORD flags = 0;
                const HRESULT hr = capService->GetBuffer(&data, &frames, &flags, nullptr,
                                                         nullptr);
                if (FAILED(hr)) {
                    fail("WASAPI capture GetBuffer (device invalidated?)", hr);
                    return;
                }
                if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY)
                    xruns.fetch_add(1, std::memory_order_relaxed);

                const size_t samples =
                    static_cast<size_t>(frames) * static_cast<size_t>(capCh);
                size_t written;
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    written = capRing.writeZeros(samples);
                } else {
                    // Shared + AUTOCONVERTPCM with our float format -> data is already
                    // interleaved float32 at the session rate.
                    written = capRing.write(reinterpret_cast<const float*>(data), samples);
                }
                if (written < samples)
                    capDrops.fetch_add(static_cast<long long>(samples - written),
                                       std::memory_order_relaxed); // drift: drop overflow
                capService->ReleaseBuffer(frames);
            }
        }
        if (mmcss)
            AvRevertMmThreadCharacteristics(mmcss);
    }

    // ------------------------------------------------------------------ enumeration ------
    static void enumerateFlow(EDataFlow flow, std::vector<DeviceInfo>& out) {
        IMMDeviceEnumerator* en = nullptr;
        if (FAILED(makeEnumerator(&en)))
            return;

        std::wstring defaultId;
        {
            IMMDevice* def = nullptr;
            if (SUCCEEDED(en->GetDefaultAudioEndpoint(flow, eMultimedia, &def)) && def) {
                LPWSTR id = nullptr;
                if (SUCCEEDED(def->GetId(&id)) && id) {
                    defaultId = id;
                    CoTaskMemFree(id);
                }
                safeRelease(def);
            }
        }

        IMMDeviceCollection* coll = nullptr;
        if (FAILED(en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &coll)) || !coll) {
            safeRelease(en);
            return;
        }
        UINT count = 0;
        coll->GetCount(&count);
        for (UINT i = 0; i < count; ++i) {
            IMMDevice* dev = nullptr;
            if (FAILED(coll->Item(i, &dev)) || !dev)
                continue;

            DeviceInfo info;
            LPWSTR wid = nullptr;
            std::wstring widStr;
            if (SUCCEEDED(dev->GetId(&wid)) && wid) {
                widStr = wid;
                info.id = utf8FromWide(wid);
                CoTaskMemFree(wid);
            }
            info.isDefault = !widStr.empty() && widStr == defaultId;

            IPropertyStore* props = nullptr;
            if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props)) && props) {
                PROPVARIANT v;
                PropVariantInit(&v);
                if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) &&
                    v.vt == VT_LPWSTR)
                    info.name = utf8FromWide(v.pwszVal);
                PropVariantClear(&v);
                safeRelease(props);
            }
            if (info.name.empty())
                info.name = info.id;

            // Mix format + sample-rate probing.
            IAudioClient* client = nullptr;
            int mixCh = 2;
            int mixRate = 0;
            if (SUCCEEDED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                        reinterpret_cast<void**>(&client))) &&
                client) {
                WAVEFORMATEX* mix = nullptr;
                if (SUCCEEDED(client->GetMixFormat(&mix)) && mix) {
                    mixCh = std::clamp(static_cast<int>(mix->nChannels), 1, 8);
                    mixRate = static_cast<int>(mix->nSamplesPerSec);
                    CoTaskMemFree(mix);
                }
                for (int rate : kProbeRates) {
                    if (rate == mixRate)
                        continue; // added below
                    // Exclusive-mode probe (native support); shared+AUTOCONVERTPCM accepts
                    // any rate anyway, so this list is informational (NOTE in header).
                    const DevFormat f16{DevSampleKind::Int16, 2, 16};
                    const DevFormat f32{DevSampleKind::Float32, 4, 32};
                    WAVEFORMATEXTENSIBLE a = makeWf(f16, mixCh, rate);
                    WAVEFORMATEXTENSIBLE b = makeWf(f32, mixCh, rate);
                    if (client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &a.Format,
                                                  nullptr) == S_OK ||
                        client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &b.Format,
                                                  nullptr) == S_OK)
                        info.sampleRates.push_back(rate);
                }
                safeRelease(client);
            }
            if (mixRate > 0)
                info.sampleRates.push_back(mixRate);
            std::sort(info.sampleRates.begin(), info.sampleRates.end());
            info.sampleRates.erase(
                std::unique(info.sampleRates.begin(), info.sampleRates.end()),
                info.sampleRates.end());

            if (flow == eRender) {
                info.maxOutputs = mixCh;
                info.maxInputs = 0;
            } else {
                info.maxInputs = mixCh;
                info.maxOutputs = 0;
            }
            out.push_back(std::move(info));
            safeRelease(dev);
        }
        safeRelease(coll);
        safeRelease(en);
    }
};

// =========================================================================================
// WasapiDriver
// =========================================================================================

WasapiDriver::WasapiDriver() : impl_(std::make_unique<Impl>()) {}

WasapiDriver::~WasapiDriver() {
    close();
}

bool WasapiDriver::isAvailable(std::string* reasonOut) const {
    ensureComInitialized();
    IMMDeviceEnumerator* en = nullptr;
    const HRESULT hr = Impl::makeEnumerator(&en);
    if (FAILED(hr)) {
        if (reasonOut)
            *reasonOut = hrText("WASAPI device enumerator creation", hr);
        return false;
    }
    safeRelease(en);
    if (reasonOut)
        reasonOut->clear();
    return true;
}

std::vector<DeviceInfo> WasapiDriver::enumerateRender() {
    ensureComInitialized();
    std::vector<DeviceInfo> out;
    Impl::enumerateFlow(eRender, out);
    return out;
}

std::vector<DeviceInfo> WasapiDriver::enumerateCapture() {
    ensureComInitialized();
    std::vector<DeviceInfo> out;
    Impl::enumerateFlow(eCapture, out);
    return out;
}

std::vector<DeviceInfo> WasapiDriver::enumerate() {
    std::vector<DeviceInfo> out = enumerateRender();
    std::vector<DeviceInfo> cap = enumerateCapture();
    out.insert(out.end(), cap.begin(), cap.end());
    return out;
}

bool WasapiDriver::open(const AudioConfig& config, AudioCallback callback, void* user,
                        std::string* errorOut) {
    Impl& s = *impl_;
    if (s.opened) {
        setErr(errorOut, "WASAPI driver already open (close() first)");
        return false;
    }
    if (!callback) {
        setErr(errorOut, "WASAPI: no audio callback supplied");
        return false;
    }
    ensureComInitialized();

    s.cb = callback;
    s.user = user;
    s.requested = config;
    s.sr = std::clamp(config.sampleRate, 8000, 384000);
    s.quantum = std::clamp(config.bufferSize, 32, 2048); // engine/plugin maxBlock (SPEC §8.1)
    s.fallbackInfo.clear();
    s.xruns.store(0, std::memory_order_relaxed);
    s.capZeroFills.store(0, std::memory_order_relaxed);
    s.capDrops.store(0, std::memory_order_relaxed);
    s.faultFlag.store(false, std::memory_order_relaxed);
    s.faultMsg[0] = '\0';
    ResetEvent(s.faultEvent);

    std::string err;
    if (!s.openRender(err)) {
        s.releaseAll();
        setErr(errorOut, err);
        return false;
    }

    s.capCh = 0;
    if (!config.captureDeviceId.empty()) {
        std::string capErr;
        if (!s.openCapture(config.captureDeviceId, capErr)) {
            Log::warn("WASAPI: capture open failed (%s) — continuing render-only",
                      capErr.c_str());
            appendInfo(s.fallbackInfo, "capture unavailable: " + capErr);
            s.releaseCapture();
        }
    }

    // Pre-allocate all RT staging.
    const size_t q = static_cast<size_t>(s.quantum);
    s.engL.assign(q, 0.0f);
    s.engR.assign(q, 0.0f);
    s.engPtrs = {s.engL.data(), s.engR.data()};
    s.popL.assign(q, 0.0f);
    s.popR.assign(q, 0.0f);
    s.fifo.init(q + static_cast<size_t>(s.renderBufferFrames) + q);
    if (s.capCh > 0) {
        s.capPlanes.assign(static_cast<size_t>(s.capCh), std::vector<float>(q, 0.0f));
        s.capPtrs.resize(static_cast<size_t>(s.capCh));
        for (int c = 0; c < s.capCh; ++c)
            s.capPtrs[static_cast<size_t>(c)] = s.capPlanes[static_cast<size_t>(c)].data();
        s.capInter.assign(q * static_cast<size_t>(s.capCh), 0.0f);
        size_t ringCap = static_cast<size_t>(s.sr) / 4; // ~250 ms
        if (ringCap < q * 8)
            ringCap = q * 8;
        s.capRing.init(ringCap * static_cast<size_t>(s.capCh));
    }

    AudioConfig actual = config;
    actual.driverType = DriverType::Wasapi;
    actual.sampleRate = s.sr;
    actual.bufferSize = s.quantum;
    actual.exclusive = s.exclusive;
    {
        LPWSTR wid = nullptr;
        if (s.renderDevice && SUCCEEDED(s.renderDevice->GetId(&wid)) && wid) {
            actual.deviceId = utf8FromWide(wid);
            CoTaskMemFree(wid);
        }
        wid = nullptr;
        if (s.capDevice && SUCCEEDED(s.capDevice->GetId(&wid)) && wid) {
            actual.captureDeviceId = utf8FromWide(wid);
            CoTaskMemFree(wid);
        } else {
            actual.captureDeviceId.clear();
        }
    }
    s.actual = actual;
    s.opened = true;
    const std::string extra =
        s.fallbackInfo.empty() ? std::string() : (" [" + s.fallbackInfo + "]");
    Log::info("WASAPI: opened %s, %d Hz, engine block %d, device buffer %u frames%s%s",
              s.exclusive ? "EXCLUSIVE" : "shared (AUTOCONVERTPCM)", s.sr, s.quantum,
              s.renderBufferFrames, s.capCh > 0 ? ", capture on" : "", extra.c_str());
    return true;
}

bool WasapiDriver::start() {
    Impl& s = *impl_;
    if (!s.opened || s.running.load(std::memory_order_acquire))
        return false;

    s.stopReq.store(false, std::memory_order_release);
    ResetEvent(s.stopEvent);
    s.fifo.head = s.fifo.tail = 0;
    s.capRing.reset();

    // Pre-fill the render buffer with silence to avoid a startup glitch.
    {
        BYTE* data = nullptr;
        if (SUCCEEDED(s.renderService->GetBuffer(s.renderBufferFrames, &data)) && data)
            s.renderService->ReleaseBuffer(s.renderBufferFrames,
                                           AUDCLNT_BUFFERFLAGS_SILENT);
    }

    s.faultThread = std::thread([this] { impl_->faultThreadMain(); });
    if (s.capCh > 0)
        s.capThread = std::thread([this] { impl_->capThreadMain(); });
    s.renderThread = std::thread([this] { impl_->renderThreadMain(); });

    HRESULT hr = S_OK;
    if (s.capClient) {
        hr = s.capClient->Start();
        if (FAILED(hr))
            Log::warn("WASAPI: capture Start failed (hr=0x%08lX) — inputs will be silent",
                      static_cast<unsigned long>(hr));
    }
    hr = s.renderClient->Start();
    if (FAILED(hr)) {
        Log::error("WASAPI: render Start failed (hr=0x%08lX)",
                   static_cast<unsigned long>(hr));
        stop();
        return false;
    }
    s.running.store(true, std::memory_order_release);
    return true;
}

void WasapiDriver::stop() {
    Impl& s = *impl_;
    s.stopReq.store(true, std::memory_order_release);
    if (s.stopEvent)
        SetEvent(s.stopEvent);
    if (s.renderThread.joinable())
        s.renderThread.join();
    if (s.capThread.joinable())
        s.capThread.join();
    if (s.faultThread.joinable())
        s.faultThread.join();
    if (s.renderClient)
        s.renderClient->Stop();
    if (s.capClient)
        s.capClient->Stop();
    ResetEvent(s.stopEvent);
    s.running.store(false, std::memory_order_release);
}

void WasapiDriver::close() {
    Impl& s = *impl_;
    stop();
    s.releaseAll();
    s.opened = false;
    s.cb = nullptr;
    s.user = nullptr;
    s.renderBufferFrames = 0;
    s.latencyInFrames = 0;
    s.latencyOutFrames = 0;
}

int WasapiDriver::latencyFramesIn() const {
    return impl_->latencyInFrames;
}

int WasapiDriver::latencyFramesOut() const {
    return impl_->latencyOutFrames;
}

AudioConfig WasapiDriver::actualConfig() const {
    return impl_->actual;
}

void WasapiDriver::setErrorCallback(AudioErrorCallback callback, void* user) {
    impl_->errCb = callback;
    impl_->errUser = user;
}

int WasapiDriver::xrunCount() const {
    return impl_->xruns.load(std::memory_order_relaxed);
}

bool WasapiDriver::isRunning() const {
    return impl_->running.load(std::memory_order_acquire) &&
           !impl_->faultFlag.load(std::memory_order_acquire);
}

std::string WasapiDriver::openFallbackInfo() const {
    return impl_->fallbackInfo;
}

} // namespace mydaw
