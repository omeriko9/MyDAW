// MyDAW — Settings.h (E9)
// App settings persisted to %APPDATA%/MyDAW/settings.json (SPEC §5.7):
//   { autosaveMinutes, audio:{driver,deviceId,sampleRate,bufferSize,exclusive},
//     pluginFoldersVst2:[..], pluginFoldersVst3:[..], host32Path?, host64Path?, ... }
// Unknown keys (theme etc) are round-tripped verbatim. settings/get returns the FLAT
// object; settings/set merges a patch (objects merge recursively, null deletes a key)
// and persists immediately.
//
// Main-thread only (settings are read/written from command processing).

#pragma once

#include <string>
#include <vector>

#include "audio/IAudioDriver.h" // AudioConfig
#include "util/Json.h"

namespace mydaw {

class Settings {
public:
    // Loads settings.json over the built-in defaults. Portable mode: if a
    // settings.json exists next to the exe it is used (read + write); otherwise
    // %APPDATA%/MyDAW/settings.json.
    Settings();

    // Full flat settings object (settings/get reply payload).
    const json& get() const { return data_; }

    // Recursive merge of `patch` (null values delete keys), then save().
    void set(const json& patch);

    // Atomic-ish persist (tmp + rename). Logged on failure, never throws.
    void save() const;

    // ----- typed accessors ----------------------------------------------------
    int port() const;                            // HTTP/WS port, default 8417
    int autosaveMinutes() const;                 // default 2
    AudioConfig audioConfig() const;             // from "audio" object
    void storeAudioConfig(const AudioConfig& c); // writes "audio" + save()
    std::vector<std::string> pluginFoldersVst2() const;
    std::vector<std::string> pluginFoldersVst3() const;
    void storePluginFolders(const std::vector<std::string>& vst2,
                            const std::vector<std::string>& vst3); // + save()
    std::string host32Path() const; // "" = unset
    std::string host64Path() const;

private:
    static json defaults();
    static void mergeInto(json& dst, const json& patch);

    std::string filePath_;
    json data_;
};

} // namespace mydaw
