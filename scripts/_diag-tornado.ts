// TEMP §2 diagnostic — terminating, no game loop. Force doubleTornadoChance=1
// and assert the round instantiates TWO independent funnels with distinct
// positions/seeds and divergent paths. Delete after use.
import * as THREE from "three";
import { GameConfig } from "../src/config/GameConfig";
import { TornadoSystem } from "../src/systems/TornadoSystem";
import { WindField } from "../src/systems/WindField";
import { Noise } from "../src/core/Noise";

GameConfig.tornado.doubleTornadoChance = 1; // force the double branch
GameConfig.tornado.throughBuildingChance = 0;

const t = new TornadoSystem(new Noise());
t.begin();

console.log("funnelCount =", t.funnelCount, " maxFunnels =", GameConfig.tornado.maxFunnels);
console.log("funnels.length at pass start =", t.funnels.length);
t.funnels.forEach((f, i) =>
  console.log(
    `  funnel ${i}: seed=${f.seed} spawn=(${f.spawnPos.x.toFixed(1)},${f.spawnPos.y.toFixed(1)}) ` +
      `pos=(${f.position.x.toFixed(1)},${f.position.z.toFixed(1)}) heading=(${f.heading.x.toFixed(2)},${f.heading.y.toFixed(2)})`,
  ),
);

// Advance a few seconds and confirm both travel and DIVERGE (distinct routes).
let updates = 0;
for (let i = 0; i < 120; i++) {
  t.update(1 / 60);
  updates++;
  if (t.funnels.length < 2) break;
}
console.log(`after ${updates} updates (~${(updates / 60).toFixed(1)}s): funnels.length =`, t.funnels.length);
if (t.funnels.length >= 2) {
  const a = t.funnels[0].position;
  const b = t.funnels[1].position;
  const sep = Math.hypot(a.x - b.x, a.z - b.z);
  console.log(`  funnel 0 pos=(${a.x.toFixed(1)},${a.z.toFixed(1)}) int=${t.funnels[0].intensity.toFixed(2)}`);
  console.log(`  funnel 1 pos=(${b.x.toFixed(1)},${b.z.toFixed(1)}) int=${t.funnels[1].intensity.toFixed(2)}`);
  console.log(`  separation = ${sep.toFixed(1)} m (want >> 0 -> distinct places)`);
}

// Wind superposition sanity: sample a point and confirm the field is non-zero.
const wf = new WindField(t, new Noise());
const wind = new THREE.Vector3();
wf.sample(wind, new THREE.Vector3(0, 1, -24), updates / 60);
console.log(`wind at (0,1,-24) with both funnels = |${wind.length().toFixed(1)}| m/s`);

const pass = t.funnels.length >= 2;
console.log(pass ? "PASS: two independent funnels at chance=1" : "FAIL: did not get two funnels");
process.exit(pass ? 0 : 1);
