// MyDAW agent bounded read/query primitive.
//
// All reads happen against App's authoritative main-thread state. The function never
// mutates the project and returns a uniform, paginated envelope:
//   {view, revision, items, total, nextCursor}

#pragma once

#include <string>

#include "util/Json.h"

namespace mydaw {

class App;

json runAgentQuery(App& app, const json& payload, std::string& errCode,
                   std::string& errMsg);

} // namespace mydaw

