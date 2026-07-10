// Static axis check: does the Rapier heightfield collider agree with
// Terrain.heightAt about WHERE each height goes? Terrain holds a row-major grid
// samples[iz·n+ix] (ix→+x, iz→+z); Rapier reads `heights` column-major and applies
// its own row/col→world-axis convention (compiled into the parry3d WASM, not
// readable in node_modules). For a square grid the flat indices coincide
// NUMERICALLY, but if the axis SEMANTICS are swapped, every off-diagonal height
// lands transposed. This script reads that convention EMPIRICALLY.
//
// This is a UNIT check, NOT a headless game run: no Game import, no render loop,
// no dev server, and NO stepping. It constructs ONE heightfield collider in a
// world with no other bodies, casts ~50 downward rays straight at the collider's
// own shape (Collider.castRay — step-free, it does not touch the broad phase or a
// query pipeline that a step would populate), compares each hit y to heightAt,
// prints counts, and exits.
//
// The grid is deliberately ASYMMETRIC and PLANAR: h[iz][ix] = (iz-c)·1000 + (ix-c)
// (c = grid centre). Planar ⇒ both triangles of every cell are coplanar, so the
// diagonal split is irrelevant and any mismatch is an AXIS swap, not a
// triangulation difference. Mean-zero in each axis ⇒ robust even if parry vertically
// centres the field. Asymmetric ⇒ a transpose changes h at every off-diagonal node
// (a symmetric grid transposes to itself and would pass while the axes are swapped).
//
// Run with: npm run verify:axes   (or: npx tsx scripts/verify-terrain-axes.ts)
import RAPIER from "@dimforge/rapier3d-compat";
import { Terrain, type TerrainSpec } from "../src/level/Terrain";

const SIZE = 8; // square domain [-4, 4]
const CELL = 1; // 8 cells/side → a 9×9 node grid
const HALF = SIZE / 2;
const RAY_COUNT = 50;
const TOL = 0.5; // f32 heightfield vs f64 heightAt noise is ~1e-3; a swap is ≥999.

await RAPIER.init();

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

// A Terrain over the SIZE×CELL square, then its samples OVERWRITTEN in place with
// the asymmetric planar grid. heightAt reads this.samples, so this exercises the
// real interpolation code over a known grid.
const spec: TerrainSpec = {
  size: SIZE,
  cellSize: CELL,
  amplitude: 0,
  wavelength: 100,
  padY: 0,
  padMargin: 0,
  apronWidth: 0,
  footprints: [],
  authoredPadRects: [],
};
const terrain = new Terrain(spec);
const n = terrain.cols + 1; // 9
const c = (n - 1) / 2; // grid centre index (4)
for (let iz = 0; iz < n; iz++) {
  for (let ix = 0; ix < n; ix++) {
    terrain.samples[iz * n + ix] = (iz - c) * 1000 + (ix - c);
  }
}

// --- grid asymmetry: a transpose must change (almost) every node -------------
{
  let differ = 0;
  let pairs = 0;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      pairs++;
      if (terrain.samples[a * n + b] !== terrain.samples[b * n + a]) differ++;
    }
  }
  check(differ === pairs, `grid asymmetry: h[a][b] != h[b][a] for ${differ} / ${pairs} sampled pairs`);
}

// --- build ONE heightfield collider, exactly as Level.ts does ----------------
const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const collider = world.createCollider(
  RAPIER.ColliderDesc.heightfield(terrain.rows, terrain.cols, terrain.samples, {
    x: SIZE,
    y: 1,
    z: SIZE,
  }),
  body,
);

// --- cast ~50 rays; hit y must equal heightAt(x, z) --------------------------
// Deterministic spread strictly inside the domain (planar ⇒ interpolation is exact
// everywhere, so any interior point detects a transpose except on the x==z line —
// the spread keeps points off it).
const down = { x: 0, y: -1, z: 0 };
let mismatches = 0;
let missed = 0;
let worst = 0;
let transposeAgree = 0; // rays where hit y == heightAt(z, x) instead — a diagnosis.
for (let i = 0; i < RAY_COUNT; i++) {
  const x = -3.5 + 7 * (((i * 2654435761) >>> 0) / 4294967296);
  const z = -3.5 + 7 * ((((i * 40503 + 12345) >>> 0) % 100003) / 100003);
  const ray = new RAPIER.Ray({ x, y: 10000, z }, down);
  const hit = collider.castRayAndGetNormal(ray, 20000, true);
  if (!hit) {
    missed++;
    continue;
  }
  const hitY = 10000 - hit.timeOfImpact;
  const diff = Math.abs(hitY - terrain.heightAt(x, z));
  worst = Math.max(worst, diff);
  if (diff > TOL) mismatches++;
  if (Math.abs(hitY - terrain.heightAt(z, x)) <= TOL) transposeAgree++;
}

check(missed === 0, `rays missed: ${missed} / ${RAY_COUNT}`);
check(mismatches === 0, `axis mismatches: ${mismatches} / ${RAY_COUNT}  (worst |Δy| ${worst.toFixed(4)} m, tol ${TOL})`);
// Diagnosis: if the mismatching rays all agree with heightAt(z, x), the collider
// indexes the grid TRANSPOSED vs Terrain/the mesh — a clean x↔z axis swap. This
// says WHERE the fix belongs (Level.ts heightfield construction), not that heightAt
// is wrong; heightAt matches the mesh (verify:terrain meshGap 0).
console.log(`      diagnosis — rays matching heightAt(z, x) [transpose]: ${transposeAgree} / ${RAY_COUNT}`);

if (failures > 0) {
  // A non-zero mismatch count means the Rapier heightfield and heightAt disagree
  // about the axes. Per the run spec this is NOT fixed here (heightAt is the pure
  // module; a collider-construction fix belongs in Level.ts as its own change) —
  // it is reported.
  throw new Error(`${failures} axis invariant violation(s) — Rapier heightfield vs heightAt disagree`);
}
console.log("\nOK — Rapier heightfield agrees with heightAt on an asymmetric grid");
