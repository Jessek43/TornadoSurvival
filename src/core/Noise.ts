import {
  createNoise2D,
  createNoise3D,
  type NoiseFunction2D,
  type NoiseFunction3D,
} from "simplex-noise";

/**
 * Seeded simplex-noise helpers.
 *
 * Simplex noise is "smooth randomness": nearby inputs give nearby outputs
 * (unlike Math.random(), which is uncorrelated between calls). We use it
 * wherever we want organic wobble — tornado path jitter, funnel wobble,
 * wind gusts, camera shake. Seeding makes a run reproducible when
 * debugging.
 */

/** Tiny deterministic PRNG (mulberry32), used to seed the noise tables. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Noise {
  private readonly n2: NoiseFunction2D;
  private readonly n3: NoiseFunction3D;

  constructor(seed = Date.now()) {
    const rand = mulberry32(seed);
    this.n2 = createNoise2D(rand);
    this.n3 = createNoise3D(rand);
  }

  /** 1D noise over time, in [-1, 1]. `channel` selects independent streams. */
  noise1(t: number, channel = 0): number {
    return this.n2(t, channel * 137.7);
  }

  noise2(x: number, y: number): number {
    return this.n2(x, y);
  }

  noise3(x: number, y: number, z: number): number {
    return this.n3(x, y, z);
  }
}
