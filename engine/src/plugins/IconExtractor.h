// MyDAW — plugins/IconExtractor.h (E6)
// Plugin icon harvesting (SPEC §5.6): after a scan finishes, pull the embedded icon out
// of each ok plugin binary (ExtractIconExW — only when the module really carries an icon
// resource; .vst3 bundles also try Contents/Resources/*.ico) and cache it as a 32×32 PNG
// under %APPDATA%/MyDAW/icons/<fnv1a64(normPath)>.png, served at GET /api/plugin-icon/<key>.
// Registry rows carry `iconKey` only when the PNG exists; the UI falls back to a
// vendor-colored initial avatar (and the user's emoji override wins over both).
//
// Extraction runs AFTER the scan's done() fired (scanner worker thread), so scanDone
// latency never pays for it. Every failure is logged-and-skipped — icons are decoration.

#pragma once

#include <cstdint>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace mydaw {

class IconExtractor {
public:
    IconExtractor();                       // icons dir under %APPDATA%/MyDAW
    explicit IconExtractor(std::string dir); // tests

    // Stable content key for a plugin file path (lowercased, forward slashes → FNV-1a 64
    // as 16 hex chars). The same function the registry annotation and the HTTP route use.
    static std::string keyFor(const std::string& path);

    // Extract + cache icons for every path that has none yet. Blocking; call off the
    // main thread (the scanner worker's post-done tail). COM is initialized per call.
    int extractMissing(const std::vector<std::string>& paths); // returns #icons newly cached

    // True when <key>.png exists (backed by an in-memory set primed at construction).
    bool has(const std::string& key) const;

    // PNG bytes for a key ("" on miss) — the HTTP provider.
    std::vector<uint8_t> read(const std::string& key) const;

private:
    std::string dir_;
    mutable std::mutex mutex_;
    std::set<std::string> known_; // keys with a PNG on disk
};

} // namespace mydaw
