// TEMP §1 diagnostic — terminating, pure geometry over the emitted house
// blocks. Uses a proper capsule-COLUMN (circle) vs block-rect test so edge
// walls the capsule never enters are not mistaken for ceilings. Delete after.
import { buildNeighborhood } from "../src/level/Neighborhood";
import type { SectionSpec, BlockDef } from "../src/level/Blueprints";

const CAP_H = 1.8; // GameConfig.player.height
const CAP_R = 0.35; // GameConfig.player.radius
const AUTOSTEP = 0.5;
const SNAP = 0.45;

type B = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; mat: string };
function toBoxes(s: SectionSpec): B[] {
  return s.blocks.map((b: BlockDef) => ({
    x0: b.position[0] - b.size[0] / 2,
    x1: b.position[0] + b.size[0] / 2,
    y0: b.position[1] - b.size[1] / 2,
    y1: b.position[1] + b.size[1] / 2,
    z0: b.position[2] - b.size[2] / 2,
    z1: b.position[2] + b.size[2] / 2,
    mat: b.material,
  }));
}
// True if the vertical capsule column (centre cx,cz, radius R) intersects the
// block's XZ rect — the closest point of the rect to the centre is within R.
function columnHits(b: B, cx: number, cz: number, R: number): boolean {
  const qx = Math.max(b.x0, Math.min(cx, b.x1));
  const qz = Math.max(b.z0, Math.min(cz, b.z1));
  return (qx - cx) ** 2 + (qz - cz) ** 2 <= R * R;
}

const houses = buildNeighborhood().filter((s) => s.name === "house");
console.log(`houses: ${houses.length}`);

let worstStep = 0;
let worstStepWhere = "";
let minHeadroom = Infinity;
let minHeadWhere = "";

for (let h = 0; h < houses.length; h++) {
  const boxes = toBoxes(houses[h]);
  const cx = houses[h].blocks.reduce((a, b) => a + b.position[0], 0) / houses[h].blocks.length;

  // --- (a) DOORSTEP: the porch slab is the only ground-level (<0.25 m tall)
  // wood plate; interior furniture (TV stand 0.5, table 0.4) is taller.
  const porch = boxes.filter((b) => b.y0 <= 0.02 && b.y1 - b.y0 <= 0.25 && b.mat === "wood");
  const stepTop = porch.reduce((m, b) => Math.max(m, b.y1), 0);
  if (stepTop > worstStep) {
    worstStep = stepTop;
    worstStepWhere = `house#${h} @x≈${cx.toFixed(0)} porch top ${stepTop.toFixed(2)}m`;
  }

  // --- (b) STAIRS: wood treads are ~0.47 m tall boxes stacked diagonally. For
  // each, put the capsule column at the tread CENTRE and find the lowest true
  // ceiling above the head.
  // Treads: wood, height ≈ TREAD_T (0.47), footprint STAIR_W(1.1) × STAIR_RUN(0.78)
  // in either orientation. Excludes furniture (different footprints/heights).
  const treads = boxes.filter((b) => {
    if (b.mat !== "wood") return false;
    const hgt = b.y1 - b.y0;
    if (hgt < 0.44 || hgt > 0.5) return false;
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    const lo = Math.min(w, d);
    const hi = Math.max(w, d);
    return lo > 0.7 && lo < 0.85 && hi > 1.0 && hi < 1.2;
  });
  for (const t of treads) {
    const tcx = (t.x0 + t.x1) / 2;
    const tcz = (t.z0 + t.z1) / 2;
    const treadTop = t.y1;
    const headY = treadTop + CAP_H;
    let ceil = Infinity;
    for (const c of boxes) {
      if (c === t) continue;
      if (c.y0 < treadTop + 0.3) continue; // must be above the tread
      if (!columnHits(c, tcx, tcz, CAP_R)) continue;
      if (c.y0 < ceil) ceil = c.y0;
    }
    if (ceil === Infinity) continue; // open to the stairwell void above
    const clearance = ceil - headY;
    if (clearance < minHeadroom) {
      minHeadroom = clearance;
      minHeadWhere = `house#${h} @x≈${cx.toFixed(0)} treadTop ${treadTop.toFixed(2)} ceil ${ceil.toFixed(2)} clr ${clearance.toFixed(2)}m`;
    }
  }
}

console.log("");
console.log(`autostep max = ${AUTOSTEP}m, snap-to-ground = ${SNAP}m, capsule = ${CAP_H}m`);
console.log(`(a) DOORSTEP worst blocking step = ${worstStep.toFixed(2)}m  [${worstStepWhere}]`);
console.log(`    -> ${worstStep <= AUTOSTEP ? "OK (< autostep)" : "FAIL (> autostep, must jump)"}`);
console.log(`(b) STAIR min headroom clearance = ${minHeadroom.toFixed(2)}m  [${minHeadWhere}]`);
console.log(`    -> ${minHeadroom >= 0.3 ? "OK (>= 0.3m margin)" : "FAIL (head clips ceiling)"}`);

const pass = worstStep <= AUTOSTEP && minHeadroom >= 0.3;
console.log(pass ? "PASS: house traversal geometry within limits" : "FAIL: house traversal geometry violates a limit");
process.exit(pass ? 0 : 1);
