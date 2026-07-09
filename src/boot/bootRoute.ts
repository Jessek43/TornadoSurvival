import type { BootTransition } from "../systems/BootFlow";

/**
 * The pure mapping from a BootFlow transition to what the DOM/loop consumer must
 * do. Extracted as its own THREE-free / DOM-free seam so the BootFlow↔consumer
 * CONTRACT is testable (verify:boot) — the earlier bug wasn't in BootFlow (it
 * emitted the post-`ready` error transition correctly), it was that the consumer
 * dropped it on the floor. With the decision isolated here, the DOM layer in
 * main.ts is a thin apply step, and the routing is asserted statically.
 */
export type BootScreen = "loading" | "unsupported" | "ready" | "error" | "contextLost" | "none";

export interface BootAction {
  /** Which overlay screen to show. `"ready"` == remove the overlay (menu handoff). */
  screen: BootScreen;
  /** Whether this transition must STOP the game — cancel the RAF loop AND halt
   *  audio. True only for the fatal `error` / `contextLost` transitions. */
  fatal: boolean;
}

export function routeBootTransition(t: BootTransition): BootAction {
  switch (t.to) {
    case "loading":
      return { screen: "loading", fatal: false };
    case "unsupported":
      return { screen: "unsupported", fatal: false };
    case "ready":
      return { screen: "ready", fatal: false };
    case "error":
      // A lost graphics context reads differently to the player than a generic
      // exception; both are fatal (the loop cannot continue).
      return { screen: t.errorKind === "contextLost" ? "contextLost" : "error", fatal: true };
    case "checking":
      // Never emitted as a `to` (it's the initial state), but the union demands it.
      return { screen: "none", fatal: false };
  }
}
