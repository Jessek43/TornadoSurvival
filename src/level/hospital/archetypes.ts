import type { BlockDef } from "../Blueprints";
import type { MaterialId } from "../Materials";
import {
  HOSPITAL_PARAMS as P,
  COLS,
  X_EDGES,
  Z_EDGES,
  overlapsVoid,
  wallBaseY,
  wallTopY,
  type Fixture,
  type RoomSpec,
} from "./params";
import { block } from "./shell";
import * as props from "./props";

/**
 * PHASE 2 — floor archetypes. Each furnish*Floor function decorates ONE floor
 * of ONE wing, appending blocks into the wing's existing section (props must
 * live in their wing's section: the support flood-fill is per-section, and
 * riding it is exactly what releases a bed when its room is torn out).
 *
 * WARD floors (revised after the first gate failure): a DOUBLE-LOADED
 * corridor parallel to the facade — the image-1 read:
 *
 *   facade wall | patient rooms (windowed) | corridor | blind rooms | wing core
 *        z=0         0 … 4.6                4.6 … 6.8   6.8 … 10.6     open
 *
 * Rooms are FREE-FORM intervals between the rib-corridor no-go zones (their
 * separators never touch the facade wall band, so they don't need to align
 * to the window segments) — that's what makes rooms big: the old
 * segment-aligned slicing produced only cramped 2.9 m rooms.
 *
 * Enterability is designed in, then ASSERTED (verify.ts, rooms registry):
 *  - beds run along x with the headboard on a SIDE wall — never on the wall
 *    the door is cut into (the old layout put the bed across the doorway);
 *  - the 1.4 m door passage contains nothing (the old vision panel stood in
 *    it) — an open wood door LEAF sits flat against the corridor-side wall;
 *  - curtains became wall-flat window drapes (the old mid-room drape hung to
 *    1.7 m across the room — under the 1.8 m capsule);
 *  - drapes/extras keep the high-x band clear — it is the walking corridor
 *    from the door to the window.
 *
 * Interior rooms are BLIND — zero glass by construction (only the shell's
 * addExteriorWall ever emits glass): the shelter puzzle's safe-but-blind
 * option, and what stops the wing interior reading hollow.
 */

/** Phase-2 palette: interior deck color per floor (roofs stay cladding).
 *  All ids are physics clones of concrete — color only. */
export function DECK_PALETTE(f: number): MaterialId {
  return f === 0 ? "floorBeige" : f === 1 ? "floorTeal" : "floorMustard";
}

export interface WingCtx {
  gx: number;
  gz: number;
  blocks: BlockDef[]; // the wing section's array — APPEND ONLY
  addFixture: (f: Fixture) => void;
  rooms: RoomSpec[]; // enterability registry for verify.ts
}

// Band depths of the double-loaded ward corridor, measured inward from the
// facade. Facade rooms [0, ROOM_D]; corridor [ROOM_D, ROOM_D+CORR_W];
// interior rooms [ROOM_D+CORR_W, ROOM_D+CORR_W+INT_D], open-backed.
const ROOM_D = 4.6;
const CORR_W = 2.2;
const INT_D = 3.8;
/** Interval edges keep separator bands (wallT) clear of the rib walls'
 *  outer faces (ribHW + wallT/2) with a 0.15 m abutment-free gap. */
const RIB_CLEAR = 1.7;
const MIN_ROOM = 2.4;
const WIDE_ROOM = 4.5;

const dirToFacing = (s: number): props.Facing => (s > 0 ? "+z" : "-z");

interface RoomInterval {
  x0: number; // clear-interval edges (separator bands sit just inside)
  x1: number;
  sepLo: boolean; // rib-adjacent edge → separator wall; else wing boundary
  sepHi: boolean;
  window?: [number, number]; // facade window segment inside the room, if any
  wide: boolean;
}

/** Slice the wing width into free-form room intervals between the rib
 *  no-go zones; attach the window segment nearest each room's center. */
function planRoomIntervals(xMin: number, xMax: number): RoomInterval[] {
  const zones = P.ribX
    .map((rx) => [rx - RIB_CLEAR, rx + RIB_CLEAR] as const)
    .filter(([z0, z1]) => z1 > xMin && z0 < xMax)
    .sort((a, b) => a[0] - b[0]);
  const intervals: RoomInterval[] = [];
  let cursor = xMin;
  const pushInterval = (x0: number, x1: number): void => {
    if (x1 - x0 < MIN_ROOM + 0.6) return;
    intervals.push({ x0, x1, sepLo: x0 > xMin + 0.05, sepHi: x1 < xMax - 0.05, wide: false });
  };
  for (const [z0, z1] of zones) {
    pushInterval(cursor, Math.min(z0, xMax));
    cursor = Math.max(cursor, z1);
  }
  pushInterval(cursor, xMax);

  // Window attachment: the facade's glass sits on even segments (see
  // addExteriorWall); a room is windowed when a window segment's center
  // falls inside it.
  const n = Math.max(1, Math.round((xMax - xMin) / P.seg));
  const seg = (xMax - xMin) / n;
  for (const room of intervals) {
    for (let i = 0; i < n; i += 2) {
      const ws0 = xMin + i * seg;
      const c = ws0 + seg / 2;
      if (c > room.x0 && c < room.x1) {
        room.window = [ws0, ws0 + seg];
        break;
      }
    }
    room.wide = room.x1 - room.x0 > WIDE_ROOM;
  }
  intervals.sort(
    (a, b) => Number(!!b.window) - Number(!!a.window) || b.x1 - b.x0 - (a.x1 - a.x0),
  );
  return intervals;
}

/** Inner face of whatever shell wall stands at a wing x-boundary this floor.
 *  Envelope side walls and partitions STRADDLE the edge (inner face at
 *  wallT/2); only a massing-step wall sits flush inside (inner face at
 *  wallT). Getting this wrong leaves a 15 cm air gap that strands
 *  wall-mounted props. */
function boundaryInset(gx: number, f: number, side: -1 | 1): number {
  const neighbor = side === -1 ? gx - 1 : gx + 1;
  const isStep = neighbor >= 0 && neighbor < COLS && f >= P.colFloors[neighbor];
  return isStep ? P.wallT : P.wallT / 2;
}

export function furnishWardFloor(ctx: WingCtx, f: number): void {
  const { gx, gz, blocks, addFixture } = ctx;
  const before = blocks.length;
  const xMin = X_EDGES[gx];
  const xMax = X_EDGES[gx + 1];
  const base = wallBaseY(f);
  const top = wallTopY(f);
  const h = top - base;
  const fy = f * P.floorHeight + P.floorHeight - P.ceilGap;
  // `inward` points from the wing's envelope facade into the building.
  const inward = gz === 0 ? 1 : -1;
  const facadeZ = inward === 1 ? Z_EDGES[gz] : Z_EDGES[gz + 1];
  const faceIn = facadeZ + inward * (P.wallT / 2); // facade wall inner face
  const frontWallZ = facadeZ + inward * ROOM_D; // facade rooms' corridor wall
  const intWallZ = facadeZ + inward * (ROOM_D + CORR_W); // interior rooms' corridor wall
  const intBackZ = facadeZ + inward * (ROOM_D + CORR_W + INT_D); // open back edge

  /** One room off the ward corridor. Separator walls sit just inside the
   *  interval edges (clear of the rib walls); the doorway sits on the
   *  boundary side while the bed anchors to a separator wall, so entry is
   *  never behind furniture. Records the room for verify's enterability
   *  asserts and returns the door placement for the corridor dressing. */
  const addRoom = (
    room: RoomInterval,
    kind: "facade" | "interior",
  ): { doorC: number; bedLow: boolean; xIn0: number; xIn1: number } | null => {
    const wallZ = kind === "facade" ? frontWallZ : intWallZ;
    const zNear = kind === "facade" ? faceIn : intWallZ + inward * (P.wallT / 2);
    const zFar = kind === "facade" ? frontWallZ - inward * (P.wallT / 2) : intBackZ;
    const xIn0 = room.sepLo ? room.x0 + P.wallT : room.x0 + boundaryInset(gx, f, -1);
    const xIn1 = room.sepHi ? room.x1 - P.wallT : room.x1 - boundaryInset(gx, f, 1);
    for (const [needed, sx] of [
      [room.sepLo, room.x0 + P.wallT / 2],
      [room.sepHi, room.x1 - P.wallT / 2],
    ] as const) {
      if (!needed) continue;
      blocks.push(
        block("cladding", sx, base, (zNear + zFar) / 2, P.wallT, h, Math.abs(zFar - zNear)),
      );
    }

    // The bed cluster anchors to a SEPARATOR side wall, never a wing
    // boundary (corner columns live 0.3–0.8 m inside boundary walls and the
    // first slice's beds collided with them). When only the high edge has a
    // separator, the whole room mirrors: bed high, door low.
    if (!room.sepLo && !room.sepHi) return null; // can't happen: every wing has a rib
    const bedLow = room.sepLo;
    const bedX = bedLow ? xIn0 : xIn1;
    const bedFacing: props.Facing = bedLow ? "+x" : "-x";
    const doorSideX = bedLow ? xIn1 : xIn0;

    // Corridor wall with a 1.4 m clear doorway on the door side.
    const doorC = bedLow ? xIn1 - 1.05 : xIn0 + 1.05;
    for (const [w0, w1] of [[xIn0, doorC - 0.95], [doorC + 0.95, xIn1]] as const) {
      if (w1 - w0 > 0.1) {
        blocks.push(block("cladding", (w0 + w1) / 2, base, wallZ, w1 - w0, h, P.wallT));
      }
    }
    for (const jx of [doorC - 0.825, doorC + 0.825]) {
      blocks.push(block("wood", jx, base, wallZ, 0.25, 2.1, P.wallT)); // jambs
    }
    blocks.push(block("wood", doorC, base + 2.1, wallZ, 1.9, h - 2.1, P.wallT)); // header
    // Open door leaf flat against the corridor-side wall face beside the
    // opening (on the bed side, where the wall piece is long) — the door
    // reads without a single collider in the passage.
    const corrSide = kind === "facade" ? inward : -inward;
    const corrFaceZ = wallZ + corrSide * (P.wallT / 2);
    const leafFits = bedLow ? doorC - 0.95 - xIn0 > 0.95 : xIn1 - (doorC + 0.95) > 0.95;
    if (leafFits) {
      const leafX = bedLow ? doorC - 0.95 - 0.46 : doorC + 0.95 + 0.46;
      blocks.push(block("wood", leafX, base, corrFaceZ + corrSide * 0.025, 0.9, 2.0, 0.05));
    }
    blocks.push(
      ...props.wallPanel(doorC, base + 2.45, corrFaceZ, dirToFacing(corrSide), "signRed", 0.5, 0.3),
    );

    // FURNITURE — bed along x, headboard on the separator wall, in the band
    // away from the door wall; cabinet beside the headboard.
    const bedZ = kind === "facade" ? faceIn + inward * 0.8 : intBackZ - inward * 0.8;
    blocks.push(...props.bed(bedX, base, bedZ, bedFacing));
    blocks.push(...props.bedheadPanel(bedX, base, bedZ, bedFacing));
    blocks.push(...props.bedsideCabinet(bedX, base, bedZ + inward * 0.9, bedFacing));
    if (kind === "facade" && room.window) {
      // Drapes flank the window flat on the facade wall — but never in the
      // door-side band, which is the walking corridor from door to window.
      for (const dx of [room.window[0] + 0.25, room.window[1] - 0.25]) {
        const clearOfDoorBand = bedLow ? dx < xIn1 - 1.2 : dx > xIn0 + 1.2;
        if (dx > xIn0 + 0.3 && dx < xIn1 - 0.3 && clearOfDoorBand) {
          blocks.push(...props.windowDrape(dx, base, faceIn, dirToFacing(inward)));
        }
      }
    }
    if (kind === "facade" && room.wide && P.furnish.wardExtras) {
      blocks.push(...props.ivStand(bedX + (bedLow ? 1.9 : -1.9), base, bedZ, bedFacing));
      blocks.push(
        ...props.chair(doorSideX, base, faceIn + inward * 1.05, bedLow ? "-x" : "+x"),
      );
    }
    addFixture([(xIn0 + xIn1) / 2, fy, (zNear + zFar) / 2]);

    ctx.rooms.push({
      x0: xIn0,
      x1: xIn1,
      z0: Math.min(zNear, zFar),
      z1: Math.max(zNear, zFar),
      base,
      doorC,
      doorWallZ: wallZ,
      windowZ: kind === "facade" ? faceIn : undefined,
      kind,
      name: `wing_${gx}${gz} f${f} ${kind} @${room.x0.toFixed(0)}`,
    });
    return { doorC, bedLow, xIn0, xIn1 };
  };

  const intervals = planRoomIntervals(xMin, xMax);
  let mainRoom: { doorC: number; bedLow: boolean; xIn0: number; xIn1: number } | null = null;
  for (const room of intervals.slice(0, P.furnish.roomsPerFloor)) {
    const placed = addRoom(room, "facade");
    mainRoom = mainRoom ?? placed;
  }
  for (const room of intervals.slice(0, P.furnish.interiorRoomsPerFloor)) {
    addRoom(room, "interior");
  }

  // CORRIDOR DRESSING — orange handrail bumpers + wall chart on the main
  // room's LONG wall piece (the bed side — clear of both the doorway and
  // the open door leaf), a freestanding waiting chair 0.1 m off the wall
  // (never sharing the rail's wall plane), plus the rib-corridor rails
  // (image-1: rails line every corridor).
  if (mainRoom) {
    // Rail zone: the long piece, minus the leaf's footprint next to the door.
    const r0 = mainRoom.bedLow ? mainRoom.xIn0 + 0.1 : mainRoom.doorC + 1.96;
    const r1 = mainRoom.bedLow ? mainRoom.doorC - 1.96 : mainRoom.xIn1 - 0.1;
    if (r1 - r0 > 1.2) {
      const railW = Math.min(r1 - r0, 2.6);
      const railC = (r0 + r1) / 2;
      for (const [wz, s] of [
        [frontWallZ + inward * (P.wallT / 2), inward],
        [intWallZ - inward * (P.wallT / 2), -inward],
      ] as const) {
        blocks.push(block("accentOrange", railC, base + 0.9, wz + s * 0.03, railW, 0.12, 0.06));
      }
      blocks.push(
        ...props.wallPanel(
          railC, base + 1.35, frontWallZ + inward * (P.wallT / 2),
          dirToFacing(inward), "propWhite", 0.8, 0.6,
        ),
      );
      blocks.push(
        ...props.chair(
          railC, base,
          intWallZ - inward * (P.wallT / 2 + 0.1), dirToFacing(-inward),
        ),
      );
    }
  }
  const rib = P.ribX.find((rx) => rx > xMin + 0.1 && rx < xMax - 0.1);
  if (rib !== undefined) {
    const zr0 = Z_EDGES[gz] + (gz === 0 ? P.wallT / 2 : 0);
    const zr1 = Z_EDGES[gz + 1] - (gz === P.rows - 1 ? P.wallT / 2 : 0);
    const zSeg = (zr1 - zr0) / Math.max(1, Math.round((zr1 - zr0) / P.seg));
    const railZ = zr0 + zSeg * 2.5; // center of solid segment i=2 (never a door)
    for (const side of [-1, 1] as const) {
      const face = rib + side * (P.ribHW - P.wallT / 2);
      const railX = face - side * 0.03;
      if (!overlapsVoid(railX, railZ, 0.06, 2.8)) {
        blocks.push(block("accentOrange", railX, base + 0.9, railZ, 0.06, 0.12, 2.8));
      }
    }
  }
  // Corridor ceiling panels down the ward corridor's centerline.
  for (let sx = xMin + 3; sx < xMax; sx += 6) {
    addFixture([sx, fy, facadeZ + inward * (ROOM_D + CORR_W / 2)]);
  }

  const used = blocks.length - before;
  if (used > P.furnish.budgetPerFloor.ward) {
    throw new Error(
      `ward furnish budget exceeded: wing_${gx}${gz} floor ${f} used ${used} > ${P.furnish.budgetPerFloor.ward}`,
    );
  }
}
