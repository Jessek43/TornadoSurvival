import { HOSPITAL_PARAMS as P, wallBaseY, wallTopY, type Fixture } from "./params";
import {
  NX,
  NZ,
  CELLS_PER_COL,
  CELLS_PER_ROW,
  cellX0,
  cellZ0,
  cellCX,
  cellCZ,
  wingGX,
  wingGZ,
  inUsable,
  isCoreCell,
  exteriorInnerBounds,
  voidCellBounds,
  type CellRect,
} from "./grid";
import { block, type HospitalShell } from "./shell";
import { FLOOR_SPECS, type FloorSpec } from "./floorplans";
import type { RoomContent } from "./layouts";

/**
 * THE PER-FLOOR INTERIOR PARTITION BUILDER.
 *
 * This is what turns the authored floor plans (floorplans.ts) into real
 * enclosure. It runs entirely on the module CELL grid (grid.ts), independent of
 * the shell's world-space envelope, and does three things per storey exactly as
 * the design mandates:
 *
 *  1. RASTERIZE the plan → a cell map (OUTSIDE / CORE / CORRIDOR / ROOM /
 *     BLOCKED). Corridors come straight from the spec; the leftover usable cells
 *     are deterministically carved into whole-cell room rectangles, each cut a
 *     door onto an adjacent corridor. (Authored data expanded by a deterministic
 *     builder — never a runtime random generator.)
 *  2. EMIT INTERIOR WALLS: a full-height wall on EVERY boundary between a
 *     walkable cell and a non-walkable cell (and between two different rooms),
 *     except at door openings, where a 1-cell gap is left under a lintel. Walls
 *     merge into runs, abut (never overlap) at corners, clip to the shell's
 *     exterior inner faces, and ride the wing SECTION under them so the support
 *     flood-fill and wake/re-sleep keep working per wing.
 *  3. TAG each room with its content so furnish.ts dresses a real enclosed room
 *     instead of open space.
 *
 * An "open plate" is impossible by construction: unwalked space is walled off,
 * corridors are the only circulation, rooms connect only through authored doors.
 * verify.ts re-derives the cell map + samples the emitted geometry to assert it.
 */

export const enum Cell {
  OUTSIDE = 0,
  CORE = 1, // reserved stair void (the shell's stairwell owns its own walls)
  CORRIDOR = 2,
  ROOM = 3,
  BLOCKED = 4, // usable but un-tiled → solid poché, walled off from walkable space
}

export interface BuiltRoom {
  floor: number;
  gx: number;
  gz: number;
  content: RoomContent;
  facade: boolean; // touches an exterior (windowed) plate edge
  /** Cell rect. */
  cix: number;
  ciz: number;
  cw: number;
  cd: number;
  /** Interior clear rect (world, between wall inner faces). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  base: number;
  /** Door opening: `axis` is the wall's normal, `perp` its plane, `along` the
   *  opening centre, `inward` points from the door into the room. `mid`/`edge`
   *  are the opening's cell coordinates (the header emitter reads them to butt
   *  the jambs on both sides — see Doorway). */
  door: (Doorway & { perp: number; along: number; inward: 1 | -1 }) | null;
  name: string;
}

/**
 * A 1-cell doorway on the cell grid, enough to emit its header. `axis` is the
 * wall's normal ("z" = a horizontal wall, opening spans x; "x" = a vertical
 * wall, opening spans z). `mid` is the opening cell's index ALONG the wall;
 * `edge` is the wall's cell-edge index on the perpendicular axis — so for a
 * z-door the wall is at z=cellZ0(edge+1) across cell mid, and for an x-door at
 * x=cellX0(edge+1) across cell mid. Rooms and stair cores share this.
 */
export interface Doorway {
  axis: "x" | "z";
  mid: number;
  edge: number;
}

export interface FloorMap {
  f: number;
  spec: FloorSpec;
  kind: Uint8Array; // idx(ix,iz)
  roomId: Int16Array; // -1 or index into rooms
  rooms: BuiltRoom[];
  /** Room/core → corridor edges left open (no wall); keyed `v:ix:iz`/`h:ix:iz`. */
  doorEdges: Set<string>;
  /** One doorway per stair core per floor (the corridor→stairs connection). */
  coreDoors: Doorway[];
  usableCells: number;
  corridorCells: number;
  signature: string;
}

export interface PartitionResult {
  rooms: BuiltRoom[];
  floorMaps: FloorMap[];
}

const idx = (ix: number, iz: number): number => ix * NZ + iz;
const inGrid = (ix: number, iz: number): boolean => ix >= 0 && ix < NX && iz >= 0 && iz < NZ;
const NEI4: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Cell kind at (ix,iz), or OUTSIDE off-grid — the read verify shares. */
export const cellKindAt = (map: FloorMap, ix: number, iz: number): Cell =>
  inGrid(ix, iz) ? (map.kind[idx(ix, iz)] as Cell) : Cell.OUTSIDE;
export const isWalkable = (k: Cell): boolean => k === Cell.CORRIDOR || k === Cell.ROOM;

/** Does the builder emit a wall on the edge between (ax,az) and its +x or +z
 *  neighbour (bx,bz)? (verify replays this to check the geometry matches.) */
export function edgeHasWall(map: FloorMap, ax: number, az: number, bx: number, bz: number): boolean {
  if (!needsWall(map, ax, az, bx, bz)) return false;
  const key = bx === ax + 1 ? `v:${ax}:${az}` : `h:${ax}:${az}`;
  return !map.doorEdges.has(key);
}

// ===========================================================================
// 1 — RASTERIZE the plan to a cell map + carve rooms.
// ===========================================================================

function rasterizeCorridors(kind: Uint8Array, corridors: readonly CellRect[]): void {
  for (const r of corridors) {
    for (let ix = r.x; ix < r.x + r.w; ix++) {
      for (let iz = r.z; iz < r.z + r.d; iz++) {
        if (!inGrid(ix, iz)) continue;
        // Corridors only claim usable, non-core cells (a rect may sweep over a
        // void or off the plate — those cells are ignored, never un-walled).
        if (kind[idx(ix, iz)] === Cell.BLOCKED) kind[idx(ix, iz)] = Cell.CORRIDOR;
      }
    }
  }
}

/** Longest run of free (BLOCKED) cells rightward from (ix,iz), within [.,ix1). */
function freeRun(kind: Uint8Array, ix: number, iz: number, ix1: number): number {
  let n = 0;
  while (ix + n < ix1 && kind[idx(ix + n, iz)] === Cell.BLOCKED) n++;
  return n;
}

/** How deep a w-wide band of free cells extends downward from (ix,iz). */
function freeDepth(kind: Uint8Array, ix: number, w: number, iz: number, iz1: number): number {
  let d = 0;
  outer: while (iz + d < iz1) {
    for (let k = 0; k < w; k++) {
      if (kind[idx(ix + k, iz + d)] !== Cell.BLOCKED) break outer;
    }
    d++;
  }
  return d;
}

const colHasCorridor = (map: FloorMap, cx: number, iz: number, d: number): boolean => {
  for (let z = iz; z < iz + d; z++) if (cellKindAt(map, cx, z) === Cell.CORRIDOR) return true;
  return false;
};
const rowHasCorridor = (map: FloorMap, ix: number, cz: number, w: number): boolean => {
  for (let x = ix; x < ix + w; x++) if (cellKindAt(map, x, cz) === Cell.CORRIDOR) return true;
  return false;
};

/**
 * Carve one wing's leftover free cells into whole-cell room rectangles. The
 * cardinal rule (the fix for the old open-plate + unreachable rooms): a room
 * spans the FULL width of its bay perpendicular to its access corridor, and is
 * sliced only ALONG that corridor — so EVERY room touches a corridor and can be
 * given a door. A maximal free rectangle picks its access side (a rib on the
 * left/right → slice along z; else an avenue above/below → slice along x), then
 * cuts rooms ≤ roomMaxD deep / roomMaxW wide (runs of ≤ max+1 stay whole).
 */
function carveWing(map: FloorMap, gx: number, gz: number, spec: FloorSpec): void {
  const { kind, f } = map;
  const ix0 = gx * CELLS_PER_COL;
  const ix1 = Math.min(ix0 + CELLS_PER_COL, NX);
  const iz0 = gz * CELLS_PER_ROW;
  const iz1 = iz0 + CELLS_PER_ROW;

  const place = (ix: number, iz: number, w: number, d: number): void => {
    if (w * d < 2) return; // leave a lone cell as poché (BLOCKED)
    const id = map.rooms.length;
    for (let cx = ix; cx < ix + w; cx++) {
      for (let cz = iz; cz < iz + d; cz++) {
        kind[idx(cx, cz)] = Cell.ROOM;
        map.roomId[idx(cx, cz)] = id;
      }
    }
    map.rooms.push(makeRoom(f, gx, gz, ix, iz, w, d, spec));
  };

  for (let iz = iz0; iz < iz1; iz++) {
    for (let ix = ix0; ix < ix1; ix++) {
      if (kind[idx(ix, iz)] !== Cell.BLOCKED) continue;
      const wFull = freeRun(kind, ix, iz, ix1);
      const dFull = freeDepth(kind, ix, wFull, iz, iz1);
      const ribAccess =
        colHasCorridor(map, ix - 1, iz, dFull) || colHasCorridor(map, ix + wFull, iz, dFull);
      const avnAccess =
        rowHasCorridor(map, ix, iz - 1, wFull) || rowHasCorridor(map, ix, iz + dFull, wFull);
      if (ribAccess || !avnAccess) {
        // Slice along z: each room spans the full bay width (touches the rib).
        for (let z = iz; z < iz + dFull; ) {
          const remain = iz + dFull - z;
          const d = remain <= spec.roomMaxD + 1 ? remain : spec.roomMaxD;
          place(ix, z, wFull, d);
          z += d;
        }
      } else {
        // Slice along x: each room spans the full bay depth (touches the avenue).
        for (let x = ix; x < ix + wFull; ) {
          const remain = ix + wFull - x;
          const w = remain <= spec.roomMaxW + 1 ? remain : spec.roomMaxW;
          place(x, iz, w, dFull);
          x += w;
        }
      }
    }
  }
}

function touchesExterior(f: number, ix: number, iz: number, w: number, d: number): boolean {
  for (let cx = ix; cx < ix + w; cx++) {
    if (!inUsable(cx, iz - 1, f) && !isCoreCell(cx, iz - 1)) return true;
    if (!inUsable(cx, iz + d, f) && !isCoreCell(cx, iz + d)) return true;
  }
  for (let cz = iz; cz < iz + d; cz++) {
    if (!inUsable(ix - 1, cz, f) && !isCoreCell(ix - 1, cz)) return true;
    if (!inUsable(ix + w, cz, f) && !isCoreCell(ix + w, cz)) return true;
  }
  return false;
}

function makeRoom(
  f: number,
  gx: number,
  gz: number,
  ix: number,
  iz: number,
  w: number,
  d: number,
  spec: FloorSpec,
): BuiltRoom {
  const t = P.wallT / 2;
  const facade = touchesExterior(f, ix, iz, w, d);
  // Envelope/partition walls straddle the cell edge (inner face wallT/2 in), but
  // a massing-STEP wall (upper floors' gx1 west / gx2 east faces) sits flush
  // inside its wing (inner face wallT in). Insetting the clear rect to match
  // keeps furniture off the step wall face — otherwise props clip 0.15 m into it.
  const stepW = f >= 5 && gx === 1 && ix === CELLS_PER_COL;
  const stepE = f >= 5 && gx === 2 && ix + w === 3 * CELLS_PER_COL;
  return {
    floor: f,
    gx,
    gz,
    content: facade ? spec.facade : spec.core,
    facade,
    cix: ix,
    ciz: iz,
    cw: w,
    cd: d,
    x0: cellX0(ix) + (stepW ? P.wallT : t),
    x1: cellX0(ix + w) - (stepE ? P.wallT : t),
    z0: cellZ0(iz) + t,
    z1: cellZ0(iz + d) - t,
    base: wallBaseY(f),
    door: null,
    name: `f${f} w${gx}${gz} ${spec.facade}@${ix},${iz}`,
  };
}

/** Assign each room a door onto the corridor its perimeter borders, and record
 *  the opened edge. Picks the side with the most corridor-adjacent cells so the
 *  door lands on the room's main corridor frontage. */
function assignDoors(map: FloorMap): void {
  const { kind, rooms } = map;
  const isCorridor = (ix: number, iz: number): boolean =>
    inGrid(ix, iz) && kind[idx(ix, iz)] === Cell.CORRIDOR;

  for (const r of rooms) {
    const sides: { side: "S" | "N" | "W" | "E"; cells: number[] }[] = [
      { side: "S", cells: [] },
      { side: "N", cells: [] },
      { side: "W", cells: [] },
      { side: "E", cells: [] },
    ];
    for (let cx = r.cix; cx < r.cix + r.cw; cx++) {
      if (isCorridor(cx, r.ciz - 1)) sides[0].cells.push(cx);
      if (isCorridor(cx, r.ciz + r.cd)) sides[1].cells.push(cx);
    }
    for (let cz = r.ciz; cz < r.ciz + r.cd; cz++) {
      if (isCorridor(r.cix - 1, cz)) sides[2].cells.push(cz);
      if (isCorridor(r.cix + r.cw, cz)) sides[3].cells.push(cz);
    }
    const best = sides.filter((s) => s.cells.length > 0).sort((a, b) => b.cells.length - a.cells.length)[0];
    if (!best) continue; // unreachable — verify's reachability assert will flag it
    const mid = best.cells[Math.floor(best.cells.length / 2)];

    if (best.side === "S") {
      const edge = r.ciz - 1;
      map.doorEdges.add(`h:${mid}:${edge}`);
      r.door = { axis: "z", mid, edge, perp: cellZ0(r.ciz), along: cellCX(mid), inward: 1 };
    } else if (best.side === "N") {
      const edge = r.ciz + r.cd - 1;
      map.doorEdges.add(`h:${mid}:${edge}`);
      r.door = { axis: "z", mid, edge, perp: cellZ0(r.ciz + r.cd), along: cellCX(mid), inward: -1 };
    } else if (best.side === "W") {
      const edge = r.cix - 1;
      map.doorEdges.add(`v:${edge}:${mid}`);
      r.door = { axis: "x", mid, edge, perp: cellX0(r.cix), along: cellCZ(mid), inward: 1 };
    } else {
      const edge = r.cix + r.cw - 1;
      map.doorEdges.add(`v:${edge}:${mid}`);
      r.door = { axis: "x", mid, edge, perp: cellX0(r.cix + r.cw), along: cellCZ(mid), inward: -1 };
    }
  }
}

/**
 * Cut ONE doorway per stair core per floor, on the shaft's OPEN side and at the
 * LANDING row, so the player steps from the corridor through the door onto the
 * stairs. The rest of the core perimeter is walled by needsWall; this just
 * opens the single edge (added to doorEdges + recorded for its header). The
 * open side + landing row are read from the fixed void geometry — never moved.
 */
function addCoreDoors(map: FloorMap): void {
  for (const v of voidCellBounds()) {
    const cx = (cellX0(v.ix0) + cellX0(v.ix1 + 1)) / 2; // shaft centre x
    const midIz = v.iz1; // front row of the void = the landing the flight arrives on
    // Open side faces the building centre: east for the west shaft, west for the east.
    const edge = cx < 0 ? v.ix1 : v.ix0 - 1;
    const outside = cx < 0 ? v.ix1 + 1 : v.ix0 - 1;
    if (cellKindAt(map, outside, midIz) !== Cell.CORRIDOR) continue; // no lobby to open onto
    map.doorEdges.add(`v:${edge}:${midIz}`);
    map.coreDoors.push({ axis: "x", mid: midIz, edge });
  }
}

/** Apply the spec's targeted content overrides + the single-kitchen rule
 *  (deterministic: the first matching room in carve order). */
function applyContentOverrides(map: FloorMap, spec: FloorSpec): void {
  const firstIn = (gx: number, gz: number, facade: boolean): BuiltRoom | undefined =>
    map.rooms.find((r) => r.gx === gx && r.gz === gz && r.facade === facade);
  for (const o of spec.overrides ?? []) {
    const room = firstIn(o.gx, o.gz, o.facade);
    if (room) room.content = o.content;
  }
  if (spec.kitchenWing) {
    const [kgx, kgz] = spec.kitchenWing;
    const room = firstIn(kgx, kgz, true) ?? map.rooms.find((r) => r.gx === kgx && r.gz === kgz);
    if (room) room.content = "kitchen";
  }
}

function signature(map: FloorMap): string {
  // Structural fingerprint: corridor cell coverage + every room rect/content.
  // Two floors with different subdivision OR routing cannot collide.
  const parts: string[] = [`c${map.corridorCells}`];
  for (const r of map.rooms) parts.push(`${r.cix},${r.ciz},${r.cw},${r.cd},${r.content}`);
  return parts.sort().join("|");
}

export function expandFloor(f: number, spec: FloorSpec): FloorMap {
  const kind = new Uint8Array(NX * NZ);
  const roomId = new Int16Array(NX * NZ).fill(-1);
  const doorEdges = new Set<string>();
  let usableCells = 0;
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (!inUsable(ix, iz, f)) {
        kind[idx(ix, iz)] = Cell.OUTSIDE;
      } else if (isCoreCell(ix, iz)) {
        kind[idx(ix, iz)] = Cell.CORE;
        usableCells++;
      } else {
        kind[idx(ix, iz)] = Cell.BLOCKED;
        usableCells++;
      }
    }
  }
  const map: FloorMap = {
    f,
    spec,
    kind,
    roomId,
    rooms: [],
    doorEdges,
    coreDoors: [],
    usableCells,
    corridorCells: 0,
    signature: "",
  };

  rasterizeCorridors(kind, spec.corridors);
  // STAIR-LOBBY RING — force a 1-cell corridor buffer around every core so no
  // room ever abuts the shaft: the core is then walled entirely against
  // circulation (one doorway per floor), and furniture never meets a core wall.
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (kind[idx(ix, iz)] !== Cell.BLOCKED) continue;
      for (const [dx, dz] of NEI4) {
        if (inGrid(ix + dx, iz + dz) && kind[idx(ix + dx, iz + dz)] === Cell.CORE) {
          kind[idx(ix, iz)] = Cell.CORRIDOR;
          break;
        }
      }
    }
  }
  for (let i = 0; i < kind.length; i++) if (kind[i] === Cell.CORRIDOR) map.corridorCells++;

  for (let gx = 0; gx < P.colFloors.length; gx++) {
    for (let gz = 0; gz < P.rows; gz++) {
      if (f < P.colFloors[gx]) carveWing(map, gx, gz, spec);
    }
  }
  assignDoors(map);
  addCoreDoors(map);
  applyContentOverrides(map, spec);
  map.signature = signature(map);
  return map;
}

// ===========================================================================
// 2 — EMIT interior walls from the cell map (merged runs, corner-safe, clipped,
//     bucketed into wing sections) + door lintels.
// ===========================================================================

/** Region identity for the wall test: same corridor / same room / same poché =
 *  no wall; anything different (and at least one walkable) = a wall. */
function regionId(kind: Uint8Array, roomId: Int16Array, ix: number, iz: number): string {
  const k = kind[idx(ix, iz)];
  if (k === Cell.CORRIDOR) return "C";
  if (k === Cell.ROOM) return `R${roomId[idx(ix, iz)]}`;
  return "B"; // BLOCKED
}

function needsWall(map: FloorMap, ax: number, az: number, bx: number, bz: number): boolean {
  const ka = map.kind[idx(ax, az)];
  const kb = map.kind[idx(bx, bz)];
  if (ka === Cell.OUTSIDE || kb === Cell.OUTSIDE) return false; // exterior/step wall
  const aWalk = ka === Cell.CORRIDOR || ka === Cell.ROOM;
  const bWalk = kb === Cell.CORRIDOR || kb === Cell.ROOM;
  // Wrap the stair core: a wall wherever the void meets a walkable cell (the
  // one doorway per floor is carved out via doorEdges). Core↔core / core↔poché
  // need no wall (the shell stairwell + poché own those).
  if (ka === Cell.CORE || kb === Cell.CORE) return aWalk || bWalk;
  if (!aWalk && !bWalk) return false; // poché ↔ poché: no walkable face
  return regionId(map.kind, map.roomId, ax, az) !== regionId(map.kind, map.roomId, bx, bz);
}

interface WallSink {
  push: (gx: number, gz: number, b: ReturnType<typeof block>) => void;
}

function emitFloorWalls(map: FloorMap, sink: WallSink): void {
  const doorEdges = map.doorEdges;
  const f = map.f;
  const base = wallBaseY(f);
  const top = wallTopY(f);
  const h = top - base;
  const b = exteriorInnerBounds(f);

  // Wall-edge grids (interior edges only). vWall = east edge of (ix,iz);
  // hWall = north edge of (ix,iz).
  const vWall = new Uint8Array(NX * NZ);
  const hWall = new Uint8Array(NX * NZ);
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (ix + 1 < NX && needsWall(map, ix, iz, ix + 1, iz) && !doorEdges.has(`v:${ix}:${iz}`)) {
        vWall[idx(ix, iz)] = 1;
      }
      if (iz + 1 < NZ && needsWall(map, ix, iz, ix, iz + 1) && !doorEdges.has(`h:${ix}:${iz}`)) {
        hWall[idx(ix, iz)] = 1;
      }
    }
  }
  // A horizontal wall crosses vertical-edge column c at z=cellZ0(k) iff either
  // flanking cell has its north edge walled there (used to split/inset verticals
  // so no two perpendicular walls ever share a corner volume).
  const horizAtVertex = (c: number, k: number): boolean =>
    k - 1 >= 0 &&
    ((hWall[idx(c, k - 1)] === 1) || (c + 1 < NX && hWall[idx(c + 1, k - 1)] === 1));

  const clampX = (x: number): number => Math.max(b.xMin, Math.min(b.xMax, x));
  const clampZ = (z: number): number => Math.max(b.zMin, Math.min(b.zMax, z));

  // Horizontal runs (own their corners — full length, no inset). Break at wing
  // column boundaries so each block lives in one section.
  for (let iz = 0; iz < NZ - 1; iz++) {
    let ix = 0;
    while (ix < NX) {
      if (!hWall[idx(ix, iz)]) {
        ix++;
        continue;
      }
      const start = ix;
      ix++;
      while (ix < NX && hWall[idx(ix, iz)] && wingGX(ix) === wingGX(start)) ix++;
      const x0 = clampX(cellX0(start));
      const x1 = clampX(cellX0(ix));
      if (x1 - x0 > 0.05) {
        const z = cellZ0(iz + 1);
        sink.push(wingGX(start), wingGZ(iz), block("cladding", (x0 + x1) / 2, base, z, x1 - x0, h, P.wallT));
      }
    }
  }

  // Vertical runs — split at every horizontal-wall crossing / wing-row boundary,
  // inset wallT/2 at any end a horizontal wall meets (abut, never overlap).
  for (let c = 0; c < NX - 1; c++) {
    let iz = 0;
    while (iz < NZ) {
      if (!vWall[idx(c, iz)]) {
        iz++;
        continue;
      }
      const start = iz;
      let end = iz;
      while (
        end + 1 < NZ &&
        vWall[idx(c, end + 1)] &&
        wingGZ(end + 1) === wingGZ(start) &&
        !horizAtVertex(c, end + 1)
      ) {
        end++;
      }
      let zLo = cellZ0(start);
      let zHi = cellZ0(end + 1);
      if (horizAtVertex(c, start)) zLo += P.wallT / 2;
      if (horizAtVertex(c, end + 1)) zHi -= P.wallT / 2;
      zLo = clampZ(zLo);
      zHi = clampZ(zHi);
      if (zHi - zLo > 0.05) {
        const x = cellX0(c + 1);
        sink.push(wingGX(c), wingGZ(start), block("cladding", x, base, (zLo + zHi) / 2, P.wallT, h, zHi - zLo));
      }
      iz = end + 1;
    }
  }

  // Door HEADERS — fill the wall solidly ABOVE every opening, flush to the jamb
  // on each side, so there is no vertical slot flanking the header up to the
  // ceiling. A header spans its whole opening cell and insets wallT/2 ONLY at an
  // end where a PERPENDICULAR wall stands (a corner door's side wall), so it
  // abuts — never overlaps — that wall. Clamped to the plate for step walls.
  const headerBase = base + 2.1;
  const headerH = top - headerBase;
  if (headerH > 0.05) {
    const doorways: Doorway[] = map.coreDoors.slice();
    for (const r of map.rooms) if (r.door) doorways.push(r.door);
    for (const d of doorways) {
      const m = d.mid;
      const e = d.edge;
      if (d.axis === "z") {
        // Header is horizontal. A PERPENDICULAR (vertical) side wall abuts it,
        // but a vertical wall INSETS away when a co-linear horizontal jamb sits
        // on that side (hWall) — so inset the header only when the side wall
        // actually reaches the corner (present AND no co-linear jamb); otherwise
        // extend to the cell edge to fill the corner the side wall vacated.
        const leftWall = m - 1 >= 0 && (vWall[idx(m - 1, e)] === 1 || (e + 1 < NZ && vWall[idx(m - 1, e + 1)] === 1));
        const rightWall = vWall[idx(m, e)] === 1 || (e + 1 < NZ && vWall[idx(m, e + 1)] === 1);
        const insetL = leftWall && !(m - 1 >= 0 && hWall[idx(m - 1, e)] === 1);
        const insetR = rightWall && !(m + 1 < NX && hWall[idx(m + 1, e)] === 1);
        const x0 = clampX(cellX0(m) + (insetL ? P.wallT / 2 : 0));
        const x1 = clampX(cellX0(m + 1) - (insetR ? P.wallT / 2 : 0));
        if (x1 - x0 > 0.05) {
          sink.push(wingGX(m), wingGZ(e), block("cladding", (x0 + x1) / 2, headerBase, cellZ0(e + 1), x1 - x0, headerH, P.wallT));
        }
      } else {
        // Header is vertical. Its PERPENDICULAR walls are horizontal RUNS, which
        // never inset (they own their corners), so the header simply insets to
        // abut one wherever present.
        const lowWall = m - 1 >= 0 && (hWall[idx(e, m - 1)] === 1 || (e + 1 < NX && hWall[idx(e + 1, m - 1)] === 1));
        const highWall = hWall[idx(e, m)] === 1 || (e + 1 < NX && hWall[idx(e + 1, m)] === 1);
        const z0 = clampZ(cellZ0(m) + (lowWall ? P.wallT / 2 : 0));
        const z1 = clampZ(cellZ0(m + 1) - (highWall ? P.wallT / 2 : 0));
        if (z1 - z0 > 0.05) {
          sink.push(wingGX(e), wingGZ(m), block("cladding", cellX0(e + 1), headerBase, (z0 + z1) / 2, P.wallT, headerH, z1 - z0));
        }
      }
    }
  }
}

// ===========================================================================
// 3 — Ceiling fixtures for the enclosed rooms + corridors (position-only;
//     runtime local-enclosure governs their life, like every hospital fixture).
// ===========================================================================

function emitFixtures(map: FloorMap, addFixture: (fx: Fixture) => void): void {
  const fy = map.f * P.floorHeight + P.floorHeight - P.ceilGap;
  for (const r of map.rooms) {
    addFixture([(r.x0 + r.x1) / 2, fy, (r.z0 + r.z1) / 2]);
  }
  // Corridor panels on a sparse grid so the circulation reads lit without one
  // fixture per cell.
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (map.kind[idx(ix, iz)] === Cell.CORRIDOR && ix % 2 === 1 && iz % 2 === 1) {
        addFixture([cellCX(ix), fy, cellCZ(iz)]);
      }
    }
  }
}

// ===========================================================================
// Assembly — expand every storey, emit its interior into the shell's sections.
// ===========================================================================

export function partitionHospital(shell: HospitalShell): PartitionResult {
  const rooms: BuiltRoom[] = [];
  const floorMaps: FloorMap[] = [];
  const sink: WallSink = {
    push: (gx, gz, b) => shell.sections[gx * P.rows + gz].blocks.push(b),
  };
  const addFixture = (fx: Fixture): void => {
    shell.lightFixtures.push(fx);
  };

  const FLOORS = Math.max(...P.colFloors);
  for (let f = 0; f < FLOORS; f++) {
    const spec = FLOOR_SPECS[f];
    const map = expandFloor(f, spec);
    emitFloorWalls(map, sink);
    emitFixtures(map, addFixture);
    rooms.push(...map.rooms);
    floorMaps.push(map);
  }
  return { rooms, floorMaps };
}
