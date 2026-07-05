import type { MaterialId } from "./Materials";

/**
 * Data-only structure layouts. A blueprint is just "which boxes, where,
 * out of what" — StructureSystem turns it into meshes and colliders.
 *
 * Authoring rules that destruction (step 4) relies on:
 *  - Blocks that should hold each other up must overlap or touch (their
 *    AABBs within ~4 cm) — that's how the support graph finds neighbors.
 *  - Anything not connected to a ground-touching block through that graph
 *    will fall the moment the structure wakes and something breaks.
 */

export interface BlockDef {
  /** Block center in structure-local coordinates (y up, ground at y = 0). */
  position: [number, number, number];
  /** Full extents (width, height, depth) in meters. */
  size: [number, number, number];
  material: MaterialId;
}

/** Axis-aligned box the player can climb while inside it (tower ladder). */
export interface ClimbVolume {
  position: [number, number, number];
  size: [number, number, number];
}

export interface StructureBlueprint {
  name: string;
  blocks: BlockDef[];
  climbVolumes?: ClimbVolume[];
}

/** Where a blueprint is stamped into the yard (axis-aligned, no rotation in v1). */
export interface StructurePlacement {
  blueprint: keyof typeof BLUEPRINTS;
  x: number;
  z: number;
}

/**
 * A destructible SECTION — the unit StructureSystem turns into one
 * independently-waking, -breaking, -collapsing StructureRuntime. Blocks are
 * in WORLD space (unlike a blueprint's local coords). The yard is a handful
 * of one-section structures; the hospital is many sections (wings + core +
 * cars) sharing this same type. See level/Hospital.ts.
 */
export interface SectionSpec {
  name: string;
  /** World-space blocks. */
  blocks: BlockDef[];
  /** World-space climb volumes (stairwell / ladder). */
  climbVolumes?: ClimbVolume[];
  /** Tree sections: wind-sway their canopy blocks while awake (see
   *  StructureSystem's sway pass — an update-LOD, only near-funnel trees move). */
  sway?: boolean;
}

/** Expand yard placements into world-space section specs (one per placement). */
export function placementsToSections(placements: StructurePlacement[]): SectionSpec[] {
  return placements.map((p) => {
    const bp = BLUEPRINTS[p.blueprint];
    return {
      name: bp.name,
      blocks: bp.blocks.map((blk) => ({
        material: blk.material,
        size: blk.size,
        position: [blk.position[0] + p.x, blk.position[1], blk.position[2] + p.z],
      })),
      climbVolumes: bp.climbVolumes?.map((v) => ({
        size: v.size,
        position: [v.position[0] + p.x, v.position[1], v.position[2] + p.z],
      })),
    };
  });
}

/** Helper: author blocks by their BOTTOM y (easier to stack), store center y. */
function b(
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

/**
 * Scaffold tower — the "climb for visibility, become a target" option.
 * 3×3 m footprint, ~10 m tall: 4 posts in 3 stacked segments (so the tornado
 * can shear it mid-height), braces, a 4-slab platform, parapet rails, and a
 * ladder up the +Z face.
 */
function buildTower(): StructureBlueprint {
  const blocks: BlockDef[] = [];

  // 4 corner posts × 3 stacked segments
  for (const sx of [-1.35, 1.35]) {
    for (const sz of [-1.35, 1.35]) {
      for (const level of [0, 3.2, 6.4]) {
        blocks.push(b("metal", sx, level, sz, 0.3, 3.2, 0.3));
      }
    }
  }

  // Horizontal brace rings near the top of segments 1 and 2
  for (const y of [2.95, 6.15]) {
    blocks.push(b("metal", 0, y, -1.35, 3.0, 0.25, 0.3));
    blocks.push(b("metal", 0, y, 1.35, 3.0, 0.25, 0.3));
    blocks.push(b("metal", -1.35, y, 0, 0.3, 0.25, 3.0));
    blocks.push(b("metal", 1.35, y, 0, 0.3, 0.25, 3.0));
  }

  // Platform: 4 slabs resting on the post tops (floor top at y ≈ 9.85)
  for (const px of [-0.8, 0.8]) {
    for (const pz of [-0.8, 0.8]) {
      blocks.push(b("metal", px, 9.6, pz, 1.7, 0.25, 1.7));
    }
  }

  // Parapet rails sitting ON the platform (so the support graph keeps them),
  // on 3 edges — the ladder edge (+Z) stays open.
  blocks.push(b("metal", 0, 9.85, -1.55, 3.4, 0.5, 0.12));
  blocks.push(b("metal", -1.55, 9.85, 0, 0.12, 0.5, 3.4));
  blocks.push(b("metal", 1.55, 9.85, 0, 0.12, 0.5, 3.4));

  // Ladder: two rails ground→platform edge + chunky rungs
  for (const rx of [-0.45, 0.45]) {
    blocks.push(b("metal", rx, 0, 1.62, 0.1, 9.85, 0.1));
  }
  for (let i = 1; i <= 8; i++) {
    blocks.push(b("metal", 0, i * 1.1, 1.62, 1.0, 0.1, 0.1));
  }

  return {
    name: "tower",
    blocks,
    // Extends ~1.5 m above the platform floor so the player's feet clear the
    // deck before the climb ends and they can walk forward onto it.
    climbVolumes: [{ position: [0, 5.7, 1.8], size: [1.6, 11.4, 1.6] }],
  };
}

/**
 * Flimsy wooden shed — shelter that will NOT hold. Thin plank panels with a
 * door gap on −Z; low break threshold, splits on release.
 */
function buildWoodShed(): StructureBlueprint {
  const blocks: BlockDef[] = [];

  // Side walls (2 panels each)
  for (const sx of [-2.075, 2.075]) {
    for (const sz of [-1.25, 1.25]) {
      blocks.push(b("wood", sx, 0, sz, 0.15, 2.4, 2.5));
    }
  }
  // Back wall
  for (const wx of [-1.05, 1.05]) {
    blocks.push(b("wood", wx, 0, 2.425, 2.1, 2.4, 0.15));
  }
  // Front wall with a door gap + header
  for (const wx of [-1.45, 1.45]) {
    blocks.push(b("wood", wx, 0, -2.425, 1.2, 2.4, 0.15));
  }
  blocks.push(b("wood", 0, 1.8, -2.425, 1.7, 0.6, 0.15));
  // Roof (3 slabs)
  for (const rz of [-1.65, 0, 1.65]) {
    blocks.push(b("wood", 0, 2.4, rz, 4.6, 0.15, 1.75));
  }

  return { name: "woodShed", blocks };
}

/**
 * Concrete shelter — the sturdy, low option. Thick walls in few big blocks;
 * high break threshold so it sheds pieces near the core but mostly holds.
 */
function buildConcreteShelter(): StructureBlueprint {
  const blocks: BlockDef[] = [];

  // Side walls (2 blocks each)
  for (const sx of [-1.55, 1.55]) {
    for (const sz of [-1.1, 1.1]) {
      blocks.push(b("concrete", sx, 0, sz, 0.3, 2.0, 2.2));
    }
  }
  // Back wall
  for (const wx of [-0.7, 0.7]) {
    blocks.push(b("concrete", wx, 0, 2.05, 1.4, 2.0, 0.3));
  }
  // Front wall with entrance gap
  for (const wx of [-1.15, 1.15]) {
    blocks.push(b("concrete", wx, 0, -2.05, 1.1, 2.0, 0.3));
  }
  // Roof (2 slabs)
  for (const rz of [-1.1, 1.1]) {
    blocks.push(b("concrete", 0, 2.0, rz, 3.4, 0.3, 2.2));
  }

  return { name: "concreteShelter", blocks };
}

/** Loose wooden crate — future debris/projectile. */
function buildCrate(): StructureBlueprint {
  return { name: "crate", blocks: [b("wood", 0, 0, 0, 1, 1, 1)] };
}

export const BLUEPRINTS = {
  tower: buildTower(),
  woodShed: buildWoodShed(),
  concreteShelter: buildConcreteShelter(),
  crate: buildCrate(),
} as const;
