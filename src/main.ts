import RAPIER from "@dimforge/rapier3d-compat";
import { inject } from "@vercel/analytics";
import { Game } from "./Game";
import { BootFlow, type BootTransition, type CapabilityResult } from "./systems/BootFlow";
import { checkCapabilities, missingCapabilities } from "./boot/capabilities";
import { BootOverlay } from "./ui/BootOverlay";

/**
 * Bootstrap. Runs the pure BootFlow ONCE, before the game's own AppFlow exists:
 * capability gate → loading gate (driven by the real awaited work) → hand off to
 * the existing menu. Rapier's physics is WebAssembly and must finish loading
 * before any physics object can exist — hence the async entry point.
 *
 * The two declared tasks are the only real awaited/completed units before the
 * first frame: Rapier's WASM init (a promise) and the synchronous world build
 * inside `new Game()` (one task that reports on completion — its progress is not
 * faked into sub-steps).
 */
const BOOT_TASKS = ["rapier", "world"] as const;

async function boot(): Promise<void> {
  // Vercel Web Analytics — framework-agnostic injector for this Vite SPA.
  // Only phones home on the deployed site; a no-op in local dev.
  inject();

  const params = new URLSearchParams(location.search);
  const overlay = new BootOverlay();

  // The capability probe result — captured here so the transition handler can
  // name what's missing on the unsupported screen.
  let cap: CapabilityResult = { webgl2: false, wasm: false };

  // Side effects of each boot transition. BootFlow decides WHEN; this decides
  // WHAT shows. (The `error` case is wired in the error-overlay commit.)
  const onBootTransition = (t: BootTransition): void => {
    switch (t.to) {
      case "loading":
        overlay.showLoading();
        break;
      case "unsupported":
        overlay.showUnsupported(missingCapabilities(cap));
        break;
      case "ready":
        overlay.remove(); // menu is already up (Game's constructor showed it)
        break;
    }
  };

  const flow = new BootFlow(BOOT_TASKS, onBootTransition);

  // (1) Capability gate. The forcing flags inject at BootFlow's INPUT — they
  // override the probe RESULT, never add a branch inside checkCapabilities.
  cap = checkCapabilities();
  const forced = params.get("forceUnsupported");
  if (forced === "webgl") cap.webgl2 = false;
  if (forced === "wasm") cap.wasm = false;
  flow.capabilityChecked(cap);
  if (flow.state === "unsupported") return; // terminal — the game never starts

  // (2) Loading gate. Each declared task reports on its REAL resolution; the bar
  // advances only as promises resolve, and only reaches 100% at the menu.
  await RAPIER.init();
  flow.taskCompleted("rapier");
  overlay.setProgress(flow.progress);

  const app = document.getElementById("app")!;
  const ui = document.getElementById("ui")!;
  const game = new Game(app, ui); // synchronous world build == the "world" task
  flow.taskCompleted("world");
  overlay.setProgress(flow.progress); // → ready → overlay removed, menu handoff

  window.addEventListener("resize", () =>
    game.onResize(window.innerWidth, window.innerHeight),
  );

  let last = performance.now();
  const frame = (now: number): void => {
    // Clamp dt so a backgrounded tab or debugger pause doesn't feed the
    // game a huge time step when it resumes.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    game.update(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
