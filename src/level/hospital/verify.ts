import { MATERIALS, type MaterialId } from "../Materials";
import type { SectionSpec } from "../Blueprints";
import { GameConfig } from "../../config/GameConfig";
import {
  HOSPITAL_PARAMS as P,
  FLOORS_MAX,
  wallBaseY,
  wallTopY,
  type ExteriorFace,
  type Fixture,
} from "./params";
import { NX, NZ, CELL, GX0, GZ0, cellCX, cellCZ, cellX0, cellZ0, voidCellBounds } from "./grid";
import {
  Cell,
  cellKindAt,
  isWalkable,
  edgeHasWall,
  type FloorMap,
  type BuiltRoom,
  type Doorway,
} from "./partition";
import { FLOOR_SPECS } from "./floorplans";

/**
 * Build-time invariants for the hospital definition — pure geometry + cell-map
 * checks over the emitted {sections, fixtures, faces} and the per-floor plans,
 * no three.js and no engine state, so they run both in the browser (dev) and
 * from the CLI (`npm run verify:hospital`). Each invariant is the STATIC half of
 * a runtime failure mode:
 *
 *  - coplanar overlaps  → the floor/wall z-fighting flicker
 *  - glass off the perimeter registry → a broken shelter puzzle
 *  - fixture without durable enclosure → a light that floats after its room
 *  - blocks unsupported at birth → props/walls raining down on first wake
 *  - oversized sections → wake-budget hitches and O(n²) neighbor blowup
 *  - stair parameters   → a building the player can't climb
 *
 * The PARTITION asserts (added for the interior overhaul) make the old
 * open-plate failure impossible to ship: an un-walled boundary, an unreachable
 * room, a single giant walkable region, a disconnected corridor net, or two
 * identical floors each FAIL here.
 */

export interface VerifyResult {
  failures: string[];
  info: string[];
}

interface Box {
  min: [number, number, number];
  max: [number, number, number];
  material: MaterialId;
  section: string;
}

const AXES = [0, 1, 2] as const;

function toBoxes(sections: SectionSpec[]): Box[] {
  const out: Box[] = [];
  for (const s of sections) {
    for (const b of s.blocks) {
      out.push({
        min: [b.position[0] - b.size[0] / 2, b.position[1] - b.size[1] / 2, b.position[2] - b.size[2] / 2],
        max: [b.position[0] + b.size[0] / 2, b.position[1] + b.size[1] / 2, b.position[2] + b.size[2] / 2],
        material: b.material,
        section: s.name,
      });
    }
  }
  return out;
}

function overlap1D(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Same-facing coplanar overlap detector — the z-fighting assertion. */
function findCoplanarOverlaps(boxes: Box[]): string[] {
  const found: string[] = [];
  const CELL_H = 8;
  const cells = new Map<string, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    for (let cx = Math.floor(b.min[0] / CELL_H); cx <= Math.floor(b.max[0] / CELL_H); cx++) {
      for (let cz = Math.floor(b.min[2] / CELL_H); cz <= Math.floor(b.max[2] / CELL_H); cz++) {
        const key = `${cx},${cz}`;
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push(i);
      }
    }
  }
  const seen = new Set<number>();
  for (const list of cells.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = Math.min(list[a], list[b]);
        const j = Math.max(list[a], list[b]);
        const pairKey = i * boxes.length + j;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const A = boxes[i];
        const B = boxes[j];
        for (const axis of AXES) {
          const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
          for (const side of ["max", "min"] as const) {
            if (Math.abs(A[side][axis] - B[side][axis]) >= 1e-4) continue;
            const area =
              overlap1D(A.min[u], A.max[u], B.min[u], B.max[u]) *
              overlap1D(A.min[v], A.max[v], B.min[v], B.max[v]);
            if (area > 1e-3) {
              found.push(
                `coplanar ${side}-${"xyz"[axis]} faces of ${A.section}/${A.material} and ` +
                  `${B.section}/${B.material} at y≈${A.min[1].toFixed(2)} ` +
                  `(plane ${A[side][axis].toFixed(3)}, area ${area.toFixed(3)} m²)`,
              );
            }
          }
        }
      }
    }
  }
  return found;
}

/** Every glass block must lie on a registered exterior face. */
function findInteriorGlass(boxes: Box[], faces: ExteriorFace[]): string[] {
  const bad: string[] = [];
  for (const b of boxes) {
    if (b.material !== "glass") continue;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const thinX = b.max[0] - b.min[0] <= P.wallT + 0.01;
    const run = thinX ? "z" : "x";
    const perp = thinX ? cx : cz;
    const along = thinX ? cz : cx;
    const ok = faces.some(
      (f) => f.run === run && Math.abs(f.perp - perp) < 1e-3 && along > f.a0 - 0.01 && along < f.a1 + 0.01,
    );
    if (!ok) bad.push(`glass off the perimeter registry at (${cx.toFixed(1)}, ${cz.toFixed(1)})`);
  }
  return bad;
}

/** Every fixture needs a DURABLE block within strandRange. */
function findOrphanFixtures(boxes: Box[], fixtures: Fixture[]): string[] {
  const range = GameConfig.interiorLights.strandRange;
  const bad: string[] = [];
  for (const f of fixtures) {
    let ok = false;
    for (const b of boxes) {
      if (MATERIALS[b.material].breakThreshold < 550) continue;
      const dx = Math.max(b.min[0] - f[0], f[0] - b.max[0], 0);
      const dy = Math.max(b.min[1] - f[1], f[1] - b.max[1], 0);
      const dz = Math.max(b.min[2] - f[2], f[2] - b.max[2], 0);
      if (dx * dx + dy * dy + dz * dz <= range * range) {
        ok = true;
        break;
      }
    }
    if (!ok) bad.push(`fixture without durable enclosure at (${f[0]}, ${f[1].toFixed(1)}, ${f[2]})`);
  }
  return bad;
}

/** Reimplementation of StructureSystem's neighbor graph + ground flood-fill. */
function findUnsupported(sections: SectionSpec[]): string[] {
  const EPS = 0.05;
  const bad: string[] = [];
  for (const s of sections) {
    const n = s.blocks.length;
    const supported = new Array<boolean>(n).fill(false);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = s.blocks[i];
      if (b.position[1] - b.size[1] / 2 <= EPS) {
        supported[i] = true;
        stack.push(i);
      }
    }
    const touches = (i: number, j: number): boolean => {
      const a = s.blocks[i];
      const b = s.blocks[j];
      return AXES.every((ax) => Math.abs(a.position[ax] - b.position[ax]) <= (a.size[ax] + b.size[ax]) / 2 + EPS);
    };
    while (stack.length > 0) {
      const i = stack.pop()!;
      for (let j = 0; j < n; j++) {
        if (!supported[j] && touches(i, j)) {
          supported[j] = true;
          stack.push(j);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (!supported[i]) {
        const b = s.blocks[i];
        bad.push(
          `unsupported-at-birth block in ${s.name} at ` +
            `(${b.position[0].toFixed(1)}, ${b.position[1].toFixed(1)}, ${b.position[2].toFixed(1)})`,
        );
      }
    }
  }
  return bad;
}

function findMapOverlaps(hospital: Box[], neighborhood: Box[]): string[] {
  const bad: string[] = [];
  for (const h of hospital) {
    for (const nb of neighborhood) {
      const vol =
        overlap1D(h.min[0], h.max[0], nb.min[0], nb.max[0]) *
        overlap1D(h.min[1], h.max[1], nb.min[1], nb.max[1]) *
        overlap1D(h.min[2], h.max[2], nb.min[2], nb.max[2]);
      if (vol > 1e-6) {
        bad.push(
          `${h.section} intersects neighborhood ${nb.section} near (${h.min[0].toFixed(0)}, ${h.min[2].toFixed(0)})`,
        );
      }
    }
  }
  return bad;
}

// Budget override (interior overhaul): genuinely enclosed floors cost more
// static geometry than the old open plate. Perf headroom is large, so the caps
// are raised and re-asserted against the new build (largest section printed).
const MAX_SECTION_BLOCKS = 1400;
const MAX_TOTAL_BLOCKS = 16000;
const CAPSULE_R = 0.35; // player capsule radius (GameConfig.player.radius)

/**
 * §3.0 STAIR-TOP GAP assert — the switchback landing must meet the wing deck
 * with no walk-out seam. (Unchanged from the shell era; the partition never
 * touches the cores.)
 */
function findStairTopGaps(boxes: Box[]): { bad: string[]; info: string[] } {
  const bad: string[] = [];
  const yTol = 0.05;
  const eps = 0.06;
  let maxGap = 0;
  const hd = P.stairs.hd;
  const zFront = P.spineZ + hd;
  const runFront = zFront - P.stairs.landingDepth;
  const floorZ1 = zFront - P.wallT;
  const zSamples = [0.25, 0.5, 0.75].map((t) => runFront + (floorZ1 - runFront) * t);
  for (const cx of P.stairs.xs) {
    const openSign = cx < 0 ? 1 : -1;
    const voidEdge = cx + openSign * P.stairs.hw;
    for (let n = 1; n < FLOORS_MAX; n++) {
      const y = n * P.floorHeight;
      for (const zc of zSamples) {
        const onPlane = (bx: Box): boolean =>
          Math.abs(bx.max[1] - y) <= yTol && zc > bx.min[2] + 1e-4 && zc < bx.max[2] - 1e-4;
        let landReach = openSign > 0 ? -Infinity : Infinity;
        for (const bx of boxes) {
          if (!bx.section.startsWith("stair_") || !onPlane(bx)) continue;
          landReach = openSign > 0 ? Math.max(landReach, bx.max[0]) : Math.min(landReach, bx.min[0]);
        }
        if (!isFinite(landReach)) continue;
        let deckReach = openSign > 0 ? Infinity : -Infinity;
        for (const bx of boxes) {
          if (bx.section.startsWith("stair_") || !onPlane(bx)) continue;
          if (openSign > 0 && bx.max[0] > voidEdge + 0.01) {
            deckReach = Math.min(deckReach, Math.max(bx.min[0], voidEdge));
          } else if (openSign < 0 && bx.min[0] < voidEdge - 0.01) {
            deckReach = Math.max(deckReach, Math.min(bx.max[0], voidEdge));
          }
        }
        if (!isFinite(deckReach)) {
          bad.push(`stair@${cx} floor ${n}: no wing deck to step onto at z=${zc.toFixed(1)}`);
          continue;
        }
        const gap = Math.max(0, openSign > 0 ? deckReach - landReach : landReach - deckReach);
        if (gap > maxGap) maxGap = gap;
        if (gap > eps) {
          bad.push(
            `stair@${cx} floor ${n}: ${gap.toFixed(2)} m gap between landing ${landReach.toFixed(2)} ` +
              `and deck ${deckReach.toFixed(2)} (z=${zc.toFixed(1)})`,
          );
        }
      }
    }
  }
  return { bad, info: [`stair-top seam: max gap ${maxGap.toFixed(3)} m (want 0)`] };
}

// ===========================================================================
// PARTITION cell-map asserts — the "no open plate can ship" guards.
// ===========================================================================

const idx = (ix: number, iz: number): number => ix * NZ + iz;

/** Is a wall emitted (per the builder) between (ix,iz) and its neighbour? */
function wallBetween(map: FloorMap, ix: number, iz: number, nx: number, nz: number): boolean {
  if (nx === ix + 1) return edgeHasWall(map, ix, iz, nx, nz);
  if (nx === ix - 1) return edgeHasWall(map, nx, nz, ix, iz);
  if (nz === iz + 1) return edgeHasWall(map, ix, iz, nx, nz);
  return edgeHasWall(map, nx, nz, ix, iz);
}

const NEI: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function adjacentToCore(map: FloorMap, ix: number, iz: number): boolean {
  return NEI.some(([dx, dz]) => cellKindAt(map, ix + dx, iz + dz) === Cell.CORE);
}

/** REACHABILITY — flood walkable cells from the stair-adjacent corridors,
 *  crossing only open (door / same-region) edges; every room must be reached. */
function checkReachability(map: FloorMap): { unreachableRooms: number; bad: string[] } {
  const bad: string[] = [];
  const seen = new Uint8Array(NX * NZ);
  const stack: [number, number][] = [];
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (cellKindAt(map, ix, iz) === Cell.CORRIDOR && adjacentToCore(map, ix, iz) && !seen[idx(ix, iz)]) {
        seen[idx(ix, iz)] = 1;
        stack.push([ix, iz]);
      }
    }
  }
  while (stack.length) {
    const [ix, iz] = stack.pop()!;
    for (const [dx, dz] of NEI) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (!isWalkable(cellKindAt(map, nx, nz)) || seen[idx(nx, nz)]) continue;
      if (wallBetween(map, ix, iz, nx, nz)) continue;
      seen[idx(nx, nz)] = 1;
      stack.push([nx, nz]);
    }
  }
  let unreachable = 0;
  for (const r of map.rooms) {
    let reached = false;
    for (let cx = r.cix; cx < r.cix + r.cw && !reached; cx++) {
      for (let cz = r.ciz; cz < r.ciz + r.cd; cz++) {
        if (seen[idx(cx, cz)]) {
          reached = true;
          break;
        }
      }
    }
    if (!reached) {
      unreachable++;
      bad.push(`f${map.f}: room ${r.name} (${r.content}) unreachable from the stairs`);
    }
  }
  return { unreachableRooms: unreachable, bad };
}

/** ENCLOSURE — every boundary the builder means to wall must actually have a
 *  wall block in the emitted geometry at wall mid-height (no un-walled openings
 *  beyond doors). Verified against a set of edges the walls physically cover. */
function checkEnclosure(map: FloorMap, wallEdges: Set<string>): { openEdges: number; bad: string[] } {
  const bad: string[] = [];
  let open = 0;
  const check = (ax: number, az: number, bx: number, bz: number, key: string): void => {
    if (!edgeHasWall(map, ax, az, bx, bz)) return;
    if (!wallEdges.has(`${map.f}:${key}`)) {
      open++;
      if (bad.length < 4) bad.push(`f${map.f}: un-walled boundary at edge ${key}`);
    }
  };
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (ix + 1 < NX) check(ix, iz, ix + 1, iz, `v:${ix}:${iz}`);
      if (iz + 1 < NZ) check(ix, iz, ix, iz + 1, `h:${ix}:${iz}`);
    }
  }
  return { openEdges: open, bad };
}

/** Build the set of cell edges physically covered by a full-height wall block,
 *  keyed `${floor}:v|h:ix:iz` — the honest read of what the geometry encloses. */
function collectWallEdges(boxes: Box[]): Set<string> {
  const edges = new Set<string>();
  for (const b of boxes) {
    const h = b.max[1] - b.min[1];
    if (h < 1.5) continue; // furniture / lintels don't enclose a walkable edge
    if (b.material !== "cladding" && b.material !== "concrete") continue;
    const f = Math.round(b.min[1] / P.floorHeight);
    if (f < 0 || f >= FLOORS_MAX) continue;
    const sx = b.max[0] - b.min[0];
    const sz = b.max[2] - b.min[2];
    if (sx <= P.wallT + 0.02 && sz > P.wallT + 0.02) {
      // vertical wall at x=center → covers v-edges along its z-span
      const cx = (b.min[0] + b.max[0]) / 2;
      const ixEdge = Math.round((cx - GX0) / CELL) - 1;
      for (let iz = 0; iz < NZ; iz++) {
        const cz = cellCZ(iz);
        if (cz > b.min[2] + 0.01 && cz < b.max[2] - 0.01) edges.add(`${f}:v:${ixEdge}:${iz}`);
      }
    } else if (sz <= P.wallT + 0.02 && sx > P.wallT + 0.02) {
      const cz = (b.min[2] + b.max[2]) / 2;
      const izEdge = Math.round((cz - GZ0) / CELL) - 1;
      for (let ix = 0; ix < NX; ix++) {
        const cx = cellCX(ix);
        if (cx > b.min[0] + 0.01 && cx < b.max[0] - 0.01) edges.add(`${f}:h:${ix}:${izEdge}`);
      }
    }
  }
  return edges;
}

/** NOT-ONE-BIG-ROOM — components by same-region adjacency (doors are barriers
 *  here), so an open hall shows up as one huge region. Largest ≤ ~40% of plate;
 *  ≥ 5 enclosed rooms. */
function checkRegions(map: FloorMap): { bad: string[]; largestPct: number; roomCount: number } {
  const bad: string[] = [];
  const region = (ix: number, iz: number): string => {
    const k = cellKindAt(map, ix, iz);
    if (k === Cell.CORRIDOR) return "C";
    if (k === Cell.ROOM) return `R${map.roomId[idx(ix, iz)]}`;
    return "";
  };
  const seen = new Uint8Array(NX * NZ);
  let plate = 0;
  for (let i = 0; i < NX * NZ; i++) {
    const k = map.kind[i];
    if (k !== Cell.OUTSIDE && k !== Cell.CORE) plate++;
  }
  let largest = 0;
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (seen[idx(ix, iz)] || !isWalkable(cellKindAt(map, ix, iz))) continue;
      const rid = region(ix, iz);
      let size = 0;
      const stack: [number, number][] = [[ix, iz]];
      seen[idx(ix, iz)] = 1;
      while (stack.length) {
        const [cx, cz] = stack.pop()!;
        size++;
        for (const [dx, dz] of NEI) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= NX || nz < 0 || nz >= NZ || seen[idx(nx, nz)]) continue;
          if (region(nx, nz) !== rid) continue;
          seen[idx(nx, nz)] = 1;
          stack.push([nx, nz]);
        }
      }
      largest = Math.max(largest, size);
    }
  }
  const largestPct = plate > 0 ? largest / plate : 1;
  const roomCount = map.rooms.length;
  if (roomCount < 5) bad.push(`f${map.f}: only ${roomCount} enclosed rooms (want ≥ 5)`);
  if (largestPct > 0.4) {
    bad.push(`f${map.f}: largest walkable region ${(largestPct * 100).toFixed(0)}% of plate (want ≤ 40%)`);
  }
  return { bad, largestPct, roomCount };
}

/** CORRIDOR CONNECTIVITY — one component reaching a stair core. */
function checkCorridors(map: FloorMap): string[] {
  const bad: string[] = [];
  const corridorCells: [number, number][] = [];
  for (let ix = 0; ix < NX; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      if (cellKindAt(map, ix, iz) === Cell.CORRIDOR) corridorCells.push([ix, iz]);
    }
  }
  if (corridorCells.length === 0) return [`f${map.f}: no corridors`];
  const seen = new Uint8Array(NX * NZ);
  const [sx, sz] = corridorCells[0];
  const stack: [number, number][] = [[sx, sz]];
  seen[idx(sx, sz)] = 1;
  let reached = 0;
  let touchesCore = false;
  while (stack.length) {
    const [ix, iz] = stack.pop()!;
    reached++;
    if (adjacentToCore(map, ix, iz)) touchesCore = true;
    for (const [dx, dz] of NEI) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (cellKindAt(map, nx, nz) !== Cell.CORRIDOR || seen[idx(nx, nz)]) continue;
      seen[idx(nx, nz)] = 1;
      stack.push([nx, nz]);
    }
  }
  if (reached !== corridorCells.length) {
    bad.push(`f${map.f}: corridor network has ${corridorCells.length - reached} orphaned cell(s) (not one component)`);
  }
  if (!touchesCore) bad.push(`f${map.f}: corridor network does not reach a stair core`);
  // Every shaft must have a corridor on its open side.
  for (const v of voidCellBounds()) {
    let ok = false;
    for (let ix = v.ix0 - 1; ix <= v.ix1 + 1 && !ok; ix++) {
      for (let iz = v.iz0 - 1; iz <= v.iz1 + 1; iz++) {
        if (cellKindAt(map, ix, iz) === Cell.CORRIDOR) {
          ok = true;
          break;
        }
      }
    }
    if (!ok) bad.push(`f${map.f}: a stair shaft has no adjacent corridor lobby`);
  }
  return bad;
}

/**
 * ENTERABILITY — the furnished half of "you can walk into every room": the door
 * volume is clear and a capsule-inflated flood-fill from just inside the door
 * reaches enough free floor. Generalised to a door on any of the four walls.
 */
function checkRooms(boxes: Box[], rooms: BuiltRoom[]): { bad: string[]; info: string[] } {
  const bad: string[] = [];
  let minArea = Infinity;
  let facadeCount = 0;
  for (const room of rooms) {
    if (!room.door) continue; // reachability already flagged it
    if (room.facade) facadeCount++;
    const d = room.door;
    // The clear opening is one cell (2 m) between wall inner faces (~1.7 m); a
    // ±0.66 m span stays inside it (a wider probe clips the jamb walls).
    const along0 = d.along - 0.66;
    const along1 = d.along + 0.66;
    // Door clearance volume (below the 2.0 m head — the lintel sits above it).
    const dv =
      d.axis === "z"
        ? { x0: along0, x1: along1, z0: d.perp - 0.55, z1: d.perp + 0.55 }
        : { x0: d.perp - 0.55, x1: d.perp + 0.55, z0: along0, z1: along1 };
    const y0 = room.base + 0.05;
    const y1 = room.base + 2.0;
    for (const b of boxes) {
      if (
        b.min[0] < dv.x1 && b.max[0] > dv.x0 &&
        b.min[1] < y1 && b.max[1] > y0 &&
        b.min[2] < dv.z1 && b.max[2] > dv.z0
      ) {
        bad.push(`door blocked in ${room.name} by ${b.section}/${b.material}`);
        break;
      }
    }

    // Capsule-inflated walkability flood-fill over the room's clear rect.
    const wy0 = room.base + 0.1;
    const wy1 = room.base + 1.85;
    const obstacles = boxes.filter(
      (b) =>
        b.min[1] < wy1 && b.max[1] > wy0 &&
        b.min[0] < room.x1 && b.max[0] > room.x0 &&
        b.min[2] < room.z1 && b.max[2] > room.z0,
    );
    const GRID = 0.2;
    const nx = Math.max(1, Math.floor((room.x1 - room.x0) / GRID));
    const nz = Math.max(1, Math.floor((room.z1 - room.z0) / GRID));
    const free = (ix: number, iz: number): boolean => {
      const cx = room.x0 + (ix + 0.5) * GRID;
      const cz = room.z0 + (iz + 0.5) * GRID;
      return !obstacles.some(
        (b) =>
          cx > b.min[0] - CAPSULE_R && cx < b.max[0] + CAPSULE_R &&
          cz > b.min[2] - CAPSULE_R && cz < b.max[2] + CAPSULE_R,
      );
    };
    const startWX = d.axis === "z" ? d.along : d.perp + d.inward * 0.6;
    const startWZ = d.axis === "z" ? d.perp + d.inward * 0.6 : d.along;
    const startX = Math.floor((startWX - room.x0) / GRID);
    const startZ = Math.floor((startWZ - room.z0) / GRID);
    const seen = new Set<number>();
    const stack: number[] = [];
    if (startX >= 0 && startX < nx && startZ >= 0 && startZ < nz && free(startX, startZ)) {
      seen.add(startX * nz + startZ);
      stack.push(startX * nz + startZ);
    }
    while (stack.length) {
      const cur = stack.pop()!;
      const ix = Math.floor(cur / nz);
      const iz = cur % nz;
      for (const [dx, dz] of NEI) {
        const jx = ix + dx;
        const jz = iz + dz;
        const key = jx * nz + jz;
        if (jx < 0 || jx >= nx || jz < 0 || jz >= nz || seen.has(key) || !free(jx, jz)) continue;
        seen.add(key);
        stack.push(key);
      }
    }
    const area = seen.size * GRID * GRID;
    minArea = Math.min(minArea, area);
    const need = room.facade ? 3.0 : 2.5;
    if (area < need) bad.push(`room not walkable: ${room.name} reachable ${area.toFixed(1)} m² < ${need}`);
  }
  const info = [
    `rooms: ${rooms.length} (${facadeCount} facade/windowed, ${rooms.length - facadeCount} blind)` +
      (rooms.length > 0 ? ` · min reachable ${minArea === Infinity ? 0 : minArea.toFixed(1)} m²` : ""),
  ];
  return { bad, info };
}

/** Furnish must never spill a prop into a corridor cell (density contrast is
 *  the claustrophobia — corridors stay bare). Checks appended (non-shell)
 *  furniture-height blocks against the cell map. */
function findCorridorIntrusions(
  sections: SectionSpec[],
  shellCounts: number[],
  floorMaps: FloorMap[],
): string[] {
  const bad: string[] = [];
  for (let i = 0; i < shellCounts.length; i++) {
    const s = sections[i];
    for (let j = shellCounts[i]; j < s.blocks.length; j++) {
      const b = s.blocks[j];
      const bottom = b.position[1] - b.size[1] / 2;
      const f = Math.floor(bottom / P.floorHeight);
      const rel = bottom - f * P.floorHeight;
      if (rel >= 1.8 || f < 0 || f >= floorMaps.length) continue; // walls/lintels/ceiling props exempt
      if (b.size[1] >= 2.2) continue; // full-height walls exempt
      const ix = Math.floor((b.position[0] - GX0) / CELL);
      const iz = Math.floor((b.position[2] - GZ0) / CELL);
      if (cellKindAt(floorMaps[f], ix, iz) === Cell.CORRIDOR) {
        bad.push(`furnish prop intrudes on a corridor in ${s.name} at (${b.position[0].toFixed(1)}, ${b.position[2].toFixed(1)})`);
      }
    }
  }
  return bad;
}

/** Every doorway on a floor — room doors + the stair-core doors. */
function floorDoorways(m: FloorMap): Doorway[] {
  const out: Doorway[] = m.coreDoors.slice();
  for (const r of m.rooms) if (r.door) out.push(r.door);
  return out;
}

/**
 * DOOR HEADERS — the wall ABOVE every opening must be solid to the ceiling
 * across the whole opening, with no vertical slot flanking the header. Samples
 * the header band over each doorway (both jamb ends + the middle, at two
 * heights) and counts uncovered points → must be 0 on every floor.
 */
function checkDoorHeaders(boxes: Box[], floorMaps: FloorMap[]): { open: number; bad: string[] } {
  const hash = new Map<string, Box[]>();
  const bucket = (x: number, z: number): string => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
  // Interior headers/walls are cladding/concrete; a doorway that opens toward
  // the facade is closed above by the exterior wall (glass in the window band),
  // so glass counts as covering too.
  const isWall = (m: MaterialId): boolean => m === "cladding" || m === "concrete" || m === "glass";
  for (const b of boxes) {
    if (!isWall(b.material)) continue;
    for (let cx = Math.floor(b.min[0] / 4); cx <= Math.floor(b.max[0] / 4); cx++) {
      for (let cz = Math.floor(b.min[2] / 4); cz <= Math.floor(b.max[2] / 4); cz++) {
        const k = `${cx},${cz}`;
        let l = hash.get(k);
        if (!l) hash.set(k, (l = []));
        l.push(b);
      }
    }
  }
  const E = 1e-4;
  const covered = (x: number, y: number, z: number): boolean =>
    (hash.get(bucket(x, z)) ?? []).some(
      (b) =>
        x >= b.min[0] - E && x <= b.max[0] + E &&
        y >= b.min[1] - E && y <= b.max[1] + E &&
        z >= b.min[2] - E && z <= b.max[2] + E,
    );
  const bad: string[] = [];
  let open = 0;
  for (const m of floorMaps) {
    const ys = [wallBaseY(m.f) + 2.25, wallTopY(m.f) - 0.1];
    for (const d of floorDoorways(m)) {
      const a0 = d.axis === "z" ? cellX0(d.mid) : cellZ0(d.mid);
      const a1 = d.axis === "z" ? cellX0(d.mid + 1) : cellZ0(d.mid + 1);
      const perp = d.axis === "z" ? cellZ0(d.edge + 1) : cellX0(d.edge + 1);
      for (const t of [0.06, 0.25, 0.5, 0.75, 0.94]) {
        const a = a0 + (a1 - a0) * t;
        const x = d.axis === "z" ? a : perp;
        const z = d.axis === "z" ? perp : a;
        for (const y of ys) {
          if (!covered(x, y, z)) {
            open++;
            if (bad.length < 4) {
              bad.push(`f${m.f}: open above ${d.axis}-doorway (mid ${d.mid}, edge ${d.edge}) at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
            }
          }
        }
      }
    }
  }
  return { open, bad };
}

/** DISTINCTNESS + the single-kitchen rule + a per-floor summary line. */
function checkFloors(floorMaps: FloorMap[], rooms: BuiltRoom[]): { bad: string[]; info: string[] } {
  const bad: string[] = [];
  const info: string[] = [];

  const ids = FLOOR_SPECS.map((s) => s.id);
  const dupeIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupeIds.length) bad.push(`duplicate floor id(s): ${dupeIds.join(", ")}`);

  const sigs = floorMaps.map((m) => m.signature);
  const dupeSigs = [...new Set(sigs.filter((s, i) => sigs.indexOf(s) !== i))];
  if (dupeSigs.length) bad.push(`floors share a structural signature (identical layout): ${dupeSigs.length} clash(es)`);

  const kitchenConfigs = FLOOR_SPECS.filter((s) => s.kitchenWing).length;
  const kitchenRooms = rooms.filter((r) => r.content === "kitchen").length;
  if (kitchenConfigs !== 1) bad.push(`FLOOR_SPECS declare ${kitchenConfigs} kitchens (want 1)`);
  if (kitchenRooms !== 1) bad.push(`placed ${kitchenRooms} kitchen room(s) (want 1)`);
  info.push(`kitchens (config/placed): ${kitchenConfigs}/${kitchenRooms}`);

  return { bad, info };
}

export function verifyHospital(
  sections: SectionSpec[],
  fixtures: Fixture[],
  exteriorFaces: ExteriorFace[],
  opts: {
    neighborhood?: SectionSpec[];
    shellCounts?: number[];
    rooms?: BuiltRoom[];
    floorMaps?: FloorMap[];
  } = {},
): VerifyResult {
  const failures: string[] = [];
  const info: string[] = [];
  const boxes = toBoxes(sections);

  const push = (label: string, found: string[], sample = 5): void => {
    info.push(`${label}: ${found.length}`);
    for (const f of found.slice(0, sample)) failures.push(f);
    if (found.length > sample) failures.push(`…and ${found.length - sample} more (${label})`);
  };

  push("coplanar same-facing overlaps", findCoplanarOverlaps(boxes));
  const stairGaps = findStairTopGaps(boxes);
  push("stair-top gaps", stairGaps.bad);
  info.push(...stairGaps.info);
  push("interior glass blocks", findInteriorGlass(boxes, exteriorFaces));
  push("fixtures without enclosure", findOrphanFixtures(boxes, fixtures));
  push("unsupported-at-birth blocks", findUnsupported(sections));
  if (opts.neighborhood) {
    push("hospital↔neighborhood overlaps", findMapOverlaps(boxes, toBoxes(opts.neighborhood)));
  }

  if (opts.shellCounts) {
    const counts = opts.shellCounts;
    let appended = 0;
    for (let i = 0; i < counts.length; i++) {
      if (sections[i].blocks.length < counts[i]) {
        failures.push(`interior REMOVED blocks from ${sections[i].name} (shell prefix violated)`);
      }
      appended += sections[i].blocks.length - counts[i];
    }
    for (let i = counts.length; i < sections.length; i++) appended += sections[i].blocks.length;
    info.push(`interior + furnish appended: ${appended} blocks`);
    if (opts.floorMaps) {
      push("corridor intrusions by furnish", findCorridorIntrusions(sections, counts, opts.floorMaps));
    }
  }

  // --- the partition (per-floor cell-map) invariants ---
  if (opts.floorMaps && opts.floorMaps.length) {
    const wallEdges = collectWallEdges(boxes);
    let unreachTotal = 0;
    let openTotal = 0;
    const summary: string[] = [];
    for (const map of opts.floorMaps) {
      const reach = checkReachability(map);
      const enc = checkEnclosure(map, wallEdges);
      const reg = checkRegions(map);
      const corr = checkCorridors(map);
      unreachTotal += reach.unreachableRooms;
      openTotal += enc.openEdges;
      for (const m of [...reach.bad, ...enc.bad.slice(0, 2), ...reg.bad, ...corr]) failures.push(m);
      // Compact signature fingerprint so distinct routings are visible per line.
      let h = 0;
      for (let k = 0; k < map.signature.length; k++) h = (h * 31 + map.signature.charCodeAt(k)) | 0;
      const sig = (h >>> 0).toString(36).slice(0, 6);
      summary.push(
        `${map.spec.id} | rooms ${reg.roomCount} | corridors ${map.corridorCells}c | ` +
          `largest ${(reg.largestPct * 100).toFixed(0)}% | reach ${reach.unreachableRooms === 0 ? "ok" : "FAIL"} | ` +
          `sig ${sig}`,
      );
    }
    info.push(`partition: unreachable rooms ${unreachTotal}, un-walled edges ${openTotal}`);
    for (const line of summary) info.push(line);

    // Fix 3 — door headers: no open cells above any doorway (all floors).
    const headers = checkDoorHeaders(boxes, opts.floorMaps);
    for (const m of headers.bad) failures.push(m);
    info.push(`door headers: ${headers.open} open samples above openings (want 0)`);

    if (opts.rooms) {
      const roomCheck = checkRooms(boxes, opts.rooms);
      push("room enterability violations", roomCheck.bad);
      info.push(...roomCheck.info);
      const floorCheck = checkFloors(opts.floorMaps, opts.rooms);
      push("floor distinctness / kitchen violations", floorCheck.bad);
      info.push(...floorCheck.info);
    }
  }

  if (boxes.length > MAX_TOTAL_BLOCKS) {
    failures.push(`total hospital blocks ${boxes.length} exceed ceiling ${MAX_TOTAL_BLOCKS}`);
  }

  const big = sections.filter((s) => s.blocks.length > 4);
  const over = sections.filter((s) => s.blocks.length > MAX_SECTION_BLOCKS);
  for (const s of over) failures.push(`section ${s.name} has ${s.blocks.length} blocks (max ${MAX_SECTION_BLOCKS})`);
  info.push(`big sections (wake-cap relevant): ${big.length} / maxAwakeSections ${GameConfig.tornado.maxAwakeSections}`);

  const rise = P.floorHeight / 2 / P.stairs.stepsPerFlight;
  const run = (2 * P.stairs.hd - 2 * P.stairs.landingDepth) / P.stairs.stepsPerFlight;
  if (rise > 0.45) failures.push(`stair rise ${rise.toFixed(2)} exceeds autostep-safe 0.45`);
  if (run < 0.75) failures.push(`stair run ${run.toFixed(2)} below capsule-safe 0.75`);
  info.push(`stairs: rise ${rise.toFixed(2)} m, run ${run.toFixed(2)} m, ${FLOORS_MAX} floors`);

  const perMaterial = new Map<MaterialId, number>();
  for (const b of boxes) perMaterial.set(b.material, (perMaterial.get(b.material) ?? 0) + 1);
  info.push(`sections: ${sections.length} (${big.length} big) · blocks: ${boxes.length} · fixtures: ${fixtures.length}`);
  info.push("blocks by material: " + [...perMaterial.entries()].map(([id, n]) => `${id} ${n}`).join(", "));
  const biggest = [...sections].sort((a, b) => b.blocks.length - a.blocks.length)[0];
  info.push(`largest section: ${biggest.name} (${biggest.blocks.length} blocks, cap ${MAX_SECTION_BLOCKS})`);

  return { failures, info };
}
