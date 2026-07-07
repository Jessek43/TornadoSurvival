/**
 * The hospital's SIZE DIAL and derived spatial grid — the single source of
 * spatial truth for the whole building. Every generator in shell.ts (and the
 * assertions in verify.ts) consults these; nothing computes its own idea of
 * where an edge, corridor, or stair void is.
 *
 * Change the building by changing HOSPITAL_PARAMS; everything below it is
 * derived. verify.ts re-checks the invariants (stairs walkable, windows
 * perimeter-only, no coplanar overlaps, full ground support) on every build,
 * so turning a dial can't silently break an integration.
 */

export const HOSPITAL_PARAMS = {
  /**
   * Ground footprint (m). The front wall sits at zMax = 0 (entrance faces the
   * parking lot and spawn at z > 0), so growth over the previous 56×40 m
   * building went north (−z) and sideways — the lot, spawn, and streets never
   * move. Center (0, −24) — GameConfig.hospitalCenter mirrors this by hand.
   */
  footprint: { xMin: -32, xMax: 32, zMin: -48, zMax: 0 },
  /** Storeys per wing COLUMN, west→east (stepped massing: lower outer wings). */
  colFloors: [5, 7, 7, 5],
  /** Wing rows (north–south divisions of the footprint). */
  rows: 3,
  floorHeight: 3.6,
  wallT: 0.3,
  /** Deck slab thickness. Decks are tiled (deckTile) so blocks stay liftable.
   *  5.4 → 3×3 tiles per 16 m wing floor (was 4×4): the "shell diet" that
   *  pays for the denser ward furnish under the 600-block section cap. */
  deckT: 0.24,
  deckTile: 5.4,
  /** Wall segment length — one wall block (or sill/glass/spandrel stack) each. */
  seg: 3.2,
  /** Window band, measured up from the wall base. The lobby glazes to the
   *  ceiling (no head) — its sill is lower too. */
  window: { sill: 0.9, head: 2.4, lobbySill: 0.3 },
  /** Fixture drop below the floor line — puts the emissive strip 2 cm inside
   *  the deck slab above it: reads as a recessed ceiling panel AND guarantees
   *  local enclosure (an intact deck within strandRange keeps it lit). */
  ceilGap: 0.22,
  /**
   * Z-FIGHT LIFT TABLE — every horizontal surface CLASS gets its own y-plane,
   * so no two same-facing surfaces that can overlap are ever coplanar:
   *   ground deck top = lifts.ground        (clears the Level ground at y=0)
   *   interior deck top = f · floorHeight
   *   roof deck top   = floors · floorHeight + lifts.roof
   *                     (clears a taller neighbor's interior deck plane)
   * Walls and columns run deck-top → next-deck-BOTTOM (see shell.ts), so wall
   * tops never share a plane with deck tops — the old interior flicker.
   */
  lifts: { ground: 0.06, roof: 0.04 },
  /** Corridors: one E–W spine along the middle row (both stairwells sit on
   *  it) + one N–S rib per wing column, plus the x=0 entrance axis, which is
   *  a wall-suppressed corridor zone rather than a walled corridor. */
  spineZ: -24,
  spineHW: 1.6,
  ribX: [-24, -10, 0, 10, 24],
  ribHW: 1.4,
  /** Extra clearance opened where two corridors cross (plaza, not a pinch). */
  crossPad: 0.6,
  /**
   * Furnish density backstop (Phase-2 detailing). Per-floor room COUNTS and
   * density now live in the authored FLOOR_LAYOUTS table (layouts.ts); these
   * are the per-wing block budgets each archetype is capped at (a throw fires
   * if a floor's furnish exceeds them), sized so the tallest wing stays under
   * the 600-block section cap in verify.ts with headroom. Turn these (or the
   * layout room counts) down if the runtime perf gate fails — never raise the
   * section cap instead.
   */
  furnish: {
    budgetPerFloor: { ward: 58, office: 46, entrance: 40 },
  },
  stairs: {
    /** Shaft centers — on the spine, at the ±10 rib positions (tall columns). */
    xs: [-10, 10],
    hw: 2.6, // shaft x half-width
    hd: 3.6, // shaft z half-depth
    /** 6 steps per half-flight → rise = floorHeight/2/6 = 0.3 m, safely under
     *  the player controller's 0.5 m autostep. verify.ts asserts this. */
    stepsPerFlight: 6,
    landingDepth: 1.2,
    flightW: 2.0,
    laneOff: 1.15, // the two flight lanes sit at shaft-center ± this
  },
};

const P = HOSPITAL_PARAMS;

export const COLS = P.colFloors.length;
export const FLOORS_MAX = Math.max(...P.colFloors);

/** Wing grid edges, derived evenly from the footprint. */
export const X_EDGES = Array.from(
  { length: COLS + 1 },
  (_, i) => P.footprint.xMin + ((P.footprint.xMax - P.footprint.xMin) * i) / COLS,
);
export const Z_EDGES = Array.from(
  { length: P.rows + 1 },
  (_, i) => P.footprint.zMin + ((P.footprint.zMax - P.footprint.zMin) * i) / P.rows,
);

export type Rect = { x0: number; x1: number; z0: number; z1: number };

/** Reserved stairwell voids (whole column of air, all floors). Decks clip
 *  around these; walls/columns skip them by EXTENT, never by center-point. */
export const VOID_RECTS: Rect[] = P.stairs.xs.map((cx) => ({
  x0: cx - P.stairs.hw,
  x1: cx + P.stairs.hw,
  z0: P.spineZ - P.stairs.hd,
  z1: P.spineZ + P.stairs.hd,
}));

/** Extent-aware void test: does the AABB centered (x,z), size (w,d), touch a
 *  reserved shaft? (A block whose center is outside but whose body overlaps
 *  correctly reads as intruding.) */
export function overlapsVoid(x: number, z: number, w = 0, d = 0): boolean {
  const hx = w / 2 + 0.02;
  const hz = d / 2 + 0.02;
  return VOID_RECTS.some(
    (v) => x + hx > v.x0 && x - hx < v.x1 && z + hz > v.z0 && z - hz < v.z1,
  );
}

/** Subtract every void rect from a candidate deck tile, returning the
 *  leftover rectangles — the floor that survives around the shaft, abutting
 *  it exactly (no overlap, no gap). */
export function clipRectToVoids(t: Rect): Rect[] {
  let rects: Rect[] = [t];
  for (const v of VOID_RECTS) {
    const next: Rect[] = [];
    for (const r of rects) {
      if (r.x1 <= v.x0 || r.x0 >= v.x1 || r.z1 <= v.z0 || r.z0 >= v.z1) {
        next.push(r); // no overlap
        continue;
      }
      if (r.x0 < v.x0) next.push({ x0: r.x0, x1: v.x0, z0: r.z0, z1: r.z1 }); // west
      if (r.x1 > v.x1) next.push({ x0: v.x1, x1: r.x1, z0: r.z0, z1: r.z1 }); // east
      const mx0 = Math.max(r.x0, v.x0);
      const mx1 = Math.min(r.x1, v.x1);
      if (r.z0 < v.z0) next.push({ x0: mx0, x1: mx1, z0: r.z0, z1: v.z0 }); // south band
      if (r.z1 > v.z1) next.push({ x0: mx0, x1: mx1, z0: v.z1, z1: r.z1 }); // north band
    }
    rects = next;
  }
  return rects.filter((r) => r.x1 - r.x0 > 0.1 && r.z1 - r.z0 > 0.1);
}

export const inSpine = (z: number): boolean => Math.abs(z - P.spineZ) <= P.spineHW;
export const inRib = (x: number): boolean => P.ribX.some((rx) => Math.abs(x - rx) <= P.ribHW);
export const inCorridor = (x: number, z: number): boolean => inSpine(z) || inRib(x);

// --- the surface-plane tables (see the lift-table comment above) ---

/** Top of the walking surface at floor f (interior floors sit on the exact
 *  floor line; the ground deck is lifted clear of the Level ground plane). */
export function deckTopY(f: number): number {
  return f === 0 ? P.lifts.ground : f * P.floorHeight;
}

/** Top of a wing's roof deck — lifted off the floor-line grid so a shorter
 *  wing's roof never shares a plane with a taller neighbor's interior deck. */
export function roofTopY(floors: number): number {
  return floors * P.floorHeight + P.lifts.roof;
}

/** Walls/columns are sandwiched between deck planes: base ON the deck top
 *  (never interpenetrating it — a wall sunk into the lifted ground deck put
 *  coplanar slivers at every deck edge). Support flows wall → deck → ground. */
export function wallBaseY(f: number): number {
  return deckTopY(f);
}

/** …and top at the deck-BOTTOM plane above — never at the deck-top plane,
 *  which is what used to z-fight along every wall line. One uniform formula:
 *  under a roof deck (lifted +0.04) the walls stop 0.04 short of its
 *  underside — inside the 5 cm support epsilon, so the roof still rests on
 *  them, and the top-storey walls of a SHORTER wing can never poke into a
 *  taller neighbor's floor slab across the massing step. */
export function wallTopY(f: number): number {
  return (f + 1) * P.floorHeight - P.deckT;
}

export type Fixture = [number, number, number];

/**
 * A stairwell ceiling light, tagged with what it is mounted under. Unlike the
 * anonymous corridor/room fixtures, these carry enough metadata for the debug
 * HUD to report, per floor, WHICH flight/landing each light hangs from and
 * whether it is still lit — the readout behind the "lights track the flight
 * above, not a distant deck" fix. `fixtureIndex` points into the flat
 * lightFixtures array (furnish only ever APPENDS after the stairs, so the
 * index stays valid), so InteriorLights.isLit(fixtureIndex) is its live state.
 */
export interface StairLight {
  fixtureIndex: number;
  stair: "A" | "B";
  /** Storey the light serves (its landing sits one floor below the mount). */
  floor: number;
  /** Human-readable mount target, e.g. "f3 landing" or "head roof". */
  mount: string;
}

/**
 * One furnished room, recorded by the furnish pass. verify.ts turns
 * ENTERABILITY into a build-time invariant with these: the door volume must
 * be empty, and a capsule-inflated flood-fill from the door must reach a
 * minimum free area (and, for facade rooms, the window wall).
 */
export interface RoomSpec {
  /** Interior clear rect (between wall inner faces), world coords. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Wall-base y of the room's floor. */
  base: number;
  /** Doorway center x and the door wall's z plane. */
  doorC: number;
  doorWallZ: number;
  /** z of the facade wall's inner face (windowed side) — facade rooms only. */
  windowZ?: number;
  kind: "facade" | "interior";
  /** What the room is furnished as (drives the §4 kitchen/room-count asserts). */
  content: "patient" | "office" | "kitchen";
  /** Storey the room sits on (for the per-floor room-count report). */
  floor: number;
  name: string;
}

/** One exterior wall run, recorded by the shell as it builds. This registry
 *  is the single source of truth for "perimeter": verify.ts asserts every
 *  glass block lies on one of these faces (the shelter-puzzle invariant). */
export interface ExteriorFace {
  run: "x" | "z"; // axis the wall runs along
  perp: number; // the wall's plane coordinate on the other axis
  a0: number;
  a1: number;
  floor: number;
  kind: "envelope" | "step"; // footprint edge, or exposed face of the stepped massing
}
