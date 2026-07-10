/**
 * Boot-time flow: the state machine every first-time visitor passes through
 * BEFORE `AppFlow` (the in-game menu→playing machine) even exists.
 *
 *   checking → capabilityChecked ─┬─ ok   → loading → (all tasks) → ready
 *                                 └─ !ok  → unsupported            (terminal)
 *   any non-terminal ── errorRaised / contextLost ──→ error        (terminal)
 *
 * Deliberately pure — no THREE, no Rapier, no DOM — exactly like AlarmController
 * and AppFlow: the DOM overlays, the capability probe, the real awaits and the
 * RAF cancel all live in the wiring (`src/boot`, `main.ts`); the *legality* of
 * every transition is one testable decision a terminating script drives through
 * synthetic sequences (see scripts/verify-boot.ts).
 *
 * Design rules (all asserted in verify:boot):
 *  - `unsupported` is TERMINAL — no input escapes it.
 *  - `error` is TERMINAL and IDEMPOTENT — the 1st error transitions, the
 *    2nd..Nth are ignored. It EMITS a transition (via onChange), it is not a
 *    boolean to poll — callers latch on the edge, like the boundary warning.
 *  - `error` is reachable from EVERY non-terminal state (checking/loading/ready).
 *  - progress is completedTasks/declaredTasks, MONOTONIC, never decreasing.
 *  - `ready` is emitted ONLY when every declared task has reported — there is no
 *    path to `ready` at partial progress.
 *
 * BootFlow does not know what a "task" is: the id list is passed at construction
 * and it only counts distinct completions against it.
 */
export type BootState = "checking" | "unsupported" | "loading" | "ready" | "error";

/** Why we entered `error` — lets the overlay show a graphics-context-loss
 *  message distinct from a generic exception (a lost context is a DOM event,
 *  not a thrown error, and must read differently to the player). */
export type BootErrorKind = "error" | "contextLost";

/** Result of the pre-flight capability probe (WebGL2 + WebAssembly + a
 *  desktop-class pointer). Each field is a distinct capability; the WHY behind a
 *  failure (which reason screen to show) is derived from this struct in the
 *  wiring, not stored as a BootFlow state — a reason is data, not a state. */
export interface CapabilityResult {
  webgl2: boolean;
  wasm: boolean;
  /** Pointer Lock + a fine pointer both present — i.e. the game is genuinely
   *  playable (mouse look + real cursor). Absent on a touch-only phone. */
  pointerlock: boolean;
}

/** One emitted transition. `errorKind` is set only when `to === "error"`. */
export interface BootTransition {
  from: BootState;
  to: BootState;
  errorKind?: BootErrorKind;
}

/** The non-terminal states — `error` must be reachable from each of these. */
export const NON_TERMINAL_STATES: readonly BootState[] = ["checking", "loading", "ready"];

export class BootFlow {
  private current: BootState = "checking";
  private readonly declared: readonly string[];
  private readonly completed = new Set<string>();
  /** Total transitions performed (== onChange invocations); ignored inputs excluded. */
  transitions = 0;

  /**
   * @param taskIds  the declared awaited units; `ready` is emitted once every id
   *                 in this list has been reported to `taskCompleted`.
   * @param onChange fired once per real transition (never for an ignored input).
   */
  constructor(
    taskIds: readonly string[],
    private readonly onChange?: (t: BootTransition) => void,
  ) {
    // Copy so a caller can't mutate the declared set out from under progress.
    this.declared = [...taskIds];
  }

  get state(): BootState {
    return this.current;
  }

  /** completedTasks / declaredTasks, clamped to [0,1]. Monotonic: `completed` is
   *  a Set of distinct ids, so a duplicate or unknown id never moves it. */
  get progress(): number {
    if (this.declared.length === 0) return 1;
    return this.completed.size / this.declared.length;
  }

  /** A terminal state accepts no further input. */
  private get terminal(): boolean {
    return this.current === "unsupported" || this.current === "error";
  }

  private emit(to: BootState, errorKind?: BootErrorKind): void {
    const from = this.current;
    this.current = to;
    this.transitions++;
    this.onChange?.(errorKind ? { from, to, errorKind } : { from, to });
  }

  /**
   * Pre-flight result. Legal only from `checking`: all capabilities present →
   * `loading` (or straight to `ready` if the task list is empty); anything
   * missing → `unsupported` (terminal). Ignored in any other state.
   */
  capabilityChecked(result: CapabilityResult): void {
    if (this.current !== "checking") return;
    if (result.webgl2 && result.wasm && result.pointerlock) {
      this.emit("loading");
      // A degenerate empty task list is already "done" — resolve immediately so
      // the machine never wedges in `loading`.
      if (this.completed.size >= this.declared.length) this.emit("ready");
    } else {
      this.emit("unsupported");
    }
  }

  /**
   * A declared awaited unit resolved. Only meaningful in `loading`; an unknown id
   * or a duplicate is ignored (keeps progress monotonic). `ready` is emitted the
   * moment — and only the moment — every declared id has reported.
   */
  taskCompleted(id: string): void {
    if (this.current !== "loading") return;
    if (!this.declared.includes(id) || this.completed.has(id)) return;
    this.completed.add(id);
    if (this.completed.size >= this.declared.length) this.emit("ready");
  }

  /**
   * A thrown/rejected error reached the boot latch. Transitions to `error` from
   * any non-terminal state; ignored once terminal (idempotent — the 2nd..Nth
   * error after the first are swallowed here, not by the callback).
   */
  errorRaised(kind: BootErrorKind = "error"): void {
    if (this.terminal) return;
    this.emit("error", kind);
  }

  /** WebGL context loss — a distinct input, transitions to `error` with the
   *  `contextLost` kind so the overlay message differs from a generic error. */
  contextLost(): void {
    this.errorRaised("contextLost");
  }
}
