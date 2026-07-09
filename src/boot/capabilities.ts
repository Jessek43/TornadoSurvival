import type { CapabilityResult } from "../systems/BootFlow";

/**
 * Pre-flight capability probe — the ONE thing that must run before the renderer
 * bundle is asked to do anything. Pure DOM: no THREE, no Rapier import, so a
 * machine that can't run WebGL2 is never asked to execute the renderer to be
 * told so. (It IS still parsed — `main.ts` statically imports `Game` — but never
 * run on the unsupported path; splitting that out would mean code-splitting the
 * bundle, deliberately out of scope this run.)
 *
 * No user-agent sniffing, ever: we feature-test the actual capability.
 */
export function checkCapabilities(): CapabilityResult {
  return { webgl2: hasWebGL2(), wasm: hasWasm() };
}

/**
 * Attempt a real `webgl2` context on a throwaway canvas and verify it is
 * non-null. Deliberately NOT `window.WebGL2RenderingContext` feature-detection —
 * that constructor exists in browsers where context creation still fails
 * (blocklisted GPU, headless, exhausted contexts), which is exactly the case we
 * must catch. The throwaway context is released immediately so it doesn't count
 * against the browser's live-context budget.
 */
function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Rapier's physics is WebAssembly; verify the instantiate entry point exists. */
function hasWasm(): boolean {
  return typeof WebAssembly?.instantiate === "function";
}

/** Human-readable list of what a failing capability result is missing — feeds
 *  the unsupported screen. Empty when everything is present. */
export function missingCapabilities(result: CapabilityResult): string[] {
  const missing: string[] = [];
  if (!result.webgl2) missing.push("WebGL2 (hardware-accelerated 3D graphics)");
  if (!result.wasm) missing.push("WebAssembly (the physics engine)");
  return missing;
}
