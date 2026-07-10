import type { CapabilityResult } from "../systems/BootFlow";

/**
 * Pre-flight capability probe — the ONE thing that must run before the renderer
 * bundle is asked to do anything. Pure DOM: no THREE, no Rapier import, so a
 * machine that can't run WebGL2 is never asked to execute the renderer to be
 * told so. (It IS still parsed — `main.ts` statically imports `Game` — but never
 * run on the unsupported path; splitting that out would mean code-splitting the
 * bundle, deliberately out of scope this run.)
 *
 * No user-agent sniffing, ever, and no touch-capability signal: we feature-test
 * the actual capabilities the game needs. The pointer gate keys on Pointer Lock
 * (needed for mouse look) + a fine pointer — deliberately NOT "is this a phone",
 * so an iPad with a trackpad (playable) is allowed and a touchscreen laptop
 * (also has a fine pointer) is allowed, while a touch-only phone is blocked.
 */

/** The raw feature reads, split out so the DECISION is a pure function a
 *  terminating script can drive with every input combination (no DOM). */
export interface CapabilityInputs {
  hasWebGL2: boolean;
  hasWasm: boolean;
  hasPointerLock: boolean;
  hasFinePointer: boolean;
}

/** The single primary reason the browser can't run the game, or `null` when it
 *  can. Priority order (most fundamental first) picks ONE reason when several
 *  are missing, so the screen names the one that matters most. */
export type CapabilityReason = "webgl2" | "wasm" | "pointerlock";

export function checkCapabilities(): CapabilityResult {
  return evaluateCapabilities({
    hasWebGL2: hasWebGL2(),
    hasWasm: hasWasm(),
    hasPointerLock: hasPointerLock(),
    hasFinePointer: hasFinePointer(),
  });
}

/** Pure DOM-free decision from the raw reads. `pointerlock` collapses the two
 *  pointer sub-checks into one capability: both must be present to be playable. */
export function evaluateCapabilities(i: CapabilityInputs): CapabilityResult {
  return {
    webgl2: i.hasWebGL2,
    wasm: i.hasWasm,
    pointerlock: i.hasPointerLock && i.hasFinePointer,
  };
}

/** The one reason to show on the unsupported screen, or `null` when supported.
 *  Pure — the wiring and the overlay both key off this, never off the raw struct. */
export function capabilityReason(result: CapabilityResult): CapabilityReason | null {
  if (!result.webgl2) return "webgl2";
  if (!result.wasm) return "wasm";
  if (!result.pointerlock) return "pointerlock";
  return null;
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

/** Pointer Lock — the API first-person mouse look is built on. iOS Safari has
 *  never shipped it, so its absence cleanly marks a browser the game can't drive. */
function hasPointerLock(): boolean {
  return "requestPointerLock" in Element.prototype;
}

/** A fine (mouse/trackpad-class) pointer. Reads the CSS `(pointer: fine)` media
 *  query — a capability signal, never a device-class one. iOS Safari reports
 *  coarse only; a touchscreen laptop that ALSO has a mouse reports fine. */
function hasFinePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
}
