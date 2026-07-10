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
 * `heightAt` is computed ANALYTICALLY, not by interpolating the grid, so it is
 * exact on pad boundaries and deterministic. The `samples` grid is just
 * `heightAt` evaluated at the grid points, shared verbatim by mesh and collider.
 *
 *   pads(x,z) = union( buildingFootprints ⊕ padMargin ) ∪ authoredPadRects
 *   heightAt  = padY inside a pad; a padY→field ramp across `apronWidth`; else
 *               field height (padY + amplitude·noise).
 *
 * With `amplitude = 0` and `padY = 0` every sample is 0 and the world is
 * byte-identical to the old flat plane — the code path is what this run proves.
 * Trees are NOT pads (buildings-only); they plant at field height.
 */

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

/** Smooth value noise in [-1,1] on a 1/16 m grid. Only scaled into the field
 *  height when `amplitude > 0`, but kept here so run two is a one-constant flip. */
function valueNoise(x: number, z: number): number {
  const s = 0.0625; // spatial frequency of the field undulation
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

  constructor(spec: TerrainSpec) {
    this.size = spec.size;
    this.cellSize = spec.cellSize;
    this.amplitude = spec.amplitude;
    this.padY = spec.padY;
    this.apronWidth = spec.apronWidth;

    // Pads: each footprint dilated by padMargin, plus any authored rects.
    const m = spec.padMargin;
    this.pads = [
      ...spec.footprints.map((f) => ({ x0: f.x0 - m, x1: f.x1 + m, z0: f.z0 - m, z1: f.z1 + m })),
      ...spec.authoredPadRects.map((r) => ({ ...r })),
    ];
    this.padCount = countComponents(this.pads);

    // Sample grid (heights = heightAt at grid points).
    this.cols = Math.round(spec.size / spec.cellSize);
    this.rows = this.cols; // square ground
    const n = this.cols + 1;
    this.samples = new Float32Array(n * n);
    const half = spec.size / 2;
    for (let iz = 0; iz < n; iz++) {
      const wz = -half + iz * spec.cellSize;
      for (let ix = 0; ix < n; ix++) {
        const wx = -half + ix * spec.cellSize;
        this.samples[iz * n + ix] = this.heightAt(wx, wz);
      }
    }
  }

  /** THE height function. Pure in (x, z) — there is deliberately no y parameter. */
  heightAt(x: number, z: number): number {
    if (this.isPad(x, z)) return this.padY;
    const field = this.padY + this.amplitude * valueNoise(x, z);
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
