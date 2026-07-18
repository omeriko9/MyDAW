import React from "react";
import { createRoot } from "react-dom/client";
import "./lib/theme-base.css";
import { initTheme } from "./lib/theme";
import App from "./App";

initTheme(); // index.html already stamped data-theme pre-paint; this is the fallback

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
