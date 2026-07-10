// Static verification of the ground substrate (level/Terrain.ts) — the pure
// height function + pad mask. Terminates on its own: no dev server, no THREE, no
// Rapier, no game loop. Builds the terrain from the SAME footprints the world
// build uses (hospital params + placed house/shop sections) and prints a count
// behind every assertion.
// Run with: npm run verify:terrain   (or: npx tsx scripts/verify-terrain.ts)
//
// Assertions 4a/4b/5/9 are trivially satisfied at amplitude 0 (there is no relief)
// — written anyway; they are the assertions that do the work in run two, when
// GameConfig.terrain.amplitude flips and this script is re-read. 4a/4b split the
// retired whole-grid `maxStep` into an apron STEP bound and a field SLOPE bound.
import { Terrain, type Rect, type TerrainSpec } from "../src/level/Terrain";
import { GameConfig } from "../src/config/GameConfig";
import { buildNeighborhood, footprintXZ } from "../src/level/Neighborhood";
import { buildHospital } from "../src/level/Hospital";
import { HOSPITAL_PARAMS } from "../src/level/hospital/params";
import type { SectionSpec } from "../src/level/Blueprints";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

const T = GameConfig.terrain;
const SIZE = GameConfig.world.groundSize;
const HALF = SIZE / 2;

// --- reconstruct the world footprints (exactly as Game will) ----------------
const hospital = buildHospital({ detail: true });
const neighborhood = buildNeighborhood();
const hf = HOSPITAL_PARAMS.footprint;
const hospitalFootprint: Rect = { x0: hf.xMin, x1: hf.xMax, z0: hf.zMin, z1: hf.zMax };

// Building sections = the hospital's sections + every non-tree neighborhood
// section. Trees are placed sections too but are field-planted, NOT pads.
const buildingSections: SectionSpec[] = [
  ...hospital.sections,
  ...neighborhood.filter((s) => s.name !== "tree"),
];
const treeSections = neighborhood.filter((s) => s.name === "tree");
// Pad sources = the union of every PLACED building footprint (§4), so nothing
// built ever sits on a cliff: the hospital params envelope (one gap-free pad for
// the interior) + every hospital section's footprint (its cars / ambulance /
// canopy reach past the envelope) + every non-tree neighborhood footprint. Trees
// are excluded. This mirrors Game's pad build.
const buildingFootprints: Rect[] = [
  hospitalFootprint,
  ...buildingSections.map(footprintXZ),
];

// apronWidth is DERIVED (apronCells × cellSize) exactly as Game does it — the
// apron/field split (assertions 4a/4b) leans on it being an integer of cells.
const APRON_WIDTH = T.apronCells * T.cellSize;
const spec: TerrainSpec = {
  size: SIZE,
  cellSize: T.cellSize,
  amplitude: T.amplitude,
  wavelength: T.terrainWavelength,
  padY: T.padY,
  padMargin: T.padMargin,
  apronWidth: APRON_WIDTH,
  footprints: buildingFootprints,
  authoredPadRects: [],
};
const terrain = new Terrain(spec);
const n = terrain.cols + 1;
const gx = (ix: number): number => -HALF + ix * terrain.cellSize;
console.log(
  `\nterrain ${terrain.rows}×${terrain.cols} @ ${terrain.cellSize}m · amp ${T.amplitude} · ` +
    `padY ${T.padY} · pads ${terrain.padCount} (${terrain.pads.length} rects)\n`,
);

// --- 1. every sample inside a pad equals padY exactly -----------------------
{
  let inPad = 0;
  let atPadY = 0;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      if (!terrain.isPad(gx(ix), gx(iz))) continue;
      inPad++;
      if (terrain.samples[iz * n + ix] === T.padY) atPadY++;
    }
  }
  check(atPadY === inPad, `pad samples at padY: ${atPadY} / ${inPad}`);
}

// --- 2. every building section footprint lies inside some pad ----------------
{
  const contained = (f: Rect): boolean =>
    terrain.pads.some((p) => f.x0 >= p.x0 && f.x1 <= p.x1 && f.z0 >= p.z0 && f.z1 <= p.z1);
  let outside = 0;
  for (const s of buildingSections) if (!contained(footprintXZ(s))) outside++;
  check(outside === 0, `building sections outside a pad: ${outside} / ${buildingSections.length}`);
  console.log(`      (tree sections field-planted, off-pad by design: ${treeSections.length})`);
}

// --- 3. every hospital footprint cell is flat -------------------------------
{
  let cells = 0;
  let flat = 0;
  for (let iz = 0; iz < n; iz++) {
    const wz = gx(iz);
    if (wz < hospitalFootprint.z0 || wz > hospitalFootprint.z1) continue;
    for (let ix = 0; ix < n; ix++) {
      const wx = gx(ix);
      if (wx < hospitalFootprint.x0 || wx > hospitalFootprint.x1) continue;
      cells++;
      if (terrain.samples[iz * n + ix] === T.padY) flat++;
    }
  }
  check(flat === cells, `hospital cells at padY: ${flat} / ${cells}`);
}

// --- 4. de-conflated shape bounds: apron STEP (4a) vs field SLOPE (4b) -------
// The single retired `maxStep` bounded the raw per-cell Δh over the WHOLE grid,
// silently capping the field's gradient with a number written for the apron ramp.
// It is now two: 4a bounds Δh inside the apron band (an authored ramp — a step
// bound is right); 4b bounds slope on open-field cells (an emergent gradient — a
// slope bound is right). A cell is FIELD only when BOTH its sample endpoints lie
// ≥ apronWidth from every pad (the strict side: any cell touching the apron band
// is checked by the tighter step bound, so no field cell is under-checked). Pad
// interior cells (both endpoints inside a pad, Δh 0) are owned by assertions 1/3.
//
// distanceOutsideNearestPad replicated here (0 inside a pad) — Terrain keeps it
// private; a 6-line copy avoids widening its API for two throwaway scripts.
const distOutsidePad = (x: number, z: number): number => {
  let best = Infinity;
  for (const p of terrain.pads) {
    const dx = Math.max(p.x0 - x, 0, x - p.x1);
    const dz = Math.max(p.z0 - z, 0, z - p.z1);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
};
// A point is FIELD when it is off every pad AND ≥ apronWidth from all of them.
const isFieldPoint = (x: number, z: number): boolean =>
  !terrain.isPad(x, z) && distOutsidePad(x, z) >= APRON_WIDTH;
{
  const RETIRED_STEP = 0.5; // the pre-split whole-grid Δh bound this replaces.
  let apronCells = 0;
  let apronOver = 0;
  let fieldCells = 0;
  let fieldOver = 0;
  let newlyAccepted = 0; // cells the OLD bound rejected but the split accepts.
  const visit = (ax: number, az: number, ah: number, bx: number, bz: number, bh: number): void => {
    const dh = Math.abs(bh - ah);
    const slope = dh / terrain.cellSize;
    const aPad = terrain.isPad(ax, az);
    const bPad = terrain.isPad(bx, bz);
    const field = isFieldPoint(ax, az) && isFieldPoint(bx, bz);
    const oldReject = dh > RETIRED_STEP + 1e-9;
    let newAccept: boolean;
    if (field) {
      fieldCells++;
      const over = slope > T.fieldMaxSlope + 1e-9;
      if (over) fieldOver++;
      newAccept = !over;
    } else if (aPad && bPad) {
      newAccept = dh <= 1e-9; // pad-interior cell: flat, owned by assertions 1/3.
    } else {
      apronCells++;
      const over = dh > T.apronMaxStep + 1e-9;
      if (over) apronOver++;
      newAccept = !over;
    }
    if (oldReject && newAccept) newlyAccepted++;
  };
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const wx = gx(ix);
      const wz = gx(iz);
      const h = terrain.samples[iz * n + ix];
      if (ix + 1 < n) visit(wx, wz, h, gx(ix + 1), wz, terrain.samples[iz * n + ix + 1]);
      if (iz + 1 < n) visit(wx, wz, h, wx, gx(iz + 1), terrain.samples[(iz + 1) * n + ix]);
    }
  }
  check(apronOver === 0, `4a apron cells over step: ${apronOver} / ${apronCells} (limit ${T.apronMaxStep} m)`);
  check(fieldOver === 0, `4b field cells over slope: ${fieldOver} / ${fieldCells} (limit ${T.fieldMaxSlope})`);
  // The split must be at least as strict as the retired whole-grid bound: no cell
  // it rejected may now pass. (Trivially 0 at amplitude 0; the proof that matters
  // when relief turns on.)
  check(newlyAccepted === 0, `cells newly accepted: ${newlyAccepted}`);
}

// --- 5. max slope inside PlayArea ≤ maxWalkable -----------------------------
{
  const H = GameConfig.PLAY_AREA.halfExtent;
  const area: Rect = { x0: -H, x1: H, z0: -H, z1: H };
  let over = 0;
  let cells = 0;
  for (let iz = 0; iz < n; iz++) {
    const wz = gx(iz);
    if (wz < area.z0 || wz > area.z1) continue;
    for (let ix = 0; ix < n; ix++) {
      const wx = gx(ix);
      if (wx < area.x0 || wx > area.x1) continue;
      cells++;
      const h = terrain.samples[iz * n + ix];
      const sx = ix + 1 < n ? Math.abs(terrain.samples[iz * n + ix + 1] - h) / terrain.cellSize : 0;
      const sz = iz + 1 < n ? Math.abs(terrain.samples[(iz + 1) * n + ix] - h) / terrain.cellSize : 0;
      if (Math.max(sx, sz) > T.maxWalkable) over++;
    }
  }
  check(over === 0, `cells over slope limit: ${over} / ${cells}`);
}

// --- 6. heightAt is total: no NaN / Inf over the whole grid ------------------
{
  let bad = 0;
  for (let i = 0; i < terrain.samples.length; i++) {
    if (!Number.isFinite(terrain.samples[i])) bad++;
  }
  check(bad === 0, `non-finite samples: ${bad} / ${terrain.samples.length}`);
}

// --- 7. heightAt is deterministic: two independent builds agree bitwise ------
{
  const t2 = new Terrain(spec);
  let mismatch = 0;
  for (let i = 0; i < terrain.samples.length; i++) {
    if (terrain.samples[i] !== t2.samples[i]) mismatch++;
  }
  // Also probe heightAt at off-grid points (the analytic path, not the grid).
  let probes = 0;
  for (let k = 0; k < 500; k++) {
    const x = -HALF + (SIZE * ((k * 2654435761) >>> 0)) / 4294967296;
    const z = -HALF + (SIZE * ((k * 40503 + 12345) % 100000)) / 100000;
    probes++;
    if (terrain.heightAt(x, z) !== t2.heightAt(x, z)) mismatch++;
  }
  check(mismatch === 0, `mismatches: ${mismatch} / ${terrain.samples.length + probes}`);
}

// --- 8. sampling exactly on a pad boundary is stable (inclusive intervals) ---
{
  let total = 0;
  let resolved = 0;
  for (const p of terrain.pads) {
    const pts: [number, number][] = [
      [p.x0, p.z0], [p.x1, p.z0], [p.x0, p.z1], [p.x1, p.z1], // corners
      [(p.x0 + p.x1) / 2, p.z0], [(p.x0 + p.x1) / 2, p.z1], // z-edge midpoints
      [p.x0, (p.z0 + p.z1) / 2], [p.x1, (p.z0 + p.z1) / 2], // x-edge midpoints
    ];
    for (const [x, z] of pts) {
      total++;
      if (terrain.isPad(x, z) && terrain.heightAt(x, z) === T.padY) resolved++;
    }
  }
  check(resolved === total, `boundary samples resolved: ${resolved} / ${total}`);
}

// --- 9. perimeter wall base y has no gap along the ring ----------------------
// The boundary walls are flat cuboids whose base Boundary sets to heightAt at
// their centre; the treeline trunks likewise. A height jump between adjacent ring
// points would leave a gap under the flat wall — a raw Δh (step) bound, so it uses
// apronMaxStep (the retired maxStep's value, unchanged). At amp 0 the ring is flat.
{
  const H = GameConfig.PLAY_AREA.halfExtent;
  const STEPS = 240;
  const ring: number[] = [];
  for (let i = 0; i < STEPS; i++) {
    const f = (i / STEPS) * 2 - 1; // −1..1 along an edge
    ring.push(terrain.heightAt(f * H, H)); // +Z edge
    ring.push(terrain.heightAt(f * H, -H)); // −Z edge
    ring.push(terrain.heightAt(H, f * H)); // +X edge
    ring.push(terrain.heightAt(-H, f * H)); // −X edge
  }
  let gaps = 0;
  for (let i = 1; i < ring.length; i++) {
    if (Math.abs(ring[i] - ring[i - 1]) > T.apronMaxStep + 1e-9) gaps++;
  }
  check(gaps === 0, `wall base gaps: ${gaps} / ${ring.length}`);
}

// --- 10. amplitude 0 → every sample equals padY -----------------------------
{
  if (T.amplitude === 0) {
    let flat = 0;
    for (let i = 0; i < terrain.samples.length; i++) if (terrain.samples[i] === T.padY) flat++;
    check(flat === terrain.samples.length, `flat: ${flat} / ${terrain.samples.length}`);
  } else {
    console.log(`SKIP  flat: amplitude ${T.amplitude} ≠ 0 (run-2 relief active)`);
  }
}

if (failures > 0) {
  throw new Error(`${failures} terrain invariant violation(s)`);
}
console.log("\nOK — all Terrain substrate invariants hold");
