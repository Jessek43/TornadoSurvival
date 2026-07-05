import { defineConfig } from "vite";

export default defineConfig({
  // @dimforge/rapier3d-compat ships its WASM inlined as base64, so no special
  // WASM plugin is needed. Excluding it from dep pre-bundling avoids Vite
  // re-processing the large embedded blob on every dev-server start.
  optimizeDeps: {
    exclude: ["@dimforge/rapier3d-compat"],
  },
});
