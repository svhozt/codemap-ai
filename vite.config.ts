import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));

// Builds the impact visualization (src/web/app) into web-dist/, which the CLI serves.
export default defineConfig({
  plugins: [react()],
  root: resolve(root, "src/web/app"),
  base: "./",
  build: {
    outDir: resolve(root, "web-dist"),
    emptyOutDir: true,
    // React Flow + dagre are one ~520 KB chunk; it is served from localhost, so that is fine.
    chunkSizeWarningLimit: 800,
  },
  resolve: {
    alias: {
      "@": resolve(root, "src/web/app"),
    },
  },
});
