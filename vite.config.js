import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Crash-log stack readability (B5 research, 2026-07-06):
  // - 'hidden' sourcemaps: .map files are generated but NOT referenced from
  //   the bundle. build:release moves them out of dist/ (never shipped) into
  //   release-sourcemaps/<version>/ for offline symbolication of pasted
  //   crash stacks.
  // - minifyIdentifiers:false keeps real function names in raw stack frames
  //   (positions still need the map, but frames are human-scannable).
  build: {
    sourcemap: "hidden",
  },
  esbuild: {
    minifyIdentifiers: false,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
