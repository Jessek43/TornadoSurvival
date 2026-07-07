/**
 * Block material definitions.
 *
 * A structure is a set of blocks; each block references one of these
 * materials. The material decides how a block looks, how heavy it is once
 * it tears free, and — most importantly — the wind pressure needed to tear
 * it free (breakThreshold). Different thresholds are what make the wooden
 * shed disintegrate while the concrete shelter only sheds panels, and — in
 * the hospital — glass blow first, upper-floor cladding next, ground-floor
 * concrete last.
 *
 * Densities are GAMEPLAY values, deliberately below real-world numbers:
 * with realistic masses, quadratic wind drag barely moves a concrete block
 * and the storm reads as weak. These are tuned for debris that visibly
 * flies (balanced live via the ?debug lil-gui panel).
 */
export interface BlockMaterialDef {
  name: string;
  /** Base render color (subtle per-instance variation is added on top). */
  color: number;
  /** Render surface parameters. */
  roughness: number;
  metalness: number;
  /** kg/m³ — a block's mass when it becomes dynamic = density × volume. */
  density: number;
  /** Wind dynamic pressure (|wind|², m²/s²) above which a block tears free. */
  breakThreshold: number;
  /**
   * Progressive fracture: if the pressure at release exceeds
   * splitFactor × breakThreshold, the block splits into smaller children.
   * null = this material never splits.
   */
  splitFactor: number | null;
  /** Semi-transparent render (glass). Default opaque. */
  transparent?: boolean;
  /** Alpha when transparent. */
  opacity?: number;
  /** Whether this material casts shadows (glass shouldn't). Default true. */
  castShadow?: boolean;
}

export const MATERIALS = {
  wood: {
    name: "wood",
    color: 0x6b5136,
    roughness: 0.9,
    metalness: 0,
    density: 300,
    breakThreshold: 400,
    splitFactor: 1.5,
  },
  concrete: {
    name: "concrete",
    color: 0x8a8d88,
    roughness: 0.95,
    metalness: 0,
    density: 1400,
    breakThreshold: 1600, // ground-floor structure — holds longest
    splitFactor: null,
  },
  metal: {
    name: "metal",
    color: 0x5c6670,
    roughness: 0.55,
    metalness: 0.7,
    density: 800, // hollow scaffold members / stair core, not solid steel
    breakThreshold: 1100,
    splitFactor: null,
  },
  // --- hospital materials ---
  // Upper-floor exterior skin + interior partitions. Lighter and weaker than
  // concrete, so upper floors and inner walls fail while the podium holds.
  cladding: {
    name: "cladding",
    // Off-white: the hospital's interior/upper walls read white per the
    // references (also brightens shop roofs — accepted leak).
    color: 0xd6d4cc,
    roughness: 0.85,
    metalness: 0.05,
    density: 500,
    breakThreshold: 700,
    splitFactor: 1.6,
  },
  // Perimeter windows only. Very low threshold → blow in first; shatter into
  // shards; see-through while intact (the visibility half of the puzzle).
  // Tinted blue for the reference-hospital window grid (shared with houses).
  glass: {
    name: "glass",
    color: 0x9ec6dd,
    roughness: 0.1,
    metalness: 0.1,
    density: 180,
    breakThreshold: 180,
    splitFactor: 1.2,
    transparent: true,
    opacity: 0.38,
    castShadow: false,
  },
  // Parked cars — heavy props. High density + high threshold: they don't
  // fragment, they get shoved and launched whole as heavy projectiles.
  car: {
    name: "car",
    color: 0x74403a,
    roughness: 0.5,
    metalness: 0.4,
    density: 2600,
    breakThreshold: 900,
    splitFactor: null,
  },
  // Interior clutter (beds, furniture, equipment). Light and flimsy — becomes
  // debris the moment wind or falling rubble reaches it.
  furniture: {
    name: "furniture",
    color: 0x556052,
    roughness: 0.8,
    metalness: 0.05,
    density: 250,
    breakThreshold: 260,
    splitFactor: null,
  },
  // --- hospital palette (Phase-2 detailing) ---
  // Physics CLONES of existing tiers — only name/color differ, so the
  // destruction model is untouched. Floor colors clone concrete (threshold
  // 1600: decks stay the durable enclosure that keeps ceiling fixtures lit);
  // accents clone cladding; props clone furniture. Each id costs one
  // structure InstancedMesh + one debris pool (accepted draw-call budget).
  floorBeige: {
    name: "floorBeige",
    color: 0xd8c9a8,
    roughness: 0.9,
    metalness: 0,
    density: 1400,
    breakThreshold: 1600,
    splitFactor: null,
  },
  floorMustard: {
    name: "floorMustard",
    color: 0xd2a83c,
    roughness: 0.85,
    metalness: 0.05,
    density: 1400,
    breakThreshold: 1600,
    splitFactor: null,
  },
  floorTeal: {
    name: "floorTeal",
    color: 0x7fbdb0,
    roughness: 0.85,
    metalness: 0.05,
    density: 1400,
    breakThreshold: 1600,
    splitFactor: null,
  },
  accentOrange: {
    name: "accentOrange",
    color: 0xe07b30,
    roughness: 0.8,
    metalness: 0.05,
    density: 500,
    breakThreshold: 700,
    splitFactor: 1.6,
  },
  accentBlue: {
    name: "accentBlue",
    color: 0x3a6ea8,
    roughness: 0.8,
    metalness: 0.05,
    density: 500,
    breakThreshold: 700,
    splitFactor: 1.6,
  },
  accentTeal: {
    name: "accentTeal",
    color: 0x2fa39a,
    roughness: 0.8,
    metalness: 0.05,
    density: 500,
    breakThreshold: 700,
    splitFactor: 1.6,
  },
  // White prop bodies (beds, desks, cabinets, drapes). Threshold 260 < the
  // 550 "durable" bar, so props can never masquerade as light enclosure;
  // splitFactor null so props fly whole, never fragment.
  propWhite: {
    name: "propWhite",
    color: 0xe8e6e0,
    roughness: 0.7,
    metalness: 0.05,
    density: 250,
    breakThreshold: 260,
    splitFactor: null,
  },
  signRed: {
    name: "signRed",
    color: 0xc23b2e,
    roughness: 0.6,
    metalness: 0.1,
    density: 500,
    breakThreshold: 700,
    splitFactor: null,
  },

  // --- neighborhood materials ---
  // Residential brick — between wood and hospital cladding: houses shred in a
  // direct pass but shrug off the outer edge of the swath, so the neighborhood
  // reads a believable damage gradient (wood flattens, brick survives grazes).
  brick: {
    name: "brick",
    color: 0x7a5648,
    roughness: 0.9,
    metalness: 0,
    density: 900,
    breakThreshold: 550,
    splitFactor: 1.5,
  },
  // Tree trunks. Splits so a sheared trunk breaks into tumbling logs.
  trunk: {
    name: "trunk",
    color: 0x4a3a28,
    roughness: 0.95,
    metalness: 0,
    density: 400,
    breakThreshold: 500,
    splitFactor: 1.6,
  },
  // Tree canopies — very light and weak: foliage strips first (leaves torn off
  // ahead of the trunk shearing), and flies far once loose.
  foliage: {
    name: "foliage",
    color: 0x3d4a30,
    roughness: 1,
    metalness: 0,
    density: 120,
    breakThreshold: 250,
    splitFactor: 1.4,
  },
} satisfies Record<string, BlockMaterialDef>; // not `as const` — ?debug GUI tunes thresholds live

export type MaterialId = keyof typeof MATERIALS;
