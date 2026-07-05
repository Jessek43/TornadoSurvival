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
 * Layout (hospital envelope X[-28,28] × Z[-40,0]; player spawns at z=20):
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
}

const ASPHALT = 0x232526;
const SIDEWALK = 0x45464a;

/** Flat ground-paint rectangles for the streets + sidewalks (Level draws these). */
export const STREET_PATCHES: StreetPatch[] = [
  // Main street + its two sidewalk strips.
  { x: 0, z: MAIN_Z, w: 150, d: STREET_W, color: ASPHALT },
  { x: 0, z: MAIN_Z - STREET_W / 2 - 0.9, w: 150, d: 1.8, color: SIDEWALK },
  { x: 0, z: MAIN_Z + STREET_W / 2 + 0.9, w: 150, d: 1.8, color: SIDEWALK },
  // Cross streets (run from behind the houses down past the hospital).
  { x: -CROSS_X, z: -14, w: STREET_W, d: 90, color: ASPHALT },
  { x: CROSS_X, z: -14, w: STREET_W, d: 90, color: ASPHALT },
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

/**
 * One enterable house: hollow shell with a door gap on the facing side, glass
 * windows, a second-story slab when 2-story, and a stepped blocky gable roof.
 * `facing` is the axis-aligned direction the front door looks toward
 * (+z/−z/+x/−x — no rotation support in the block engine, so facades are
 * built per-direction by swapping axes).
 */
function buildHouse(
  cx: number,
  cz: number,
  facing: "+z" | "-z" | "+x" | "-x",
  stories: 1 | 2,
  wall: MaterialId,
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

    // Second-story floor slab (rests on the walls below).
    if (s > 0) put(wall, 0, y - 0.12, 0, 2 * HW, 0.24, 2 * HD);
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

  // Front porch: slab + two thin posts flanking the door.
  put("wood", 0, 0, HD + 0.9, 3, 0.18, 1.8);
  put("wood", -1.2, 0, HD + 1.6, 0.18, 2.3, 0.18);
  put("wood", 1.2, 0, HD + 1.6, 0.18, 2.3, 0.18);
  put("wood", 0, 2.3, HD + 1.0, 3.2, 0.16, 2.2); // porch roof

  return { name: "house", blocks };
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
export function buildNeighborhood(): SectionSpec[] {
  const sections: SectionSpec[] = [];

  // --- houses on the main street's north side, facing the street (−z) ---
  // Gaps left open: the center entrance axis (|x|<8), the cross streets
  // (|x|≈40), and the shop lots (|x|≈28).
  const mainRowZ = MAIN_Z + STREET_W / 2 + 9; // front wall ~5.5 m behind the sidewalk
  const mainXs = [-62, -50, -14, 14, 50, 62];
  mainXs.forEach((x, i) => {
    const stories: 1 | 2 = prand(i + 3) > 0.45 ? 2 : 1;
    const wall: "wood" | "brick" = prand(i + 11) > 0.5 ? "brick" : "wood";
    sections.push(buildHouse(x, mainRowZ, "-z", stories, wall));
  });

  // --- houses on the cross streets' outer sides, facing the street ---
  for (const side of [-1, 1]) {
    const x = side * (CROSS_X + 10);
    let i = 0;
    for (const z of [10, -8, -26]) {
      const stories: 1 | 2 = prand(i++ + (side + 2) * 7) > 0.5 ? 2 : 1;
      sections.push(buildHouse(x, z, side < 0 ? "+x" : "-x", stories, "wood"));
    }
  }

  // --- two corner shops flanking the main street (in the ±26..33 gaps) ---
  sections.push(buildShop(-28, mainRowZ - 3.5));
  sections.push(buildShop(28, mainRowZ - 3.5));

  // --- street trees ---
  let seed = 100;
  const jit = (): number => prand(seed++) * 2 - 1;
  const scale = (): number => 0.85 + prand(seed++) * 0.4;
  // North side of the main street: in the lawn gaps BETWEEN houses/shops.
  for (const x of [-56, -34, -20, 0, 20, 34, 56]) {
    sections.push(buildTree(x + jit(), MAIN_Z + STREET_W / 2 + 2.6, scale()));
  }
  // South side: only outside the parking-lot span so the lot/spawn stays open.
  for (const x of [-64, -55, -46, -34, 34, 46, 55, 64]) {
    sections.push(buildTree(x + jit(), MAIN_Z - STREET_W / 2 - 2.4, scale()));
  }
  // Cross streets, inner row (between the hospital block and the street).
  for (const side of [-1, 1]) {
    for (let z = -44; z <= 16; z += 10) {
      sections.push(buildTree(side * (CROSS_X - 4.6) + jit() * 0.5, z + jit() * 1.5, scale()));
    }
  }
  // Cross streets, outer row (in the gaps between the cross-street houses).
  for (const side of [-1, 1]) {
    for (const z of [-40, -17, 1, 18]) {
      sections.push(buildTree(side * (CROSS_X + 5.2) + jit() * 0.5, z + jit(), scale()));
    }
  }
  // A few scattered backyard trees behind the main-street houses.
  for (const x of [-58, -33, -8, 21, 44, 60]) {
    sections.push(buildTree(x + jit() * 2, mainRowZ + 9 + prand(seed++) * 4, scale()));
  }

  return sections;
}
