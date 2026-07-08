import RAPIER from "@dimforge/rapier3d-compat";
import { inject } from "@vercel/analytics";
import { Game } from "./Game";

/**
 * Bootstrap. Rapier's physics engine is WebAssembly and must finish
 * loading before any physics object can exist — hence the async entry
 * point.
 */
async function boot(): Promise<void> {
  // Vercel Web Analytics — framework-agnostic injector for this Vite SPA.
  // Only phones home on the deployed site; a no-op in local dev.
  inject();

  // Rapier 0.19 logs a deprecation asking for an options object here, but
  // its own type definitions still declare zero parameters — harmless.
  await RAPIER.init();

  const app = document.getElementById("app")!;
  const ui = document.getElementById("ui")!;
  const game = new Game(app, ui);

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
