import { HOSPITAL_PARAMS as P, COLS, VOID_RECTS } from "./params";

/**
 * THE MODULE CELL GRID — the spatial vocabulary the per-floor interior layer
 * is authored and verified on. The shell (shell.ts) owns the structural
 * envelope, cores, decks, columns and stairs in world coordinates; this grid
 * is the SEPARATE lattice the interior PARTITION layer (floorplans.ts +
 * partition.ts) speaks, so rooms and corridors are whole-cell rectangles that
 * line up and can never half-overlap.
 *
 * One CELL is the interior module (2 m). The grid spans the footprint exactly
 * (32 × 24 cells over 64 × 48 m); each wing column/row is 8 cells. Nothing here
 * moves a core or an edge — the fixed stair voids come straight from
 * params.VOID_RECTS (rasterized to CORE cells), and the usable region per floor
 * is the shell inner rectangle for the wings that exist on that storey.
 */

export const CELL = 2.0;
export const GX0 = P.footprint.xMin; // grid origin x (-32)
export const GZ0 = P.footprint.zMin; // grid origin z (-48)
export const NX = Math.round((P.footprint.xMax - P.footprint.xMin) / CELL); // 32
export const NZ = Math.round((P.footprint.zMax - P.footprint.zMin) / CELL); // 24
/** Cells per wing column / row (8 each: 16 m wing ÷ 2 m cell). */
export const CELLS_PER_COL = NX / COLS;
export const CELLS_PER_ROW = NZ / P.rows;

/** Whole-cell rectangle, cell coordinates: covers cells [x, x+w) × [z, z+d). */
export interface CellRect {
  x: number;
  z: number;
  w: number;
  d: number;
}

// --- cell ↔ world (a cell's world span is [cellX0(ix), cellX0(ix+1)]) ---
export const cellX0 = (ix: number): number => GX0 + ix * CELL;
export const cellZ0 = (iz: number): number => GZ0 + iz * CELL;
export const cellCX = (ix: number): number => GX0 + (ix + 0.5) * CELL;
export const cellCZ = (iz: number): number => GZ0 + (iz + 0.5) * CELL;

/** Which wing column/row a cell centre falls in (0-based). */
export const wingGX = (ix: number): number => Math.floor(ix / CELLS_PER_COL);
export const wingGZ = (iz: number): number => Math.floor(iz / CELLS_PER_ROW);

/** A wing (gx) exists on floor f iff the storey is within its column height. */
export const wingExists = (gx: number, f: number): boolean => f < P.colFloors[gx];

/** West-most / east-most wing column that exists on floor f (the massing step:
 *  outer columns are 5 storeys, inner 7, so upper floors shrink to gx 1..2). */
export function existingColRange(f: number): [number, number] {
  let lo = COLS;
  let hi = -1;
  for (let gx = 0; gx < COLS; gx++) {
    if (wingExists(gx, f)) {
      lo = Math.min(lo, gx);
      hi = Math.max(hi, gx);
    }
  }
  return [lo, hi];
}

/** Is cell (ix,iz) inside the usable plate on floor f? (Inside the footprint
 *  AND under a wing that exists on this storey. Cores are still usable-region
 *  cells — they are marked CORE separately.) */
export function inUsable(ix: number, iz: number, f: number): boolean {
  if (ix < 0 || ix >= NX || iz < 0 || iz >= NZ) return false;
  const [lo, hi] = existingColRange(f);
  const gx = wingGX(ix);
  return gx >= lo && gx <= hi;
}

/** Does a cell overlap a reserved stair void? Marks the whole cell CORE if any
 *  part of it intrudes (conservative — the interior never walls into a core). */
export function isCoreCell(ix: number, iz: number): boolean {
  const x0 = cellX0(ix);
  const x1 = cellX0(ix + 1);
  const z0 = cellZ0(iz);
  const z1 = cellZ0(iz + 1);
  return VOID_RECTS.some((v) => x1 > v.x0 && x0 < v.x1 && z1 > v.z0 && z0 < v.z1);
}

/**
 * The exterior-wall INNER faces bounding the usable plate on floor f — the
 * planes the partition's perpendicular walls must abut (never cross) so no
 * interior wall is coplanar with an envelope/step wall. Envelope walls straddle
 * the footprint edge (inner face wallT/2 in); massing-step walls sit flush
 * inside their wing (inner face wallT in). Front/back are always envelope.
 */
export function exteriorInnerBounds(f: number): {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
} {
  const [lo, hi] = existingColRange(f);
  const west = lo === 0 ? P.footprint.xMin + P.wallT / 2 : P.footprint.xMin + lo * CELLS_PER_COL * CELL + P.wallT;
  const east = hi === COLS - 1 ? P.footprint.xMax - P.wallT / 2 : P.footprint.xMin + (hi + 1) * CELLS_PER_COL * CELL - P.wallT;
  return {
    xMin: west,
    xMax: east,
    zMin: P.footprint.zMin + P.wallT / 2,
    zMax: P.footprint.zMax - P.wallT / 2,
  };
}

/** Reserved stair-void rects in cell-index bounds (for CORE-adjacency /
 *  stair-reachability tests in verify). One entry per shaft. */
export function voidCellBounds(): { ix0: number; ix1: number; iz0: number; iz1: number }[] {
  return VOID_RECTS.map((v) => ({
    ix0: Math.floor((v.x0 - GX0) / CELL),
    ix1: Math.ceil((v.x1 - GX0) / CELL) - 1,
    iz0: Math.floor((v.z0 - GZ0) / CELL),
    iz1: Math.ceil((v.z1 - GZ0) / CELL) - 1,
  }));
}
