// MyDAW — import/Providers.cpp
// Single registration point for every foreign-project ImportProvider. Called once from
// App::init (idempotent guard so accidental re-entry is harmless).

#include <memory>

#include "import/CprImportProvider.h"
#include "import/ImportProvider.h"
#include "import/SmfImportProvider.h"

namespace mydaw {

void registerAllImportProviders() {
    static bool registered = false;
    if (registered)
        return;
    registered = true;
    ImportProviderRegistry& reg = ImportProviderRegistry::instance();

    // ------------------------------------------------------------------------
    // ADD NEW IMPORT PROVIDERS HERE (one line each) — see docs/IMPORT_PROJECT.md
    // ------------------------------------------------------------------------
    reg.add(std::make_unique<SmfImportProvider>());
    reg.add(std::make_unique<CprImportProvider>());
}

} // namespace mydaw
