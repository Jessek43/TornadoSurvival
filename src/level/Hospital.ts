import type { MaterialId } from "./Materials";
import type { BlockDef, SectionSpec } from "./Blueprints";

/**
 * The hospital level generator — rebuilt around ONE shared spatial model.
 *
 * Why a rebuild: stairs, columns, and lights used to be placed independently,
 * and the stairwell "void" was reserved by a CENTER-POINT test — so 4.5 m slab
 * tiles, partition walls, and edge columns whose centers sat outside the shaft
 * but whose extents overlapped it clipped straight through the stairs. Fixtures
 * were owned at whole-wing granularity, so a light on a destroyed floor of a
 * surviving wing floated. This file now generates everything from HospitalGrid
 * in a strict order, each step respecting the reserved void EXTENT-AWARE, so
 * those three failure modes are impossible by construction:
 *
 *   1. grid + per-column floor heights (stepped massing)
 *   2. reserve the stairwell VOID first (whole-column, all floors) — decks are
 *      CLIPPED around it (abut the shaft, never overlap it, never leave a gap)
 *   3. columns on wing corners, skipped where they'd overlap the void
 *   4. parametric switchback stairs, sized to fit exactly inside the void
 *   5. interior walls: a corridor spine (E–W) + ribs (N–S) connecting the
 *      stairwells, rooms off them, doors on a rhythm — all void-clipped
 *   6. ceiling fixtures anchored to a specific floor-slab block, so on
 *      destruction the fixture dies with THAT local geometry (not the wing),
 *      and on re-sleep it is retained
 *   7. perimeter windows (exterior only, transparent/destructible)
 *
 * Output shape is unchanged — 12 wing sections + 2 stairwell sections + a
 * portico + parking props — so the destruction / wake / re-sleep / debris /
 * per-material-instancing systems (StructureSystem) plug in exactly as before.
 *
 * Coordinates: player spawns at z≈20 (south), walks −z through the lot to the
 * entrance at z=0. Envelope X[-28,28] × Z[-40,0], centered (0,-20).
 */

// ===========================================================================
// HospitalGrid — the single source of spatial truth. Every placement below
// consults these; nothing computes its own idea of where the void/corridors are.
// ===========================================================================

const X_MIN = -28;
const X_MAX = 28;
const Z_MIN = -40;
const Z_MAX = 0;
const FLOORS = 5; // tallest columns (the middle two)
const FLOOR_H = 3.6;
const WALL_T = 0.3;
const SEG = 3.0; // wall segment length
const SILL_H = 0.9; // solid below the glass
const HEAD_Y = 2.4; // glass top; concrete spandrel above to the ceiling
const CEIL_GAP = 0.22; // fixture drop below the ceiling deck

// 4 × 3 wing grid.
const N_COL = 4;
const N_ROW = 3;
// Stepped massing: outer columns 4 stories, middle two 5.
const COL_FLOORS = [4, 5, 5, 4];
const X_EDGES = Array.from({ length: N_COL + 1 }, (_, i) => X_MIN + ((X_MAX - X_MIN) * i) / N_COL);
const Z_EDGES = Array.from({ length: N_ROW + 1 }, (_, i) => Z_MIN + ((Z_MAX - Z_MIN) * i) / N_ROW);

// --- reserved stairwell voids (whole-column, all floors) ---
const STAIRS = [
  { cx: -7, cz: -20, side: "A" as const },
  { cx: 7, cz: -20, side: "B" as const },
];
const STAIR_HW = 2.6; // x half-width of a shaft
const STAIR_HD = 3.6; // z half-depth of a shaft

type Rect = { x0: number; x1: number; z0: number; z1: number };
const VOID_RECTS: Rect[] = STAIRS.map((s) => ({
  x0: s.cx - STAIR_HW,
  x1: s.cx + STAIR_HW,
  z0: s.cz - STAIR_HD,
  z1: s.cz + STAIR_HD,
}));

/** Extent-aware void test: does the AABB centered (x,z) size (w,d) touch any
 *  reserved shaft? This REPLACES the old center-point inStair — a block whose
 *  center is outside but whose body overlaps now correctly reads as intruding. */
function overlapsVoid(x: number, z: number, w = 0, d = 0): boolean {
  const hx = w / 2 + 0.02;
  const hz = d / 2 + 0.02;
  return VOID_RECTS.some(
    (v) => x + hx > v.x0 && x - hx < v.x1 && z + hz > v.z0 && z - hz < v.z1,
  );
}

// --- corridor network (the [HOSPITAL-INTERIOR] read) ---
// A hero E–W spine at the middle-row centerline (which the two stairwells sit
// on), plus N–S ribs that connect the spine forward to the entrance and back to
// the deep wings. Every room reaches a corridor; both stairwells sit on the spine.
const SPINE_Z = -20;
const SPINE_HW = 1.6; // 3.2 m corridor
const RIB_X = [-21, -7, 0, 7, 21];
const RIB_HW = 1.4; // 2.8 m corridors
// Corridor intersections open into a generous crossing (wider than the corridor
// itself) so circulation is forgiving and never pinches to a single-file gap.
const CROSS_PAD = 0.6;

const inSpine = (z: number): boolean => Math.abs(z - SPINE_Z) <= SPINE_HW;
const inRib = (x: number): boolean => RIB_X.some((rx) => Math.abs(x - rx) <= RIB_HW);
const inCorridor = (x: number, z: number): boolean => inSpine(z) || inRib(x);

type Fixture = [number, number, number];

/** Author a block by its BOTTOM y (easier to stack); store the center. */
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

// ===========================================================================
// Step 2 — decks CLIPPED around the void (abut it, never overlap, never gap).
// ===========================================================================

/** Subtract every void rect from a candidate deck tile, returning the leftover
 *  rectangles (the floor that survives around the shaft). This is what makes a
 *  clean, gap-free floor opening at the stairwell: the deck stops exactly at the
 *  shaft wall instead of a center-test tile poking in or leaving a hole. */
function clipTileToVoids(t: Rect): Rect[] {
  let rects: Rect[] = [t];
  for (const v of VOID_RECTS) {
    const next: Rect[] = [];
    for (const r of rects) {
      if (r.x1 <= v.x0 || r.x0 >= v.x1 || r.z1 <= v.z0 || r.z0 >= v.z1) {
        next.push(r); // no overlap
        continue;
      }
      if (r.x0 < v.x0) next.push({ x0: r.x0, x1: v.x0, z0: r.z0, z1: r.z1 }); // west
      if (r.x1 > v.x1) next.push({ x0: v.x1, x1: r.x1, z0: r.z0, z1: r.z1 }); // east
      const mx0 = Math.max(r.x0, v.x0);
      const mx1 = Math.min(r.x1, v.x1);
      if (r.z0 < v.z0) next.push({ x0: mx0, x1: mx1, z0: r.z0, z1: v.z0 }); // south band
      if (r.z1 > v.z1) next.push({ x0: mx0, x1: mx1, z0: v.z1, z1: r.z1 }); // north band
    }
    rects = next;
  }
  return rects.filter((r) => r.x1 - r.x0 > 0.1 && r.z1 - r.z0 > 0.1);
}

// A slab record so fixtures can anchor to the exact deck block beneath them.
type SlabRef = { x: number; z: number; idx: number };

/** Build one floor's deck for a wing as ~4.5 m tiles, each clipped to the void.
 *  Records every emitted slab (with its index in `blocks`) for fixture anchoring. */
function addDeck(
  blocks: BlockDef[],
  xMin: number,
  xMax: number,
  zMin: number,
  zMax: number,
  deckTopY: number,
  material: MaterialId,
  slabs: SlabRef[] | null,
): void {
  const STEP = 4.5;
  for (let x0 = xMin; x0 < xMax - 0.05; x0 += STEP) {
    const x1 = Math.min(x0 + STEP, xMax);
    for (let z0 = zMin; z0 < zMax - 0.05; z0 += STEP) {
      const z1 = Math.min(z0 + STEP, zMax);
      for (const r of clipTileToVoids({ x0, x1, z0, z1 })) {
        const cx = (r.x0 + r.x1) / 2;
        const cz = (r.z0 + r.z1) / 2;
        if (slabs) slabs.push({ x: cx, z: cz, idx: blocks.length });
        blocks.push(block(material, cx, deckTopY - 0.24, cz, r.x1 - r.x0, 0.24, r.z1 - r.z0));
      }
    }
  }
}

function nearestSlab(slabs: SlabRef[], x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (const s of slabs) {
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s.idx;
    }
  }
  return best;
}

// ===========================================================================
// Walls — exterior (windowed) and interior (corridor/partition). All skip the
// void by EXTENT, so a wall never clips into the shaft.
// ===========================================================================

/** Global-phase door test so doorways line up across wing boundaries. */
function isDoorSeg(center: number): boolean {
  return ((Math.round(center / SEG) % 3) + 3) % 3 === 1;
}

/**
 * Exterior wall run: sill + glass + concrete spandrel band on windowed
 * segments, solid otherwise. Windows only on exterior faces (perimeter
 * visibility). `lobby` gives the front-center ground floor tall glazing.
 */
function addExteriorWall(
  blocks: BlockDef[],
  axis: "x" | "z",
  a0: number,
  a1: number,
  perp: number,
  floor: number,
  lobby: boolean,
  door?: (c: number) => boolean,
): void {
  const base = floor * FLOOR_H;
  const len = a1 - a0;
  const n = Math.max(1, Math.round(len / SEG));
  const seg = len / n;
  const solid: MaterialId = floor === 0 ? "concrete" : "cladding";
  for (let i = 0; i < n; i++) {
    const c = a0 + seg * (i + 0.5);
    const x = axis === "x" ? c : perp;
    const z = axis === "x" ? perp : c;
    const w = axis === "x" ? seg : WALL_T;
    const d = axis === "x" ? WALL_T : seg;
    if (overlapsVoid(x, z, w, d)) continue;
    if (door?.(c)) continue; // walk-through opening (the entrance)
    const windowed = (floor > 0 || perp === Z_MAX) && i % 2 === 0;
    if (!windowed) {
      blocks.push(block(solid, x, base, z, w, FLOOR_H, d));
      continue;
    }
    const sillH = lobby ? 0.3 : SILL_H;
    const headY = lobby ? 3.3 : HEAD_Y;
    blocks.push(block(solid, x, base, z, w, sillH, d)); // sill
    blocks.push(block("glass", x, base + sillH, z, w, headY - sillH, d)); // window
    blocks.push(block("concrete", x, base + headY, z, w, FLOOR_H - headY, d)); // spandrel band
  }
}

/**
 * Interior wall run (cladding). `skip(x,z)` opens the wall where a crossing
 * corridor runs; `doors` puts a doorway on the global rhythm. Void-safe.
 */
function addInteriorWall(
  blocks: BlockDef[],
  axis: "x" | "z",
  a0: number,
  a1: number,
  perp: number,
  floor: number,
  doors: boolean,
  skip: (x: number, z: number) => boolean,
): void {
  const base = floor * FLOOR_H;
  const len = a1 - a0;
  const n = Math.max(1, Math.round(len / SEG));
  const seg = len / n;
  for (let i = 0; i < n; i++) {
    const c = a0 + seg * (i + 0.5);
    const x = axis === "x" ? c : perp;
    const z = axis === "x" ? perp : c;
    if (doors && isDoorSeg(c)) continue; // doorway
    const w = axis === "x" ? seg : WALL_T;
    const d = axis === "x" ? WALL_T : seg;
    if (overlapsVoid(x, z, w, d)) continue;
    if (skip(x, z)) continue; // crossing corridor — leave open
    blocks.push(block("cladding", x, base, z, w, FLOOR_H, d));
  }
}

// ===========================================================================
// Step 3–6 per wing.
// ===========================================================================

/** addFixture(position, anchorBlockIndex-within-this-section). */
type AddFixture = (f: Fixture, anchor: number) => void;

function buildWing(gx: number, gz: number, addFixture: AddFixture): SectionSpec {
  const xMin = X_EDGES[gx];
  const xMax = X_EDGES[gx + 1];
  const zMin = Z_EDGES[gz];
  const zMax = Z_EDGES[gz + 1];
  const blocks: BlockDef[] = [];
  const floors = COL_FLOORS[gx];
  const extMinZ = gz === 0;
  const extMaxZ = gz === N_ROW - 1;

  for (let f = 0; f < floors; f++) {
    const y = f * FLOOR_H;
    const slabs: SlabRef[] = [];

    // (2) DECK — clipped around the void. The ground floor's deck is lifted a
    // few cm so its top clears the Level ground plane (both were at y=0 → the
    // coplanar z-fighting/flicker); the tiny threshold auto-steps seamlessly.
    addDeck(blocks, xMin, xMax, zMin, zMax, f === 0 ? 0.06 : y, "concrete", slabs);

    // (3) COLUMNS — wing corners, vertically aligned. Skipped where they'd
    // overlap the void OR stand in a corridor: the x=0 entrance rib runs along
    // the gx=1/gx=2 column boundary, so its corner columns would otherwise
    // block the doorway/corridor. "Columns never obstruct circulation" is part
    // of the spatial model, not a per-column patch.
    for (const cx of [xMin + 0.3, xMax - 0.3]) {
      for (const cz of [zMin + 0.3, zMax - 0.3]) {
        if (overlapsVoid(cx, cz, 0.5, 0.5)) continue;
        if (inCorridor(cx, cz)) continue;
        blocks.push(block("concrete", cx, y, cz, 0.5, FLOOR_H, 0.5));
      }
    }

    // (5a) EXTERIOR perimeter walls. A face is exterior if it's on the envelope
    // edge OR faces a shorter neighbor column (stepped massing shows the step).
    const eMinX = gx === 0 || f >= COL_FLOORS[gx - 1];
    const eMaxX = gx === N_COL - 1 || f >= COL_FLOORS[gx + 1];
    const lobby = extMaxZ && f === 0 && (gx === 1 || gx === 2);
    // Front entrance: a walk-through gap in the ground-floor front-center wall
    // (aligned with the portico and the x=0 rib that leads back to the spine).
    const entrance = lobby ? (c: number): boolean => Math.abs(c) < 3 : undefined;
    if (extMinZ) addExteriorWall(blocks, "x", xMin, xMax, zMin, f, false);
    if (extMaxZ) addExteriorWall(blocks, "x", xMin, xMax, zMax, f, lobby, entrance);
    if (eMinX) addExteriorWall(blocks, "z", zMin, zMax, xMin, f, false);
    if (eMaxX) addExteriorWall(blocks, "z", zMin, zMax, xMax, f, false);
    // Interior faces toward a same-or-taller neighbor: light partition wall with
    // doorways (so wings connect), opened where a corridor crosses.
    if (!eMinX) addInteriorWall(blocks, "z", zMin, zMax, xMin, f, true, (x, z) => inSpine(z) || inRib(x));
    if (!eMaxX) addInteriorWall(blocks, "z", zMin, zMax, xMax, f, true, (x, z) => inSpine(z) || inRib(x));

    // (5b) CORRIDOR walls inside this wing: spine edges (if the wing spans the
    // spine) and rib edges (for ribs crossing this wing). Doors on the rhythm;
    // opened where the perpendicular corridor crosses.
    if (zMin < SPINE_Z - SPINE_HW && zMax > SPINE_Z + SPINE_HW) {
      for (const sz of [SPINE_Z - SPINE_HW, SPINE_Z + SPINE_HW]) {
        // open where a rib crosses (generously — the intersection is a plaza)
        addInteriorWall(blocks, "x", xMin, xMax, sz, f, true, (x) =>
          RIB_X.some((rx) => Math.abs(x - rx) <= RIB_HW + CROSS_PAD),
        );
      }
    }
    for (const rx of RIB_X) {
      if (rx <= xMin + 0.1 || rx >= xMax - 0.1) continue; // rib runs inside this wing
      for (const rex of [rx - RIB_HW, rx + RIB_HW]) {
        addInteriorWall(blocks, "z", zMin, zMax, rex, f, true, (_x, z) => Math.abs(z - SPINE_Z) <= SPINE_HW + CROSS_PAD);
      }
    }

    // (6) FIXTURES — corridor cells + room cells, anchored to the deck beneath.
    const add = (fx: number, fz: number): void => {
      if (overlapsVoid(fx, fz)) return;
      addFixture([fx, y + FLOOR_H - CEIL_GAP, fz], nearestSlab(slabs, fx, fz));
    };
    // spine cells within this wing
    if (zMin < SPINE_Z && zMax > SPINE_Z) {
      for (let sx = xMin + 2.5; sx < xMax; sx += 5) add(sx, SPINE_Z);
    }
    // rib cells within this wing
    for (const rx of RIB_X) {
      if (rx <= xMin || rx >= xMax) continue;
      for (let rz = zMin + 3; rz < zMax; rz += 6) add(rx, rz);
    }
    // one room fixture per wing-half (offset off the corridor into a room)
    add((xMin + xMax) / 2, (zMin + zMax) / 2 + (gz === 0 ? -1 : gz === 2 ? 1 : 0) * 3.5);

    // Interior clutter — becomes debris when hit.
    for (let k = 0; k < 3; k++) {
      const cx = xMin + 2 + ((gx + f + k) % 3) * 3.5;
      const cz = zMin + 2 + ((gz + k) % 3) * 3.5;
      if (overlapsVoid(cx, cz, 1.6, 0.9) || inCorridor(cx, cz)) continue;
      blocks.push(block("furniture", cx, y + 0.12, cz, 1.6, 0.9, 0.9));
    }
  }

  // Roof deck (clipped around the void) + parapet + mechanical units.
  const roofY = floors * FLOOR_H;
  addDeck(blocks, xMin, xMax, zMin, zMax, roofY, "cladding", null);
  const parapet = (axis: "x" | "z", perp: number): void => {
    const a0 = axis === "x" ? xMin : zMin;
    const a1 = axis === "x" ? xMax : zMax;
    const c = (a0 + a1) / 2;
    const len = a1 - a0;
    const x = axis === "x" ? c : perp;
    const z = axis === "x" ? perp : c;
    blocks.push(
      block("cladding", x, roofY + 0.1, z, axis === "x" ? len : 0.3, 0.55, axis === "x" ? 0.3 : len),
    );
  };
  if (extMinZ) parapet("x", zMin + 0.15);
  if (extMaxZ) parapet("x", zMax - 0.15);
  if (gx === 0 || COL_FLOORS[gx - 1] < floors) parapet("z", xMin + 0.15);
  if (gx === N_COL - 1 || COL_FLOORS[gx + 1] < floors) parapet("z", xMax - 0.15);
  if (floors === FLOORS) {
    const mx = (xMin + xMax) / 2 + ((gx + gz) % 2 === 0 ? -3 : 3);
    const mz = (zMin + zMax) / 2 + (((gz + 1) % 3) - 1) * 3;
    if (!overlapsVoid(mx, mz, 2.4, 1.7)) {
      blocks.push(block("metal", mx, roofY + 0.1, mz, 2.4, 1.3, 1.7));
      blocks.push(block("metal", mx + 1.9, roofY + 0.1, mz - 1.2, 1.1, 0.8, 1.1));
    }
  }

  return { name: `wing_${gx}${gz}`, blocks };
}

/** The entrance portico: a canopy on four columns at the front-center. */
function buildPortico(): SectionSpec {
  const blocks: BlockDef[] = [];
  for (const px of [-5.4, -1.8, 1.8, 5.4]) {
    blocks.push(block("concrete", px, 0, 3.9, 0.45, 3.4, 0.45));
  }
  blocks.push(block("cladding", 0, 3.4, 2.3, 13.6, 0.35, 4.6));
  return { name: "portico", blocks };
}

/**
 * (4) Parametric switchback stairwell, sized to fit EXACTLY inside its reserved
 * void. Two half-flights per storey (each rising FLOOR_H/2) in two x-lanes,
 * joined by a mid-landing (back) and a floor-landing (front). Closed-riser
 * treads (0.3 m rise < the controller's 0.5 m autostep, 0.8 m run > capsule
 * diameter) so the whole run is cleanly walkable; the flight one storey up sits
 * exactly FLOOR_H above the same lane, so headroom clears the capsule. The
 * matching floor-slab opening is produced by the deck-clip (step 2), so you can
 * pass floor-to-floor. Fixtures anchor to each floor-landing block.
 */
function buildStairwell(cx: number, cz: number, side: "A" | "B", addFixture: AddFixture): SectionSpec {
  const blocks: BlockDef[] = [];
  const HW = STAIR_HW;
  const HD = STAIR_HD;
  const stepsPerFlight = 6;
  const halfRise = FLOOR_H / 2;
  const rise = halfRise / stepsPerFlight; // 0.3 m
  const treadThick = rise + 0.12;
  const landingDepth = 1.2;
  const laneOffX = 1.15;
  const flightW = 2.0;
  const landW = 2 * (laneOffX + flightW / 2);
  const zFront = cz + HD;
  const zBack = cz - HD;
  const runFront = zFront - landingDepth;
  const runBack = zBack + landingDepth;
  const run = (runFront - runBack) / stepsPerFlight;

  for (let f = 0; f < FLOORS - 1; f++) {
    const yBase = f * FLOOR_H;
    const laneA = cx - laneOffX;
    const laneB = cx + laneOffX;
    for (let i = 1; i <= stepsPerFlight; i++) {
      const zc = runFront - (i - 0.5) * run;
      blocks.push(block("concrete", laneA, yBase + i * rise - treadThick, zc, flightW, treadThick, run + 0.04));
    }
    blocks.push(block("concrete", cx, yBase + halfRise - 0.24, zBack + landingDepth / 2, landW, 0.24, landingDepth));
    const baseB = yBase + halfRise;
    for (let i = 1; i <= stepsPerFlight; i++) {
      const zc = runBack + (i - 0.5) * run;
      blocks.push(block("concrete", laneB, baseB + i * rise - treadThick, zc, flightW, treadThick, run + 0.04));
    }
    // Floor-landing (arrival at floor f+1). Anchor this floor's fixture to it.
    const landingIdx = blocks.length;
    blocks.push(block("concrete", cx, yBase + FLOOR_H - 0.24, zFront - landingDepth / 2, landW, 0.24, landingDepth));
    addFixture([cx, (f + 1) * FLOOR_H + FLOOR_H - 0.4, cz], landingIdx);
  }

  // Shaft walls on 3 sides (open toward the corridor: A→+x, B→−x).
  const farX = cx < 0 ? cx - HW : cx + HW;
  for (let f = 0; f < FLOORS; f++) {
    const y = f * FLOOR_H;
    blocks.push(block("concrete", cx, y, zBack, 2 * HW, FLOOR_H, WALL_T));
    blocks.push(block("concrete", cx, y, zFront, 2 * HW, FLOOR_H, WALL_T));
    blocks.push(block("concrete", farX, y, cz, WALL_T, FLOOR_H, 2 * HD));
  }
  // Ground-floor fixture, anchored to the first shaft wall (always present).
  addFixture([cx, FLOOR_H - 0.4, cz], 0);
  // Stair penthouse cap (massing; reads like the reference circulation core).
  blocks.push(block("cladding", cx, FLOORS * FLOOR_H - 0.05, cz, 2 * HW, 2.3, 2 * HD));
  return { name: `stair_${side}`, blocks };
}

// --- unchanged surroundings (props) ---

function buildCar(x: number, z: number, alongX: boolean): SectionSpec {
  const L = 4.4;
  const W = 1.9;
  const w = alongX ? L : W;
  const d = alongX ? W : L;
  return {
    name: "car",
    blocks: [block("car", x, 0, z, w, 0.8, d), block("car", x, 0.8, z, w * 0.6, 0.7, d * 0.9)],
  };
}

function buildPole(x: number, z: number, addFixture: AddFixture): SectionSpec {
  addFixture([x, 5.2, z], 0); // anchor to the pole block itself
  return { name: "pole", blocks: [block("metal", x, 0, z, 0.25, 5.5, 0.25)] };
}

function buildOutbuilding(cx: number, cz: number): SectionSpec {
  const blocks: BlockDef[] = [];
  const hw = 3;
  const hd = 2.5;
  const h = 3;
  blocks.push(block("concrete", cx, 0, cz - hd, 2 * hw, h, 0.3));
  blocks.push(block("concrete", cx - hw, 0, cz, 0.3, h, 2 * hd));
  blocks.push(block("concrete", cx + hw, 0, cz, 0.3, h, 2 * hd));
  blocks.push(block("concrete", cx - hw + 0.9, 0, cz + hd, 1.8, h, 0.3));
  blocks.push(block("concrete", cx + hw - 0.9, 0, cz + hd, 1.8, h, 0.3));
  blocks.push(block("cladding", cx, h - 0.12, cz, 2 * hw, 0.24, 2 * hd));
  return { name: "outbuilding", blocks };
}

function buildDumpster(x: number, z: number): SectionSpec {
  return { name: "dumpster", blocks: [block("metal", x, 0, z, 2.2, 1.5, 1.4)] };
}

function buildBarrier(x: number, z: number, alongX: boolean): SectionSpec {
  const w = alongX ? 3 : 0.5;
  const d = alongX ? 0.5 : 3;
  return { name: "barrier", blocks: [block("concrete", x, 0, z, w, 0.9, d)] };
}

// ===========================================================================
// Assembly.
// ===========================================================================

/**
 * buildHospital() returns:
 *  - sections: fed to StructureSystem (order preserved 1:1 with fixture owners)
 *  - lightFixtures / fixtureSection / fixtureAnchor: parallel arrays. A fixture
 *    is owned by section `fixtureSection[i]` and ANCHORED to that section's
 *    block `fixtureAnchor[i]` — InteriorLights kills the fixture (mesh + light)
 *    exactly when that anchor block is released (genuine destruction), and
 *    retains it when the section merely re-sleeps (anchor never released).
 */
export function buildHospital(): {
  sections: SectionSpec[];
  lightFixtures: Fixture[];
  fixtureSection: number[];
  fixtureAnchor: number[];
} {
  const sections: SectionSpec[] = [];
  const lightFixtures: Fixture[] = [];
  const fixtureSection: number[] = [];
  const fixtureAnchor: number[] = [];
  const fixtureAdder =
    (sectionIndex: number): AddFixture =>
    (f, anchor) => {
      lightFixtures.push(f);
      fixtureSection.push(sectionIndex);
      fixtureAnchor.push(anchor);
    };

  for (let gx = 0; gx < N_COL; gx++) {
    for (let gz = 0; gz < N_ROW; gz++) {
      sections.push(buildWing(gx, gz, fixtureAdder(sections.length)));
    }
  }
  for (const s of STAIRS) {
    sections.push(buildStairwell(s.cx, s.cz, s.side, fixtureAdder(sections.length)));
  }
  sections.push(buildPortico());

  // Parking lot.
  const carRows = [5.5, 15.5];
  for (const z of carRows) {
    let stall = 0;
    for (let x = -25.5; x <= 25.5; x += 2.7) {
      stall++;
      if (Math.abs(x) < (z === carRows[0] ? 7.5 : 2)) continue;
      if (stall % 6 === 0) continue;
      sections.push(buildCar(x, z, false));
    }
  }
  for (const [px, pz] of [[-25, 5.5], [25, 5.5], [-25, 15.5], [25, 15.5], [0, 10.5]]) {
    sections.push(buildPole(px, pz, fixtureAdder(sections.length)));
  }
  sections.push(buildOutbuilding(-52, -44));
  for (const [dx, dz] of [[-30, 4], [-30, 6.5], [30, 18], [33, 18]]) {
    sections.push(buildDumpster(dx, dz));
  }
  for (const [bx, bz, ax] of [[-6, 1, 1], [6, 1, 1]]) {
    sections.push(buildBarrier(bx, bz, ax === 1));
  }

  return { sections, lightFixtures, fixtureSection, fixtureAnchor };
}
