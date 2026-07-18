// MyDAW — import/ImportProvider.cpp. See ImportProvider.h.

#include "import/ImportProvider.h"

#include "util/Log.h"
#include "util/Paths.h"   // fileExtension (lowercased, with dot)
#include "util/Strings.h" // iequals

namespace mydaw {

bool ImportProvider::probe(const std::string& absPath, std::string& whyNot) const {
    (void)absPath;
    (void)whyNot;
    return true; // extension match suffices by default
}

ImportProviderRegistry& ImportProviderRegistry::instance() {
    static ImportProviderRegistry registry;
    return registry;
}

void ImportProviderRegistry::add(std::unique_ptr<ImportProvider> provider) {
    if (!provider)
        return;
    std::lock_guard<std::mutex> lock(mutex_);
    providers_.push_back(std::move(provider));
}

std::vector<const ImportProvider*> ImportProviderRegistry::all() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<const ImportProvider*> out;
    out.reserve(providers_.size());
    for (const std::unique_ptr<ImportProvider>& p : providers_)
        out.push_back(p.get());
    return out;
}

const ImportProvider* ImportProviderRegistry::forPath(const std::string& absPath) const {
    std::string ext = fileExtension(absPath); // ".mid" -> "mid"
    if (!ext.empty() && ext[0] == '.')
        ext.erase(0, 1);
    std::lock_guard<std::mutex> lock(mutex_);
    for (const std::unique_ptr<ImportProvider>& p : providers_) {
        bool extMatch = false;
        for (const std::string& e : p->extensions())
            if (iequals(e, ext)) {
                extMatch = true;
                break;
            }
        if (!extMatch)
            continue;
        std::string whyNot;
        if (p->probe(absPath, whyNot))
            return p.get();
        Log::warn("import: provider '%s' rejected %s: %s", p->id().c_str(), absPath.c_str(),
                  whyNot.c_str());
    }
    return nullptr;
}

} // namespace mydaw
