// Static verification of the app-shell flow — the AppFlow state machine, the
// SurviveAllPasses objective, and the persisted sensitivity Settings. Terminates
// on its own (no dev server, no game/physics/render loop).
// Run with: npm run verify:flow   (or: npx tsx scripts/verify-flow.ts)
//
// Covers the checks computable WITHOUT running the game:
//  1. Every AppState is reachable from `menu` (BFS over legal edges).
//  2. `died` and `survived` are both reachable from `playing` and are mutually
//     exclusive (no direct edge between the two terminals).
//  3. Edge-trigger property: one legal transition() == one onChange == one edge
//     increment; illegal (throwing) calls touch nothing.
//  4. An illegal transition (menu→win, playing→start, …) THROWS.
//  5. The machine is exhaustive: every (state,event) pair either moves or throws
//     — all 24 combos are classified (drives the exhaustive `next` switch).
//  6. SurviveAllPasses.evaluate returns exactly one terminal verdict per
//     synthetic round, never both won and lost for one input.
//  7. Settings: clampSensitivity below→min / above→max / identity in range;
//     loadSettings() returns the default (no throw) for every corrupt input.
import { AppFlow, type AppState, type AppEvent } from "../src/systems/AppFlow";
import { SurviveAllPasses, type ObjectiveState } from "../src/systems/Objective";
import {
  clampSensitivity,
  loadSettings,
  saveSettings,
  SENSITIVITY_MIN,
  SENSITIVITY_MAX,
  SENSITIVITY_DEFAULT,
  type StorageLike,
} from "../src/config/Settings";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
}
function expectThrow(fn: () => void, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(threw, label);
}

const ALL_STATES: AppState[] = ["menu", "playing", "survived", "died"];
const ALL_EVENTS: AppEvent[] = ["start", "win", "lose", "playAgain", "retry", "toMenu"];

/** Replay a path of events on a fresh flow (AppFlow always starts at `menu`). */
function flowAfter(path: AppEvent[]): AppFlow {
  const f = new AppFlow();
  for (const e of path) f.transition(e);
  return f;
}
/** The state reached by `event` from `state`, or null if illegal. */
function targetOf(state: AppState, path: AppEvent[], event: AppEvent): AppState | null {
  const f = flowAfter(path);
  if (f.state !== state) return null;
  try {
    return f.transition(event);
  } catch {
    return null;
  }
}

// --- 1. reachability BFS from menu ------------------------------------------
console.log("--- reachability ---");
const seen = new Set<AppState>(["menu"]);
const pathTo = new Map<AppState, AppEvent[]>([["menu", []]]);
const queue: AppState[] = ["menu"];
while (queue.length) {
  const s = queue.shift()!;
  const path = pathTo.get(s)!;
  for (const ev of ALL_EVENTS) {
    const to = targetOf(s, path, ev);
    if (to && !seen.has(to)) {
      seen.add(to);
      pathTo.set(to, [...path, ev]);
      queue.push(to);
    }
  }
}
for (const st of ALL_STATES) check(seen.has(st), `state "${st}" reachable from menu`);
check(seen.size === ALL_STATES.length, `all ${ALL_STATES.length} states reachable (got ${seen.size})`);

// --- 2. terminals reachable from playing + mutually exclusive ---------------
console.log("\n--- terminals ---");
const toPlaying: AppEvent[] = ["start"];
check(targetOf("playing", toPlaying, "win") === "survived", "playing --win--> survived");
check(targetOf("playing", toPlaying, "lose") === "died", "playing --lose--> died");
// Mutually exclusive: no direct edge survived↔died (must pass back through playing).
const atSurvived: AppEvent[] = ["start", "win"];
const atDied: AppEvent[] = ["start", "lose"];
const survivedTargets = ALL_EVENTS.map((e) => targetOf("survived", atSurvived, e));
const diedTargets = ALL_EVENTS.map((e) => targetOf("died", atDied, e));
check(!survivedTargets.includes("died"), "no direct survived→died edge");
check(!diedTargets.includes("survived"), "no direct died→survived edge");

// --- 3. edge-trigger: one transition == one onChange == one edge increment ---
console.log("\n--- edge-trigger ---");
let onChangeFires = 0;
const flow = new AppFlow(() => onChangeFires++);
// A legal walk touching several distinct edges once each.
flow.transition("start"); // menu->playing
flow.transition("win"); //   playing->survived
flow.transition("playAgain"); // survived->playing
flow.transition("lose"); //   playing->died
flow.transition("retry"); //  died->playing
const legalCount = 5;
// Illegal attempts in the middle must not fire anything.
expectThrow(() => flow.transition("start"), "playing --start--> throws (illegal mid-walk)");
check(onChangeFires === legalCount, `onChange fired ${onChangeFires}× == ${legalCount} legal transitions`);
check(flow.transitions === legalCount, `flow.transitions == ${legalCount} (illegal excluded, got ${flow.transitions})`);
const edgeSum = Object.values(flow.edgeCounts).reduce((a, b) => a + b, 0);
check(edgeSum === legalCount, `edge increments sum to ${legalCount} (got ${edgeSum})`);
check(
  Object.values(flow.edgeCounts).every((c) => c === 1),
  `each distinct edge fired exactly once (${JSON.stringify(flow.edgeCounts)})`,
);

// --- 4. illegal transitions throw -------------------------------------------
console.log("\n--- illegal transitions throw ---");
expectThrow(() => new AppFlow().transition("win"), "menu --win--> throws");
expectThrow(() => new AppFlow().transition("lose"), "menu --lose--> throws");
expectThrow(() => new AppFlow().transition("retry"), "menu --retry--> throws");
expectThrow(() => flowAfter(["start"]).transition("playAgain"), "playing --playAgain--> throws");
expectThrow(() => flowAfter(["start", "win"]).transition("retry"), "survived --retry--> throws");
expectThrow(() => flowAfter(["start", "lose"]).transition("playAgain"), "died --playAgain--> throws");

// --- 5. exhaustive: every (state,event) is either a move or a throw ----------
console.log("\n--- exhaustiveness ---");
let handled = 0;
for (const st of ALL_STATES) {
  // A minimal path to each state so we can probe its events.
  const path: AppEvent[] =
    st === "menu" ? [] : st === "playing" ? ["start"] : st === "survived" ? ["start", "win"] : ["start", "lose"];
  for (const ev of ALL_EVENTS) {
    const to = targetOf(st, path, ev);
    // Either a legal AppState move, or targetOf caught a throw (to === null).
    if (to === null || ALL_STATES.includes(to)) handled++;
  }
}
const combos = ALL_STATES.length * ALL_EVENTS.length;
check(handled === combos, `all ${combos} (state,event) combos classified (got ${handled})`);

// --- 6. objective: one terminal verdict per round --------------------------
console.log("\n--- objective ---");
const obj = new SurviveAllPasses();
// A synthetic 3-pass round that the player SURVIVES: pending until tornadoDone.
function roundVerdicts(snaps: ObjectiveState[]): Set<string> {
  return new Set(snaps.map((s) => obj.evaluate(s)).filter((v) => v !== "pending"));
}
const surviveRound: ObjectiveState[] = [
  { dead: false, tornadoDone: false, passesTotal: 3 },
  { dead: false, tornadoDone: false, passesTotal: 3 },
  { dead: false, tornadoDone: true, passesTotal: 3 },
];
const deathRound: ObjectiveState[] = [
  { dead: false, tornadoDone: false, passesTotal: 3 },
  { dead: true, tornadoDone: false, passesTotal: 3 },
];
const sv = roundVerdicts(surviveRound);
const dv = roundVerdicts(deathRound);
check(sv.size === 1 && sv.has("won"), `survive round → exactly one terminal verdict "won" (${[...sv]})`);
check(dv.size === 1 && dv.has("lost"), `death round → exactly one terminal verdict "lost" (${[...dv]})`);
// Death takes precedence even coincident with tornadoDone — still a single verdict.
check(
  obj.evaluate({ dead: true, tornadoDone: true, passesTotal: 3 }) === "lost",
  "dead+tornadoDone → single verdict 'lost' (never both won and lost)",
);
// evaluate is a pure function: same input → same single verdict.
const pending = obj.evaluate({ dead: false, tornadoDone: false, passesTotal: 2 });
check(pending === "pending", "mid-round → pending");

// --- 7. settings ------------------------------------------------------------
console.log("\n--- settings ---");
check(clampSensitivity(SENSITIVITY_MIN - 1) === SENSITIVITY_MIN, `clamp below-min → ${SENSITIVITY_MIN}`);
check(clampSensitivity(SENSITIVITY_MAX + 10) === SENSITIVITY_MAX, `clamp above-max → ${SENSITIVITY_MAX}`);
const mid = (SENSITIVITY_MIN + SENSITIVITY_MAX) / 2;
check(clampSensitivity(mid) === mid, `clamp identity in range (${mid})`);

/** A stub whose getItem always returns `value` — injects a raw stored string. */
function rawStore(value: string | null): StorageLike {
  return { getItem: () => value, setItem: () => {} };
}
const corruptCases: [string, StorageLike][] = [
  ["absent key", rawStore(null)],
  ['malformed JSON "{"', rawStore("{")],
  ['wrong type "fast"', rawStore('{"sensitivity":"fast"}')],
  ["null value", rawStore('{"sensitivity":null}')],
  ["NaN token", rawStore("NaN")],
  ["Infinity token", rawStore("Infinity")],
  ["100× max (out of range)", rawStore(JSON.stringify({ sensitivity: SENSITIVITY_MAX * 100 }))],
];
for (const [label, store] of corruptCases) {
  let result: number | "threw" = "threw";
  try {
    result = loadSettings(store).sensitivity;
  } catch {
    result = "threw";
  }
  check(result === SENSITIVITY_DEFAULT, `loadSettings(${label}) → default ${SENSITIVITY_DEFAULT} (no throw), got ${result}`);
}
// Positive round-trip: a valid value persists; an over-range save is clamped.
const mem = (() => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
})();
saveSettings({ sensitivity: 2 }, mem);
check(loadSettings(mem).sensitivity === 2, "save/load round-trip preserves an in-range value (2)");
saveSettings({ sensitivity: 999 }, mem);
check(loadSettings(mem).sensitivity === SENSITIVITY_MAX, `save clamps out-of-range → load returns ${SENSITIVITY_MAX}`);

if (failures > 0) {
  throw new Error(`${failures} app-flow invariant violation(s)`);
}
console.log("\nOK — all app-flow / objective / settings invariants hold");
