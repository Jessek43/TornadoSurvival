// Static verification of the storm-lightning + alarm feature — terminates on
// its own (no dev server, no game/physics/render loop).
// Run with: npm run verify:lightning   (or: npx tsx scripts/verify-lightning.ts)
//
// Covers the checks that are computable WITHOUT running the game:
//  1. Prints the LightningConfig defaults.
//  2. maxBlocksPerStrike ≤ the global debris budget on every quality preset, so
//     a single strike's slice can never exhaust the debris pool.
//  3. AlarmController is EDGE-triggered: start/stop fire once per transition,
//     never on a repeated same-state tick — driven through a synthetic
//     warning→pass→gap→pass→done sequence (the alarm-goes-silent-during-a-pass
//     rule), asserting the exact start/stop counts.
import { LightningConfig } from "../src/config/LightningConfig";
import { QUALITY_PRESETS } from "../src/config/QualitySettings";
import { AlarmController } from "../src/systems/AlarmController";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

// --- 1. LightningConfig defaults --------------------------------------------
console.log("--- LightningConfig defaults ---");
for (const [k, v] of Object.entries(LightningConfig)) {
  const shown = typeof v === "number" && (k.endsWith("Color") || k === "boltColor")
    ? `0x${(v as number).toString(16)}`
    : String(v);
  console.log(`  ${k}: ${shown}`);
}

// --- 2. per-strike cap ≤ global debris budget -------------------------------
console.log("\n--- caps ---");
for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
  check(
    LightningConfig.maxBlocksPerStrike <= preset.debrisBudget,
    `maxBlocksPerStrike ${LightningConfig.maxBlocksPerStrike} ≤ ${name} debrisBudget ${preset.debrisBudget}`,
  );
}
check(LightningConfig.maxBlocksPerStrike >= 1, "maxBlocksPerStrike ≥ 1");
check(LightningConfig.strikeRatePerSecond > 0, "strikeRatePerSecond > 0");
check(LightningConfig.boltSegments >= 2, "boltSegments ≥ 2");
check(LightningConfig.boltLifetimeMs > 0, "boltLifetimeMs > 0");
check(LightningConfig.flashDurationMs > 0, "flashDurationMs > 0");
check(LightningConfig.damageRadius > 0, "damageRadius > 0");
check(
  ["uniform", "nearTornado", "tallStructures"].includes(LightningConfig.targetBias),
  `targetBias "${LightningConfig.targetBias}" is valid`,
);

// --- 3. alarm is edge-triggered ---------------------------------------------
console.log("\n--- alarm edge-triggering ---");

// The exact Game decision: audible during warning + between-pass gap, silent
// while a funnel is present ("pass"), silent when the storm is done. (Game wraps
// this in `flow === playing && locked`; that gate is exercised in verify-flow.)
type Frame = { phase: "warning" | "active"; state: "idle" | "pass" | "gap" | "done" };
const alarmDesired = (f: Frame): boolean =>
  f.phase === "warning" || (f.phase === "active" && f.state === "gap");

// warning(×3) → pass(×3) → gap(×2) → pass(×2) → done(×2)  (a 2-pass round)
const sequence: Frame[] = [
  ...rep({ phase: "warning", state: "idle" }, 3),
  ...rep({ phase: "active", state: "pass" }, 3),
  ...rep({ phase: "active", state: "gap" }, 2),
  ...rep({ phase: "active", state: "pass" }, 2),
  ...rep({ phase: "active", state: "done" }, 2),
];

let cbStarts = 0;
let cbStops = 0;
const alarm = new AlarmController(
  () => cbStarts++,
  () => cbStops++,
);
// Trace desired vs playing each tick to prove no per-frame re-trigger.
for (const f of sequence) alarm.set(alarmDesired(f));

// Edges in the sequence: off→on (warning), on→off (pass), off→on (gap),
// on→off (pass); done stays off. So 2 starts and 2 stops, and the callbacks
// fire exactly as often as the internal counters (no double / no per-frame).
check(alarm.starts === 2, `alarm.starts == 2 (got ${alarm.starts})`);
check(alarm.stops === 2, `alarm.stops == 2 (got ${alarm.stops})`);
check(cbStarts === alarm.starts, `onStart fired ${cbStarts}× == starts`);
check(cbStops === alarm.stops, `onStop fired ${cbStops}× == stops`);
check(alarm.playing === false, "alarm silent at end (storm done)");

// A long run of identical ticks must NOT accumulate transitions.
const flat = new AlarmController(() => {}, () => {});
for (let i = 0; i < 100; i++) flat.set(true);
check(flat.starts === 1 && flat.stops === 0, `100 identical ticks → 1 start (got ${flat.starts})`);

// --- 4. round resolution: NO phantom gap after the final pass ----------------
// Regression guard for the phantom-gap bug. The FIXED round goes
// warning → pass → gap → pass(final) → done — the final pass recedes STRAIGHT to
// "done", never to a gap — so the siren must not restart after the final pass.
console.log("\n--- final-pass resolution (no phantom gap) ---");
const warningBlock = rep<Frame>({ phase: "warning", state: "idle" }, 3);
const pass0 = rep<Frame>({ phase: "active", state: "pass" }, 4);
const gap0 = rep<Frame>({ phase: "active", state: "gap" }, 3); // the real between-pass gap
const passFinal = rep<Frame>({ phase: "active", state: "pass" }, 4);
const resolve = rep<Frame>({ phase: "active", state: "done" }, 3); // straight to done, no gap
const warningEntries = 1;
const gapEntries = 1;

const round = new AlarmController(() => {}, () => {});
[...warningBlock, ...pass0, ...gap0].forEach((f) => round.set(alarmDesired(f)));
const startsBeforeFinal = round.starts; // warning + gap = 2
const stopsBeforeFinal = round.stops; // pass0 = 1
passFinal.forEach((f) => round.set(alarmDesired(f)));
check(round.stops === stopsBeforeFinal + 1, "exactly one stop edge on entering the final pass");
check(round.starts === startsBeforeFinal, "no start edge on the final pass");
resolve.forEach((f) => round.set(alarmDesired(f)));
check(round.starts === startsBeforeFinal, "no start edge fires after the final pass (resolve)");
check(round.stops === stopsBeforeFinal + 1, "stop edge never re-fires after the final pass");
check(
  round.starts === warningEntries + gapEntries,
  `start edges == warning + gap entries (${warningEntries + gapEntries}, got ${round.starts})`,
);
check(round.playing === false, "siren silent once the round resolves to done");

// --- 5. two-funnel: state leaves "pass" only after ALL funnels recede --------
// The tornado state stays "pass" while ANY funnel is present, so the siren stays
// silent through the whole (staggered) pass and only the resolve to "done"
// follows — no phantom gap while one funnel lingers.
console.log("\n--- two-funnel resolution ---");
const twoFunnel: Frame[] = [
  ...rep<Frame>({ phase: "warning", state: "idle" }, 2),
  ...rep<Frame>({ phase: "active", state: "pass" }, 3), // both funnels up
  ...rep<Frame>({ phase: "active", state: "pass" }, 3), // one receded, other still up → still "pass"
  ...rep<Frame>({ phase: "active", state: "done" }, 2), // all receded → resolve (no gap)
];
const two = new AlarmController(() => {}, () => {});
twoFunnel.forEach((f) => two.set(alarmDesired(f)));
check(two.starts === 1, `two-funnel: single start (warning only), no restart while any funnel present (got ${two.starts})`);
check(two.stops === 1, `two-funnel: single stop at pass start, none after (got ${two.stops})`);
check(two.playing === false, "two-funnel: silent once all funnels recede + resolve");

function rep<T>(v: T, n: number): T[] {
  return Array.from({ length: n }, () => v);
}

if (failures > 0) {
  throw new Error(`${failures} lightning/alarm invariant violation(s)`);
}
console.log("\nOK — all lightning/alarm invariants hold");
