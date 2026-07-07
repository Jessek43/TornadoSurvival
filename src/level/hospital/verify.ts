import { MATERIALS, type MaterialId } from "../Materials";
import type { SectionSpec } from "../Blueprints";
import { GameConfig } from "../../config/GameConfig";
import {
  HOSPITAL_PARAMS as P,
  FLOORS_MAX,
  type ExteriorFace,
  type Fixture,
  type RoomSpec,
} from "./params";
import { FLOOR_LAYOUTS, floorSignature } from "./layouts";

/**
 * Build-time invariants for the hospital definition — pure geometry checks
 * over the emitted {sections, lightFixtures, exteriorFaces}, no three.js and
 * no engine state, so they run both in the browser (dev) and from the CLI
 * (`npm run verify:hospital`). Every invariant here is the STATIC half of a
 * runtime failure mode:
 *
 *  - coplanar overlaps  → the floor/wall z-fighting flicker
 *  - glass off the perimeter registry → a broken shelter puzzle
 *  - fixture without durable enclosure → a light that floats after its room
 *  - blocks unsupported at birth → props/walls raining down on first wake
 *  - oversized sections → wake-budget hitches and O(n²) neighbor blowup
 *  - stair parameters   → a building the player can't climb
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
        min: [
          b.position[0] - b.size[0] / 2,
          b.position[1] - b.size[1] / 2,
          b.position[2] - b.size[2] / 2,
        ],
        max: [
          b.position[0] + b.size[0] / 2,
          b.position[1] + b.size[1] / 2,
          b.position[2] + b.size[2] / 2,
        ],
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

/**
 * Same-facing coplanar overlap detector — the z-fighting assertion. Two box
 * faces fight when they are on the same axis, face the SAME direction (top vs
 * top, +x vs +x, …), lie in the same plane, and overlap with real area.
 * Abutting surfaces (deck tiles, wall segments, stair landings) share planes
 * with ZERO overlap area and pass; a face resting on another (top vs bottom)
 * is opposite-facing and is never compared.
 */
function findCoplanarOverlaps(boxes: Box[]): string[] {
  const found: string[] = [];
  // Spatial hash on (x,z) so the pair scan stays near-linear.
  const CELL = 8;
  const cells = new Map<string, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    for (let cx = Math.floor(b.min[0] / CELL); cx <= Math.floor(b.max[0] / CELL); cx++) {
      for (let cz = Math.floor(b.min[2] / CELL); cz <= Math.floor(b.max[2] / CELL); cz++) {
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

/** Every glass block must lie on a registered exterior face — glass placement
 *  IS the shelter puzzle's "perimeter windows only" rule. */
function findInteriorGlass(boxes: Box[], faces: ExteriorFace[]): string[] {
  const bad: string[] = [];
  for (const b of boxes) {
    if (b.material !== "glass") continue;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const thinX = b.max[0] - b.min[0] <= P.wallT + 0.01;
    const run = thinX ? "z" : "x"; // wall plane normal is the thin axis
    const perp = thinX ? cx : cz;
    const along = thinX ? cz : cx;
    const ok = faces.some(
      (f) =>
        f.run === run &&
        Math.abs(f.perp - perp) < 1e-3 &&
        along > f.a0 - 0.01 &&
        along < f.a1 + 0.01,
    );
    if (!ok) bad.push(`glass off the perimeter registry at (${cx.toFixed(1)}, ${cz.toFixed(1)})`);
  }
  return bad;
}

/** Every fixture needs a DURABLE block (not glass/props) within strandRange,
 *  so it stays lit exactly as long as its room stands — never floats. */
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
    if (!ok) {
      bad.push(`fixture without durable enclosure at (${f[0]}, ${f[1].toFixed(1)}, ${f[2]})`);
    }
  }
  return bad;
}

/** Reimplementation of StructureSystem's neighbor graph + ground flood-fill
 *  (same 5 cm epsilon): nothing may be unsupported at birth. */
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
      return AXES.every(
        (ax) =>
          Math.abs(a.position[ax] - b.position[ax]) <= (a.size[ax] + b.size[ax]) / 2 + EPS,
      );
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

/** Hospital blocks must stay clear of the neighborhood's (and vice versa). */
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
          `${h.section} intersects neighborhood ${nb.section} near ` +
            `(${h.min[0].toFixed(0)}, ${h.min[2].toFixed(0)})`,
        );
      }
    }
  }
  return bad;
}

const MAX_SECTION_BLOCKS = 600; // bounds wake hitches + O(n²) neighbor cost
const MAX_TOTAL_BLOCKS = 7000; // runaway-density backstop for the furnish pass

const CAPSULE_R = 0.35; // player capsule radius (GameConfig.player.radius)

/**
 * ENTERABILITY asserts — the static half of "you can walk into every room"
 * (the first ward slice shipped rooms whose doors opened onto the bed).
 *
 * 1. Door clearance: nothing may intersect the doorway volume — the 1.32 m
 *    span between the jambs (which sit at ±0.7 with 0.04 slack), from just
 *    above the deck to 2.0 m, through the wall plane ±0.55.
 * 2. Walkability: a 0.2 m occupancy grid over the room's clear rect, with
 *    every block AABB inflated by the capsule radius (y-band floor+0.1 …
 *    +1.85 — a drape hanging below head height IS an obstacle); flood-fill
 *    from just inside the door. Facade rooms must reach ≥ 3 m² of free floor
 *    AND a cell within 0.6 m of the window wall; interior rooms ≥ 2.5 m².
 */
function checkRooms(boxes: Box[], rooms: RoomSpec[]): { bad: string[]; info: string[] } {
  const bad: string[] = [];
  let minArea = Infinity;
  let windowed = 0;
  for (const room of rooms) {
    if (room.kind === "facade") windowed++;
    // --- door volume ---
    const d = {
      x0: room.doorC - 0.66,
      x1: room.doorC + 0.66,
      y0: room.base + 0.05,
      y1: room.base + 2.0,
      z0: room.doorWallZ - 0.55,
      z1: room.doorWallZ + 0.55,
    };
    for (const b of boxes) {
      if (
        b.min[0] < d.x1 && b.max[0] > d.x0 &&
        b.min[1] < d.y1 && b.max[1] > d.y0 &&
        b.min[2] < d.z1 && b.max[2] > d.z0
      ) {
        bad.push(`door blocked in ${room.name} by ${b.section}/${b.material}`);
      }
    }

    // --- capsule-inflated walkability flood-fill ---
    const y0 = room.base + 0.1;
    const y1 = room.base + 1.85;
    const obstacles = boxes.filter(
      (b) =>
        b.min[1] < y1 && b.max[1] > y0 &&
        b.min[0] < room.x1 && b.max[0] > room.x0 &&
        b.min[2] < room.z1 && b.max[2] > room.z0,
    );
    const CELL = 0.2;
    const nx = Math.max(1, Math.floor((room.x1 - room.x0) / CELL));
    const nz = Math.max(1, Math.floor((room.z1 - room.z0) / CELL));
    const free = (ix: number, iz: number): boolean => {
      const cx = room.x0 + (ix + 0.5) * CELL;
      const cz = room.z0 + (iz + 0.5) * CELL;
      return !obstacles.some(
        (b) =>
          cx > b.min[0] - CAPSULE_R && cx < b.max[0] + CAPSULE_R &&
          cz > b.min[2] - CAPSULE_R && cz < b.max[2] + CAPSULE_R,
      );
    };
    // Start just inside the door (the door is in a z-plane wall).
    const inwardZ = room.doorWallZ < (room.z0 + room.z1) / 2 ? 1 : -1;
    const startX = Math.floor((room.doorC - room.x0) / CELL);
    const startZ = Math.floor(
      (room.doorWallZ + inwardZ * 0.6 - room.z0) / CELL,
    );
    const seen = new Set<number>();
    const stack: number[] = [];
    if (startX >= 0 && startX < nx && startZ >= 0 && startZ < nz && free(startX, startZ)) {
      seen.add(startX * nz + startZ);
      stack.push(startX * nz + startZ);
    }
    let reachWindow = false;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const ix = Math.floor(cur / nz);
      const iz = cur % nz;
      if (room.windowZ !== undefined) {
        const cz = room.z0 + (iz + 0.5) * CELL;
        if (Math.abs(cz - room.windowZ) < 0.6) reachWindow = true;
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const jx = ix + dx;
        const jz = iz + dz;
        const key = jx * nz + jz;
        if (jx < 0 || jx >= nx || jz < 0 || jz >= nz || seen.has(key)) continue;
        if (!free(jx, jz)) continue;
        seen.add(key);
        stack.push(key);
      }
    }
    const area = seen.size * CELL * CELL;
    minArea = Math.min(minArea, area);
    const need = room.kind === "facade" ? 3.0 : 2.5;
    if (area < need) {
      bad.push(`room not walkable: ${room.name} reachable ${area.toFixed(1)} m² < ${need}`);
    }
    if (room.windowZ !== undefined && !reachWindow) {
      bad.push(`window unreachable in ${room.name}`);
    }
  }
  const info = [
    `rooms: ${rooms.length} (${windowed} facade/windowed, ${rooms.length - windowed} blind)` +
      (rooms.length > 0 ? ` · min reachable ${minArea.toFixed(1)} m²` : ""),
  ];
  return { bad, info };
}

/** Furnish blocks must never intrude on the corridors: any APPENDED block in
 *  the walkable band (bottom < 2 m above its floor) must stay out of the
 *  spine/rib zones shrunk by 0.25 m (wall-hugging rails/signs live inside
 *  that shrink margin and are exempt by it). */
function findCorridorIntrusions(sections: SectionSpec[], shellCounts: number[]): string[] {
  const bad: string[] = [];
  const fp = P.footprint;
  const spineHW = P.spineHW - 0.25;
  const ribHW = P.ribHW - 0.25;
  for (let i = 0; i < shellCounts.length; i++) {
    const s = sections[i];
    for (let j = shellCounts[i]; j < s.blocks.length; j++) {
      const b = s.blocks[j];
      const bottom = b.position[1] - b.size[1] / 2;
      const f = Math.floor((bottom + 0.02) / P.floorHeight);
      if (bottom - f * P.floorHeight >= 2.0) continue; // above head height
      const x0 = b.position[0] - b.size[0] / 2;
      const x1 = b.position[0] + b.size[0] / 2;
      const z0 = b.position[2] - b.size[2] / 2;
      const z1 = b.position[2] + b.size[2] / 2;
      const inFootprint = x1 > fp.xMin && x0 < fp.xMax && z1 > fp.zMin && z0 < fp.zMax;
      if (!inFootprint) continue;
      const hitsSpine = z1 > P.spineZ - spineHW && z0 < P.spineZ + spineHW;
      const hitsRib = P.ribX.some((rx) => x1 > rx - ribHW && x0 < rx + ribHW);
      if (hitsSpine || hitsRib) {
        bad.push(
          `furnish block intrudes on a corridor in ${s.name} at ` +
            `(${b.position[0].toFixed(1)}, ${b.position[2].toFixed(1)})`,
        );
      }
    }
  }
  return bad;
}

/**
 * §4 detailing invariants over the authored FLOOR_LAYOUTS + placed rooms:
 * distinct per-floor layout ids, EXACTLY ONE kitchen in the whole building
 * (declared in the table AND actually placed), and a per-floor room-count
 * report. ("No windows on interior walls" is the separate interior-glass == 0
 * assert — glass only ever comes from the perimeter shell.)
 */
function checkFloorLayouts(rooms: RoomSpec[]): { bad: string[]; info: string[] } {
  const bad: string[] = [];
  const info: string[] = [];

  const ids = FLOOR_LAYOUTS.map((l) => l.id);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) bad.push(`duplicate floor-layout id(s): ${dupes.join(", ")}`);

  // Structural distinctness — the machine-checkable "every floor unique": no two
  // floors may share the same signature (archetype/room counts/content/extras/
  // kitchen), so distinct ids can't paper over two identically-built floors (the
  // old f1≡f2 that read the same despite different names).
  const sigs = FLOOR_LAYOUTS.map(floorSignature);
  const sigDupes = [...new Set(sigs.filter((s, i) => sigs.indexOf(s) !== i))];
  if (sigDupes.length) {
    bad.push(`floors share a structural signature (identical layout): ${sigDupes.join(" | ")}`);
  }
  info.push("floor signatures: " + sigs.map((s, f) => `f${f}=${s}`).join("  "));

  const kitchenConfigs = FLOOR_LAYOUTS.filter((l) => l.kitchenWing).length;
  const kitchenRooms = rooms.filter((r) => r.content === "kitchen").length;
  if (kitchenConfigs !== 1) bad.push(`FLOOR_LAYOUTS declares ${kitchenConfigs} kitchens (want 1)`);
  if (kitchenRooms !== 1) bad.push(`placed ${kitchenRooms} kitchen room(s) (want 1)`);

  const perFloor = new Map<number, number>();
  for (const r of rooms) perFloor.set(r.floor, (perFloor.get(r.floor) ?? 0) + 1);
  info.push(`kitchens (config/placed): ${kitchenConfigs}/${kitchenRooms}`);
  info.push(
    "floor layouts: " +
      FLOOR_LAYOUTS.map((l, f) => `f${f}=${l.id}[${perFloor.get(f) ?? 0} rooms]`).join(", "),
  );
  return { bad, info };
}

export function verifyHospital(
  sections: SectionSpec[],
  fixtures: Fixture[],
  exteriorFaces: ExteriorFace[],
  opts: {
    neighborhood?: SectionSpec[];
    shellCounts?: number[];
    rooms?: RoomSpec[];
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
  push("interior glass blocks", findInteriorGlass(boxes, exteriorFaces));
  push("fixtures without enclosure", findOrphanFixtures(boxes, fixtures));
  push("unsupported-at-birth blocks", findUnsupported(sections));
  if (opts.neighborhood) {
    push("hospital↔neighborhood overlaps", findMapOverlaps(boxes, toBoxes(opts.neighborhood)));
  }

  // Furnish contract: the shell prefix of every section is append-only, the
  // total stays under the density ceiling, corridors stay walkable.
  if (opts.shellCounts) {
    const counts = opts.shellCounts;
    let appended = 0;
    for (let i = 0; i < counts.length; i++) {
      if (sections[i].blocks.length < counts[i]) {
        failures.push(`furnish REMOVED blocks from ${sections[i].name} (shell prefix violated)`);
      }
      appended += sections[i].blocks.length - counts[i];
    }
    for (let i = counts.length; i < sections.length; i++) appended += sections[i].blocks.length;
    info.push(`furnish appended: ${appended} blocks`);
    push("corridor intrusions by furnish", findCorridorIntrusions(sections, counts));
  }
  if (opts.rooms) {
    const roomCheck = checkRooms(boxes, opts.rooms);
    push("room enterability violations", roomCheck.bad);
    info.push(...roomCheck.info);
    const layoutCheck = checkFloorLayouts(opts.rooms);
    push("floor-layout / kitchen violations", layoutCheck.bad);
    info.push(...layoutCheck.info);
  }
  if (boxes.length > MAX_TOTAL_BLOCKS) {
    failures.push(`total hospital blocks ${boxes.length} exceed ceiling ${MAX_TOTAL_BLOCKS}`);
  }

  // Section budgets vs the wake machinery.
  const big = sections.filter((s) => s.blocks.length > 4);
  const over = sections.filter((s) => s.blocks.length > MAX_SECTION_BLOCKS);
  for (const s of over) {
    failures.push(`section ${s.name} has ${s.blocks.length} blocks (max ${MAX_SECTION_BLOCKS})`);
  }
  info.push(
    `big sections (wake-cap relevant): ${big.length} / maxAwakeSections ${GameConfig.tornado.maxAwakeSections}`,
  );

  // Stair walkability (static half of "the capsule can climb").
  const rise = P.floorHeight / 2 / P.stairs.stepsPerFlight;
  const run = (2 * P.stairs.hd - 2 * P.stairs.landingDepth) / P.stairs.stepsPerFlight;
  if (rise > 0.45) failures.push(`stair rise ${rise.toFixed(2)} exceeds autostep-safe 0.45`);
  if (run < 0.75) failures.push(`stair run ${run.toFixed(2)} below capsule-safe 0.75`);
  if (2 * (P.stairs.laneOff + P.stairs.flightW / 2) > 2 * P.stairs.hw) {
    failures.push("stair lanes wider than the shaft");
  }
  info.push(`stairs: rise ${rise.toFixed(2)} m, run ${run.toFixed(2)} m, ${FLOORS_MAX} floors`);

  // Inventory report (draw-call estimate: one structure InstancedMesh per
  // material USED + one debris pool mesh per material DEFINED + fixtures).
  const perMaterial = new Map<MaterialId, number>();
  for (const b of boxes) perMaterial.set(b.material, (perMaterial.get(b.material) ?? 0) + 1);
  const total = boxes.length;
  info.push(`sections: ${sections.length} (${big.length} big) · blocks: ${total} · fixtures: ${fixtures.length}`);
  info.push(
    "blocks by material: " +
      [...perMaterial.entries()].map(([id, n]) => `${id} ${n}`).join(", "),
  );
  info.push(
    `draw-call estimate: ${perMaterial.size} structure + ` +
      `${Object.keys(MATERIALS).length} debris + 1 fixture meshes`,
  );
  const biggest = [...sections].sort((a, b) => b.blocks.length - a.blocks.length)[0];
  info.push(`largest section: ${biggest.name} (${biggest.blocks.length} blocks)`);

  return { failures, info };
}
