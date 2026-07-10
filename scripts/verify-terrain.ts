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
import { buildNeighborhood, footprintXZ, STREET_PATCHES } from "../src/level/Neighborhood";
import { buildHospital } from "../src/level/Hospital";
import { HOSPITAL_PARAMS } from "../src/level/hospital/params";
import { PlayArea } from "../src/systems/PlayArea";
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

// The terrain MESH surface at (x,z): THREE.PlaneGeometry's triangulation of the
// shared sample grid — the ground the game actually renders and collides with.
// This is the REFERENCE heightAt must now reproduce (it moved off the analytic
// field onto exactly this surface). Byte-identical to sweep-terrain's meshSurface;
// each cell splits on the anti-diagonal (b–d = (ix,iz+1)–(ix+1,iz), u+v=1).
function meshSurface(t: Terrain, x: number, z: number): number {
  const m = t.cols + 1;
  const cs = t.cellSize;
  const fx = (x + SIZE / 2) / cs;
  const fz = (z + SIZE / 2) / cs;
  const ix = Math.max(0, Math.min(m - 2, Math.floor(fx)));
  const iz = Math.max(0, Math.min(m - 2, Math.floor(fz)));
  const u = Math.max(0, Math.min(1, fx - ix));
  const v = Math.max(0, Math.min(1, fz - iz));
  const h00 = t.samples[iz * m + ix];
  const h10 = t.samples[iz * m + ix + 1];
  const h01 = t.samples[(iz + 1) * m + ix];
  const h11 = t.samples[(iz + 1) * m + ix + 1];
  if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
  return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}

// Max |heightAt − meshSurface| over every cell, sampled at the grid VERTEX, the
// two EDGE midpoints, and interior points either side of the split diagonal — so
// the check exercises both triangles and the seam, not just cell centres. Returns
// the gap and the sample count for the printed line.
function meshGapOf(t: Terrain): { gap: number; samples: number } {
  const m = t.cols + 1;
  const cs = t.cellSize;
  const offsets: [number, number][] = [
    [0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5], [0.3, 0.7], [0.7, 0.3], [0.5, 0.5001],
  ];
  let gap = 0;
  let count = 0;
  for (let iz = 0; iz < m - 1; iz++) {
    for (let ix = 0; ix < m - 1; ix++) {
      for (const [ou, ov] of offsets) {
        const x = -SIZE / 2 + (ix + ou) * cs;
        const z = -SIZE / 2 + (iz + ov) * cs;
        gap = Math.max(gap, Math.abs(t.heightAt(x, z) - meshSurface(t, x, z)));
        count++;
      }
    }
  }
  return { gap, samples: count };
}

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
// The seam guard: a point landing EXACTLY on a dilated-pad edge must resolve as
// pad (inclusive intervals), so there is no half-open one-cell seam that could
// sink a block under a wall. With relief ON, heightAt at a between-grid boundary
// point is no longer exactly padY (the apron ramp starts there — smootherstep(0)
// is padY only at a grid-aligned edge; off-grid it interpolates a neighbouring
// ramp sample), so the amplitude-0-only `heightAt === padY` clause is dropped.
// It is harmless anyway: every building sits padMargin (= 1 cell) INSIDE its pad
// (assertions 2/3), so no block is within a cell of the boundary this probes.
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
      if (terrain.isPad(x, z)) resolved++;
    }
  }
  check(resolved === total, `boundary samples resolve as pad: ${resolved} / ${total}`);
}

// --- 9. perimeter wall bases meet the real ground (the SINK) ------------------
// Boundary no longer point-samples each wall's centre (that floated the long box
// over the low stretches of the edge). It SINKS the base to minHeightIn over the
// footprint and grows the box downward, holding the top. The invariant is now
// "base ≤ heightAt EVERYWHERE on the footprint" — buried on every high stretch,
// flush on the lowest, never a gap. A dense footprint probe confirms it against
// the real triangulated surface. (The old interleaved-ring Δh check modelled the
// retired point-sample placement; it is superseded here.)
{
  const playArea = new PlayArea(GameConfig.PLAY_AREA);
  const segs = playArea.wallSegments();
  let floating = 0;
  let maxOvershoot = 0; // how far a base pokes ABOVE the ground, if ever
  for (const seg of segs) {
    const footprint: Rect = {
      x0: seg.center.x - seg.halfExtents.x,
      x1: seg.center.x + seg.halfExtents.x,
      z0: seg.center.z - seg.halfExtents.z,
      z1: seg.center.z + seg.halfExtents.z,
    };
    // Base as Boundary sets it: seg.center.y − halfExtents.y (= 0) + footprint min.
    const baseY = seg.center.y - seg.halfExtents.y + terrain.minHeightIn(footprint);
    let over = 0;
    const nx = 240, nz = 240;
    for (let i = 0; i <= nx; i++) {
      const wx = footprint.x0 + (i / nx) * (footprint.x1 - footprint.x0);
      for (let j = 0; j <= nz; j++) {
        const wz = footprint.z0 + (j / nz) * (footprint.z1 - footprint.z0);
        const gap = baseY - terrain.heightAt(wx, wz); // > 0 ⇒ base above ground (floating)
        if (gap > 1e-6) over = Math.max(over, gap);
      }
    }
    if (over > 1e-6) floating++;
    maxOvershoot = Math.max(maxOvershoot, over);
  }
  check(floating === 0, `wall base gaps: ${floating} / ${segs.length} (max overshoot ${maxOvershoot.toFixed(4)} m)`);
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

// --- 11. heightAt IS the triangulated ground: meshGap ≡ 0 --------------------
// The point of this run: heightAt no longer evaluates the continuous analytic
// field, it interpolates the same triangle grid the mesh and Rapier heightfield
// use. So it must equal the mesh surface to the bit (float reassociation only) at
// vertices, edges, and both triangle interiors — NOT within a tolerance. The 1e-9
// bound is a float-equality guard: a larger residual would mean the two are not
// the same formula, which is a bug, not rounding.
{
  const { gap, samples } = meshGapOf(terrain);
  check(gap < 1e-9, `meshGap: ${gap.toFixed(3)} m over ${samples} samples`);
}

// --- 11b. and it stays 0 with real relief -----------------------------------
// The sweep measured meshGap 0.155–0.335 m at amplitude 1.0 against the OLD
// analytic heightAt. With heightAt on the triangulated grid it is 0 at ANY
// amplitude (triangulated-vs-triangulated), which is the before/after proof the
// run did its job. Built locally so the shipped amplitude (0) is untouched.
{
  const amp1 = new Terrain({ ...spec, amplitude: 1.0 });
  const { gap, samples } = meshGapOf(amp1);
  check(gap < 1e-9, `meshGap at amplitude 1.0: ${gap.toFixed(3)} m over ${samples} samples`);
}

// ===========================================================================
// RELIEF-ON assertions (run "relief on"): the paved drape, the wall sink, the
// tree plant, and funnel occlusion. These do the real work now that amplitude
// is non-zero; at amplitude 0 they are all trivially green.
// ===========================================================================

// The six paved rects EXACTLY as Level draws them: the parking-lot literal
// (Level.ts) + STREET_PATCHES, with the paint tier each is lifted by. Kept in
// lock-step with Level.addPatch — same dims, same tiers.
interface Paved { name: string; x: number; z: number; w: number; d: number; tier: number; }
const PAVED: Paved[] = [
  { name: "lot", x: 0, z: 10, w: 58, d: 20, tier: 0.015 },
  ...STREET_PATCHES.map((p, i) => ({ name: `patch${i}`, x: p.x, z: p.z, w: p.w, d: p.d, tier: p.y })),
];

// The DRAPED paved surface height at (wx,wz) — a byte-for-byte replica of the
// mesh Level builds: PlaneGeometry(w,d, ceil(w/step), ceil(d/step)) laid flat,
// every vertex lifted to heightAt + tier, split on THREE's b–d anti-diagonal
// (u+t=1) exactly like Terrain.heightAt. This is the surface the game renders;
// residual against heightAt is the chord error the ≤ cellSize/3 step must bound.
function pavedHeightAt(t: Terrain, r: Paved, step: number, wx: number, wz: number): number {
  const segX = Math.ceil(r.w / step);
  const segZ = Math.ceil(r.d / step);
  const segW = r.w / segX;
  const segH = r.d / segZ;
  const x0 = r.x - r.w / 2;
  const z0 = r.z - r.d / 2;
  const fu = (wx - x0) / segW;
  const ft = (wz - z0) / segH;
  const ix = Math.max(0, Math.min(segX - 1, Math.floor(fu)));
  const iy = Math.max(0, Math.min(segZ - 1, Math.floor(ft)));
  const u = Math.max(0, Math.min(1, fu - ix));
  const tt = Math.max(0, Math.min(1, ft - iy));
  const vy = (gx: number, gy: number): number =>
    t.heightAt(x0 + gx * segW, z0 + gy * segH) + r.tier;
  const ya = vy(ix, iy), yb = vy(ix, iy + 1), yc = vy(ix + 1, iy + 1), yd = vy(ix + 1, iy);
  if (u + tt <= 1) return ya + u * (yd - ya) + tt * (yb - ya);
  return yc + (1 - u) * (yb - yc) + (1 - tt) * (yd - yc);
}

// --- R1. paved clearance: the drape never dips into the ground, and the chord
// error inside a sub-quad stays under the budget. Dense probe (≥ 50 000 points)
// across all six footprints. min residual (paved − heightAt) ≥ 0.010 m (never
// pierces the ground); max chord deviation (paved − heightAt − tier) ≤ 0.005 m.
// The chord error is measured, not assumed: it is reported at the SHIPPED step
// and at the halved step (the run's protocol — halve once and re-measure before
// escalating), so the reading shows how the error scales with subdivision.
function measurePaved(step: number): { minResidual: number; maxResidual: number; maxChordDev: number; probes: number } {
  const probeStep = 0.25; // → ~66 k probes over the six rects (≥ 50 000)
  let minResidual = Infinity;
  let maxResidual = -Infinity;
  let maxChordDev = -Infinity;
  let probes = 0;
  for (const r of PAVED) {
    const nx = Math.ceil(r.w / probeStep);
    const nz = Math.ceil(r.d / probeStep);
    for (let i = 0; i <= nx; i++) {
      const wx = r.x - r.w / 2 + (i / nx) * r.w;
      for (let j = 0; j <= nz; j++) {
        const wz = r.z - r.d / 2 + (j / nz) * r.d;
        const residual = pavedHeightAt(terrain, r, step, wx, wz) - terrain.heightAt(wx, wz);
        minResidual = Math.min(minResidual, residual);
        maxResidual = Math.max(maxResidual, residual);
        maxChordDev = Math.max(maxChordDev, residual - r.tier);
        probes++;
      }
    }
  }
  return { minResidual, maxResidual, maxChordDev, probes };
}
{
  const chordBudget = 0.005;
  const shipped = GameConfig.terrain.pavedSegment;
  const m = measurePaved(shipped);
  const half = measurePaved(shipped / 2);
  const quarter = measurePaved(shipped / 4);
  console.log(
    `      paved clearance @ ${shipped} m: min ${m.minResidual.toFixed(4)} m, max ${m.maxResidual.toFixed(4)} m over ${m.probes} probes`,
  );
  console.log(
    `      max chord deviation: ${m.maxChordDev.toFixed(4)} m @ ${shipped} · ` +
      `${half.maxChordDev.toFixed(4)} m @ ${(shipped / 2).toFixed(3)} · ${quarter.maxChordDev.toFixed(4)} m @ ${(shipped / 4).toFixed(3)}`,
  );
  check(m.minResidual >= 0.01 - 1e-9, `paved never dips into ground: min residual ${m.minResidual.toFixed(4)} m ≥ 0.010`);
  check(
    m.maxChordDev <= chordBudget + 1e-9,
    `max chord deviation (paved − heightAt − tier): ${m.maxChordDev.toFixed(4)} m ≤ ${chordBudget}`,
  );
}

// --- R2. tier separation: every XZ-overlapping paved pair keeps ≥ 0.010 m of
// NORMAL separation (the z-fight floor). Offsets are along +y, so the normal
// separation is |Δtier|·cosθ at the field's steepest; a hard 0.01 m bound (no
// epsilon, no slope-scale — the surfaces are parallel by construction).
{
  const cosT = 1 / Math.sqrt(1 + GameConfig.terrain.fieldMaxSlope ** 2);
  const overlap = (a: Paved, b: Paved): boolean =>
    a.x - a.w / 2 < b.x + b.w / 2 && a.x + a.w / 2 > b.x - b.w / 2 &&
    a.z - a.d / 2 < b.z + b.d / 2 && a.z + a.d / 2 > b.z - b.d / 2;
  let pairs = 0;
  let under = 0;
  let minNormal = Infinity;
  for (let i = 0; i < PAVED.length; i++) {
    for (let j = i + 1; j < PAVED.length; j++) {
      if (!overlap(PAVED[i], PAVED[j])) continue;
      pairs++;
      const normal = Math.abs(PAVED[i].tier - PAVED[j].tier) * cosT;
      minNormal = Math.min(minNormal, normal);
      if (normal < 0.01) under++;
    }
  }
  check(under === 0, `under-separated tier pairs: ${under} / ${pairs} (min normal ${minNormal.toFixed(4)} m ≥ 0.010)`);
}

// --- R4. field-planted sections sit ON the ground at their point. Each tree is
// lifted by heightAt at its footprint centre (liftSectionsToTerrain); since the
// trunk is centred, its base lands exactly on heightAt at the trunk (x,z). An
// off-ground section would be one whose trunk is NOT its footprint centre — the
// third-class case finding 6 ruled out (M = 0), re-proven here after the lift.
{
  const trees = buildNeighborhood().filter((s) => s.name === "tree");
  let offGround = 0;
  let maxErr = 0;
  for (const s of trees) {
    const f = footprintXZ(s);
    const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
    const dy = terrain.heightAt(cx, cz); // the single plant sample the lift uses
    const trunk = s.blocks[0];
    const trunkBottom = trunk.position[1] - trunk.size[1] / 2 + dy; // after the lift
    const err = Math.abs(trunkBottom - terrain.heightAt(trunk.position[0], trunk.position[2]));
    if (err > 1e-6) offGround++;
    maxErr = Math.max(maxErr, err);
  }
  check(offGround === 0, `field sections off-ground: ${offGround} / ${trees.length} (max ${maxErr.toFixed(4)} m)`);

  // --- R5. trees not floating: a point-planted trunk touches the ground — its
  // base is at or below heightAt at at least one of its four base corners (it
  // rests on the highest contact). "Floating" = the WHOLE base clears the ground
  // (below every corner). On a slope the uphill corner is necessarily a little
  // proud of the base; that proud gap is printed (it is invisible — the trunk is
  // 3 m tall and still seated), never a hover. Planting stays ONE heightAt call
  // (§4), so the trunk is not sunk to its footprint minimum.
  let floating = 0;
  let maxProud = 0; // worst single-corner clearance above the base
  for (const s of trees) {
    const f = footprintXZ(s);
    const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
    const dy = terrain.heightAt(cx, cz);
    const trunk = s.blocks[0];
    const base = trunk.position[1] - trunk.size[1] / 2 + dy;
    const hw = trunk.size[0] / 2, hd = trunk.size[2] / 2;
    const corners: [number, number][] = [
      [trunk.position[0] - hw, trunk.position[2] - hd],
      [trunk.position[0] + hw, trunk.position[2] - hd],
      [trunk.position[0] - hw, trunk.position[2] + hd],
      [trunk.position[0] + hw, trunk.position[2] + hd],
    ];
    let minCornerGap = Infinity; // base − ground; > 0 at every corner ⇒ hovering
    for (const [x, z] of corners) {
      const gap = base - terrain.heightAt(x, z);
      minCornerGap = Math.min(minCornerGap, gap);
      maxProud = Math.max(maxProud, gap);
    }
    if (minCornerGap > 1e-6) floating++;
  }
  check(floating === 0, `trees floating: ${floating} / ${trees.length} (max corner proud ${maxProud.toFixed(4)} m)`);
}

// --- R6. funnel occlusion: from a grid of viewpoints in PlayArea, the line of
// sight to the funnel's mid-height along its pass paths clears the terrain — no
// hill hides the funnel. At 1.8 m relief this is comfortable; the printed min
// clearance is the margin (how much amplitude is left before a hill can occlude).
{
  const H = GameConfig.PLAY_AREA.halfExtent;
  const c = GameConfig.hospitalCenter;
  const passRadius = GameConfig.tornado.passRadius;
  const midHeight = GameConfig.tornado.height / 2; // funnel mid-height (m above its base)
  const eye = GameConfig.player.eyeHeight;
  const VP = 31; // 31×31 viewpoints
  const PATHS = 12; // spawn angles around the circle
  const ALONG = 6; // funnel positions sampled along each path (through the map)
  const MARCH = 48; // ray-march steps
  let points = 0;
  let occluded = 0;
  let minClear = Infinity;
  for (let a = 0; a < VP; a++) {
    const vx = -H + (a / (VP - 1)) * 2 * H;
    for (let b = 0; b < VP; b++) {
      const vz = -H + (b / (VP - 1)) * 2 * H;
      const eyeY = terrain.heightAt(vx, vz) + eye;
      points++;
      let blocked = false;
      for (let p = 0; p < PATHS; p++) {
        const ang = (p / PATHS) * Math.PI * 2;
        const sx = c.x + Math.cos(ang) * passRadius;
        const sz = c.z + Math.sin(ang) * passRadius;
        // Straight pass from spawn through the hospital centre and out the far side.
        for (let k = 0; k < ALONG; k++) {
          const tt = k / (ALONG - 1); // 0 (spawn) → 1 (exit)
          const fx = sx + (c.x - sx) * 2 * tt;
          const fz = sz + (c.z - sz) * 2 * tt;
          const fy = terrain.heightAt(fx, fz) + midHeight;
          for (let m = 1; m <= MARCH; m++) {
            const s = m / (MARCH + 1);
            const px = vx + (fx - vx) * s;
            const pz = vz + (fz - vz) * s;
            const rayY = eyeY + (fy - eyeY) * s;
            const clr = rayY - terrain.heightAt(px, pz);
            if (clr < minClear) minClear = clr;
            if (clr < 0) blocked = true;
          }
        }
      }
      if (blocked) occluded++;
    }
  }
  check(occluded === 0, `occluded sample points: ${occluded} / ${points} (min clearance ${minClear.toFixed(2)} m)`);
}

if (failures > 0) {
  throw new Error(`${failures} terrain invariant violation(s)`);
}
console.log("\nOK — all Terrain substrate invariants hold");
