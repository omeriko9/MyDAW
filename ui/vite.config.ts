import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies REST + WebSocket traffic to the engine (SPEC §1: engine HTTP+WS on 8417).
// In production the engine serves ui/dist itself, so no proxy is involved.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8417",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:8417",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
