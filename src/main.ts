import RAPIER from "@dimforge/rapier3d-compat";
import { inject } from "@vercel/analytics";
import { Game } from "./Game";
import { BootFlow, type BootTransition, type CapabilityResult } from "./systems/BootFlow";
import { checkCapabilities, capabilityReason } from "./boot/capabilities";
import { routeBootTransition } from "./boot/bootRoute";
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
  // closure captures them before any input drives the flow. `game` is a `let` so
  // the (permanently registered) transition handler can halt it on a fatal error
  // — the handler outlives the handoff to the menu and keeps rendering boot
  // screens for the process lifetime.
  let cap: CapabilityResult = { webgl2: false, wasm: false, pointerlock: false };
  let lastError: unknown = null;
  let rafHandle = 0;
  let game: Game | null = null;

  // Side effects of each boot transition. BootFlow decides WHEN, the pure router
  // decides WHAT (screen + whether it's fatal), and this applies it. The handler
  // stays subscribed for the whole process, so a fatal transition AFTER `ready`
  // (a mid-round exception, a lost context) is still rendered.
  const onBootTransition = (t: BootTransition): void => {
    const action = routeBootTransition(t);
    // A fatal transition stops the game: cancel the RAF loop (this owns the
    // handle) FIRST — a loop that keeps running re-throws every frame and buries
    // the real trace — then halt what the loop can't (audio lives outside it).
    // Safe before the loop/game exist: cancelAnimationFrame(0) and `game?` no-op.
    if (action.fatal) {
      cancelAnimationFrame(rafHandle);
      game?.halt();
    }
    switch (action.screen) {
      case "loading":
        overlay.showLoading();
        break;
      case "unsupported":
        // capabilityReason is non-null here by construction: the unsupported
        // transition only fires when some capability is missing.
        overlay.showUnsupported(capabilityReason(cap) ?? "webgl2");
        break;
      case "ready":
        overlay.remove(); // menu is already up (Game's constructor showed it)
        break;
      case "error":
        if (showStack) {
          const { message, stack } = describeError(lastError);
          overlay.showError(message, stack);
        } else {
          overlay.showError("The game hit an unexpected error. Reload to try again.", null);
        }
        break;
      case "contextLost":
        overlay.showContextLost();
        break;
      case "none":
        break;
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
  // ?forceDesktop bypasses the pointer-lock gate ONLY (never WebGL2/WASM) so the
  // game can be loaded on a touch device for testing; it injects at the input,
  // like the forcing flags below, adding no branch inside the probe.
  if (params.has("forceDesktop")) cap.pointerlock = true;
  const forced = params.get("forceUnsupported");
  if (forced === "webgl") cap.webgl2 = false;
  if (forced === "wasm") cap.wasm = false;
  if (forced === "pointerlock") cap.pointerlock = false;
  flow.capabilityChecked(cap);
  if (flow.state === "unsupported") return; // terminal — the game never starts

  // (2) Loading gate. Each declared task reports on its REAL resolution; the bar
  // advances only as promises resolve, and only reaches 100% at the menu.
  await RAPIER.init();
  flow.taskCompleted("rapier");
  overlay.setProgress(flow.progress);

  const app = document.getElementById("app")!;
  const ui = document.getElementById("ui")!;
  game = new Game(app, ui); // synchronous world build == the "world" task
  // A non-null binding for the closures below (the outer `let game` stays for
  // the transition handler's null-guarded `game?.halt()`).
  const g = game;
  flow.taskCompleted("world");
  overlay.setProgress(flow.progress); // → ready → overlay removed, menu handoff

  // WebGL context loss is a DOM event on the canvas, NOT an exception — it never
  // reaches window.onerror, so it gets its own input and its own message.
  g.canvas.addEventListener("webglcontextlost", () => flow.contextLost());

  window.addEventListener("resize", () => g.onResize(window.innerWidth, window.innerHeight));

  let last = performance.now();
  const frame = (now: number): void => {
    // Clamp dt so a backgrounded tab or debugger pause doesn't feed the
    // game a huge time step when it resumes.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    g.update(dt);
    rafHandle = requestAnimationFrame(frame);
  };
  rafHandle = requestAnimationFrame(frame);

  // Dev-only forcing flags for confirming the fallback paths in-browser. They
  // inject at BootFlow's inputs, adding no branch inside the loop or renderer.
  // Both fire ~1 s AFTER the loop is running (registered below the rAF start) so
  // they exercise the real, loop-running path — the RAF cancel in the transition
  // handler has a live frame to cancel, exactly as a genuine error/loss would.
  if (params.has("forceError")) {
    // Uncaught in a timer → window "error" → the latch above.
    setTimeout(() => {
      throw new Error("forced boot error (?forceError)");
    }, 1000);
  }
  if (params.has("forceContextLost")) {
    setTimeout(() => g.canvas.dispatchEvent(new Event("webglcontextlost")), 1000);
  }
}

/** Normalize an unknown thrown value into a message + optional stack. */
function describeError(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: err.message || "Unexpected error", stack: err.stack ?? null };
  }
  return { message: String(err ?? "Unexpected error"), stack: null };
}

void boot();
