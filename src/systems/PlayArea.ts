/**
 * PlayArea — the pure geometry + state of the map's playable square.
 *
 * NO three, NO Rapier, NO DOM: plain numbers and plain data out. Everything it
 * exposes is derived from ONE size dial (GameConfig.PLAY_AREA.halfExtent), so
 * enlarging the map later is a single-constant change — never a hunt for inlined
 * metres. The Three/Rapier construction (walls, instanced dressing) reads this;
 * the DOM edge-nudge reads this. There is no manager between them.
 *
 * The play area is an axis-aligned square centred on the world origin. Four
 * perimeter wall segments, a seeded ring of dressing slots just inside the edge,
 * and an EDGE-TRIGGERED warning latch (same idiom as AlarmController) round it
 * out. `update` returns a transition, never a state — callers must not poll a
 * boolean.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** One perimeter wall, in the shape a cuboid collider wants: centre + half-extents. */
export interface WallSegment {
  center: Vec3Like;
  halfExtents: Vec3Like;
}

/** One placed dressing prop (tree/hedge): ground position + facing + size. */
export interface DressingSlot {
  x: number;
  z: number;
  rotationY: number;
  scale: number;
}

/** The single, edge-triggered outcome of a position update — never a state. */
export type EdgeTransition = "entered" | "exited" | null;

export interface PlayAreaConfig {
  /** Metres from world centre to each edge — THE size dial. */
  halfExtent: number;
  /** Wall box height (m). Size-independent by design (a taller map isn't a
   *  taller fence), so it does NOT scale with halfExtent. */
  wallHeight: number;
  /** Wall box thickness (m). Size-independent, as wallHeight. */
  wallThickness: number;
  /** Treeline depth as a FRACTION of halfExtent, so the band — like every
   *  derived quantity — scales with the one dial (a bigger map, a proportionally
   *  deeper treeline). Effective depth (m) = halfExtent × this. */
  dressingBandFraction: number;
  /** Dressing props per edge (deterministic count → total = 4 × this). */
  slotsPerSide: number;
  /** Seed for the deterministic slot scatter (same seed → same ring). */
  dressingSeed: number;
  /** Distance from the edge (m) at which the "leaving the area" warning turns on. */
  warnBand: number;
  /** Extra distance (m) the player must travel back before it clears — the
   *  hysteresis that stops the nudge flickering on the threshold. */
  warnHysteresis: number;
}

/** Deterministic PRNG (mulberry32): pure, seedable, no allocation churn. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PlayArea {
  private readonly segments: WallSegment[];
  private readonly slots: DressingSlot[];
  /** Warning latch state — true once inside warnBand, cleared only past the
   *  hysteresis. Private: callers act on update()'s transition, not on this. */
  private warned = false;

  constructor(private readonly cfg: PlayAreaConfig) {
    this.segments = this.buildSegments();
    this.slots = this.buildSlots();
  }

  /** Chebyshev distance to the square boundary: POSITIVE inside, 0 on the edge,
   *  NEGATIVE outside. All containment/proximity derives from this one number. */
  distanceToEdge(x: number, z: number): number {
    return this.cfg.halfExtent - Math.max(Math.abs(x), Math.abs(z));
  }

  isOutside(x: number, z: number): boolean {
    return this.distanceToEdge(x, z) < 0;
  }

  /** The four perimeter walls (built once). Corners are sealed by overlap: each
   *  wall spans the full ±halfExtent along its length, so adjacent walls overlap
   *  in the corner cell. */
  wallSegments(): WallSegment[] {
    return this.segments;
  }

  /** The deterministic dressing scatter (built once). */
  dressingSlots(): DressingSlot[] {
    return this.slots;
  }

  /**
   * Edge-triggered warning. Turns ON when distanceToEdge < warnBand and OFF only
   * once distanceToEdge > warnBand + warnHysteresis — a LATCH, so a player
   * strafing on the threshold doesn't flicker the nudge. Returns the transition
   * ("entered"/"exited") on the frame it changes, else null. This is the reason
   * warnHysteresis exists.
   */
  update(x: number, z: number): EdgeTransition {
    const d = this.distanceToEdge(x, z);
    if (!this.warned && d < this.cfg.warnBand) {
      this.warned = true;
      return "entered";
    }
    if (this.warned && d > this.cfg.warnBand + this.cfg.warnHysteresis) {
      this.warned = false;
      return "exited";
    }
    return null;
  }

  /** Clear the warning latch (round restart: spawn is central, nudge hidden). */
  reset(): void {
    this.warned = false;
  }

  // --- construction (pure, run once) ----------------------------------------

  private buildSegments(): WallSegment[] {
    const h = this.cfg.halfExtent;
    const ht = this.cfg.wallThickness / 2;
    const y = this.cfg.wallHeight / 2;
    // Length half-extent is exactly h (not h+ht) so every horizontal centre and
    // perimeter-axis half-extent scales EXACTLY with the dial; corners still seal
    // because both walls of a corner overlap the ±h cell.
    return [
      { center: { x: h, y, z: 0 }, halfExtents: { x: ht, y, z: h } }, // +X (east)
      { center: { x: -h, y, z: 0 }, halfExtents: { x: ht, y, z: h } }, // -X (west)
      { center: { x: 0, y, z: h }, halfExtents: { x: h, y, z: ht } }, // +Z (north)
      { center: { x: 0, y, z: -h }, halfExtents: { x: h, y, z: ht } }, // -Z (south)
    ];
  }

  private buildSlots(): DressingSlot[] {
    const { halfExtent: h, slotsPerSide, dressingBandFraction, dressingSeed } = this.cfg;
    const rng = mulberry32(dressingSeed);
    const slots: DressingSlot[] = [];
    // Both coordinates of every slot are h × (a size-independent fraction), so
    // the whole ring scales EXACTLY with halfExtent. `perpFrac` in
    // [1-band, 1] keeps the prop inside the treeline band on its edge axis.
    // side: which axis is the perpendicular (edge) axis, and its sign.
    const sides: { axis: "x" | "z"; sign: 1 | -1 }[] = [
      { axis: "x", sign: 1 },
      { axis: "x", sign: -1 },
      { axis: "z", sign: 1 },
      { axis: "z", sign: -1 },
    ];
    for (const { axis, sign } of sides) {
      for (let i = 0; i < slotsPerSide; i++) {
        const r1 = rng();
        const r2 = rng();
        const r3 = rng();
        const r4 = rng();
        // Even spread along the edge (± a sub-cell jitter), all × h so it scales.
        const alongFrac =
          ((i + 0.5) / slotsPerSide) * 2 - 1 + ((r1 - 0.5) / slotsPerSide);
        // Inward from the very edge, within the band, × h so it scales.
        const perpFrac = sign * (1 - r2 * dressingBandFraction);
        const along = h * Math.max(-1, Math.min(1, alongFrac));
        const perp = h * perpFrac;
        const x = axis === "x" ? perp : along;
        const z = axis === "x" ? along : perp;
        slots.push({
          x,
          z,
          rotationY: r3 * Math.PI * 2,
          scale: 0.8 + r4 * 0.6,
        });
      }
    }
    return slots;
  }
}
