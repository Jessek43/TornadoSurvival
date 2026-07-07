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
import type { RoomContent } from "./layouts";

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

/** Per-floor room-archetype config, read from the FLOOR_LAYOUTS table by the
 *  furnish orchestrator and passed straight through. Everything the room floor
 *  varies per storey lives here — never a runtime random. */
export interface RoomFloorCfg {
  facadeRooms: number; // windowed rooms per wing
  interiorRooms: number; // blind rooms across the corridor per wing
  content: RoomContent; // what facade (and non-kitchen) rooms are
  interiorContent: RoomContent; // what the BLIND interior rooms are (per-floor unique room)
  extras: boolean; // IV + monitor + chair in wide rooms
  kitchen: boolean; // this wing+floor hosts the building's single kitchen
  budget: number; // block budget for this floor (per wing)
}

/**
 * Detail one floor of one wing as a double-loaded corridor of rooms, furnished
 * per `cfg.content` (patient ward / doctor's offices), with an optional single
 * kitchen. Reuses the proven room shell (separator walls, doorway, enterability
 * registry) unchanged — only the furniture cluster inside each room varies by
 * content, and every cluster is wall-backed within the bed's proven footprint,
 * so walkability is preserved by construction. (Was furnishWardFloor; the ward
 * is now just `content: "patient"`.)
 */
export function furnishRoomFloor(ctx: WingCtx, f: number, cfg: RoomFloorCfg): void {
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

  /** One room off the corridor. Separator walls sit just inside the interval
   *  edges (clear of the rib walls); the doorway sits on the boundary side
   *  while furniture anchors to a separator wall, so entry is never behind
   *  furniture. Records the room for verify's enterability asserts and returns
   *  the door placement for the corridor dressing. */
  const addRoom = (
    room: RoomInterval,
    kind: "facade" | "interior",
    content: RoomContent,
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

    // FURNITURE — content-specific cluster, anchored to the SEPARATOR side wall
    // in the band away from the door (so the door→interior walk stays clear).
    // The office/kitchen clusters fit inside the bed's proven footprint, so the
    // enterability flood-fill still clears at least the same free area.
    const bedZ = kind === "facade" ? faceIn + inward * 0.8 : intBackZ - inward * 0.8;
    const facingSep: props.Facing = bedLow ? "-x" : "+x"; // faces back to the separator
    // Direction from the wall-backed cluster INTO the room (toward the door):
    // facade rooms open inward toward the corridor, interior rooms the reverse.
    const intoRoom = kind === "facade" ? inward : -inward;
    if (content === "patient") {
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
      if (kind === "facade" && room.wide && cfg.extras) {
        blocks.push(...props.ivStand(bedX + (bedLow ? 1.9 : -1.9), base, bedZ, bedFacing));
        blocks.push(...props.chair(doorSideX, base, faceIn + inward * 1.05, facingSep));
        // Wall-flat vitals monitor over the bedside cabinet — no floor footprint
        // (keeps the room's walkable area intact), 1 block.
        blocks.push(
          ...props.wallPanel(bedX, base + 1.2, bedZ + inward * 0.9, bedFacing, "accentBlue", 0.42, 0.34),
        );
      }
    } else if (content === "office") {
      // Desk on the separator (reaches ~1.45 m out); chair seated just past it
      // facing the desk (floor footprints don't overlap); cabinet deeper along
      // the same wall.
      blocks.push(...props.officeDesk(bedX, base, bedZ, bedFacing));
      blocks.push(...props.chair(bedX + (bedLow ? 2.05 : -2.05), base, bedZ, facingSep));
      blocks.push(...props.cabinet(bedX, base, bedZ + intoRoom * 1.5, bedFacing));
    } else if (content === "kitchen") {
      // Kitchen (a facade room; a kitchen may have a window). Counter + fridge
      // along the separator wall, well spaced; a table off the counter foot in
      // wide rooms — all wall-hugging so the room stays walkable.
      blocks.push(...props.counter(bedX, base, bedZ, bedFacing, 1.4));
      blocks.push(...props.appliance(bedX, base, bedZ + intoRoom * 1.55, bedFacing));
      if (room.wide) {
        blocks.push(...props.kitchenTable(bedX + (bedLow ? 1.55 : -1.55), base, bedZ, bedFacing));
      }
    } else if (content === "lab") {
      // Pathology lab (a floor-unique blind room): a bench run + a wall-flat
      // vitals/analysis monitor above it + a stool — all on the separator wall,
      // footprint ≤ the office desk's, so walkability holds (5 blocks, same as
      // the patient cluster it replaces, so the floor budget is unchanged).
      blocks.push(...props.counter(bedX, base, bedZ, bedFacing, 1.4));
      blocks.push(
        ...props.wallPanel(bedX, base + 1.15, bedZ, bedFacing, "accentBlue", 0.42, 0.34),
      );
      blocks.push(...props.chair(bedX + (bedLow ? 1.65 : -1.65), base, bedZ, facingSep, "metal"));
    } else {
      // Records archive (a floor-unique blind room): a run of filing cabinets
      // along the separator wall + a wall chart — all wall-hugging, so the room
      // stays as walkable as an office.
      blocks.push(...props.cabinet(bedX, base, bedZ, bedFacing));
      blocks.push(...props.cabinet(bedX, base, bedZ + intoRoom * 1.5, bedFacing));
      blocks.push(
        ...props.wallPanel(bedX, base + 1.4, bedZ + intoRoom * 0.75, bedFacing, "propWhite", 0.7, 0.5),
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
      content,
      floor: f,
      name: `wing_${gx}${gz} f${f} ${content} ${kind} @${room.x0.toFixed(0)}`,
    });
    return { doorC, bedLow, xIn0, xIn1 };
  };

  const intervals = planRoomIntervals(xMin, xMax);
  let mainRoom: { doorC: number; bedLow: boolean; xIn0: number; xIn1: number } | null = null;
  const facade = intervals.slice(0, cfg.facadeRooms);
  for (let i = 0; i < facade.length; i++) {
    // The building's single kitchen takes the LAST facade room of its
    // designated wing+floor (facade geometry is the roomy, predictable one);
    // every other facade room follows cfg.content.
    const content = cfg.kitchen && i === facade.length - 1 ? "kitchen" : cfg.content;
    const placed = addRoom(facade[i], "facade", content);
    if (content !== "kitchen") mainRoom = mainRoom ?? placed;
  }
  for (const room of intervals.slice(0, cfg.interiorRooms)) {
    // The blind interior room is the floor's UNIQUE room type (lab / records /
    // ward office / kitchen), so every floor has a room the others don't.
    addRoom(room, "interior", cfg.interiorContent);
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
  if (used > cfg.budget) {
    throw new Error(
      `room furnish budget exceeded: wing_${gx}${gz} floor ${f} (${cfg.content}) used ${used} > ${cfg.budget}`,
    );
  }
}

/**
 * FLOOR 0 — the entrance concourse. The two front-center wings (gx 1/2, gz 2)
 * that flank the glazed entrance axis get an open reception area rather than
 * rooms: a reception/nurse desk facing the doors, two waiting bench rows, a
 * planter and a directory pillar. Everything is freestanding on the deck (so
 * the per-section support flood-fill releases it with the floor) and kept well
 * clear of the rib/entrance corridor no-go zones (verify's corridor-intrusion
 * assert), spaced apart so no two props share a plane.
 */
export function furnishEntranceHall(ctx: WingCtx, budget: number): void {
  const { gx, blocks } = ctx;
  const before = blocks.length;
  const base = wallBaseY(0);
  const east = gx === 2;
  const cx = east ? 5 : -5; // concourse center in the entrance-side half
  const sign = east ? 1 : -1;

  // Reception counter (west wing) / nurse station (east wing), facing the doors.
  if (east) blocks.push(...props.nurseStation(cx, base, -4, "+z"));
  else blocks.push(...props.receptionDesk(cx, base, -4, "+z", "accentTeal"));

  // Two waiting bench rows deeper into the hall.
  blocks.push(...props.benchRow(cx, base, -8.4, "+z", "accentBlue"));
  blocks.push(...props.benchRow(cx, base, -11, "+z", "accentOrange"));

  // Planter near the entrance and a directory pillar (post + hanging sign).
  blocks.push(...props.plant(cx + sign * 2.6, base, -2.2));
  blocks.push(block("metal", cx - sign * 2.6, base, -1.7, 0.12, 2.0, 0.12));
  blocks.push(block("signRed", cx - sign * 2.6, base + 2.0, -1.7, 1.3, 0.5, 0.14));

  // A row of parked medical equipment along the back of the concourse (the
  // wishlist gurney / wheelchair / cart + a vending machine). Spaced 2 m apart
  // and clear of the rib corridors, so they never share a face plane or block
  // circulation. Facing the doors (+z).
  const backZ = -13.5;
  blocks.push(...props.vendingMachine(cx - 3, base, backZ, "+z"));
  blocks.push(...props.gurney(cx - 1, base, backZ, "+z"));
  blocks.push(...props.wheelchair(cx + 1, base, backZ, "+z"));
  blocks.push(...props.supplyCart(cx + 3, base, backZ, "+z"));

  const used = blocks.length - before;
  if (used > budget) {
    throw new Error(`entrance furnish budget exceeded: wing_${gx}2 used ${used} > ${budget}`);
  }
}
