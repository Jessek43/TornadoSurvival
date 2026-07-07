import {
  HOSPITAL_PARAMS as P,
  COLS,
  FLOORS_MAX,
  roofTopY,
  type Fixture,
  type RoomSpec,
} from "./params";
import { block, type HospitalShell } from "./shell";
import { furnishWardFloor, type WingCtx } from "./archetypes";
import * as props from "./props";

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
  furnishExterior(shell);

  return { shellCounts, rooms };
}

/**
 * Exterior detailing: generic hospital signage (invented — no reference
 * branding), a glazed entrance podium, and two ambulances under the bay
 * canopy. Signage and glazing APPEND into the sections whose geometry
 * supports them (roof deck / facade / portico); the podium glass registers
 * matching ExteriorFace entries, so the perimeter-glass invariant stays
 * honest — it IS perimeter glass and blows first, right for an entrance.
 */
function furnishExterior(shell: HospitalShell): void {
  const byName = (name: string) => shell.sections.find((s) => s.name === name);

  // Rooftop red cross on a tall middle wing, standing on its roof deck
  // (clear of the stair void, mech units, and parapets).
  const roofWing = byName("wing_11");
  if (roofWing) {
    roofWing.blocks.push(...props.roofCross(-4.5, roofTopY(FLOORS_MAX), -28.5));
  }

  // Red cross over the entrance, abutting the floor-1 spandrel band.
  const frontWing = byName("wing_12");
  if (frontWing) {
    frontWing.blocks.push(
      ...props.wallPanel(0, 6.05, P.footprint.zMax + P.wallT / 2, "+z", "signRed", 0.8, 0.8),
    );
  }

  // "HOSPITAL" letter bar on the portico canopy + glazed podium side walls.
  const portico = byName("portico");
  if (portico) {
    portico.blocks.push(...props.hospitalBar(0, 3.75, 2.3));
    for (const px of [-6.6, 6.6]) {
      portico.blocks.push(block("glass", px, 0, 1.95, P.wallT, 3.4, 3.3));
      shell.exteriorFaces.push({
        run: "z",
        perp: px,
        a0: 0.25,
        a1: 3.65,
        floor: 0,
        kind: "envelope",
      });
    }
  }

  // Two ambulances under the bay canopy, nosed toward the building.
  for (const ax of [13.5, 18.5]) {
    shell.sections.push({ name: "ambulance", blocks: props.ambulance(ax, 0, 2.2, "+z") });
  }
}
