// Static verification of the map boundary's PURE geometry + warning latch
// (systems/PlayArea.ts). Terminates on its own — no dev server, no THREE, no
// Rapier, no game loop. Drives PlayArea through synthetic sequences and prints a
// count behind every assertion.
// Run with: npm run verify:boundary   (or: npx tsx scripts/verify-boundary.ts)
//
// Covers:
//  1. Coverage    — 360 rays from centre (1° steps) each hit a wall segment.
//  2. Corners     — the four corners at 1.02× halfExtent read outside.
//  3. Containment — 10k-point grid: isOutside matches the analytic square test.
//  4. Warning (clean walk)  — centre→outside→centre yields exactly 2 transitions.
//  5. Warning (jitter)      — 40 oscillations across warnBand (amplitude <
//                             hysteresis) still yield exactly 2 (the reason
//                             hysteresis exists — remove it and this fails).
//  6. Scale invariance      — at h vs 2h, every wall centre (horizontal), every
//                             perimeter-axis half-extent, and every dressing-slot
//                             position scales by exactly 2 (heights/thickness are
//                             size-independent by design, so excluded).
//  7. Dressing band         — every slot lies within the treeline band on ≥1 axis.
import { PlayArea, type PlayAreaConfig } from "../src/systems/PlayArea";
import { GameConfig } from "../src/config/GameConfig";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

const CFG: PlayAreaConfig = GameConfig.PLAY_AREA;
const H = CFG.halfExtent;
const pa = new PlayArea(CFG);
const EPS = 1e-6;

// --- 1. coverage: every ray from the centre hits a wall ---------------------
console.log("--- coverage ---");
/** 2D ray-vs-AABB (origin at 0,0). Returns true if the ray hits the box. */
function rayHitsBox(dx: number, dz: number, cx: number, cz: number, hx: number, hz: number): boolean {
  // Slab method; ray origin is the world centre (0,0).
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const [d, c, hlf] of [
    [dx, cx, hx],
    [dz, cz, hz],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (-c - hlf > 0 || -c + hlf < 0) return false; // parallel & outside slab
    } else {
      let t1 = (c - hlf) / d;
      let t2 = (c + hlf) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
    }
  }
  return tmax >= Math.max(tmin, 0);
}
const segs = pa.wallSegments();
let covered = 0;
for (let deg = 0; deg < 360; deg++) {
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  const hit = segs.some((s) =>
    rayHitsBox(dx, dz, s.center.x, s.center.z, s.halfExtents.x, s.halfExtents.z),
  );
  if (hit) covered++;
}
check(covered === 360, `boundary coverage: ${covered}/360`);

// --- 2. corners outside -----------------------------------------------------
console.log("\n--- corners ---");
let cornersOut = 0;
for (const sx of [1, -1]) {
  for (const sz of [1, -1]) {
    if (pa.isOutside(sx * 1.02 * H, sz * 1.02 * H)) cornersOut++;
  }
}
check(cornersOut === 4, `corners outside: ${cornersOut}/4`);

// --- 3. containment vs analytic square --------------------------------------
console.log("\n--- containment ---");
let matches = 0;
const N = 100; // 100 × 100 = 10,000 points
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const x = -1.5 * H + (3 * H * i) / (N - 1);
    const z = -1.5 * H + (3 * H * j) / (N - 1);
    const analytic = Math.abs(x) > H || Math.abs(z) > H;
    if (pa.isOutside(x, z) === analytic) matches++;
  }
}
check(matches === N * N, `containment matches: ${matches}/${N * N}`);

// --- 4. warning edges — clean walk ------------------------------------------
console.log("\n--- warning (clean walk) ---");
/** Count non-null transitions along a path of edge-distances (fed as x, z=0). */
function countTransitions(area: PlayArea, distances: number[]): number {
  area.reset();
  let n = 0;
  for (const d of distances) {
    // Convert a signed distance-to-edge into an x on the +X axis (z=0):
    // distanceToEdge(x,0) = H - |x|  →  x = H - d.
    if (area.update(H - d, 0) !== null) n++;
  }
  return n;
}
// centre (d≈H) → just outside (d<0) → back to centre. Crosses warnBand twice.
const cleanWalk: number[] = [];
for (let d = H; d >= -5; d -= 2) cleanWalk.push(d); // walk out
for (let d = -5; d <= H; d += 2) cleanWalk.push(d); // walk back in
const cleanTransitions = countTransitions(pa, cleanWalk);
check(cleanTransitions === 2, `warning transitions: ${cleanTransitions} (expected 2)`);

// --- 5. warning edges — jitter ----------------------------------------------
console.log("\n--- warning (jitter) ---");
const amp = CFG.warnHysteresis - 1; // amplitude strictly < hysteresis
const jitter: number[] = [];
jitter.push(H); // start deep inside (un-warned)
for (let k = 0; k < 40; k++) {
  // Oscillate the distance-to-edge around warnBand by ±amp.
  jitter.push(CFG.warnBand - amp);
  jitter.push(CFG.warnBand + amp);
}
jitter.push(H + CFG.warnHysteresis + 5); // finally leave the band, past hysteresis
const jitterTransitions = countTransitions(pa, jitter);
check(
  jitterTransitions === 2,
  `warning transitions under jitter: ${jitterTransitions} (expected 2)`,
);

// --- 6. scale invariance ----------------------------------------------------
console.log("\n--- scale invariance ---");
const pa1 = new PlayArea({ ...CFG, halfExtent: H });
const pa2 = new PlayArea({ ...CFG, halfExtent: 2 * H });
let scaled = 0;
let scaleTotal = 0;
const seg1 = pa1.wallSegments();
const seg2 = pa2.wallSegments();
const near2x = (a: number, b: number): boolean => Math.abs(a * 2 - b) <= EPS + 1e-6 * Math.abs(b);
for (let i = 0; i < seg1.length; i++) {
  // Horizontal centre scales (y == wallHeight/2 is size-independent, excluded).
  for (const v of ["x", "z"] as const) {
    scaleTotal++;
    if (near2x(seg1[i].center[v], seg2[i].center[v])) scaled++;
  }
  // Perimeter-axis half-extent scales (thickness axis is size-independent).
  const axis = seg1[i].halfExtents.x > seg1[i].halfExtents.z ? "x" : "z";
  scaleTotal++;
  if (near2x(seg1[i].halfExtents[axis], seg2[i].halfExtents[axis])) scaled++;
}
const slots1 = pa1.dressingSlots();
const slots2 = pa2.dressingSlots();
for (let i = 0; i < slots1.length; i++) {
  scaleTotal += 2;
  if (near2x(slots1[i].x, slots2[i].x)) scaled++;
  if (near2x(slots1[i].z, slots2[i].z)) scaled++;
}
check(scaled === scaleTotal, `scaled values matching: ${scaled}/${scaleTotal}`);

// --- 7. dressing band placement ---------------------------------------------
console.log("\n--- dressing band ---");
const bandInner = H - CFG.dressingBandFraction * H;
const slots = pa.dressingSlots();
let inBand = 0;
for (const s of slots) {
  const onX = Math.abs(s.x) >= bandInner - EPS && Math.abs(s.x) <= H + EPS;
  const onZ = Math.abs(s.z) >= bandInner - EPS && Math.abs(s.z) <= H + EPS;
  if (onX || onZ) inBand++;
}
check(inBand === slots.length, `slots in band: ${inBand}/${slots.length}`);
check(slots.length === CFG.slotsPerSide * 4, `slot count: ${slots.length} (== 4 × ${CFG.slotsPerSide})`);

if (failures > 0) {
  throw new Error(`${failures} boundary invariant violation(s)`);
}
console.log("\nOK — all PlayArea boundary invariants hold");
