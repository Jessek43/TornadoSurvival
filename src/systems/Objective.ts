/**
 * The win condition, extracted into ONE seam.
 *
 * The round's survive/die outcome used to be implicit in Game's round loop
 * (survived ⇔ `tornado.state === "done"`, died ⇔ `damage.dead`). That logic now
 * lives here so the shell asks the objective — AppFlow never reads round state
 * directly — and the menu goal line and both result screens pull their prose
 * from `describe()` (no duplicated strings).
 *
 * Deliberately minimal: one interface, one implementation. NOT generic, no
 * registry, no factory, no per-level config — if this starts wanting any of
 * those, that is a signal to stop, not to grow the abstraction.
 */
export type ObjectiveVerdict = "pending" | "won" | "lost";

/** The flattened round facts an objective needs — a plain data snapshot Game
 *  builds each tick from `damage`/`tornado`, so this file stays THREE-free. */
export interface ObjectiveState {
  /** Player health has reached zero. */
  dead: boolean;
  /** Every tornado pass has completed (`tornado.state === "done"`). */
  tornadoDone: boolean;
  /** Passes this round (for result summaries; not used by the verdict). */
  passesTotal: number;
}

export interface Objective {
  /** The goal, in prose — shared by the menu goal line and result screens. */
  describe(): string;
  /** Verdict for a snapshot. Returns exactly one of pending/won/lost. */
  evaluate(state: ObjectiveState): ObjectiveVerdict;
}

/** Outlast every tornado pass without dying — the game's only objective today. */
export class SurviveAllPasses implements Objective {
  describe(): string {
    return "Survive the storm — outlast every tornado pass.";
  }

  evaluate(state: ObjectiveState): ObjectiveVerdict {
    // Death takes precedence: dying on the final pass is a loss, not a win.
    if (state.dead) return "lost";
    if (state.tornadoDone) return "won";
    return "pending";
  }
}
