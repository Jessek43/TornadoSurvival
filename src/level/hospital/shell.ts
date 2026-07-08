import type { MaterialId } from "../Materials";
import type { BlockDef, SectionSpec } from "../Blueprints";
import {
  HOSPITAL_PARAMS as P,
  COLS,
  FLOORS_MAX,
  X_EDGES,
  Z_EDGES,
  clipRectToVoids,
  deckTopY,
  inCorridor,
  overlapsVoid,
  roofTopY,
  wallBaseY,
  wallTopY,
  type ExteriorFace,
  type Fixture,
  type StairLight,
} from "./params";

/**
 * PHASE 1 — the hospital's bare structural shell (envelope + cores only).
 *
 * Everything here is generated from HOSPITAL_PARAMS / the derived grid in
 * params.ts, in a strict order per wing: deck → columns → exterior walls, then
 * roof. The INTERIOR (per-floor rooms, corridors, doors) is deliberately NOT
 * built here — it is a separate per-storey partition layer (partition.ts, from
 * the authored plans in floorplans.ts) that appends into these sections, so
 * every floor gets its own enclosure instead of one open plate. Detailing
 * (props) is a further strictly-ADDITIVE furnish pass; the shell stands alone.
 *
 * The z-fighting class the old builder had is impossible here by construction
 * (verify.ts asserts coplanar-overlap count == 0):
 *  - WALL TOPS ON DECK-TOP PLANES: walls and columns run deck-top →
 *    next-deck-BOTTOM (wallBaseY/wallTopY), so no wall top ever shares the
 *    walking plane. (The partition layer follows the same rule and abuts —
 *    never overlaps — at every corner it emits.)
 *
 * Support contract (StructureSystem flood-fill): ground-storey walls/columns
 * reach y=0; every deck rests on the walls below it via exact plane contact;
 * stair treads chain to landings which overlap the shaft walls — so nothing
 * in the shell is unsupported-at-birth (verify.ts asserts orphan count == 0).
 */

export interface HospitalShell {
  sections: SectionSpec[];
  lightFixtures: Fixture[];
  exteriorFaces: ExteriorFace[];
  /** Stairwell lights, tagged with their mount (debug HUD readout). */
  stairLights: StairLight[];
}

export interface ShellOptions {
  /** Per-floor interior deck material (the Phase-2 palette: beige lobby,
   *  teal treatment, mustard wards). Omitted → all-concrete Phase-1 shell,
   *  which is what `?bare` measures. Roof decks are always cladding. All
   *  palette ids are physics clones of concrete, so this is color only. */
  deckMaterial?: (f: number, gx: number, gz: number) => MaterialId;
  /** Wing-corner support columns. The BARE shell needs them (no interior
   *  walls, so the inner-wing decks would otherwise float). The DETAILED build
   *  omits them: the partition layer's per-floor room walls stand under the
   *  decks and carry the support flood-fill, and free-standing corner columns
   *  only collided with corner-room furniture. */
  interiorColumns?: boolean;
}

/** Push a ceiling fixture; returns its index in the flat lightFixtures array
 *  (stable — furnish only appends after the shell). */
type AddFixture = (f: Fixture) => number;

/** Author a block by its BOTTOM y (easier to stack); store the center.
 *  Exported for the Phase-2 furnish pass (props.ts / archetypes.ts). */
export function block(
  material: MaterialId,
  cx: number,
  bottom: number,
  cz: number,
  w: number,
  h: number,
  d: number,
): BlockDef {
  return { position: [cx, bottom + h / 2, cz], size: [w, h, d], material };
}

// ===========================================================================
// Decks — tiled, clipped around the stair voids, one distinct top plane per
// surface class (see the lift table in params.ts).
// ===========================================================================

function addDeck(
  blocks: BlockDef[],
  xMin: number,
  xMax: number,
  zMin: number,
  zMax: number,
  deckTop: number,
  material: MaterialId,
): void {
  for (let x0 = xMin; x0 < xMax - 0.05; x0 += P.deckTile) {
    const x1 = Math.min(x0 + P.deckTile, xMax);
    for (let z0 = zMin; z0 < zMax - 0.05; z0 += P.deckTile) {
      const z1 = Math.min(z0 + P.deckTile, zMax);
      for (const r of clipRectToVoids({ x0, x1, z0, z1 })) {
        const cx = (r.x0 + r.x1) / 2;
        const cz = (r.z0 + r.z1) / 2;
        blocks.push(block(material, cx, deckTop - P.deckT, cz, r.x1 - r.x0, P.deckT, r.z1 - r.z0));
      }
    }
  }
}

// ===========================================================================
// Walls. All z-runs are inset where they meet an x-run (envelope walls own
// their corners; crossing corridors open walls by segment EXTENT) so no two
// wall runs ever share volume — that's what keeps coplanar pairs at zero.
// ===========================================================================

/**
 * Exterior wall run: sill + glass + spandrel on windowed segments, solid
 * otherwise. Glass appears ONLY here — that placement convention IS the
 * shelter puzzle's "perimeter windows only" rule, and each run is recorded
 * in the exteriorFaces registry so verify.ts can assert it.
 */
function addExteriorWall(
  blocks: BlockDef[],
  faces: ExteriorFace[],
  run: "x" | "z",
  a0: number,
  a1: number,
  perp: number,
  f: number,
  kind: "envelope" | "step",
  lobby: boolean,
  door?: (c: number) => boolean,
): void {
  faces.push({ run, perp, a0, a1, floor: f, kind });
  const base = wallBaseY(f);
  const top = wallTopY(f);
  const len = a1 - a0;
  const n = Math.max(1, Math.round(len / P.seg));
  const seg = len / n;
  const solid: MaterialId = f === 0 ? "concrete" : "cladding";
  // Ground-floor windows only on the front facade (the lot-facing entrance
  // face); everywhere else the ground storey is solid concrete podium.
  const front = perp === P.footprint.zMax;
  for (let i = 0; i < n; i++) {
    const c = a0 + seg * (i + 0.5);
    const x = run === "x" ? c : perp;
    const z = run === "x" ? perp : c;
    const w = run === "x" ? seg : P.wallT;
    const d = run === "x" ? P.wallT : seg;
    if (overlapsVoid(x, z, w, d)) continue;
    if (door?.(c)) continue; // walk-through opening (the entrance)
    const windowed = (f > 0 || front) && i % 2 === 0;
    if (!windowed) {
      blocks.push(block(solid, x, base, z, w, top - base, d));
      continue;
    }
    const sillTop = base + (lobby ? P.window.lobbySill : P.window.sill);
    const headTop = lobby ? top : base + P.window.head; // lobby glazes to the ceiling
    blocks.push(block(solid, x, base, z, w, sillTop - base, d)); // sill
    blocks.push(block("glass", x, sillTop, z, w, headTop - sillTop, d)); // window
    if (top - headTop > 0.05) {
      blocks.push(block("concrete", x, headTop, z, w, top - headTop, d)); // spandrel band
    }
  }
}

/** z-runs stop at the inner face of the envelope's front/back x-walls
 *  instead of poking into their corners. */
function zRunSpan(gz: number): [number, number] {
  const z0 = Z_EDGES[gz] + (gz === 0 ? P.wallT / 2 : 0);
  const z1 = Z_EDGES[gz + 1] - (gz === P.rows - 1 ? P.wallT / 2 : 0);
  return [z0, z1];
}

// ===========================================================================
// One wing = one destructible section (full-height column of one grid cell —
// full-height because the support flood-fill seeds from ground blocks, which
// every section must own).
// ===========================================================================

function buildWing(gx: number, gz: number, faces: ExteriorFace[], opts: ShellOptions): SectionSpec {
  const xMin = X_EDGES[gx];
  const xMax = X_EDGES[gx + 1];
  const zMin = Z_EDGES[gz];
  const zMax = Z_EDGES[gz + 1];
  const [zr0, zr1] = zRunSpan(gz);
  const floors = P.colFloors[gx];
  const blocks: BlockDef[] = [];
  const back = gz === 0;
  const front = gz === P.rows - 1;

  for (let f = 0; f < floors; f++) {
    // DECK — one distinct plane per class (ground lift / floor line).
    addDeck(blocks, xMin, xMax, zMin, zMax, deckTopY(f), opts.deckMaterial?.(f, gx, gz) ?? "concrete");

    // COLUMNS — wing corners, inset fully clear of the boundary wall planes,
    // skipped in voids and corridors ("columns never obstruct circulation").
    // Omitted in the detailed build (the partition's room walls support the
    // decks instead — see ShellOptions.interiorColumns).
    if (opts.interiorColumns !== false) {
      const colInset = P.wallT + 0.25;
      for (const cx of [xMin + colInset, xMax - colInset]) {
        for (const cz of [zMin + colInset, zMax - colInset]) {
          if (overlapsVoid(cx, cz, 0.5, 0.5)) continue;
          if (inCorridor(cx, cz)) continue;
          blocks.push(
            block("concrete", cx, wallBaseY(f), cz, 0.5, wallTopY(f) - wallBaseY(f), 0.5),
          );
        }
      }
    }

    // EXTERIOR walls: envelope edges, plus massing-step faces where this
    // column rises above its x-neighbor.
    const lobby = front && f === 0 && (gx === 1 || gx === 2);
    const entrance = lobby ? (c: number): boolean => Math.abs(c) < 3 : undefined;
    if (back) addExteriorWall(blocks, faces, "x", xMin, xMax, zMin, f, "envelope", false);
    if (front) {
      addExteriorWall(blocks, faces, "x", xMin, xMax, zMax, f, "envelope", lobby, entrance);
    }
    // Envelope side walls straddle the footprint edge; massing-STEP walls sit
    // flush INSIDE their own wing, so nothing overhangs the shorter
    // neighbor's roof (that 15 cm overhang put coplanar slivers along every
    // step at roof level).
    const extMinX = gx === 0 || f >= P.colFloors[gx - 1];
    const extMaxX = gx === COLS - 1 || f >= P.colFloors[gx + 1];
    if (extMinX) {
      const perp = gx === 0 ? xMin : xMin + P.wallT / 2;
      addExteriorWall(blocks, faces, "z", zr0, zr1, perp, f, gx === 0 ? "envelope" : "step", false);
    }
    if (extMaxX) {
      const perp = gx === COLS - 1 ? xMax : xMax - P.wallT / 2;
      addExteriorWall(
        blocks, faces, "z", zr0, zr1, perp, f,
        gx === COLS - 1 ? "envelope" : "step", false,
      );
    }
    // INTERIOR partitioning is NO LONGER built here. The whole interior —
    // per-floor rooms, corridors, doors and their ceiling fixtures — is erected
    // by the partition layer (partition.ts) from the authored cell-grid plans
    // (floorplans.ts) and APPENDED into this wing's section, so each storey gets
    // its own enclosure instead of one open plate shared across every floor.
    // The shell keeps only what is fixed for the whole column: deck, columns,
    // exterior envelope/step walls, the stair cores, and the roof.
  }

  // ROOF — its own top plane (lift table), parapets and mechanical units
  // sitting flush ON that plane so they're support-connected, not floating.
  const roofTop = roofTopY(floors);
  addDeck(blocks, xMin, xMax, zMin, zMax, roofTop, "cladding");
  const parapet = (run: "x" | "z", perp: number, a0: number, a1: number): void => {
    const c = (a0 + a1) / 2;
    const len = a1 - a0;
    blocks.push(
      block(
        "cladding",
        run === "x" ? c : perp,
        roofTop,
        run === "x" ? perp : c,
        run === "x" ? len : P.wallT,
        0.55,
        run === "x" ? P.wallT : len,
      ),
    );
  };
  // x-parapets own the roof corners; z-parapets stop at their inner faces.
  if (back) parapet("x", zMin + P.wallT / 2, xMin, xMax);
  if (front) parapet("x", zMax - P.wallT / 2, xMin, xMax);
  const zp0 = zMin + (back ? P.wallT : 0);
  const zp1 = zMax - (front ? P.wallT : 0);
  if (gx === 0 || P.colFloors[gx - 1] < floors) parapet("z", xMin + P.wallT / 2, zp0, zp1);
  if (gx === COLS - 1 || P.colFloors[gx + 1] < floors) parapet("z", xMax - P.wallT / 2, zp0, zp1);
  if (floors === FLOORS_MAX) {
    const mx = (xMin + xMax) / 2 + ((gx + gz) % 2 === 0 ? -3 : 3);
    const mz = (zMin + zMax) / 2 + (((gz + 1) % 3) - 1) * 3;
    if (!overlapsVoid(mx, mz, 2.4, 1.7)) {
      blocks.push(block("metal", mx, roofTop, mz, 2.4, 1.3, 1.7));
      blocks.push(block("metal", mx + 1.9, roofTop, mz - 1.2, 1.1, 0.8, 1.1));
    }
  }

  return { name: `wing_${gx}${gz}`, blocks };
}

// ===========================================================================
// Stairwell — parametric switchback, sized to fit EXACTLY inside its reserved
// void. Geometry carried over from the play-proven builder (rise 0.3 < the
// 0.5 autostep, run 0.8 > capsule diameter, mid-landing + floor-landing per
// storey). Notes:
//  - shaft walls sit fully INSIDE the void (the old walls straddled the void
//    edge, so their tops z-fought the deck tops along a 15 cm strip);
//  - treads abut exactly (no overlap) so tread/landing tops — which share the
//    arrival plane by design — never overlap coplanar;
//  - ROOF ACCESS: the storey loop runs one flight past the top floor, into a
//    hollow stair head (the old solid penthouse cap) whose open side steps
//    out onto the roof deck — arrival landing top 25.20, roof top 25.24, a
//    4 cm autostep. Being on the roof means no ceiling: shelterExposureAt
//    correctly reads full exposure up there.
// ===========================================================================

function buildStairwell(
  cx: number,
  side: "A" | "B",
  addFixture: AddFixture,
  stairLights: StairLight[],
): SectionSpec {
  const blocks: BlockDef[] = [];
  const S = P.stairs;
  const H = P.floorHeight;
  const halfRise = H / 2;
  const rise = halfRise / S.stepsPerFlight;
  const treadThick = rise + 0.12;
  const landW = 2 * (S.laneOff + S.flightW / 2);
  const zFront = P.spineZ + S.hd;
  const zBack = P.spineZ - S.hd;
  const runFront = zFront - S.landingDepth;
  const runBack = zBack + S.landingDepth;
  const run = (runFront - runBack) / S.stepsPerFlight;

  // One extra storey past the top floor: the final flight arrives at the
  // roof plane inside the stair head (roof access).
  for (let f = 0; f < FLOORS_MAX; f++) {
    const yBase = f * H;
    const laneA = cx - S.laneOff;
    const laneB = cx + S.laneOff;
    // Half-flight up (lane A, front → back), abutting treads.
    for (let i = 1; i <= S.stepsPerFlight; i++) {
      const zc = runFront - (i - 0.5) * run;
      blocks.push(block("concrete", laneA, yBase + i * rise - treadThick, zc, S.flightW, treadThick, run));
    }
    // Mid-landing (back). Landings stop at the shaft walls' INNER faces:
    // their tops share the walking plane with the storey wall tops, so they
    // must abut the walls, never overlap them.
    const midZ0 = zBack + P.wallT;
    blocks.push(
      block("concrete", cx, yBase + halfRise - P.deckT, (midZ0 + runBack) / 2, landW, P.deckT, runBack - midZ0),
    );
    // Half-flight up (lane B, back → front).
    const baseB = yBase + halfRise;
    for (let i = 1; i <= S.stepsPerFlight; i++) {
      const zc = runBack + (i - 0.5) * run;
      blocks.push(block("concrete", laneB, baseB + i * rise - treadThick, zc, S.flightW, treadThick, run));
    }
    // Floor-landing (arrival at f+1) — its top IS the floor plane. Entry
    // to/from the wing floor is through the shaft's OPEN side (as before);
    // the landing abuts the front wall's inner face for support.
    const floorZ1 = zFront - P.wallT;
    blocks.push(
      block("concrete", cx, yBase + H - P.deckT, (runFront + floorZ1) / 2, landW, P.deckT, floorZ1 - runFront),
    );
    // GAP FILL — the landing (width landW) is narrower than the void (2·hw), so
    // a ~0.45 m slot opened on the OPEN side (toward the building center)
    // between the landing edge and the wing floor deck: exactly the stair↔deck
    // seam the player steps across at every arrival. Bridge it with a slab
    // flush at the floor plane. It abuts the landing (support) and stops at the
    // void edge (cx±hw) where the wing deck begins — abutment, not overlap, so
    // coplanar-overlap stays 0 and no new fall-through hole is opened.
    const openSign = cx < 0 ? 1 : -1; // walls are on the far side; center is open
    const fillW = S.hw - landW / 2;
    if (fillW > 0.02) {
      blocks.push(
        block(
          "concrete",
          cx + openSign * (landW / 2 + fillW / 2),
          yBase + H - P.deckT,
          (runFront + floorZ1) / 2,
          fillW,
          P.deckT,
          floorZ1 - runFront,
        ),
      );
    }
  }

  // FIXTURES — mounted flush under the underside of the arrival LANDING one
  // storey above (floors ≥ 1; floor 0 stays unlit by design). The old fixtures
  // floated at head height cantilevered off the front shaft wall — in an open
  // switchback shaft there is no ceiling there, so they read as hanging in
  // mid-air. Hung 6 cm under the landing slab above, each light reads as a real
  // ceiling fixture AND its liveness tracks that landing: anyIntactBlockNear
  // finds the concrete slab it hangs from (its mount) and the light dies
  // exactly when that flight/landing is torn out — the same local-enclosure
  // principle as the earlier floating-lights fix, pointed at the mount
  // structure rather than a distant durable deck.
  const mountZ = (runFront + (zFront - P.wallT)) / 2; // z of the arrival landing
  for (let f = 1; f < FLOORS_MAX; f++) {
    const landingBottom = (f + 1) * H - P.deckT; // arrival landing for floor f+1
    const idx = addFixture([cx - S.laneOff, landingBottom - 0.06, mountZ]);
    stairLights.push({ fixtureIndex: idx, stair: side, floor: f, mount: `f${f + 1} landing` });
  }

  // Shaft walls on 3 sides (open toward the building center), one block per
  // storey stacked flush — fully inside the void, so the surrounding decks
  // abut their outer faces and nothing shares a walking plane.
  const farX = cx < 0 ? cx - S.hw + P.wallT / 2 : cx + S.hw - P.wallT / 2;
  for (let f = 0; f < FLOORS_MAX; f++) {
    const base = f * H;
    const h = H; // storeys stack flush; wall tops stay inside the void's plan area
    blocks.push(block("concrete", cx, base, zBack + P.wallT / 2, 2 * S.hw, h, P.wallT));
    blocks.push(block("concrete", cx, base, zFront - P.wallT / 2, 2 * S.hw, h, P.wallT));
    blocks.push(block("concrete", farX, base, P.spineZ, P.wallT, h, 2 * S.hd - 2 * P.wallT));
  }
  // Stair HEAD (was a solid penthouse cap): the three shaft walls continue
  // 2.2 m above the roof plane with the open side kept open, roofed by a
  // slab resting flush on their tops — the final flight arrives inside and
  // the player steps out onto the roof deck.
  const headBase = FLOORS_MAX * H;
  blocks.push(block("concrete", cx, headBase, zBack + P.wallT / 2, 2 * S.hw, 2.2, P.wallT));
  blocks.push(block("concrete", cx, headBase, zFront - P.wallT / 2, 2 * S.hw, 2.2, P.wallT));
  blocks.push(block("concrete", farX, headBase, P.spineZ, P.wallT, 2.2, 2 * S.hd - 2 * P.wallT));
  blocks.push(block("cladding", cx, headBase + 2.2, P.spineZ, 2 * S.hw, 0.24, 2 * S.hd));
  // Roof-access head light: flush under the head's own roof slab (its mount).
  const headIdx = addFixture([cx - S.laneOff, headBase + 2.2 - 0.06, P.spineZ]);
  stairLights.push({ fixtureIndex: headIdx, stair: side, floor: FLOORS_MAX, mount: "head roof" });
  return { name: `stair_${side}`, blocks };
}

// ===========================================================================
// Entrance portico + ambulance bay + parking props (the surroundings).
// ===========================================================================

/** The entrance portico: a canopy on four columns at the front-center. */
function buildPortico(): SectionSpec {
  const blocks: BlockDef[] = [];
  for (const px of [-5.4, -1.8, 1.8, 5.4]) {
    blocks.push(block("concrete", px, 0, 3.9, 0.45, 3.4, 0.45));
  }
  blocks.push(block("cladding", 0, 3.4, 2.3, 13.6, 0.35, 4.6));
  return { name: "portico", blocks };
}

/** Ambulance bay: a flat canopy on four posts over the carved-out stall run
 *  east of the entrance drive (the vehicles themselves are Phase-2 props). */
function buildAmbulanceBay(): SectionSpec {
  const blocks: BlockDef[] = [];
  for (const [px, pz] of [[12, 3], [20, 3], [12, 6.4], [20, 6.4]]) {
    blocks.push(block("concrete", px, 0, pz, 0.4, 3.0, 0.4));
  }
  blocks.push(block("cladding", 16, 3.0, 4.7, 10.4, 0.3, 5.0));
  return { name: "ambulance_bay", blocks };
}

function buildCar(x: number, z: number, alongX: boolean): SectionSpec {
  const L = 4.4;
  const W = 1.9;
  const w = alongX ? L : W;
  const d = alongX ? W : L;
  return {
    name: "car",
    blocks: [block("car", x, 0, z, w, 0.8, d), block("car", x, 0.8, z, w * 0.6, 0.7, d * 0.9)],
  };
}

function buildPole(x: number, z: number, addFixture: AddFixture): SectionSpec {
  addFixture([x, 5.2, z]); // on the pole itself — dark once the pole is gone
  return { name: "pole", blocks: [block("metal", x, 0, z, 0.25, 5.5, 0.25)] };
}

function buildOutbuilding(cx: number, cz: number): SectionSpec {
  // Back/front x-walls own the corners; side walls and door jambs stop at
  // their inner faces (same abut-don't-overlap rule as the main building —
  // the old corner overlaps were a small real z-fight). Walls run up to the
  // roof's underside.
  const blocks: BlockDef[] = [];
  const hw = 3;
  const hd = 2.5;
  const t = 0.3;
  const roofTop = 3.12;
  const h = roofTop - 0.24;
  blocks.push(block("concrete", cx, 0, cz - hd, 2 * hw, h, t)); // back
  blocks.push(block("concrete", cx - hw, 0, cz, t, h, 2 * hd - t)); // sides
  blocks.push(block("concrete", cx + hw, 0, cz, t, h, 2 * hd - t));
  blocks.push(block("concrete", cx - hw + t / 2 + 0.825, 0, cz + hd, 1.65, h, t)); // door jambs
  blocks.push(block("concrete", cx + hw - t / 2 - 0.825, 0, cz + hd, 1.65, h, t));
  blocks.push(block("cladding", cx, h, cz, 2 * hw, 0.24, 2 * hd));
  return { name: "outbuilding", blocks };
}

function buildDumpster(x: number, z: number): SectionSpec {
  return { name: "dumpster", blocks: [block("metal", x, 0, z, 2.2, 1.5, 1.4)] };
}

function buildBarrier(x: number, z: number): SectionSpec {
  return { name: "barrier", blocks: [block("concrete", x, 0, z, 3, 0.9, 0.5)] };
}

// ===========================================================================
// Assembly.
// ===========================================================================

export function buildShell(opts: ShellOptions = {}): HospitalShell {
  const sections: SectionSpec[] = [];
  const lightFixtures: Fixture[] = [];
  const exteriorFaces: ExteriorFace[] = [];
  const stairLights: StairLight[] = [];
  const addFixture: AddFixture = (f) => lightFixtures.push(f) - 1;

  for (let gx = 0; gx < COLS; gx++) {
    for (let gz = 0; gz < P.rows; gz++) {
      sections.push(buildWing(gx, gz, exteriorFaces, opts));
    }
  }
  sections.push(buildStairwell(P.stairs.xs[0], "A", addFixture, stairLights));
  sections.push(buildStairwell(P.stairs.xs[1], "B", addFixture, stairLights));
  sections.push(buildPortico());
  sections.push(buildAmbulanceBay());

  // Parking lot. Row nearest the building keeps the entrance drive open and
  // the ambulance-bay stalls carved out.
  const carRows = [5.5, 15.5];
  for (const z of carRows) {
    let stall = 0;
    for (let x = -25.5; x <= 25.5; x += 2.7) {
      stall++;
      if (Math.abs(x) < (z === carRows[0] ? 7.5 : 2)) continue;
      if (z === carRows[0] && x > 9.5 && x < 22.5) continue; // ambulance bay
      if (stall % 6 === 0) continue;
      sections.push(buildCar(x, z, false));
    }
  }
  // Poles sit just OUTSIDE the stall rows (a pole inside a stall footprint
  // speared through its parked car — a pre-existing overlap the verifier caught).
  for (const [px, pz] of [[-27.7, 5.5], [27.7, 5.5], [-27.7, 15.5], [27.7, 15.5], [0, 10.5]]) {
    sections.push(buildPole(px, pz, addFixture));
  }
  sections.push(buildOutbuilding(-52, -56)); // clear of the deeper footprint
  for (const [dx, dz] of [[-30, 4], [-30, 6.5], [30, 13], [33, 13]]) {
    sections.push(buildDumpster(dx, dz));
  }
  // Drive bollards past the canopy (moved out of the glazed podium zone).
  for (const bx of [-6, 6]) {
    sections.push(buildBarrier(bx, 6.2));
  }

  return { sections, lightFixtures, exteriorFaces, stairLights };
}
