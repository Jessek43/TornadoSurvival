// Terrain shape SWEEP — a measuring instrument, NOT a verify script. It asserts
// nothing and never fails a build; it prints one table over a grid of
// (amplitude × wavelength) pairs so the field's relief can be PRICED before any
// is switched on. GameConfig.terrain.amplitude stays 0 — this script constructs
// its own Terrain instances at other amplitudes internally and never touches the
// shipped value or the world.
//
// It imports the pure ground module (Terrain) and the REAL world footprints
// (worldPadFootprints, fed by the same pure section builders verify:terrain uses)
// — no THREE, no Rapier, no Game. It terminates.
// Run with: npm run sweep:terrain   (or: npx tsx scripts/sweep-terrain.ts)
import { Terrain, worldPadFootprints, type Rect, type TerrainSpec } from "../src/level/Terrain";
import { GameConfig } from "../src/config/GameConfig";
import { buildNeighborhood, STREET_PATCHES } from "../src/level/Neighborhood";
import { buildHospital } from "../src/level/Hospital";

const T = GameConfig.terrain;
const SIZE = GameConfig.world.groundSize;
const HALF = SIZE / 2;
const APRON_WIDTH = T.apronCells * T.cellSize; // derived exactly as Game does.

// The sweep axes live HERE (the instrument's range), not in GameConfig.
const AMPLITUDES = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0];
const WAVELENGTHS = [20, 40, 60, 80, 120];

// --- real world footprints (identical to Game / verify:terrain) --------------
const sections = [...buildHospital({ detail: true }).sections, ...buildNeighborhood()];
const footprints = worldPadFootprints(sections);

// The six paved footprints. Five are STREET_PATCHES; the sixth is the parking-lot
// literal that lives in Level.ts (which imports THREE, so it can't be imported
// here) — replicated as the diagnosis had to. Main street is STREET_PATCHES[0].
const rectOf = (cx: number, cz: number, w: number, d: number): Rect => ({
  x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2,
});
const LOT = rectOf(0, 10, 58, 20);
const PAVED: Rect[] = [LOT, ...STREET_PATCHES.map((p) => rectOf(p.x, p.z, p.w, p.d))];
const MAIN = STREET_PATCHES[0]; // 150×7 E–W street, centreline at z = MAIN.z.

function makeTerrain(amplitude: number, wavelength: number): Terrain {
  const spec: TerrainSpec = {
    size: SIZE,
    cellSize: T.cellSize,
    amplitude,
    wavelength,
    padY: T.padY,
    padMargin: T.padMargin,
    apronWidth: APRON_WIDTH,
    footprints,
    authoredPadRects: [],
  };
  return new Terrain(spec);
}

// distanceOutsideNearestPad (private on Terrain) — 6-line copy, as in verify.
function distOutsidePad(terrain: Terrain, x: number, z: number): number {
  let best = Infinity;
  for (const p of terrain.pads) {
    const dx = Math.max(p.x0 - x, 0, x - p.x1);
    const dz = Math.max(p.z0 - z, 0, z - p.z1);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}
const isFieldPoint = (terrain: Terrain, x: number, z: number): boolean =>
  !terrain.isPad(x, z) && distOutsidePad(terrain, x, z) >= APRON_WIDTH;

// Max slope over FIELD cells only (both sample endpoints in open field) — the
// emergent field gradient the sweep prices. Linear in amplitude by construction.
function maxFieldSlope(terrain: Terrain): number {
  const n = terrain.cols + 1;
  const gx = (i: number): number => -HALF + i * terrain.cellSize;
  let max = 0;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const wx = gx(ix);
      const wz = gx(iz);
      const h = terrain.samples[iz * n + ix];
      if (ix + 1 < n && isFieldPoint(terrain, wx, wz) && isFieldPoint(terrain, gx(ix + 1), wz)) {
        max = Math.max(max, Math.abs(terrain.samples[iz * n + ix + 1] - h) / terrain.cellSize);
      }
      if (iz + 1 < n && isFieldPoint(terrain, wx, wz) && isFieldPoint(terrain, wx, gx(iz + 1))) {
        max = Math.max(max, Math.abs(terrain.samples[(iz + 1) * n + ix] - h) / terrain.cellSize);
      }
    }
  }
  return max;
}

// Max slope over the six paved footprints (via Terrain.maxSlopeIn per rect).
function maxPavedSlope(terrain: Terrain): number {
  let max = 0;
  for (const r of PAVED) max = Math.max(max, terrain.maxSlopeIn(r));
  return max;
}

// Relief (max − min heightAt) along the main street's centreline.
function mainStreetRelief(terrain: Terrain): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = MAIN.x - MAIN.w / 2; x <= MAIN.x + MAIN.w / 2 + 1e-9; x += 0.5) {
    const h = terrain.heightAt(x, MAIN.z);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return hi - lo;
}

// The terrain MESH surface at (x,z): THREE.PlaneGeometry triangulation of the
// shared sample grid. Each 3 m cell splits on the anti-diagonal (u+v=1) into two
// triangles; barycentric-interpolate the enclosing one. This is what the visual
// mesh AND the Rapier heightfield actually render — heightAt (analytic, continuous
// smootherstep) diverges from it most where a pad/apron crease cuts a cell.
function meshSurface(terrain: Terrain, x: number, z: number): number {
  const n = terrain.cols + 1;
  const cs = terrain.cellSize;
  const fx = (x + HALF) / cs;
  const fz = (z + HALF) / cs;
  let ix = Math.floor(fx);
  let iz = Math.floor(fz);
  ix = Math.max(0, Math.min(n - 2, ix));
  iz = Math.max(0, Math.min(n - 2, iz));
  const u = Math.max(0, Math.min(1, fx - ix)); // 0 at ix → 1 at ix+1 (+x)
  const v = Math.max(0, Math.min(1, fz - iz)); // 0 at iz → 1 at iz+1 (+z)
  const h00 = terrain.samples[iz * n + ix];
  const h10 = terrain.samples[iz * n + ix + 1];
  const h01 = terrain.samples[(iz + 1) * n + ix];
  const h11 = terrain.samples[(iz + 1) * n + ix + 1];
  // Diagonal b–d = (ix,iz+1)–(ix+1,iz): triangle (0,0)(0,1)(1,0) for u+v≤1.
  if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
  return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}

// Max |analytic heightAt − mesh surface| sampled across the paved footprints (the
// worst deviation is cell-interior, off grid lines — sample at 0.5 m).
function meshGapOverPaved(terrain: Terrain): number {
  let max = 0;
  for (const r of PAVED) {
    for (let x = r.x0; x <= r.x1 + 1e-9; x += 0.5) {
      for (let z = r.z0; z <= r.z1 + 1e-9; z += 0.5) {
        max = Math.max(max, Math.abs(terrain.heightAt(x, z) - meshSurface(terrain, x, z)));
      }
    }
  }
  return max;
}

// padFrac — fraction of PlayArea grid samples that are pad (geometry only, so it
// is constant across the sweep). Printed once.
function padFraction(): number {
  const terrain = makeTerrain(0, WAVELENGTHS[0]);
  const n = terrain.cols + 1;
  const gx = (i: number): number => -HALF + i * terrain.cellSize;
  const H = GameConfig.PLAY_AREA.halfExtent;
  let pad = 0;
  let total = 0;
  for (let iz = 0; iz < n; iz++) {
    const wz = gx(iz);
    if (wz < -H || wz > H) continue;
    for (let ix = 0; ix < n; ix++) {
      const wx = gx(ix);
      if (wx < -H || wx > H) continue;
      total++;
      if (terrain.isPad(wx, wz)) pad++;
    }
  }
  return pad / total;
}

// --- table -------------------------------------------------------------------
const deg = (slope: number): number => (Math.atan(slope) * 180) / Math.PI;
const p = (s: string | number, w: number): string => String(s).padStart(w);

console.log(
  `\nterrain shape sweep · ground ${SIZE}m @ ${T.cellSize}m cells · apron ${T.apronCells} cells ` +
    `(${APRON_WIDTH}m) · padY ${T.padY}\n` +
    `fieldMaxSlope limit ${T.fieldMaxSlope} (${deg(T.fieldMaxSlope).toFixed(1)}°) · ` +
    `PlayArea pad fraction ${(padFraction() * 100).toFixed(1)}%\n`,
);

console.log(
  `${p("amp", 4)} ${p("wave", 5)} ${p("fieldSlope", 18)} ${p("pavedSlope", 11)} ` +
    `${p("mainRelief", 11)} ${p("meshGap", 9)} ${p("slopeOK", 8)}`,
);
console.log("-".repeat(72));

for (const amp of AMPLITUDES) {
  for (const wave of WAVELENGTHS) {
    const terrain = makeTerrain(amp, wave);
    const fs = maxFieldSlope(terrain);
    const ps = maxPavedSlope(terrain);
    const relief = mainStreetRelief(terrain);
    const gap = meshGapOverPaved(terrain);
    const ok = fs <= T.fieldMaxSlope + 1e-9;
    console.log(
      `${p(amp.toFixed(1), 4)} ${p(wave, 5)} ` +
        `${p(`${fs.toFixed(3)} (${deg(fs).toFixed(1)}°)`, 18)} ` +
        `${p(ps.toFixed(3), 11)} ${p(`${relief.toFixed(2)}m`, 11)} ` +
        `${p(`${gap.toFixed(3)}m`, 9)} ${p(ok ? "yes" : "NO", 8)}`,
    );
  }
}

// --- derived: largest amplitude at each wavelength under fieldMaxSlope --------
// Field slope is exactly linear in amplitude (heightAt's field/apron branches are
// amplitude·noise·[smooth]), so max amp = fieldMaxSlope / (slope per unit amp).
console.log(`\nlargest amplitude at fieldMaxSlope ${T.fieldMaxSlope} (${deg(T.fieldMaxSlope).toFixed(1)}°):`);
console.log(`${p("wave", 6)} ${p("slope/amp", 11)} ${p("maxAmp", 9)}`);
console.log("-".repeat(28));
const gapAt1: number[] = [];
for (const wave of WAVELENGTHS) {
  const slopePerAmp = maxFieldSlope(makeTerrain(1, wave));
  const maxAmp = T.fieldMaxSlope / slopePerAmp;
  console.log(`${p(wave, 6)} ${p(slopePerAmp.toFixed(4), 11)} ${p(`${maxAmp.toFixed(2)}m`, 9)}`);
  gapAt1.push(meshGapOverPaved(makeTerrain(1, wave)));
}

// meshGap vs wavelength: §4 expected it wavelength-INDEPENDENT (pad-edge creases
// dominating). Report the spread across wavelengths at a fixed amplitude (1.0) and
// let the data decide.
const gLo = Math.min(...gapAt1);
const gHi = Math.max(...gapAt1);
const spread = gLo > 0 ? ((gHi - gLo) / gLo) * 100 : 0;
console.log(
  `\nmeshGap @ amp 1.0 across wavelengths: ${gLo.toFixed(3)}–${gHi.toFixed(3)} m ` +
    `(spread ${spread.toFixed(1)}% → ${spread < 5 ? "wavelength-INDEPENDENT" : "wavelength-DEPENDENT"}). ` +
    `${spread < 5 ? "Pad-edge creases dominate." : "Corrects §4: the 3 m mesh under-resolves field curvature at short wavelength, so pad-edge creases do NOT dominate alone."}`,
);
