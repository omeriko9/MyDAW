// MyDAW — plugins/IconExtractor.cpp (E6). See IconExtractor.h.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include "IconExtractor.h"

#include <windows.h>

#include <shellapi.h>  // ExtractIconExW
#include <wincodec.h>  // WIC: HICON -> 32x32 PNG

#include <cstdio>
#include <filesystem>
#include <fstream>

#include "../util/Log.h"
#include "../util/Paths.h"
#include "../util/Strings.h"

#pragma comment(lib, "windowscodecs.lib")

namespace mydaw {

namespace fs = std::filesystem;

namespace {

std::string normPathKey(std::string s) {
    for (char& c : s)
        c = (c == '\\') ? '/' : static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

// COM release helper (no ATL in this codebase).
template <typename T>
struct Com {
    T* p = nullptr;
    ~Com() {
        if (p)
            p->Release();
    }
    T** operator&() { return &p; }
    T* operator->() const { return p; }
    explicit operator bool() const { return p != nullptr; }
};

// HICON -> 32x32 PNG file via WIC. False on any failure (caller logs-and-skips).
bool iconToPng(HICON icon, const std::wstring& outFile) {
    Com<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&factory.p))))
        return false;
    Com<IWICBitmap> bitmap;
    if (FAILED(factory->CreateBitmapFromHICON(icon, &bitmap.p)))
        return false;
    Com<IWICBitmapScaler> scaler;
    if (FAILED(factory->CreateBitmapScaler(&scaler.p)) ||
        FAILED(scaler.p->Initialize(bitmap.p, 32, 32, WICBitmapInterpolationModeFant)))
        return false;

    Com<IWICStream> stream;
    if (FAILED(factory->CreateStream(&stream.p)) ||
        FAILED(stream.p->InitializeFromFilename(outFile.c_str(), GENERIC_WRITE)))
        return false;
    Com<IWICBitmapEncoder> encoder;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder.p)) ||
        FAILED(encoder.p->Initialize(stream.p, WICBitmapEncoderNoCache)))
        return false;
    Com<IWICBitmapFrameEncode> frame;
    if (FAILED(encoder.p->CreateNewFrame(&frame.p, nullptr)) || FAILED(frame.p->Initialize(nullptr)))
        return false;
    if (FAILED(frame.p->WriteSource(scaler.p, nullptr)))
        return false;
    return SUCCEEDED(frame.p->Commit()) && SUCCEEDED(encoder.p->Commit());
}

// Best icon source for a plugin path. VST3 bundle files live at
// <Bundle>.vst3/Contents/x86_64-win/<name>.vst3 — the bundle's Resources dir may carry a
// real .ico even when the inner PE has none.
HICON loadIconFor(const std::string& path) {
    HICON large = nullptr;
    // Only accept a REAL embedded icon: ExtractIconExW returns the count written; a
    // module with no icon resource yields none (never the shell's generic-DLL icon).
    if (ExtractIconExW(utf8ToWide(path).c_str(), 0, &large, nullptr, 1) >= 1 && large)
        return large;

    const std::string norm = normPathKey(path);
    const size_t contents = norm.find("/contents/");
    if (endsWith(norm, ".vst3") && contents != std::string::npos) {
        const fs::path resources =
            fs::path(utf8ToWide(path.substr(0, contents))) / L"Contents" / L"Resources";
        std::error_code ec;
        for (const auto& e : fs::directory_iterator(resources, ec)) {
            if (ec)
                break;
            if (lower(e.path().extension().string()) == ".ico") {
                HICON ico = static_cast<HICON>(LoadImageW(nullptr, e.path().c_str(),
                                                          IMAGE_ICON, 32, 32,
                                                          LR_LOADFROMFILE));
                if (ico)
                    return ico;
            }
        }
    }
    return nullptr;
}

} // namespace

std::string IconExtractor::keyFor(const std::string& path) {
    // FNV-1a 64 over the normalized path: stable across runs/builds, 16 hex chars.
    uint64_t h = 1469598103934665603ull;
    for (const char c : normPathKey(path)) {
        h ^= static_cast<unsigned char>(c);
        h *= 1099511628211ull;
    }
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(h));
    return buf;
}

IconExtractor::IconExtractor() : IconExtractor(pathJoin(appDataDir(), "icons")) {}

IconExtractor::IconExtractor(std::string dir) : dir_(std::move(dir)) {
    std::error_code ec;
    fs::create_directories(fs::path(utf8ToWide(dir_)), ec);
    for (const auto& e : fs::directory_iterator(fs::path(utf8ToWide(dir_)), ec)) {
        if (ec)
            break;
        if (lower(e.path().extension().string()) == ".png")
            known_.insert(e.path().stem().string());
    }
}

int IconExtractor::extractMissing(const std::vector<std::string>& paths) {
    // Dedup by key first (shell files appear once per sub-plugin in some callers).
    std::vector<std::pair<std::string, std::string>> todo; // key, path
    {
        std::lock_guard<std::mutex> lock(mutex_);
        std::set<std::string> seen;
        for (const std::string& p : paths) {
            const std::string key = keyFor(p);
            if (known_.count(key) || !seen.insert(key).second)
                continue;
            todo.emplace_back(key, p);
        }
    }
    if (todo.empty())
        return 0;

    const HRESULT co = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    int extracted = 0;
    for (const auto& [key, path] : todo) {
        HICON icon = loadIconFor(path);
        if (!icon)
            continue; // most VST2 DLLs carry no icon — the avatar fallback is the look
        const std::wstring out = utf8ToWide(pathJoin(dir_, key + ".png"));
        const bool ok = iconToPng(icon, out);
        DestroyIcon(icon);
        if (ok) {
            std::lock_guard<std::mutex> lock(mutex_);
            known_.insert(key);
            ++extracted;
        }
    }
    if (SUCCEEDED(co))
        CoUninitialize();
    if (extracted > 0)
        Log::info("IconExtractor: %d plugin icon(s) extracted", extracted);
    return extracted;
}

bool IconExtractor::has(const std::string& key) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return known_.count(key) > 0;
}

std::vector<uint8_t> IconExtractor::read(const std::string& key) const {
    // Keys are hex only — refuse anything path-like outright.
    for (const char c : key)
        if (!std::isxdigit(static_cast<unsigned char>(c)))
            return {};
    if (!has(key))
        return {};
    std::ifstream f(utf8ToWide(pathJoin(dir_, key + ".png")), std::ios::binary);
    if (!f.is_open())
        return {};
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(f),
                                std::istreambuf_iterator<char>());
}

} // namespace mydaw
