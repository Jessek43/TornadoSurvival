import { HOSPITAL_PARAMS as P, roofTopY, wallBaseY } from "./params";
import { FLOORS_MAX } from "./params";
import { block, type HospitalShell } from "./shell";
import { furnishRoom, deptAccent } from "./archetypes";
import { Cell, cellKindAt, type BuiltRoom, type FloorMap } from "./partition";
import { NX, NZ, cellCX, cellCZ, wingGX, wingGZ } from "./grid";
import * as props from "./props";

export { DECK_PALETTE } from "./archetypes";

/**
 * PHASE 2 — the furnish orchestrator. The partition layer (partition.ts) has
 * already erected the per-floor rooms, corridors, doors and ceiling fixtures
 * and appended them into each wing's section; this pass DRESSES those enclosed
 * rooms — each `BuiltRoom` gets its department's equipment cluster appended into
 * its own wing section (so props ride the per-section support flood-fill and are
 * released with the room) — then adds a light, wall-hugging CORRIDOR scatter and
 * the exterior detailing (signage, ambulances, glazed podium). Corridors stay
 * SPARSER than rooms: the density contrast still sells the hospital, but bare
 * white corridors read dead, so a sparse gurney/cart/cone/pylon scatter now
 * lines them (hugging a wall, leaving a clear lane — verify proves circulation).
 */
export function furnish(shell: HospitalShell, rooms: BuiltRoom[], floorMaps: FloorMap[]): void {
  for (const room of rooms) {
    const section = shell.sections[room.gx * P.rows + room.gz];
    furnishRoom(room, section.blocks);
  }
  for (const map of floorMaps) dressCorridor(shell, map);
  furnishExterior(shell);
}

/**
 * CORRIDOR DRESSING — a sparse scatter of floor-standing props down every
 * corridor. Kept safe by construction:
 *   - FLOOR-STANDING only: each prop rests on the wing deck under its cell, so
 *     support flows deck→ground within the cell's OWN wing section (a
 *     wall-mounted corridor prop could hang off a wall bucketed to a different
 *     section and rain down at wake — avoided entirely).
 *   - placed only on a door-free THROUGH-corridor cell (corridor on both ends of
 *     one axis, a solid wall to hug on the other), so it can never block a
 *     doorway (checkRooms also re-proves door clearance) or a junction.
 *   - hugged HUG m off the centre toward that wall, leaving a >1 m lane on the
 *     far side — verify's corridor-circulation flood proves the whole network
 *     stays connected with these props inflated by the player capsule.
 *   - a sparse deterministic cadence (~1 in 5 eligible cells) keeps corridors
 *     sparser than the packed rooms.
 */
const HUG = 0.75; // m the prop anchor sits off the corridor centre, toward a wall

function dressCorridor(shell: HospitalShell, map: FloorMap): void {
  const base = wallBaseY(map.f);
  const blade = deptAccent(map.spec.facade); // pylons carry the floor's dept hue
  const de = map.doorEdges;
  const isCorr = (ix: number, iz: number): boolean => cellKindAt(map, ix, iz) === Cell.CORRIDOR;
  const touchesDoor = (ix: number, iz: number): boolean =>
    de.has(`v:${ix - 1}:${iz}`) || de.has(`v:${ix}:${iz}`) ||
    de.has(`h:${ix}:${iz - 1}`) || de.has(`h:${ix}:${iz}`);

  scan(isCorr, touchesDoor, (ix, iz, ax, az, facing, pick) => {
    const section = shell.sections[wingGX(ix) * P.rows + wingGZ(iz)];
    const b = section.blocks;
    switch (pick) {
      case 0: b.push(...props.supplyCart(ax, base, az, facing)); break;
      case 1: b.push(...props.wheelchair(ax, base, az, facing)); break;
      case 2: b.push(...props.bin(ax, base, az, facing)); break;
      case 3: b.push(...props.cone(ax, base, az, facing)); break;
      case 4: b.push(...props.extinguisher(ax, base, az, facing)); break;
      default: b.push(...props.signPylon(ax, base, az, facing, blade)); break;
    }
  });
}

/** Walk every corridor cell, decide hug side + prop, and hand the placement to
 *  `place`. Split out so the geometry stays readable. */
function scan(
  isCorr: (ix: number, iz: number) => boolean,
  touchesDoor: (ix: number, iz: number) => boolean,
  place: (ix: number, iz: number, ax: number, az: number, facing: props.Facing, pick: number) => void,
): void {
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (!isCorr(ix, iz) || touchesDoor(ix, iz)) continue;
      const runZ = isCorr(ix, iz - 1) && isCorr(ix, iz + 1);
      const runX = isCorr(ix - 1, iz) && isCorr(ix + 1, iz);
      if (runZ === runX) continue; // crossing (both) or dead-end tip (neither)

      let ax = cellCX(ix);
      let az = cellCZ(iz);
      let facing: props.Facing;
      if (runZ) {
        // rib: hug a solid ±x wall (prefer west)
        if (!isCorr(ix - 1, iz)) {
          ax = cellCX(ix) - HUG;
          facing = "+x";
        } else if (!isCorr(ix + 1, iz)) {
          ax = cellCX(ix) + HUG;
          facing = "-x";
        } else continue; // both sides open (wide corridor) — nothing to hug
      } else {
        // avenue: hug a solid ±z wall (prefer south)
        if (!isCorr(ix, iz - 1)) {
          az = cellCZ(iz) - HUG;
          facing = "+z";
        } else if (!isCorr(ix, iz + 1)) {
          az = cellCZ(iz) + HUG;
          facing = "-z";
        } else continue;
      }

      // Sparse deterministic cadence + prop choice from a spatial hash.
      const h = ((ix * 73856093) ^ (iz * 19349663)) >>> 0;
      if (h % 5 !== 0) continue;
      place(ix, iz, ax, az, facing, (h >>> 4) % 6);
    }
  }
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
