import React from "react";
import { createRoot } from "react-dom/client";
import "./lib/theme-base.css";
import { initTheme } from "./lib/theme";
import { initMotion } from "./lib/motion";
import { initAccent } from "./lib/accent";
import { loadPref } from "./lib/prefs";
import App from "./App";

initTheme(); // index.html already stamped data-theme pre-paint; this is the fallback
initMotion(); // stamps data-motion (full/reduced/off) + follows the OS reduced-motion setting
initAccent(); // user accent override (Settings → General), re-derived per theme
// Hover magnification (§8.4) — GeneralTab restamps live on toggle.
document.documentElement.dataset.magnify = String(loadPref("ui.hoverMagnify", false));

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
