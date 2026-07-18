// MyDAW — server/StaticFiles.h
// Static file resolution for the UI bundle (SPEC §3, §5): sanitized path lookup under
// the uiRoot directory with SPA fallback to index.html for "/" and unknown extensionless
// paths. NO path traversal: "..", drive letters, backslashes and control characters in
// URL segments are rejected before touching the filesystem.
//
// Cache policy (per E8 contract): index.html -> "no-cache"; everything else ->
// "public, max-age=3600".
//
// Server thread only (called per-request by HttpWsServer). Non-RT.

#pragma once

#include <optional>
#include <string>

namespace mydaw {

class StaticFiles {
public:
    struct File {
        std::string body;
        std::string contentType;
        std::string cacheControl;
    };

    // uiRoot: absolute or relative directory containing index.html (may not exist yet —
    // every get() probes the filesystem fresh, so a late build appears without restart).
    void setRoot(std::string uiRoot);
    const std::string& root() const { return root_; }

    // urlPath: percent-DECODED request path beginning with '/' (no query string).
    // Returns the file (200) or nullopt (caller responds 404). Traversal attempts,
    // missing files with extensions, and unreadable files all yield nullopt; "/" and
    // extensionless unknowns fall back to index.html when it exists.
    std::optional<File> get(const std::string& urlPath) const;

    // MIME type for a file name, from its extension (SPEC list: html/js/css/svg/png/
    // woff2/json/map + a few safe extras). Unknown -> "application/octet-stream".
    static std::string contentTypeFor(const std::string& fileName);

private:
    std::optional<File> load(const std::string& relPath) const;

    std::string root_;
};

} // namespace mydaw
