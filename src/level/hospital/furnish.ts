import { HOSPITAL_PARAMS as P, COLS, type Fixture, type RoomSpec } from "./params";
import type { HospitalShell } from "./shell";
import { furnishWardFloor, type WingCtx } from "./archetypes";

export { DECK_PALETTE } from "./archetypes";

export interface FurnishResult {
  /** Per-section block counts BEFORE furnishing — verify.ts asserts the
   *  shell prefix was only ever appended to, never edited. */
  shellCounts: number[];
  /** Every furnished room — verify.ts turns enterability (empty door
   *  volume + capsule-inflated walkability) into build-time asserts. */
  rooms: RoomSpec[];
}

/**
 * PHASE 2 — the furnish orchestrator. Walks every wing floor and dispatches
 * to its archetype, APPENDING blocks into the wing's existing sections (the
 * per-section support flood-fill is the no-floating-props mechanism, so
 * props must ride their wing's section) and pushing new ceiling fixtures.
 *
 * Slice status (vertical-slice mandate):
 *  - WARD floors (f ≥ 2, outer rows): implemented — the re-gated slice.
 *  - Treatment (f=1) / lobby (f=0) / generic middle-row / exterior signage,
 *    podium glazing, ambulances: later runs, after Jesse's ward gate.
 */
export function furnish(shell: HospitalShell): FurnishResult {
  const shellCounts = shell.sections.map((s) => s.blocks.length);
  const rooms: RoomSpec[] = [];
  const addFixture = (f: Fixture): void => {
    shell.lightFixtures.push(f);
  };

  // Wings were pushed first, in (gx, gz) order — see buildShell().
  for (let gx = 0; gx < COLS; gx++) {
    for (let gz = 0; gz < P.rows; gz++) {
      const section = shell.sections[gx * P.rows + gz];
      const ctx: WingCtx = { gx, gz, blocks: section.blocks, addFixture, rooms };
      const floors = P.colFloors[gx];
      const outerRow = gz !== 1; // middle row = corridors + stair voids, no rooms
      for (let f = 2; f < floors; f++) {
        if (outerRow) furnishWardFloor(ctx, f);
      }
      // f=0 lobby (front-center wings) and f=1 treatment: later slices.
    }
  }
  // Exterior (podium glazing + registry, signage, ambulances): later slice.

  return { shellCounts, rooms };
}
