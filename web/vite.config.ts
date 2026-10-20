import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import powersyncDevtools from "@powersync/diagnostics/vite";

export default defineConfig(({ mode }) => ({
  devtools: mode === "test" ? false : { apply: "serve" },
  plugins: [
    react(),
    wasm(),
    ...(mode === "test" ? [] : [powersyncDevtools()]),
  ],
  // Vite 8 uses Rolldown. Modern browsers support the SDK's top-level await
  // natively, so no Rollup/esbuild compatibility plugin is needed.
  build: { target: "esnext" },
  optimizeDeps: {
    exclude: ["@journeyapps/wa-sqlite", "@powersync/web"],
  },
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
}));
