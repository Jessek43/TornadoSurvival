import type { MaterialId } from "./Materials";
import type { BlockDef, SectionSpec } from "./Blueprints";

/**
 * The neighborhood around the hospital — a small residential block that makes
 * the map read as a real place (tree-lined streets, houses, a couple of shops)
 * with the hospital as the tall centerpiece.
 *
 * Everything here is MORE SECTIONS for the existing StructureSystem: houses
 * and trees are ordinary SectionSpecs, so they instance, wake near the funnel,
 * break under wind, support-collapse, feed the debris pool, and re-sleep with
 * ZERO new engine code. The damage gradient comes from materials alone:
 * foliage(250) strips first, wood(400) houses flatten, brick(550) survives
 * grazes, hospital concrete(1600) endures.
 *
 * Layout (hospital envelope X[-32,32] × Z[-48,0]; player spawns at z=20):
 *  - Main street E–W at z≈24.5, just north of the parking lot (the player
 *    spawns on its south edge, hospital across the lot).
 *  - Two cross streets N–S at x=±40 flanking the hospital block.
 *  - Houses line the main street's north side and the cross streets' outer
 *    sides — enterable hollow shells (door gap + windows) so they work as
 *    risky secondary shelters via the existing shelterExposureAt probes.
 *  - Trees line the streets (mini-sections: trunk + 2 canopy blocks).
 *
 * Streets themselves are cheap flat planes (STREET_PATCHES, drawn by Level) —
 * paint, not geometry.
 */

// --- street geometry (shared with Level's ground painting) ---
const MAIN_Z = 24.5; // main street centerline
const STREET_W = 7;
const CROSS_X = 40; // |x| of the two N–S cross streets

export interface StreetPatch {
  x: number;
  z: number;
  w: number;
  d: number;
  color: number;
  /** Which tiled procedural texture Level paints this patch with (asphalt for
   *  the carriageway, concrete slabs for the sidewalk strips). */
  surface: "asphalt" | "sidewalk";
  /** Render height above the ground plane. Distinct layers keep overlapping
   *  paint from sharing a plane: the N–S cross streets pass OVER the E–W main
   *  street and its sidewalks, so they sit a hair higher and the depth buffer
   *  orders them cleanly (asphalt reads on top of the sidewalk at each corner)
   *  instead of z-fighting where they were coplanar. */
  y: number;
}

const ASPHALT = 0x232526;
const SIDEWALK = 0x45464a;
// Paint layers, each clearly separated so no two overlapping planes are coplanar.
const Y_STREET = 0.03; // main street + sidewalks (mutually non-overlapping)
const Y_CROSS = 0.045; // cross streets, drawn above where they cross the main street

/** Flat ground-paint rectangles for the streets + sidewalks (Level draws these). */
export const STREET_PATCHES: StreetPatch[] = [
  // Main street + its two sidewalk strips.
  { x: 0, z: MAIN_Z, w: 150, d: STREET_W, color: ASPHALT, surface: "asphalt", y: Y_STREET },
  { x: 0, z: MAIN_Z - STREET_W / 2 - 0.9, w: 150, d: 1.8, color: SIDEWALK, surface: "sidewalk", y: Y_STREET },
  { x: 0, z: MAIN_Z + STREET_W / 2 + 0.9, w: 150, d: 1.0, color: SIDEWALK, surface: "sidewalk", y: Y_STREET },
  // Cross streets (run from behind the houses down past the hospital); layered
  // above the main street so the crossing overlaps order cleanly, not z-fight.
  { x: -CROSS_X, z: -14, w: STREET_W, d: 90, color: ASPHALT, surface: "asphalt", y: Y_CROSS },
  { x: CROSS_X, z: -14, w: STREET_W, d: 90, color: ASPHALT, surface: "asphalt", y: Y_CROSS },
];

/** Author a block by its BOTTOM y (same helper style as Hospital.ts). */
function block(
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

// ---------------------------------------------------------------------------
// Houses
// ---------------------------------------------------------------------------

const STORY_H = 2.8;
const HW = 3.5; // half width along the facade
const HD = 4.0; // half depth
const T = 0.22; // wall thickness

// --- internal stair (a compact straight flight in the back-right corner,
//     reusing the hospital's abutting-tread pattern: rise < the 0.5 m autostep,
//     run > the capsule diameter, treads overlap the step below so there is no
//     gap). Each upper floor slab gets a matching hole cut over the flight so
//     the player climbs cleanly through — never a floating slab or a ceiling
//     bonk. All in the house's local (across, depth) frame, so it lands right
//     for every facing. ---
// Rise 0.35: the old 0.40 left only 0.10 m of autostep headroom (vs 0.5) and
// sat ABOVE the snap-to-ground distance, so the controller couldn't reliably
// track the flight (the "can't climb the house stairs" bug). 0.35 matches the
// margin the proven hospital stairs (0.30) get, and gentler steps ease the head
// clearance at the top of the flight — while still tiling the 2.8 m storey
// exactly (8 × 0.35). (§1)
const STAIR_RISE = 0.35; // < 0.5 m autostep, ≤ 0.45 m snap-to-ground
const STAIR_STEPS = Math.round(STORY_H / STAIR_RISE); // 8 → exactly one storey
const STAIR_RUN = 0.78; // > 0.7 m capsule diameter
const TREAD_T = STAIR_RISE + 0.12; // overlaps the step below (no gap)
const STAIR_W = 1.1; // tread width (across)
const STAIR_AC = HW - 0.9; // tread center, hard against the right wall
const STAIR_D0 = -HD + 0.55; // back edge of the bottom tread
const HOLE_A0 = HW - 1.6; // stair opening: across band
const HOLE_D0 = STAIR_D0 + STAIR_RUN; // solid slab under tread 1; open above tread 2+
const HOLE_D1 = STAIR_D0 + STAIR_STEPS * STAIR_RUN; // top tread far edge (= landing)

/**
 * One enterable house: a hollow shell with a door gap on the facing side, glass
 * windows on every storey's perimeter walls, 1–3 storeys joined by real
 * climbable stairs, and a stepped blocky gable roof. Furnished per floor
 * (living/kitchen ground, bedrooms above), varied by `style`. `facing` is the
 * axis-aligned direction the front door looks toward (+z/−z/+x/−x — no rotation
 * support in the block engine, so facades are built per-direction by swapping
 * axes).
 */
function buildHouse(
  cx: number,
  cz: number,
  facing: "+z" | "-z" | "+x" | "-x",
  stories: 1 | 2 | 3,
  wall: MaterialId,
  style: number,
): SectionSpec {
  const blocks: BlockDef[] = [];
  // Local frame: `f` = facing axis sign/axis, house is HW wide across the
  // facade and HD deep. Helper places a block given (across, depth) offsets
  // so one set of facade math serves all four directions.
  const alongX = facing === "+x" || facing === "-x";
  const sign = facing === "+z" || facing === "+x" ? 1 : -1;
  const put = (
    mat: MaterialId,
    across: number,
    bottom: number,
    depth: number,
    wAcross: number,
    h: number,
    wDepth: number,
  ): void => {
    if (alongX) blocks.push(block(mat, cx + depth * sign, bottom, cz + across, wDepth, h, wAcross));
    else blocks.push(block(mat, cx + across, bottom, cz + depth * sign, wAcross, h, wDepth));
  };

  for (let s = 0; s < stories; s++) {
    const y = s * STORY_H;

    // FRONT (facing) wall: door gap on the ground floor, window above.
    if (s === 0) {
      put(wall, -HW / 2 - 0.35, y, HD, HW - 0.7, STORY_H, T); // left of door
      put(wall, HW / 2 + 0.35, y, HD, HW - 0.7, STORY_H, T); // right of door
      put(wall, 0, y + 2.1, HD, 1.4, STORY_H - 2.1, T); // header over the door
    } else {
      put(wall, -HW + 1, y, HD, 2, STORY_H, T);
      put(wall, HW - 1, y, HD, 2, STORY_H, T);
      put(wall, 0, y, HD, 3, 0.9, T); // sill
      put("glass", 0, y + 0.9, HD, 3, 1.1, T); // front window
      put(wall, 0, y + 2.0, HD, 3, STORY_H - 2.0, T); // header
    }

    // BACK wall: solid with one window.
    put(wall, -HW + 1, y, -HD, 2, STORY_H, T);
    put(wall, HW - 1, y, -HD, 2, STORY_H, T);
    put(wall, 0, y, -HD, 3, 0.9, T);
    put("glass", 0, y + 0.9, -HD, 3, 1.1, T);
    put(wall, 0, y + 2.0, -HD, 3, STORY_H - 2.0, T);

    // SIDE walls: one window each side.
    for (const side of [-1, 1]) {
      const across = side * HW;
      // (side walls run along the DEPTH axis: swap roles of the put() args)
      const putSide = (mat: MaterialId, depth: number, bottom: number, wDepth: number, h: number): void => {
        if (alongX) blocks.push(block(mat, cx + depth * sign, bottom, cz + across, wDepth, h, T));
        else blocks.push(block(mat, cx + across, bottom, cz + depth * sign, T, h, wDepth));
      };
      putSide(wall, -HD + 1.25, y, 2.5, STORY_H);
      putSide(wall, HD - 1.25, y, 2.5, STORY_H);
      putSide(wall, 0, y, 3, 0.9);
      putSide("glass", 0, y + 0.9, 3, 1.1);
      putSide(wall, 0, y + 2.0, 3, STORY_H - 2.0);
    }

    // Upper floor slab (top face at the floor line y), with a hole cut over the
    // stairwell so the flight below reaches it. Three pieces around the hole,
    // each still resting on the walls below, so nothing is unsupported and the
    // next flight up starts on the solid back piece.
    if (s > 0) {
      put(wall, (-HW + HOLE_A0) / 2, y - 0.24, 0, HOLE_A0 + HW, 0.24, 2 * HD); // left of hole
      put(wall, (HOLE_A0 + HW) / 2, y - 0.24, (HOLE_D1 + HD) / 2, HW - HOLE_A0, 0.24, HD - HOLE_D1); // front of hole
      put(wall, (HOLE_A0 + HW) / 2, y - 0.24, (-HD + HOLE_D0) / 2, HW - HOLE_A0, 0.24, HOLE_D0 + HD); // behind hole
    }
  }

  // Stairs — one flight per storey gap, stacked in the same back-right corner.
  for (let k = 0; k < stories - 1; k++) {
    for (let i = 1; i <= STAIR_STEPS; i++) {
      const dep = STAIR_D0 + (i - 0.5) * STAIR_RUN;
      put("wood", STAIR_AC, k * STORY_H + i * STAIR_RISE - TREAD_T, dep, STAIR_W, TREAD_T, STAIR_RUN);
    }
  }

  // Furniture per floor: living/kitchen on the ground floor, bedrooms above,
  // the top floor a study or spare bedroom by `style`. All kept in the left
  // half, clear of the stair opening on the right.
  for (let s = 0; s < stories; s++) {
    const kind: "living" | "bed" | "study" =
      s === 0 ? "living" : s === 1 ? "bed" : style % 2 === 0 ? "study" : "bed";
    furnishHouseLevel(put, s * STORY_H, kind);
  }

  // Stepped blocky gable roof (wood — light, tears off early like real roofs).
  const roofY = stories * STORY_H;
  const steps: [number, number][] = alongX
    ? [
        [2 * HD + 0.6, 2 * HW + 0.6],
        [2 * HD * 0.62, 2 * HW + 0.4],
        [2 * HD * 0.3, 2 * HW + 0.2],
      ]
    : [
        [2 * HW + 0.6, 2 * HD + 0.6],
        [2 * HW * 0.62, 2 * HD + 0.4],
        [2 * HW * 0.3, 2 * HD + 0.2],
      ];
  let ry = roofY - 0.05;
  for (const [w, d] of steps) {
    blocks.push(block("wood", cx, ry, cz, w, 0.34, d));
    ry += 0.34;
  }

  // Front porch: a near-flush threshold slab (§1 — was a 0.18 m raised lip that
  // the player reported having to jump; dropped to a 0.06 m pad so the door is a
  // flush step-through and entry never depends on the autostep clearing a lip)
  // + two thin posts flanking the door.
  put("wood", 0, 0, HD + 0.9, 3, 0.06, 1.8);
  put("wood", -1.2, 0, HD + 1.6, 0.18, 2.3, 0.18);
  put("wood", 1.2, 0, HD + 1.6, 0.18, 2.3, 0.18);
  put("wood", 0, 2.3, HD + 1.0, 3.2, 0.16, 2.2); // porch roof

  return { name: "house", blocks };
}

/** `put` in the house's local (across, depth) frame — see buildHouse. */
type PutFn = (
  mat: MaterialId,
  across: number,
  bottom: number,
  depth: number,
  wAcross: number,
  h: number,
  wDepth: number,
) => void;

/**
 * Furnish one house floor, all in the LEFT half (across ≤ ~0) so it never
 * fouls the right-side stair opening or the door path. Freestanding on the
 * floor (released with the house by the per-section support flood-fill, and
 * pooled by the same debris caps as every other block). Living/kitchen on the
 * ground, a bedroom above, a study or spare bedroom on the top floor.
 */
function furnishHouseLevel(put: PutFn, y: number, kind: "living" | "bed" | "study"): void {
  if (kind === "living") {
    put("propWhite", -HW + 0.45, y, -0.6, 0.6, 0.85, 3.2); // kitchen counter base
    put("metal", -HW + 0.45, y + 0.85, -0.6, 0.62, 0.06, 3.2); // steel worktop
    put("metal", -HW + 0.5, y, -2.95, 0.72, 1.75, 0.7); // fridge
    put("furniture", -1.1, y, 2.3, 2.0, 0.7, 0.85); // sofa
    put("wood", -1.1, y, 1.1, 1.0, 0.4, 0.6); // coffee table
    put("wood", -1.1, y, 3.45, 1.3, 0.5, 0.35); // TV stand
    put("accentBlue", -1.1, y + 0.5, 3.45, 1.15, 0.62, 0.06); // TV screen (rests on the stand)
  } else if (kind === "bed") {
    put("wood", -1.7, y, -1.9, 1.7, 0.5, 2.1); // bed frame
    put("propWhite", -1.7, y + 0.5, -1.9, 1.55, 0.25, 2.0); // bedding
    put("propWhite", -0.35, y, -3.15, 0.5, 0.5, 0.5); // nightstand
    put("wood", -HW + 0.45, y, 1.7, 0.6, 1.9, 1.3); // wardrobe
    put("wood", -1.2, y, 3.35, 1.5, 0.9, 0.45); // dresser
  } else {
    put("propWhite", -2.5, y, -2.6, 1.5, 0.72, 0.7); // desk
    put("wood", -2.5, y + 0.72, -2.6, 1.6, 0.06, 0.8); // desk top
    put("furniture", -2.5, y, -1.7, 0.5, 0.9, 0.5); // desk chair
    put("wood", -HW + 0.4, y, 1.2, 0.5, 1.9, 2.4); // bookshelf
    put("furniture", -1.1, y, 3.0, 1.9, 0.55, 0.8); // day bed
  }
}

/** A small flat-roofed commercial box (corner shop) with a glazed front. */
function buildShop(cx: number, cz: number): SectionSpec {
  const blocks: BlockDef[] = [];
  const hw = 5;
  const hd = 4;
  const h = 3.4;
  // Back + side walls (brick).
  blocks.push(block("brick", cx, 0, cz - hd, 2 * hw, h, 0.25));
  blocks.push(block("brick", cx - hw, 0, cz, 0.25, h, 2 * hd));
  blocks.push(block("brick", cx + hw, 0, cz, 0.25, h, 2 * hd));
  // Storefront: glass band between brick piers, door gap in the middle.
  blocks.push(block("brick", cx - hw + 0.6, 0, cz + hd, 1.2, h, 0.25));
  blocks.push(block("brick", cx + hw - 0.6, 0, cz + hd, 1.2, h, 0.25));
  blocks.push(block("glass", cx - 2.6, 0.3, cz + hd, 3.4, 2.2, 0.25));
  blocks.push(block("glass", cx + 2.6, 0.3, cz + hd, 3.4, 2.2, 0.25));
  blocks.push(block("brick", cx, 2.5, cz + hd, 2 * hw - 1.2, h - 2.5, 0.25)); // fascia
  // Flat roof + parapet lip.
  blocks.push(block("cladding", cx, h - 0.12, cz, 2 * hw, 0.24, 2 * hd));
  blocks.push(block("brick", cx, h + 0.12, cz - hd + 0.15, 2 * hw, 0.5, 0.3));
  // Interior: sales counter + two stocked shelves abutting the back wall.
  blocks.push(block("wood", cx - 1.5, 0, cz + hd - 2.2, 3, 1.0, 0.6));
  blocks.push(block("wood", cx, 1.2, cz - hd + 0.35, 2 * hw - 1.6, 0.3, 0.45));
  blocks.push(block("wood", cx, 2.0, cz - hd + 0.35, 2 * hw - 1.6, 0.3, 0.45));
  return { name: "shop", blocks };
}

// ---------------------------------------------------------------------------
// Trees (mini-sections — full physical destruction via StructureSystem)
// ---------------------------------------------------------------------------

/**
 * One tree = 3 blocks: a trunk touching the ground and two stacked canopy
 * boxes. The existing support flood-fill gives snapping/uprooting for free:
 * wind beats foliage(250) → canopy tears off into flying debris; beats
 * trunk(500) → the trunk shears and the rest collapses. `sway: true` opts the
 * canopy into StructureSystem's wind-sway pass while the section is awake.
 */
function buildTree(cx: number, cz: number, scale: number): SectionSpec {
  const s = scale;
  return {
    name: "tree",
    sway: true,
    blocks: [
      block("trunk", cx, 0, cz, 0.45 * s, 3.0 * s, 0.45 * s),
      block("foliage", cx, 2.4 * s, cz, 2.9 * s, 2.3 * s, 2.9 * s),
      block("foliage", cx, 4.7 * s, cz, 1.9 * s, 1.5 * s, 1.9 * s),
    ],
  };
}

// ---------------------------------------------------------------------------
// Keeping trees clear of buildings
// ---------------------------------------------------------------------------

export interface Footprint {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** XZ bounding box of a section's blocks — the widest extent, so a tree's box
 *  is its canopy and a house's is its roof eave / porch, not just the walls.
 *  Exported so the world build (Game) + verify:terrain can derive the pad mask
 *  and per-section ground lift from the same footprints the tree-nudge uses. */
export function footprintXZ(spec: SectionSpec): Footprint {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of spec.blocks) {
    const hw = b.size[0] / 2;
    const hd = b.size[2] / 2;
    x0 = Math.min(x0, b.position[0] - hw);
    x1 = Math.max(x1, b.position[0] + hw);
    z0 = Math.min(z0, b.position[2] - hd);
    z1 = Math.max(z1, b.position[2] + hd);
  }
  return { x0, x1, z0, z1 };
}

/** Do two footprints come within `m` of each other (overlap, or gap < m)? */
function tooClose(a: Footprint, b: Footprint, m: number): boolean {
  return a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.z0 < b.z1 + m && a.z1 > b.z0 - m;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random in [0,1) from an integer seed (stable layout). */
function prand(seed: number): number {
  return (((seed * 2654435761) >>> 0) % 1000) / 1000;
}

/**
 * Build the whole neighborhood. Sections are appended AFTER the hospital's in
 * Game.ts (fixture→section indices point into the hospital range, so order
 * matters — hospital first).
 */
/** Vary house height 1–3 storeys deterministically from a seed. */
function pickStories(seed: number): 1 | 2 | 3 {
  const r = prand(seed);
  return r < 0.32 ? 1 : r < 0.7 ? 2 : 3;
}

export function buildNeighborhood(): SectionSpec[] {
  const sections: SectionSpec[] = [];

  // --- houses on the main street's north side, facing the street (−z) ---
  // Gaps left open: the center entrance axis (|x|<8), the cross streets
  // (|x|≈40), and the shop lots (|x|≈28).
  const mainRowZ = MAIN_Z + STREET_W / 2 + 9; // front wall ~5.5 m behind the sidewalk
  const mainXs = [-62, -50, -14, 14, 50, 62];
  mainXs.forEach((x, i) => {
    const wall: "wood" | "brick" = prand(i + 11) > 0.5 ? "brick" : "wood";
    sections.push(buildHouse(x, mainRowZ, "-z", pickStories(i + 3), wall, i));
  });

  // --- houses on the cross streets' outer sides, facing the street ---
  for (const side of [-1, 1]) {
    const x = side * (CROSS_X + 10);
    let i = 0;
    for (const z of [10, -8, -26]) {
      const seed = i++ + (side + 2) * 7;
      sections.push(buildHouse(x, z, side < 0 ? "+x" : "-x", pickStories(seed), "wood", seed));
    }
  }

  // --- two corner shops flanking the main street (in the ±26..33 gaps) ---
  sections.push(buildShop(-28, mainRowZ - 3.5));
  sections.push(buildShop(28, mainRowZ - 3.5));

  // Every building is now placed; snapshot their footprints so the trees below
  // can be kept clear of them. Trees are decorative sections appended AFTER, so
  // nudging or dropping one never disturbs the hospital's fixture→section
  // indices (those point only into the hospital range).
  const buildings = sections.map(footprintXZ);
  const TREE_CLEAR = 0.4; // gap a tree keeps from any wall / porch / eave
  const MAX_NUDGE = 2.5; // shove a colliding tree at most this far, else drop it

  /** Place a street tree — but first shove it out of any building it lands in
   *  (minimum-translation along the shallower axis, iterated so a push out of
   *  one building doesn't leave it inside another). If it still can't clear
   *  within MAX_NUDGE it is dropped, so a tree never grows through a house. */
  const addTree = (cx: number, cz: number, s: number): void => {
    const spec = buildTree(cx, cz, s);
    let dx = 0, dz = 0; // total displacement applied to clear buildings
    for (let iter = 0; iter < 6; iter++) {
      const f = footprintXZ(spec);
      const hit = buildings.find((b) => tooClose(f, b, TREE_CLEAR));
      if (!hit) break;
      const penX = Math.min(f.x1, hit.x1) - Math.max(f.x0, hit.x0) + TREE_CLEAR;
      const penZ = Math.min(f.z1, hit.z1) - Math.max(f.z0, hit.z0) + TREE_CLEAR;
      let mx = 0, mz = 0;
      if (penX < penZ) mx = ((f.x0 + f.x1) / 2 < (hit.x0 + hit.x1) / 2 ? -1 : 1) * penX;
      else mz = ((f.z0 + f.z1) / 2 < (hit.z0 + hit.z1) / 2 ? -1 : 1) * penZ;
      dx += mx;
      dz += mz;
      for (const b of spec.blocks) {
        b.position[0] += mx;
        b.position[2] += mz;
      }
    }
    // Dropped if it wandered too far or still clips a building after the budget.
    if (Math.hypot(dx, dz) > MAX_NUDGE) return;
    if (buildings.some((b) => tooClose(footprintXZ(spec), b, TREE_CLEAR))) return;
    sections.push(spec);
  };

  // --- street trees ---
  let seed = 100;
  const jit = (): number => prand(seed++) * 2 - 1;
  const scale = (): number => 0.85 + prand(seed++) * 0.4;
  // North side of the main street: in the lawn gaps BETWEEN houses/shops.
  for (const x of [-56, -34, -20, 0, 20, 34, 56]) {
    addTree(x + jit(), MAIN_Z + STREET_W / 2 + 2.6, scale());
  }
  // South side: only outside the parking-lot span so the lot/spawn stays open.
  for (const x of [-64, -55, -46, -34, 34, 46, 55, 64]) {
    addTree(x + jit(), MAIN_Z - STREET_W / 2 - 2.4, scale());
  }
  // Cross streets, inner row (between the hospital block and the street).
  // Pushed out to ±36.6 and extended north for the 64×48 footprint: ≥3 m of
  // trunk clearance to the ±32 wall, and the row still flanks the full depth.
  for (const side of [-1, 1]) {
    for (let z = -52; z <= 16; z += 10) {
      addTree(side * (CROSS_X - 3.4) + jit() * 0.5, z + jit() * 1.5, scale());
    }
  }
  // Cross streets, outer row (in the gaps between the cross-street houses).
  for (const side of [-1, 1]) {
    for (const z of [-40, -17, 1, 18]) {
      addTree(side * (CROSS_X + 5.2) + jit() * 0.5, z + jit(), scale());
    }
  }
  // A few scattered backyard trees behind the main-street houses.
  for (const x of [-58, -33, -8, 21, 44, 60]) {
    addTree(x + jit() * 2, mainRowZ + 9 + prand(seed++) * 4, scale());
  }

  return sections;
}
