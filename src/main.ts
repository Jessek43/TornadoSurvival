import RAPIER from "@dimforge/rapier3d-compat";
import { inject } from "@vercel/analytics";
import { Game } from "./Game";
import { BootFlow, type BootTransition, type CapabilityResult } from "./systems/BootFlow";
import { checkCapabilities, missingCapabilities } from "./boot/capabilities";
import { BootOverlay } from "./ui/BootOverlay";
import { isDebugEnabled } from "./debug/debugFlag";

/**
 * Bootstrap. Runs the pure BootFlow ONCE, before the game's own AppFlow exists:
 * capability gate → loading gate (driven by the real awaited work) → hand off to
 * the existing menu, with a one-latch error overlay over the whole thing.
 * Rapier's physics is WebAssembly and must finish loading before any physics
 * object can exist — hence the async entry point.
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
  const showStack = isDebugEnabled(location.search);

  // Mutable boot context the transition handler reads. Declared up front so the
  // closure captures them before any input drives the flow.
  let cap: CapabilityResult = { webgl2: false, wasm: false };
  let lastError: unknown = null;
  let rafHandle = 0;

  // Side effects of each boot transition. BootFlow decides WHEN; this decides
  // WHAT shows. The `error` edge fires at most once (BootFlow is idempotent), so
  // the overlay appears once and the loop is cancelled once.
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
      case "error":
        // Stop the render loop FIRST: a loop that keeps running re-throws every
        // frame and buries the real trace under thousands of copies. Safe before
        // the loop exists — cancelAnimationFrame(0) is a no-op.
        cancelAnimationFrame(rafHandle);
        if (t.errorKind === "contextLost") {
          overlay.showContextLost();
        } else if (showStack) {
          const { message, stack } = describeError(lastError);
          overlay.showError(message, stack);
        } else {
          overlay.showError("The game hit an unexpected error. Reload to try again.", null);
        }
        break;
      case "checking":
        break; // initial state, never entered via a transition
    }
  };

  const flow = new BootFlow(BOOT_TASKS, onBootTransition);

  // Global error latch — installed BEFORE anything can throw (capability probe,
  // Rapier init, world build, the loop) so the very first error, wherever it
  // originates, shows the overlay and stops the loop. Always console.error the
  // original unconditionally: the overlay must never be the only record.
  window.addEventListener("error", (e) => {
    lastError = e.error ?? e.message;
    console.error(lastError);
    flow.errorRaised("error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    lastError = e.reason;
    console.error(lastError);
    flow.errorRaised("error");
  });

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

  // WebGL context loss is a DOM event on the canvas, NOT an exception — it never
  // reaches window.onerror, so it gets its own input and its own message.
  game.canvas.addEventListener("webglcontextlost", () => flow.contextLost());

  window.addEventListener("resize", () =>
    game.onResize(window.innerWidth, window.innerHeight),
  );

  // Dev-only forcing flags for confirming the fallback paths in-browser. They
  // inject at BootFlow's inputs (a thrown error / a dispatched context-loss),
  // adding no branch inside the loop or the renderer.
  if (params.has("forceError")) {
    // Uncaught in a timer → window "error" → the latch above, one second post-ready.
    setTimeout(() => {
      throw new Error("forced boot error (?forceError)");
    }, 1000);
  }
  if (params.has("forceContextLost")) {
    game.canvas.dispatchEvent(new Event("webglcontextlost"));
  }

  let last = performance.now();
  const frame = (now: number): void => {
    // Clamp dt so a backgrounded tab or debugger pause doesn't feed the
    // game a huge time step when it resumes.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    game.update(dt);
    rafHandle = requestAnimationFrame(frame);
  };
  rafHandle = requestAnimationFrame(frame);
}

/** Normalize an unknown thrown value into a message + optional stack. */
function describeError(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: err.message || "Unexpected error", stack: err.stack ?? null };
  }
  return { message: String(err ?? "Unexpected error"), stack: null };
}

void boot();
