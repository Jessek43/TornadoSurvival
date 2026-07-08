import { HOSPITAL_PARAMS as P, roofTopY } from "./params";
import { FLOORS_MAX } from "./params";
import { block, type HospitalShell } from "./shell";
import { furnishRoom } from "./archetypes";
import type { BuiltRoom } from "./partition";
import * as props from "./props";

export { DECK_PALETTE } from "./archetypes";

/**
 * PHASE 2 — the furnish orchestrator. The partition layer (partition.ts) has
 * already erected the per-floor rooms, corridors, doors and ceiling fixtures
 * and appended them into each wing's section; this pass DRESSES those enclosed
 * rooms — each `BuiltRoom` gets its department's equipment cluster appended into
 * its own wing section (so props ride the per-section support flood-fill and are
 * released with the room), plus the exterior detailing (signage, ambulances,
 * glazed podium). It never touches the corridors: circulation stays sparse, the
 * density contrast between packed rooms and bare corridors sells the hospital.
 */
export function furnish(shell: HospitalShell, rooms: BuiltRoom[]): void {
  for (const room of rooms) {
    const section = shell.sections[room.gx * P.rows + room.gz];
    furnishRoom(room, section.blocks);
  }
  furnishExterior(shell);
}

/**
 * Exterior detailing: generic hospital signage (invented — no reference
 * branding), a glazed entrance podium, and two ambulances under the bay
 * canopy. Signage/glazing APPEND into the sections whose geometry supports
 * them; the podium glass registers matching ExteriorFace entries, so the
 * perimeter-glass invariant stays honest.
 */
function furnishExterior(shell: HospitalShell): void {
  const byName = (name: string) => shell.sections.find((s) => s.name === name);

  const roofWing = byName("wing_11");
  if (roofWing) {
    roofWing.blocks.push(...props.roofCross(-4.5, roofTopY(FLOORS_MAX), -28.5));
  }

  const frontWing = byName("wing_12");
  if (frontWing) {
    frontWing.blocks.push(
      ...props.wallPanel(0, 6.05, P.footprint.zMax + P.wallT / 2, "+z", "signRed", 0.8, 0.8),
    );
  }

  const portico = byName("portico");
  if (portico) {
    portico.blocks.push(...props.hospitalBar(0, 3.75, 2.3));
    for (const px of [-6.6, 6.6]) {
      portico.blocks.push(block("glass", px, 0, 1.95, P.wallT, 3.4, 3.3));
      shell.exteriorFaces.push({ run: "z", perp: px, a0: 0.25, a1: 3.65, floor: 0, kind: "envelope" });
    }
  }

  for (const ax of [13.5, 18.5]) {
    shell.sections.push({ name: "ambulance", blocks: props.ambulance(ax, 0, 2.2, "+z") });
  }
}
