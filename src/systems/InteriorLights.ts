import * as THREE from "three";
import { GameConfig } from "../config/GameConfig";
import type { QualitySettings } from "../config/QualitySettings";
import type { Noise } from "../core/Noise";

/**
 * Interior emergency lighting — dim, unstable, oppressive, and performant at
 * any building size.
 *
 * The trick that keeps this cheap on a large hospital: light count in the
 * forward renderer is O(1), not O(rooms).
 *
 *  - FIXTURES: every corridor/room/stair-landing position becomes a small
 *    emissive box in ONE InstancedMesh. Emissive (unlit glow) + the existing
 *    bloom makes them read as light sources — and glowing stair landings act
 *    as landmarks — but emissive costs NO per-light shader work. Some
 *    fixtures are dimmed ("burned out") for variety.
 *  - REAL LIGHTS: a fixed small POOL of real PointLights (quality-driven,
 *    ~6) that FOLLOW the player: each frame we snap them to the N nearest
 *    fixtures. So only ~6 point lights ever exist in the scene's light list,
 *    illuminating whatever room the player is in, regardless of how many
 *    fixtures the building has. They're shadowless (shadow-casting point
 *    lights would each need a cubemap — far too expensive).
 *
 * Flicker: both fixtures and pool lights are modulated by noise, with some
 * fixtures strobing off intermittently — the emergency-power feel. This is
 * purely ADDITIVE to the exterior sun/hemisphere/lightning atmosphere.
 */
export class InteriorLights {
  private readonly fixtures: THREE.Vector3[];
  private readonly fixtureMesh: THREE.InstancedMesh;
  private readonly pool: THREE.PointLight[] = [];
  private readonly poolFixture: number[] = []; // which fixture each pool light tracks

  /** Section + anchor BLOCK that owns each fixture. The fixture is parented to
   *  a specific floor-slab block of its section; when THAT block is released
   *  (genuine local destruction) the fixture dies with it. Finer than
   *  whole-section ownership — a light on a destroyed floor of a surviving wing
   *  no longer floats — and re-sleep-safe (sleep/wake never release a block). */
  private readonly fixtureSection: number[];
  private readonly fixtureAnchor: number[];
  /** True once a fixture's anchor block is released — dark + gone forever.
   *  Latched, since block release is monotonic. */
  private readonly dead: boolean[];
  private readonly black = new THREE.Color(0x000000);
  /** Zero-scale for dead fixtures: the BOX disappears with its room, not just
   *  its glow — a black fixture floating where a ceiling used to be was the
   *  leftover bug (the light died; the mesh instance didn't). */
  private static readonly ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

  // scratch
  private readonly order: number[]; // fixture indices, sorted by distance each frame
  private readonly color = new THREE.Color();
  private readonly baseColor = new THREE.Color(GameConfig.interiorLights.fixtureColor);
  private time = 0;

  constructor(
    scene: THREE.Scene,
    fixturePositions: [number, number, number][],
    quality: QualitySettings,
    private readonly noise: Noise,
    fixtureSection: number[],
    fixtureAnchor: number[],
    /** "Has this fixture's anchor block been released (destroyed)?" Reads the
     *  per-block `released` flag, which is monotonic and NEVER set by
     *  sleep()/wake() — so a re-slept dormant section keeps its lights, while a
     *  destroyed floor drops exactly its own fixtures. */
    private readonly isAnchorReleased: (sectionIndex: number, blockIndex: number) => boolean,
  ) {
    this.fixtures = fixturePositions.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    this.fixtureSection = fixtureSection;
    this.fixtureAnchor = fixtureAnchor;
    this.dead = this.fixtures.map(() => false);
    this.order = this.fixtures.map((_, i) => i);

    // --- emissive fixture strips (one instanced mesh, ~free) ---
    // A wide thin strip reads as a ceiling-mounted fluorescent fixture (not a
    // floating dot) once the room around it is lit by the pool below.
    const geo = new THREE.BoxGeometry(1.4, 0.1, 0.35);
    // MeshBasic = unlit; the box always shows its (emissive-like) color and
    // blooms, independent of scene lighting. instanceColor drives per-fixture
    // brightness and the flicker.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.fixtureMesh = new THREE.InstancedMesh(geo, mat, this.fixtures.length);
    this.fixtureMesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.fixtures.length; i++) {
      m.setPosition(this.fixtures[i]);
      this.fixtureMesh.setMatrixAt(i, m);
      this.fixtureMesh.setColorAt(i, this.baseColor);
    }
    this.fixtureMesh.instanceMatrix.needsUpdate = true;
    scene.add(this.fixtureMesh);

    // --- pooled real point lights ---
    const n = Math.min(quality.interiorLightPool, this.fixtures.length);
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(
        GameConfig.interiorLights.fixtureColor,
        0,
        GameConfig.interiorLights.range,
        GameConfig.interiorLights.decay, // softened so one light fills a room
      );
      light.castShadow = false;
      scene.add(light);
      this.pool.push(light);
      this.poolFixture.push(-1);
    }
  }

  update(playerPos: THREE.Vector3, dt: number): void {
    this.time += dt;
    const cfg = GameConfig.interiorLights;

    // Latch newly-destroyed fixtures dark AND gone. A fixture dies only when
    // its OWNING SECTION is destroyed (its geometry is gone) — never when the
    // section is merely re-slept, so intact dormant sections keep flickering.
    // Zero-scaling the instance removes the box itself: a light must not
    // outlive the room it lit, and neither may its housing.
    for (let i = 0; i < this.fixtures.length; i++) {
      if (this.dead[i]) continue;
      const sec = this.fixtureSection[i];
      if (sec >= 0 && this.isAnchorReleased(sec, this.fixtureAnchor[i])) {
        this.dead[i] = true;
        this.fixtureMesh.setColorAt(i, this.black); // no lingering glow
        this.fixtureMesh.setMatrixAt(i, InteriorLights.ZERO_SCALE); // no floating box
        this.fixtureMesh.instanceMatrix.needsUpdate = true;
      }
    }

    // Rank fixtures by distance to the player; the nearest ALIVE N get real lights.
    this.order.sort((a, b) => {
      return this.fixtures[a].distanceToSquared(playerPos) - this.fixtures[b].distanceToSquared(playerPos);
    });

    let slot = 0;
    for (let o = 0; o < this.order.length && slot < this.pool.length; o++) {
      const fi = this.order[o];
      if (this.dead[fi]) continue; // a destroyed room gets no light
      const light = this.pool[slot];
      const fx = this.fixtures[fi];
      light.position.copy(fx);
      this.poolFixture[slot] = fi;
      // Only bother lighting fixtures actually near the player (beyond ~2×
      // range the contribution is negligible; keep them dark to save cost).
      // Multiply by baseBrightness so a burned-out fixture casts no light
      // (the emissive box and the light it casts stay consistent).
      const near = fx.distanceToSquared(playerPos) < (cfg.range * 2.2) ** 2;
      light.intensity = near
        ? cfg.baseIntensity * this.baseBrightness(fi) * this.flicker(fi)
        : 0;
      slot++;
    }
    // Any leftover pool lights (all nearby fixtures dead) stay off.
    for (; slot < this.pool.length; slot++) this.pool[slot].intensity = 0;

    // Fixture emissive brightness follows the same flicker (so the glowing box
    // and the light it casts pulse together). Dead fixtures stay black.
    for (let i = 0; i < this.fixtures.length; i++) {
      if (this.dead[i]) continue;
      const b = this.baseBrightness(i) * this.flicker(i);
      this.color.copy(this.baseColor).multiplyScalar(b);
      this.fixtureMesh.setColorAt(i, this.color);
    }
    if (this.fixtureMesh.instanceColor) this.fixtureMesh.instanceColor.needsUpdate = true;
  }

  /** Some fixtures are dead/dim for variety (deterministic per index). More
   *  dead ones now → creepier pools of light and dark than uniform coverage. */
  private baseBrightness(i: number): number {
    const r = ((i * 2654435761) >>> 0) % 100;
    if (r < 15) return 0.03; // burned out (dark fixture)
    if (r < 34) return 0.45; // weak / failing
    return 1;
  }

  /** Unstable emergency flicker in [~0.15, 1]. Some fixtures strobe off. */
  private flicker(i: number): number {
    const n = this.noise.noise1(this.time * 8 + i * 13.3, i % 7); // −1..1
    let v = 0.78 + 0.22 * n;
    if (i % 4 === 0) {
      const drop = this.noise.noise1(this.time * 3 + i * 5.1, (i % 7) + 1);
      if (drop > 0.62) v *= 0.15; // intermittent strobe-off
    }
    const cfg = GameConfig.interiorLights;
    return 1 - cfg.flickerAmount + cfg.flickerAmount * v;
  }
}
