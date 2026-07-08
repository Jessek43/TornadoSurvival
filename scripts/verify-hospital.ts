// Static verification of the hospital definition — terminates on its own.
// Run with: npm run verify:hospital   (tsx; no dev server, no game loop)
//
// Runs BOTH build paths as pure data and checks every invariant in
// src/level/hospital/verify.ts. Exits non-zero on any violation.
//  - bare shell:  what `?bare` measures (the Phase-1 perf baseline)
//  - detailed:    palette decks + the furnish pass
import { buildShell } from "../src/level/hospital/shell";
import { partitionHospital } from "../src/level/hospital/partition";
import { furnish, DECK_PALETTE } from "../src/level/hospital/furnish";
import { verifyHospital } from "../src/level/hospital/verify";
import { buildNeighborhood } from "../src/level/Neighborhood";

let failures = 0;

function run(label: string, detail: boolean): void {
  const shell = buildShell(detail ? { deckMaterial: DECK_PALETTE, interiorColumns: false } : {});
  const shellCounts = detail ? shell.sections.map((s) => s.blocks.length) : undefined;
  const partition = detail ? partitionHospital(shell) : undefined;
  if (detail && partition) furnish(shell, partition.rooms);
  const result = verifyHospital(shell.sections, shell.lightFixtures, shell.exteriorFaces, {
    neighborhood: buildNeighborhood(),
    shellCounts,
    rooms: partition?.rooms,
    floorMaps: partition?.floorMaps,
  });
  console.log(`--- ${label} ---`);
  for (const line of result.info) console.log(line);
  for (const failure of result.failures) console.error(`FAIL: ${failure}`);
  failures += result.failures.length;
}

run("bare shell (?bare)", false);
run("detailed", true);

if (failures > 0) {
  throw new Error(`${failures} hospital invariant violation(s)`);
}
console.log("OK — all hospital invariants hold (bare + detailed)");
