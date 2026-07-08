/**
 * Quality presets — the single place performance knobs live.
 *
 * Every system that spends per-frame budget (particles, debris bodies,
 * shadows, fog / draw distance) reads its caps from here at construction.
 * A future "mobile" preset is a new entry in QUALITY_PRESETS, not a
 * refactor.
 */

export interface QualitySettings {
  /** Max simultaneous dust/debris sprites across all particle emitters. */
  particleCap: number;
  /** Hard cap on active dynamic debris rigid bodies (see DebrisManager). */
  debrisBudget: number;
  shadowsEnabled: boolean;
  /** Shadow map resolution (square). Ignored when shadowsEnabled is false. */
  shadowMapSize: number;
  /** FogExp2 density. Higher = spookier AND cheaper (hides the far plane). */
  fogDensity: number;
  /** Camera far plane. Kept just past where fog fully swallows geometry. */
  drawDistance: number;
  /** Real point lights that follow the player for interior lighting. This is
   *  the forward-renderer light-count dial — O(1) in building size. */
  interiorLightPool: number;
  /** Renderer pixel-ratio cap. The whole (fill-bound) post chain runs at
   *  this × the logical resolution, so it's the single biggest GPU dial on
   *  HiDPI displays. Capped below 2 to buy back headroom. */
  pixelRatio: number;
}

export const QUALITY_PRESETS = {
  high: {
    particleCap: 2000,
    // Lowered from 200 (perf pass): fewer dynamic bodies in the Rapier solver
    // during a pass — the growing part of the physics peak.
    debrisBudget: 120,
    shadowsEnabled: true,
    shadowMapSize: 2048,
    // Lowered from 0.011: still hides the far plane, but keeps near/mid-range
    // structure contrast so the yard doesn't read as one uniform dark mass.
    fogDensity: 0.0072,
    drawDistance: 400,
    // 6 (was 5): one extra player-following light keeps the current room + its
    // doorway lit at once for the furnished interior. (Briefly tried 7 — too
    // many lights stacking in one room read over-bright.) O(1) in building size.
    interiorLightPool: 6,
    pixelRatio: 1.4,
  },
  medium: {
    particleCap: 800,
    debrisBudget: 100,
    shadowsEnabled: true,
    shadowMapSize: 1024,
    fogDensity: 0.0095,
    drawDistance: 300,
    interiorLightPool: 4,
    pixelRatio: 1.25,
  },
  low: {
    particleCap: 300,
    debrisBudget: 55,
    shadowsEnabled: false,
    shadowMapSize: 512,
    fogDensity: 0.012,
    drawDistance: 220,
    interiorLightPool: 3,
    pixelRatio: 1.0,
  },
} as const satisfies Record<string, QualitySettings>;

/** Pick a preset from the ?quality= URL param; defaults to high. */
export function resolveQuality(): QualitySettings {
  const name = new URLSearchParams(location.search).get("quality");
  if (name && name in QUALITY_PRESETS) {
    return QUALITY_PRESETS[name as keyof typeof QUALITY_PRESETS];
  }
  return QUALITY_PRESETS.high;
}
