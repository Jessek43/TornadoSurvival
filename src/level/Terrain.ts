/**
 * Terrain — the ground substrate as ONE pure height function.
 *
 * NO three, NO Rapier, NO DOM: plain numbers in, plain numbers out. Everything
 * the ground used to assume about the plane y = 0 now asks `heightAt(x, z)`
 * instead. The mesh builder (Level.ts) and the collider builder (a Rapier
 * heightfield) consume the `samples` grid from OUTSIDE — this module never sees
 * THREE or Rapier, which is exactly what keeps `verify:terrain` runnable headless
 * (the AlarmController / BootFlow / PlayArea idiom: a pure class, instantiated
 * once and passed as a value; not a provider, service, registry, or factory).
 *
 * `heightAt(x, z)` returns the ground the game PHYSICALLY has: it INTERPOLATES the
 * triangulated sample grid — locate the cell, pick the triangle on the same
 * anti-diagonal split THREE.PlaneGeometry (the mesh) and the Rapier heightfield
 * use, and linearly blend that flat triangle's three corner samples. So there is
 * exactly ONE ground and `meshGap ≡ 0` by construction, not within a tolerance.
 * The `samples` grid is filled ONCE at construction by the private analytic
 * `fieldHeightAt` (pad / apron / noise); that function FILLS the grid, it is not
 * the ground, and there is deliberately no public path back to it.
 *
 *   pads(x,z)     = union( buildingFootprints ⊕ padMargin ) ∪ authoredPadRects
 *   fieldHeightAt = padY inside a pad; a padY→field ramp across `apronWidth`; else
 *                   field height (padY + amplitude·noise).  [grid-fill only]
 *   heightAt      = triangle interpolation of the samples grid.  [the ground]
 *
 * With `amplitude = 0` and `padY = 0` every sample is 0 and the world is
 * byte-identical to the old flat plane — the code path is what this run proves.
 * Trees are NOT pads (buildings-only); they plant at field height.
 */

import { footprintXZ } from "./Neighborhood";
import { HOSPITAL_PARAMS } from "./hospital/params";
import type { SectionSpec } from "./Blueprints";

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface TerrainSpec {
  /** Ground square side (m) — GameConfig.world.groundSize. */
  size: number;
  /** Sample spacing (m) — GameConfig.terrain.cellSize. size/cellSize must be ~integer. */
  cellSize: number;
  /** Field relief amplitude (m). 0 → flat field at padY. */
  amplitude: number;
  /** Characteristic period of the field undulation (m); the valueNoise spatial
   *  frequency is 1/wavelength. The second shape axis alongside amplitude. */
  wavelength: number;
  /** Flat building-pad height (m). */
  padY: number;
  /** Dilation (m) applied to every footprint before it becomes a pad, so no
   *  building sits on a mesa with a cliff at its wall. */
  padMargin: number;
  /** Width (m) of the padY→field ramp outside a pad edge (degenerate at amp 0). */
  apronWidth: number;
  /** Building footprints (houses + shops + hospital) — the ONLY pad source
   *  besides authoredPadRects. Trees are excluded by design. */
  footprints: Rect[];
  /** Explicit reserved pad rects for not-yet-placed content. START EMPTY. */
  authoredPadRects: Rect[];
}

/** Smootherstep 0..1 — C² ramp so the apron has no kink (matters in run two). */
function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
}

/** Deterministic hash → [0,1). Pure, no state, no allocation. */
function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 1274126177) >>> 0);
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [-1,1]; `s` is the spatial frequency (= 1/wavelength),
 *  so the undulation lattice is `1/s` m across. Only scaled into the field height
 *  when `amplitude > 0`, but kept here so run two is a one-constant flip. */
function valueNoise(x: number, z: number, s: number): number {
  const fx = x * s;
  const fz = z * s;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smooth(fx - ix);
  const tz = smooth(fz - iz);
  const n00 = hash2(ix, iz);
  const n10 = hash2(ix + 1, iz);
  const n01 = hash2(ix, iz + 1);
  const n11 = hash2(ix + 1, iz + 1);
  const nx0 = n00 + (n10 - n00) * tx;
  const nx1 = n01 + (n11 - n01) * tx;
  return (nx0 + (nx1 - nx0) * tz) * 2 - 1;
}

export class Terrain {
  /** Segment counts (Rapier heightfield nrows/ncols); the grid is (n+1)². */
  readonly rows: number;
  readonly cols: number;
  readonly cellSize: number;
  /** (rows+1)×(cols+1) heights, ROW-MAJOR: samples[iz*(cols+1)+ix], ix along +x,
   *  iz along +z, world coord = -size/2 + i·cellSize. Both the mesh and the
   *  collider read this; each maps it into its own convention. */
  readonly samples: Float32Array;
  /** Dilated building footprints — the pad rects (union by OR, exact). */
  readonly pads: Rect[];
  /** Connected-component count of overlapping pads (the ?debug `pads:` figure). */
  readonly padCount: number;

  private readonly size: number;
  private readonly amplitude: number;
  private readonly padY: number;
  private readonly apronWidth: number;
  /** valueNoise spatial frequency = 1/wavelength. */
  private readonly frequency: number;

  constructor(spec: TerrainSpec) {
    this.size = spec.size;
    this.cellSize = spec.cellSize;
    this.amplitude = spec.amplitude;
    this.padY = spec.padY;
    this.apronWidth = spec.apronWidth;
    this.frequency = 1 / spec.wavelength;

    // Pads: each footprint dilated by padMargin, plus any authored rects.
    const m = spec.padMargin;
    this.pads = [
      ...spec.footprints.map((f) => ({ x0: f.x0 - m, x1: f.x1 + m, z0: f.z0 - m, z1: f.z1 + m })),
      ...spec.authoredPadRects.map((r) => ({ ...r })),
    ];
    this.padCount = countComponents(this.pads);

    // Sample grid (heights = the analytic field sampled at each grid point).
    this.cols = Math.round(spec.size / spec.cellSize);
    this.rows = this.cols; // square ground
    const n = this.cols + 1;
    this.samples = new Float32Array(n * n);
    const half = spec.size / 2;
    for (let iz = 0; iz < n; iz++) {
      const wz = -half + iz * spec.cellSize;
      for (let ix = 0; ix < n; ix++) {
        const wx = -half + ix * spec.cellSize;
        this.samples[iz * n + ix] = this.fieldHeightAt(wx, wz);
      }
    }
  }

  /** THE height function: the ground the game PHYSICALLY collides with. Locate the
   *  (x, z) cell, pick the triangle on the mesh/heightfield's shared anti-diagonal
   *  split, and linearly interpolate that flat triangle's three corner samples —
   *  NOT the analytic field (that only fills the grid). heightAt is therefore the
   *  triangulated mesh and the Rapier heightfield to the bit: meshGap ≡ 0. Pure in
   *  (x, z) — there is deliberately no y parameter and no cache. */
  heightAt(x: number, z: number): number {
    const n = this.cols + 1;
    const half = this.size / 2;
    const fx = (x + half) / this.cellSize;
    const fz = (z + half) / this.cellSize;
    let ix = Math.floor(fx);
    let iz = Math.floor(fz);
    ix = Math.max(0, Math.min(n - 2, ix));
    iz = Math.max(0, Math.min(n - 2, iz));
    const u = Math.max(0, Math.min(1, fx - ix)); // 0 at ix → 1 at ix+1 (+x)
    const v = Math.max(0, Math.min(1, fz - iz)); // 0 at iz → 1 at iz+1 (+z)
    const h00 = this.samples[iz * n + ix];
    const h10 = this.samples[iz * n + ix + 1];
    const h01 = this.samples[(iz + 1) * n + ix];
    const h11 = this.samples[(iz + 1) * n + ix + 1];
    // Diagonal b–d = (ix,iz+1)–(ix+1,iz): THREE.PlaneGeometry's per-quad split,
    // matched by the Rapier heightfield. Triangle (0,0)(0,1)(1,0) covers u+v ≤ 1;
    // the opposite triangle (through the (1,1) corner) covers u+v ≥ 1.
    if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  }

  /** The analytic FIELD function — pad → padY, a smootherstep apron ramp out to
   *  `apronWidth`, else padY + amplitude·noise. Private and called EXACTLY ONCE per
   *  grid point at construction: it fills `samples`, it is not the ground. Keeping
   *  it private is deliberate — a public `heightAtAnalytic` would reintroduce two
   *  disagreeing grounds (the continuous field vs. the triangulated grid heightAt
   *  interpolates), which is the whole defect this run removes. */
  private fieldHeightAt(x: number, z: number): number {
    if (this.isPad(x, z)) return this.padY;
    const field = this.padY + this.amplitude * valueNoise(x, z, this.frequency);
    const d = this.distanceOutsideNearestPad(x, z);
    if (d < this.apronWidth) {
      return this.padY + (field - this.padY) * smooth(d / this.apronWidth);
    }
    return field;
  }

  /** Inside ANY pad? Interval tests are INCLUSIVE at both ends so a sample landing
   *  exactly on a pad boundary resolves as pad — no half-open one-cell seam (the
   *  classic sunken-block-under-a-wall bug; verify:terrain assertion 8). */
  isPad(x: number, z: number): boolean {
    for (const p of this.pads) {
      if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return true;
    }
    return false;
  }

  /** Minimum ground height over an axis-aligned rect — for SINKING an extended
   *  rigid box (a perimeter wall) so its base drops below the ground everywhere
   *  on its footprint (buried on the high side, flush on the low side, never a
   *  gap). The min of the piecewise-linear (triangulated) surface over a rect is
   *  attained at a VERTEX of the arrangement rect ∩ triangulation: an interior
   *  grid point, a rect corner, or where a rect EDGE crosses a grid line OR a
   *  cell diagonal. The last case is why "just grid points + corners" is not
   *  enough for a THIN rect whose long edges cut across triangles (a wall
   *  footprint) — the min can sit at a diagonal crossing on the edge. Enumerating
   *  all four kinds is exact; over-sampling would only sink a box lower, which is
   *  harmless. Pure in the rect. */
  minHeightIn(rect: Rect): number {
    const cs = this.cellSize;
    const half = this.size / 2;
    const n = this.cols + 1;
    let min = Infinity;
    const at = (x: number, z: number): void => {
      min = Math.min(min, this.heightAt(x, z));
    };
    // Interior grid points (exact samples).
    for (let iz = 0; iz < n; iz++) {
      const wz = -half + iz * cs;
      if (wz < rect.z0 || wz > rect.z1) continue;
      for (let ix = 0; ix < n; ix++) {
        const wx = -half + ix * cs;
        if (wx < rect.x0 || wx > rect.x1) continue;
        min = Math.min(min, this.samples[iz * n + ix]);
      }
    }
    // The four edges, each sampled at its endpoints, its grid-line crossings, and
    // its cell-diagonal crossings (the split is u+v = 1, mirroring heightAt).
    this.minAlongEdge(rect.x0, rect.z0, rect.z1, true, at); // west edge  (x const)
    this.minAlongEdge(rect.x1, rect.z0, rect.z1, true, at); // east edge
    this.minAlongEdge(rect.z0, rect.x0, rect.x1, false, at); // south edge (z const)
    this.minAlongEdge(rect.z1, rect.x0, rect.x1, false, at); // north edge
    return min;
  }

  /** Sample heightAt at every piecewise-linear breakpoint along one rect edge —
   *  endpoints, grid-line crossings, and the single cell-diagonal crossing per
   *  cell — so `minHeightIn` never misses a min that lives between grid lines.
   *  `fixedIsX` true: the edge is at x = `fixed`, running z from `a` to `b`;
   *  false: at z = `fixed`, running x from `a` to `b`. `visit(x, z)` folds in. */
  private minAlongEdge(
    fixed: number,
    a: number,
    b: number,
    fixedIsX: boolean,
    visit: (x: number, z: number) => void,
  ): void {
    const cs = this.cellSize;
    const half = this.size / 2;
    const sample = (t: number): void => (fixedIsX ? visit(fixed, t) : visit(t, fixed));
    sample(a);
    sample(b);
    // Grid-line crossings of the varying coordinate.
    for (let k = Math.ceil((a + half) / cs); k <= Math.floor((b + half) / cs); k++) {
      sample(k * cs - half);
    }
    // Diagonal crossings: the fixed coordinate sets the in-cell fraction `f`; the
    // split u+v = 1 puts the diagonal at the varying fraction 1 − f in each cell.
    const fr = (fixed + half) / cs;
    const f = fr - Math.floor(fr); // in-cell fraction of the fixed axis
    for (let iz = Math.floor((a + half) / cs); iz <= Math.floor((b + half) / cs); iz++) {
      const t = (iz + 1 - f) * cs - half; // varying coord where u + v = 1
      if (t > a && t < b) sample(t);
    }
  }

  /** Max slope (rise/run) among grid cells whose sample points fall in `rect` —
   *  for verify. Compares each interior sample to its +x and +z neighbours. */
  maxSlopeIn(rect: Rect): number {
    const n = this.cols + 1;
    const half = this.size / 2;
    let max = 0;
    for (let iz = 0; iz < n; iz++) {
      const wz = -half + iz * this.cellSize;
      if (wz < rect.z0 || wz > rect.z1) continue;
      for (let ix = 0; ix < n; ix++) {
        const wx = -half + ix * this.cellSize;
        if (wx < rect.x0 || wx > rect.x1) continue;
        const h = this.samples[iz * n + ix];
        if (ix + 1 < n) {
          max = Math.max(max, Math.abs(this.samples[iz * n + ix + 1] - h) / this.cellSize);
        }
        if (iz + 1 < n) {
          max = Math.max(max, Math.abs(this.samples[(iz + 1) * n + ix] - h) / this.cellSize);
        }
      }
    }
    return max;
  }

  /** Distance from (x,z) to the nearest pad edge, 0 inside. */
  private distanceOutsideNearestPad(x: number, z: number): number {
    let best = Infinity;
    for (const p of this.pads) {
      const dx = Math.max(p.x0 - x, 0, x - p.x1);
      const dz = Math.max(p.z0 - z, 0, z - p.z1);
      best = Math.min(best, Math.hypot(dx, dz));
    }
    return best;
  }
}

/**
 * Transpose the row-major sample grid into the buffer the Rapier heightfield
 * wants. `samples` is row-major samples[iz·n + ix] (ix→+x, iz→+z); parry3d's
 * heightfield reads `heights` column-major and maps its rows→z / cols→x, and the
 * NET effect (empirically read by verify:axes) is that a collider built from
 * `samples` directly evaluates heightAt(z, x) at world (x, z) — a clean x↔z
 * transpose, invisible on a flat grid but a diagonal-mirrored collider once relief
 * turns on. Feeding this transposed buffer (out[a·n + b] = samples[b·n + a]) makes
 * the collider surface equal heightAt(x, z) to the bit. ONE seam shared by Level
 * (the real collider) and verify:axes (the check), so they can never disagree.
 * Pure array math — no THREE, no Rapier — so the headless verify keeps importing it.
 * Square grid only (Terrain guarantees rows === cols); n = grid points per side.
 */
export function heightfieldBuffer(samples: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      out[a * n + b] = samples[b * n + a];
    }
  }
  return out;
}

/**
 * The pad footprints for THIS game world — the one binding between the generic
 * Terrain class above and the specific level. ONE source of truth shared by the
 * world build (Game) and verify:terrain, so they can never disagree:
 *
 *   the hospital params ENVELOPE (one gap-free interior pad) + every PLACED
 *   building section's footprint (so a car / ambulance / canopy that reaches
 *   past the envelope still sits on flat ground).
 *
 * Trees are excluded — they are field-planted by design (see the file header).
 * `sections` is the full world section list (hospital first, then neighborhood).
 */
export function worldPadFootprints(sections: SectionSpec[]): Rect[] {
  const hf = HOSPITAL_PARAMS.footprint;
  return [
    { x0: hf.xMin, x1: hf.xMax, z0: hf.zMin, z1: hf.zMax },
    ...sections.filter((s) => s.name !== "tree").map(footprintXZ),
  ];
}

/**
 * Rigidly lift every section onto the substrate: shift a section's blocks (and
 * climb volumes) in y by heightAt at its footprint centre, so a building sits on
 * its pad and a tree plants on the field. A RIGID per-section shift preserves all
 * internal geometry (stairs, decks, the hospital z-fight lift table) — buildings
 * sit on flat pads (footprint uniformly padY), so the centre sample is the whole
 * building's ground height. Mutates the specs once, before StructureSystem reads
 * them (rebuild() then reuses the lifted specs). At amplitude 0 / padY 0 every
 * shift is 0 — a no-op that proves the code path.
 */
export function liftSectionsToTerrain(
  sections: SectionSpec[],
  heightAt: (x: number, z: number) => number,
): void {
  for (const s of sections) {
    const f = footprintXZ(s);
    const dy = heightAt((f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2);
    if (dy === 0) continue;
    for (const b of s.blocks) b.position[1] += dy;
    if (s.climbVolumes) for (const c of s.climbVolumes) c.position[1] += dy;
  }
}

/** Count connected components among overlapping rects (union-find). Overlap is
 *  inclusive, matching isPad, so touching pads merge. */
function countComponents(rects: Rect[]): number {
  const parent = rects.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const overlap = (a: Rect, b: Rect): boolean =>
    a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlap(rects[i], rects[j])) parent[find(i)] = find(j);
    }
  }
  let roots = 0;
  for (let i = 0; i < rects.length; i++) if (find(i) === i) roots++;
  return roots;
}
