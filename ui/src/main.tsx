import React from "react";
import { createRoot } from "react-dom/client";
import "./lib/theme-base.css";
import { initTheme } from "./lib/theme";
import { initMotion } from "./lib/motion";
import { initAccent } from "./lib/accent";
import { loadPref } from "./lib/prefs";

initTheme(); // index.html already stamped data-theme pre-paint; this is the fallback
initMotion(); // stamps data-motion (full/reduced/off) + follows the OS reduced-motion setting
initAccent(); // user accent override (Settings → General), re-derived per theme
// Hover magnification (§8.4) — GeneralTab restamps live on toggle.
document.documentElement.dataset.magnify = String(loadPref("ui.hoverMagnify", false));

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

// Standalone sub-pages served from the same origin (?page=...): the Plugin Manager
// opens in its own browser tab from the Browser's Plugins tab. Both entries are
// LAZY imports — this is load-bearing, not an optimization: src/store/store.ts runs
// module-level engine wiring on import (session/hello, midi/setThruTracks [], event
// subscriptions), and a sub-page that pulled it in would act like a DAW client and
// clear the live session's MIDI-thru routing the moment the tab opened.
const page = new URLSearchParams(window.location.search).get("page");
if (page === "plugins") document.title = "MyDAW — Plugin Manager";
const App = React.lazy(() => import("./App"));
const PluginManagerPage = React.lazy(() => import("./components/PluginManager/PluginManagerPage"));

createRoot(rootEl).render(
  <React.StrictMode>
    <React.Suspense fallback={null}>
      {page === "plugins" ? <PluginManagerPage /> : <App />}
    </React.Suspense>
  </React.StrictMode>,
);
