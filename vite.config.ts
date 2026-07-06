import { defineConfig } from "vite";

export default defineConfig({
  // Expose the dev server on the LAN (0.0.0.0) so other devices on the same
  // network can open it at http://<this-machine-ip>:5173 — no `--host` flag
  // needed. `strictPort` fails loudly instead of silently hopping to 5174 if
  // 5173 is already taken (which otherwise hides the "wrong URL" confusion).
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  // @dimforge/rapier3d-compat ships its WASM inlined as base64, so no special
  // WASM plugin is needed. Excluding it from dep pre-bundling avoids Vite
  // re-processing the large embedded blob on every dev-server start.
  optimizeDeps: {
    exclude: ["@dimforge/rapier3d-compat"],
  },
});
