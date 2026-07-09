/**
 * Application-level flow: the state machine that wraps the in-round `Game`.
 *
 *   menu → (start) → playing → survived | died → (restart) → playing
 *                                              → (toMenu)   → menu
 *
 * Deliberately pure — no THREE, no Rapier, no DOM — exactly like
 * AlarmController: the shell's screen/tick side-effects are decided elsewhere
 * (Game subscribes to `onChange`), so the *legality* of every transition is one
 * testable decision a terminating script can drive through a synthetic
 * sequence (see scripts/verify-flow.ts). Illegal transitions THROW (a programmer
 * error the shell must never emit) rather than silently no-op, so a mis-wired
 * screen button surfaces loudly. `edgeCounts`/`transitions` back both that
 * assertion and the ?debug readout.
 */
export type AppState = "menu" | "playing" | "survived" | "died";

/** Events the shell emits. `playAgain`/`retry` both re-enter `playing` (from
 *  survived / died respectively); `toMenu` returns from either terminal. */
export type AppEvent = "start" | "win" | "lose" | "playAgain" | "retry" | "toMenu";

export class AppFlow {
  private current: AppState = "menu";
  /** Per-edge fire counts, keyed "from->to": edge-trigger proof + debug readout. */
  readonly edgeCounts: Record<string, number> = {};
  /** Total transitions performed (== onChange invocations, illegal attempts excluded). */
  transitions = 0;

  constructor(private readonly onChange?: (from: AppState, to: AppState) => void) {}

  get state(): AppState {
    return this.current;
  }

  /**
   * Apply an event. A legal edge moves state and fires `onChange` exactly once;
   * an event illegal for the current state THROWS without touching any counter.
   */
  transition(event: AppEvent): AppState {
    const from = this.current;
    const to = this.next(from, event);
    if (to === null) {
      throw new Error(`AppFlow: illegal transition ${from} --${event}-->`);
    }
    this.current = to;
    const key = `${from}->${to}`;
    this.edgeCounts[key] = (this.edgeCounts[key] ?? 0) + 1;
    this.transitions++;
    this.onChange?.(from, to);
    return to;
  }

  /**
   * The legal target for (state, event), or null if the event is illegal here.
   * Exhaustive over AppState — the `never` binding in the default proves every
   * state is handled at compile time (also caught by noFallthroughCasesInSwitch).
   */
  private next(state: AppState, event: AppEvent): AppState | null {
    switch (state) {
      case "menu":
        return event === "start" ? "playing" : null;
      case "playing":
        return event === "win" ? "survived" : event === "lose" ? "died" : null;
      case "survived":
        return event === "playAgain" ? "playing" : event === "toMenu" ? "menu" : null;
      case "died":
        return event === "retry" ? "playing" : event === "toMenu" ? "menu" : null;
      default: {
        // Unreachable: the union above is exhaustive. If a new AppState is added
        // without a case, `state` is no longer `never` and this fails to compile.
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  }
}
