// Static verification of the boot-time flow — the BootFlow state machine that
// runs BEFORE AppFlow exists (capability gate → loading gate → error latch).
// Terminates on its own (no dev server, no game/physics/render loop).
// Run with: npm run verify:boot   (or: npx tsx scripts/verify-boot.ts)
//
// Every assertion prints a concrete count, per the repo's verification norm.
import {
  BootFlow,
  NON_TERMINAL_STATES,
  type BootState,
  type BootTransition,
} from "../src/systems/BootFlow";
import { routeBootTransition, type BootAction } from "../src/boot/bootRoute";
import {
  evaluateCapabilities,
  capabilityReason,
  type CapabilityInputs,
  type CapabilityReason,
} from "../src/boot/capabilities";
import { isDebugEnabled } from "../src/debug/debugFlag";
import { readFileSync } from "fs";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

const ALL_STATES: BootState[] = ["checking", "unsupported", "loading", "ready", "error"];
const OK_CAP = { webgl2: true, wasm: true, pointerlock: true };
const TWO_TASKS = ["rapier", "world"] as const;

/** Build a fresh BootFlow already driven into `target`, recording transitions. */
function inState(target: BootState): { flow: BootFlow; log: BootTransition[] } {
  const log: BootTransition[] = [];
  const flow = new BootFlow(TWO_TASKS, (t) => log.push(t));
  switch (target) {
    case "checking":
      break;
    case "unsupported":
      flow.capabilityChecked({ webgl2: false, wasm: true, pointerlock: true });
      break;
    case "loading":
      flow.capabilityChecked(OK_CAP);
      break;
    case "ready":
      flow.capabilityChecked(OK_CAP);
      for (const id of TWO_TASKS) flow.taskCompleted(id);
      break;
    case "error":
      flow.errorRaised("error");
      break;
  }
  if (flow.state !== target) throw new Error(`setup: wanted ${target}, got ${flow.state}`);
  return { flow, log };
}

// --- 1. transition table: every (state,input) resolves to one target or ignore -
console.log("--- transition table ---");
type InputKind = "capability" | "task" | "error" | "contextLost";
const INPUTS: InputKind[] = ["capability", "task", "error", "contextLost"];
function apply(flow: BootFlow, input: InputKind): void {
  switch (input) {
    case "capability":
      flow.capabilityChecked(OK_CAP);
      break;
    case "task":
      flow.taskCompleted(TWO_TASKS[0]);
      break;
    case "error":
      flow.errorRaised("error");
      break;
    case "contextLost":
      flow.contextLost();
      break;
  }
}
let covered = 0;
const totalPairs = ALL_STATES.length * INPUTS.length;
for (const st of ALL_STATES) {
  for (const inp of INPUTS) {
    const { flow } = inState(st);
    const before = flow.state;
    let threw = false;
    try {
      apply(flow, inp);
    } catch {
      threw = true;
    }
    const after = flow.state;
    // "resolves to exactly one target or an explicit ignore": deterministic, no
    // throw, and the result is a valid state (either `before` = ignore, or a move).
    if (!threw && ALL_STATES.includes(after)) covered++;
    else check(false, `(${before}, ${inp}) undefined — threw=${threw}, after=${after}`);
  }
}
check(covered === totalPairs, `transitions covered: ${covered}/${totalPairs}`);

// --- 2. unsupported is terminal ---------------------------------------------
console.log("\n--- unsupported terminal ---");
let escapes = 0;
for (const inp of INPUTS) {
  const { flow } = inState("unsupported");
  apply(flow, inp);
  if (flow.state !== "unsupported") escapes++;
}
check(escapes === 0, `escapes from unsupported: ${escapes}`);

// --- 3. error is terminal and idempotent ------------------------------------
console.log("\n--- error idempotent ---");
{
  let errorTransitions = 0;
  const flow = new BootFlow(TWO_TASKS, (t) => {
    if (t.to === "error") errorTransitions++;
  });
  flow.capabilityChecked(OK_CAP); // → loading
  for (let i = 0; i < 50; i++) flow.errorRaised("error");
  check(errorTransitions === 1, `error transitions: ${errorTransitions} (expected 1)`);
}

// --- 4. error reachable from every non-terminal state -----------------------
console.log("\n--- error reachability ---");
{
  let reachable = 0;
  for (const st of NON_TERMINAL_STATES) {
    const { flow } = inState(st);
    flow.errorRaised("error");
    if (flow.state === "error") reachable++;
  }
  check(
    reachable === NON_TERMINAL_STATES.length,
    `error reachable from: ${reachable}/${NON_TERMINAL_STATES.length} non-terminal states`,
  );
}

// --- 5. progress monotonic across random completion orders ------------------
console.log("\n--- progress monotonic ---");
{
  const tasks = ["a", "b", "c", "d", "e", "f"];
  function shuffle<T>(a: T[]): T[] {
    const r = [...a];
    for (let i = r.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
  }
  let monotonic = 0;
  const PERMS = 100;
  for (let p = 0; p < PERMS; p++) {
    const flow = new BootFlow(tasks);
    flow.capabilityChecked(OK_CAP);
    let prev = flow.progress;
    let ok = true;
    for (const id of shuffle(tasks)) {
      flow.taskCompleted(id);
      if (flow.progress < prev) ok = false;
      prev = flow.progress;
    }
    if (ok && flow.progress === 1) monotonic++;
  }
  check(monotonic === PERMS, `monotonic permutations: ${monotonic}/${PERMS}`);
}

// --- 6. no early ready: no proper subset of tasks emits ready ---------------
console.log("\n--- no premature ready ---");
{
  const tasks = ["a", "b", "c", "d", "e", "f"];
  const SAMPLES = 100;
  let premature = 0;
  for (let s = 0; s < SAMPLES; s++) {
    // A random PROPER subset (drop at least one task).
    const drop = Math.floor(Math.random() * tasks.length); // index guaranteed omitted
    const subset = tasks.filter((_, i) => i !== drop && Math.random() < 0.7);
    let sawReady = false;
    const flow = new BootFlow(tasks, (t) => {
      if (t.to === "ready") sawReady = true;
    });
    flow.capabilityChecked(OK_CAP);
    for (const id of subset) flow.taskCompleted(id);
    if (sawReady) premature++; // a proper subset must NEVER reach ready
  }
  check(premature === 0, `premature ready: ${premature}/${SAMPLES}`);
}

// --- 7. ready fires exactly once on the full task set -----------------------
console.log("\n--- ready fires once ---");
{
  let readyCount = 0;
  const flow = new BootFlow(TWO_TASKS, (t) => {
    if (t.to === "ready") readyCount++;
  });
  flow.capabilityChecked(OK_CAP);
  flow.taskCompleted("rapier");
  flow.taskCompleted("world");
  // Extra completions after ready must not re-emit (machine is out of `loading`).
  flow.taskCompleted("world");
  flow.taskCompleted("rapier");
  check(readyCount === 1, `ready transitions: ${readyCount} (expected 1)`);
}

// --- 8. context loss is distinct from a generic error -----------------------
console.log("\n--- context loss distinct ---");
{
  const { flow, log } = inState("ready");
  flow.contextLost();
  const last = log[log.length - 1];
  const distinct = last.to === "error" && last.errorKind === "contextLost";
  // And a generic error carries a DIFFERENT kind, so the overlay can branch.
  const { flow: f2, log: l2 } = inState("ready");
  f2.errorRaised("error");
  const generic = l2[l2.length - 1].errorKind === "error";
  check(distinct && generic, `contextLost distinct: ${distinct && generic ? "yes" : "no"}`);
}

// --- 9. janitorial: debug widgets are gated behind ?debug -------------------
console.log("\n--- debug gating ---");
{
  // Game builds DebugTools only when isDebugEnabled(location.search) is true, so
  // with no ?debug the constructor is not invoked — count the widgets it would
  // build for a query string that lacks the flag.
  const widgetsWithoutDebug = isDebugEnabled("") || isDebugEnabled("?bare") ? 1 : 0;
  check(!isDebugEnabled("?bare"), `?bare alone does NOT enable debug`);
  check(isDebugEnabled("?debug"), `?debug enables debug`);
  check(isDebugEnabled("?debug&bare"), `?debug&bare enables debug`);
  check(widgetsWithoutDebug === 0, `debug widgets constructed without ?debug: ${widgetsWithoutDebug}`);
}

// --- 10. consumer contract: post-ready transitions are routed to the DOM -----
// These test the seam BETWEEN BootFlow and its consumer (the pure router
// main.ts applies), not BootFlow alone — the earlier bug was that a post-`ready`
// error transition WAS emitted but the consumer dropped it. Drive the flow to
// `ready`, then raise the fault, and assert the router produces the right action.
console.log("\n--- consumer routing contract (post-ready) ---");

/** A flow driven to `ready`, capturing ONLY the transitions routed after ready. */
function readyRouted(): { flow: BootFlow; routed: BootAction[] } {
  const routed: BootAction[] = [];
  const flow = new BootFlow(TWO_TASKS, (t) => routed.push(routeBootTransition(t)));
  flow.capabilityChecked(OK_CAP);
  for (const id of TWO_TASKS) flow.taskCompleted(id);
  routed.length = 0; // discard loading/ready — keep only what fires POST-ready
  return { flow, routed };
}

{
  const { flow, routed } = readyRouted();
  flow.errorRaised("error");
  const ok = routed.length === 1 && routed[0].screen === "error";
  check(ok, `post-ready error routed: ${ok ? "1/1" : "0/1"}`);
}
{
  const { flow, routed } = readyRouted();
  flow.contextLost();
  const ok = routed.length === 1 && routed[0].screen === "contextLost";
  check(ok, `post-ready contextLost routed: ${ok ? "1/1" : "0/1"}`);
}
{
  // The two faults route to DISTINCT screens (a lost context reads differently).
  const errScreen = routeBootTransition({ from: "ready", to: "error", errorKind: "error" }).screen;
  const ctxScreen = routeBootTransition({
    from: "ready",
    to: "error",
    errorKind: "contextLost",
  }).screen;
  const distinct = errScreen !== ctxScreen ? 2 : 1;
  check(distinct === 2, `distinct screen keys: ${distinct}/2 (${errScreen} vs ${ctxScreen})`);
}
{
  // Idempotence survives the handoff: 50 post-ready errors → 1 routed transition.
  const { flow, routed } = readyRouted();
  for (let i = 0; i < 50; i++) flow.errorRaised("error");
  check(routed.length === 1, `post-ready error transitions: ${routed.length} (expected 1)`);
}
{
  // Loop-cancel (fatal) is requested exactly once, on the first post-ready error.
  const { flow, routed } = readyRouted();
  flow.errorRaised("error");
  const cancels = routed.filter((a) => a.fatal).length;
  check(cancels === 1, `cancel requests (error): ${cancels} (expected 1)`);
}
{
  // ...and exactly once on context loss.
  const { flow, routed } = readyRouted();
  flow.contextLost();
  const cancels = routed.filter((a) => a.fatal).length;
  check(cancels === 1, `cancel requests (contextLost): ${cancels} (expected 1)`);
}
// Non-fatal transitions must NOT request a loop cancel (guards against a router
// that stops the game on the loading/ready handoff).
{
  const nonFatal = (["loading", "unsupported", "ready"] as const).map(
    (s) => routeBootTransition({ from: "checking", to: s }).fatal,
  );
  const anyFatal = nonFatal.filter(Boolean).length;
  check(anyFatal === 0, `non-fatal transitions requesting cancel: ${anyFatal} (expected 0)`);
}

// --- 11. capability truth table: all 16 input combinations -------------------
// The pure evaluator + reason derivation must be exhaustively decidable without
// a DOM, and "playable" is exactly the all-present combination.
console.log("\n--- capability truth table ---");
{
  const bools = [false, true];
  let combos = 0;
  let supported = 0;
  for (const hasWebGL2 of bools)
    for (const hasWasm of bools)
      for (const hasPointerLock of bools)
        for (const hasFinePointer of bools) {
          combos++;
          const r = evaluateCapabilities({ hasWebGL2, hasWasm, hasPointerLock, hasFinePointer });
          if (capabilityReason(r) === null) supported++;
        }
  check(combos === 16, `capability combinations: ${combos}/16`);
  check(supported === 1, `supported combinations: ${supported}/16 (expected 1)`);
  check(combos - supported === 15, `unsupported combinations: ${combos - supported}/16 (expected 15)`);
}

// --- 12. reason selection: each single-failure case names the right reason ---
console.log("\n--- reason selection (single failure) ---");
{
  const ALL: CapabilityInputs = {
    hasWebGL2: true,
    hasWasm: true,
    hasPointerLock: true,
    hasFinePointer: true,
  };
  const cases: Array<[Partial<CapabilityInputs>, CapabilityReason]> = [
    [{ hasWebGL2: false }, "webgl2"],
    [{ hasWasm: false }, "wasm"],
    [{ hasPointerLock: false }, "pointerlock"],
    [{ hasFinePointer: false }, "pointerlock"],
  ];
  let correct = 0;
  for (const [override, expected] of cases) {
    const r = evaluateCapabilities({ ...ALL, ...override });
    if (capabilityReason(r) === expected) correct++;
  }
  check(correct === 4, `reason keys correct: ${correct}/4`);
  const distinctReasons = new Set(cases.map(([, e]) => e)).size;
  check(distinctReasons === 3, `distinct reasons (pointer sub-checks collapse): ${distinctReasons}/3`);
}

// --- 13. device cases: an iPad with a trackpad is genuinely playable ---------
console.log("\n--- device cases ---");
{
  const ipad = evaluateCapabilities({
    hasWebGL2: true,
    hasWasm: true,
    hasPointerLock: true,
    hasFinePointer: true,
  });
  const ipadOk = capabilityReason(ipad) === null;
  check(ipadOk, `ipad-with-trackpad allowed: ${ipadOk ? "yes" : "no"}`);
}

// --- 14. the probe reads (pointer: fine), never a touch-capability signal -----
// A touchscreen laptop reports BOTH touch and a fine pointer; keying on a touch
// signal (maxTouchPoints / ontouchstart) would wrongly block it. Prove the
// source keys on the fine-pointer media query and contains no banned signal.
console.log("\n--- banned detection signals ---");
{
  const src = readFileSync("src/boot/capabilities.ts", "utf8");
  const banned = ["maxTouchPoints", "ontouchstart", "userAgent", "platform"];
  const present = banned.filter((t) => src.includes(t));
  check(
    present.length === 0,
    `banned detection signals: ${present.length}/4 present${present.length ? ` (${present.join(", ")})` : ""}`,
  );
  const readsFinePointer = src.includes("(pointer: fine)");
  check(readsFinePointer, `probe reads (pointer: fine): ${readsFinePointer ? "yes" : "no"}`);
}

// --- 15. unsupported reached via the pointer-lock reason is still terminal ----
console.log("\n--- unsupported terminal (pointerlock reason) ---");
{
  let escapes = 0;
  for (const inp of INPUTS) {
    const flow = new BootFlow(TWO_TASKS);
    flow.capabilityChecked({ webgl2: true, wasm: true, pointerlock: false });
    if (flow.state !== "unsupported") throw new Error("setup: expected unsupported via pointerlock");
    apply(flow, inp);
    if (flow.state !== "unsupported") escapes++;
  }
  check(escapes === 0, `escapes from unsupported (pointerlock): ${escapes}`);
}

// --- 16. every reason + fault maps to a distinct screen key ------------------
// The three unsupported reasons (data, selected in the overlay) plus the two
// fatal fault screens (from the router) must all be distinguishable.
console.log("\n--- distinct screen keys ---");
{
  const unsupportedKeys: CapabilityReason[] = ["webgl2", "wasm", "pointerlock"];
  const errorKey = routeBootTransition({ from: "ready", to: "error", errorKind: "error" }).screen;
  const ctxKey = routeBootTransition({ from: "ready", to: "error", errorKind: "contextLost" }).screen;
  const keys = new Set<string>([...unsupportedKeys, errorKey, ctxKey]);
  check(keys.size === 5, `distinct screen keys: ${keys.size}/5`);
}

if (failures > 0) {
  throw new Error(`${failures} boot-flow invariant violation(s)`);
}
console.log("\nOK — all boot-flow invariants hold");
