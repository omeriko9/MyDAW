// MyDAW — Settings.cpp (E9). See Settings.h.

#include "Settings.h"

#include <cstdio>

#include "plugins/PluginRegistry.h"
#include "util/Log.h"
#include "util/Paths.h"

namespace mydaw {

namespace {

bool readTextFile(const std::string& path, std::string& out) {
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

bool writeTextFileAtomic(const std::string& path, const std::string& text) {
    const std::string tmp = path + ".tmp";
    FILE* f = _wfopen(utf8ToWide(tmp).c_str(), L"wb");
    if (!f)
        return false;
    const size_t put = std::fwrite(text.data(), 1, text.size(), f);
    std::fclose(f);
    if (put != text.size())
        return false;
    // rename over the destination (remove first; plain C rename fails on existing).
    std::remove(path.c_str());
    _wremove(utf8ToWide(path).c_str());
    return _wrename(utf8ToWide(tmp).c_str(), utf8ToWide(path).c_str()) == 0;
}

} // namespace

json Settings::defaults() {
    return json{
        {"port", 8417},
        {"autosaveMinutes", 2},
        {"audio",
         json{{"driver", "wasapi"},
              {"deviceId", ""},
              {"sampleRate", 48000},
              {"bufferSize", 512},
              {"exclusive", false}}},
        {"pluginFoldersVst2", PluginRegistry::defaultVst2Folders()},
        {"pluginFoldersVst3", PluginRegistry::defaultVst3Folders()},
    };
}

void Settings::mergeInto(json& dst, const json& patch) {
    if (!patch.is_object()) {
        dst = patch;
        return;
    }
    if (!dst.is_object())
        dst = json::object();
    for (auto it = patch.begin(); it != patch.end(); ++it) {
        if (it->is_null()) {
            dst.erase(it.key());
        } else if (it->is_object() && dst.contains(it.key()) && dst[it.key()].is_object()) {
            mergeInto(dst[it.key()], *it);
        } else {
            dst[it.key()] = *it;
        }
    }
}

Settings::Settings() {
    // Portable mode: a settings.json sitting next to the exe wins over %APPDATA%
    // (shipped Release folders carry their own config; reads AND writes stay local).
    const std::string portable = pathJoin(exeDir(), "settings.json");
    std::string text;
    if (readTextFile(portable, text)) {
        filePath_ = portable;
    } else {
        filePath_ = pathJoin(appDataDir(), "settings.json");
        text.clear();
        readTextFile(filePath_, text);
    }
    data_ = defaults();
    if (!text.empty()) {
        const json loaded = parseJson(text);
        if (loaded.is_object())
            mergeInto(data_, loaded);
        else
            Log::warn("Settings: %s is not valid JSON, using defaults", filePath_.c_str());
    }
}

void Settings::set(const json& patch) {
    if (patch.is_object())
        mergeInto(data_, patch);
    save();
}

void Settings::save() const {
    if (!writeTextFileAtomic(filePath_, data_.dump(2)))
        Log::warn("Settings: failed to write %s", filePath_.c_str());
}

int Settings::autosaveMinutes() const {
    return getOr<int>(data_, "autosaveMinutes", 2);
}

int Settings::port() const {
    const int p = getOr<int>(data_, "port", 8417);
    return (p > 0 && p <= 65535) ? p : 8417;
}

AudioConfig Settings::audioConfig() const {
    AudioConfig c;
    const json a = getOr<json>(data_, "audio", json::object());
    DriverType t = DriverType::Wasapi;
    if (driverTypeFromString(getOr(a, "driver", "wasapi"), t))
        c.driverType = t;
    c.deviceId = getOr(a, "deviceId", "");
    c.sampleRate = getOr<int>(a, "sampleRate", 48000);
    c.bufferSize = getOr<int>(a, "bufferSize", 512);
    c.exclusive = getOr<bool>(a, "exclusive", false);
    c.captureDeviceId = getOr(a, "captureDeviceId", "");
    return c;
}

void Settings::storeAudioConfig(const AudioConfig& c) {
    data_["audio"] = json{{"driver", driverTypeToString(c.driverType)},
                          {"deviceId", c.deviceId},
                          {"sampleRate", c.sampleRate},
                          {"bufferSize", c.bufferSize},
                          {"exclusive", c.exclusive},
                          {"captureDeviceId", c.captureDeviceId}};
    save();
}

std::vector<std::string> Settings::pluginFoldersVst2() const {
    return getOr<std::vector<std::string>>(data_, "pluginFoldersVst2", {});
}

std::vector<std::string> Settings::pluginFoldersVst3() const {
    return getOr<std::vector<std::string>>(data_, "pluginFoldersVst3", {});
}

void Settings::storePluginFolders(const std::vector<std::string>& vst2,
                                  const std::vector<std::string>& vst3) {
    data_["pluginFoldersVst2"] = vst2;
    data_["pluginFoldersVst3"] = vst3;
    save();
}

std::string Settings::host32Path() const { return getOr(data_, "host32Path", ""); }
std::string Settings::host64Path() const { return getOr(data_, "host64Path", ""); }

} // namespace mydaw
