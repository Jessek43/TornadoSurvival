import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import GUI from "lil-gui";
import { GameConfig } from "../config/GameConfig";
import { MATERIALS } from "../level/Materials";
import type { WindField } from "../systems/WindField";
import type { TornadoSystem } from "../systems/TornadoSystem";
import type { PlayerController } from "../systems/PlayerController";
import type { StructureSystem } from "../systems/StructureSystem";
import type { DebrisManager } from "../systems/DebrisManager";
import type { InteriorLights } from "../systems/InteriorLights";
import type { LightningSystem } from "../systems/LightningSystem";
import type { AlarmController } from "../systems/AlarmController";
import type { AppFlow } from "../systems/AppFlow";
import { LightningConfig } from "../config/LightningConfig";
import type { Physics } from "../core/Physics";
import type { StairLight } from "../level/hospital/params";

const PATH_CAPACITY = 2000; // ≈10 min of breadcrumbs at 0.3 s intervals

/**
 * Developer overlay, enabled with ?debug in the URL:
 *  - FPS meter + world counters (awake sections, block bodies, released,
 *    debris, orphan-lit fixtures, draw calls) — the numbers behind the
 *    "fps under destruction" and "no floating lights" verification gates
 *  - a live wind arrow at the player (direction + magnitude of the field)
 *  - a breadcrumb line tracing the tornado's path
 *  - a lil-gui panel that mutates GameConfig / MATERIALS live for balancing
 */
export class DebugTools {
  static enabled(): boolean {
    return new URLSearchParams(location.search).has("debug");
  }

  private readonly label: HTMLDivElement;
  /** Second panel below the FPS line for the section-specific readouts
   *  (stairwell-light mounts §1, ground-gap ray §2, last fall damage §3). */
  private readonly levelLabel: HTMLDivElement;
  private smoothedFps = 60;

  private readonly windArrow: THREE.ArrowHelper;
  private readonly pathLine: THREE.Line;
  private readonly pathPositions: Float32Array;
  private pathCount = 0;
  private pathTimer = 0;
  private time = 0;
  /** World counters are recomputed at 1 Hz (they scan all blocks). */
  private counterTimer = 1;
  private counterText = "";

  // scratch
  private readonly wind = new THREE.Vector3();
  private readonly arrowOrigin = new THREE.Vector3();
  /** Reused downward ray for the §2 ground-gap probe (no per-frame alloc). */
  private readonly downRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** Reused upward ray for the §1 head-clearance probe. */
  private readonly upRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  /** Running minimum head clearance while grounded — the "do I clip the stair
   *  ceiling" number; reset when airborne so a jump doesn't skew it. */
  private minHeadroom = Infinity;

  constructor(
    uiRoot: HTMLElement,
    scene: THREE.Scene,
    private readonly windField: WindField,
    private readonly tornado: TornadoSystem,
    private readonly player: PlayerController,
    private readonly structures: StructureSystem,
    private readonly debris: DebrisManager,
    private readonly interiorLights: InteriorLights,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly physics: Physics,
    private readonly stairLights: StairLight[],
    private readonly lightning: LightningSystem,
    private readonly alarm: AlarmController,
    private readonly flow: AppFlow,
  ) {
    this.label = document.createElement("div");
    this.label.style.cssText =
      "position:absolute;top:8px;left:8px;color:#9f9;font:12px monospace;" +
      "background:rgba(0,0,0,.5);padding:2px 6px;border-radius:3px;";
    uiRoot.appendChild(this.label);

    this.levelLabel = document.createElement("div");
    this.levelLabel.style.cssText =
      "position:absolute;top:32px;left:8px;max-width:96vw;color:#9cf;font:11px monospace;" +
      "white-space:pre;overflow-x:auto;background:rgba(0,0,0,.5);padding:2px 6px;border-radius:3px;";
    uiRoot.appendChild(this.levelLabel);

    this.windArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      1,
      0x66ff66,
    );
    this.windArrow.visible = false;
    scene.add(this.windArrow);

    this.pathPositions = new Float32Array(PATH_CAPACITY * 3);
    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute("position", new THREE.BufferAttribute(this.pathPositions, 3));
    pathGeo.setDrawRange(0, 0);
    this.pathLine = new THREE.Line(
      pathGeo,
      new THREE.LineBasicMaterial({ color: 0xff5544 }),
    );
    this.pathLine.frustumCulled = false;
    scene.add(this.pathLine);

    // Live tuning — these mutate the shared config objects directly.
    const gui = new GUI({ title: "tuning" });
    const tor = gui.addFolder("tornado");
    tor.add(GameConfig.tornado, "coreRadius", 3, 25);
    tor.add(GameConfig.tornado, "maxTangential", 10, 120);
    tor.add(GameConfig.tornado, "updraftSpeed", 0, 60);
    tor.add(GameConfig.tornado, "moveSpeed", 0, 15);
    tor.add(GameConfig.tornado, "wakeRadius", 10, 60);
    tor.add(GameConfig.tornado, "gapDuration", 5, 60);
    tor.add(GameConfig.tornado, "lateralOffsetMax", 0, 60);
    // §2 — crank these to 1 to force a double funnel / through-building pass on
    // the NEXT round (rolled in TornadoSystem.begin) for verification.
    tor.add(GameConfig.tornado, "doubleTornadoChance", 0, 1);
    tor.add(GameConfig.tornado, "throughBuildingChance", 0, 1);
    tor.add(GameConfig.tornado, "pathCurveAmp", 0, 20);
    tor.close();
    const mat = gui.addFolder("break thresholds");
    mat.add(MATERIALS.glass, "breakThreshold", 20, 1000);
    mat.add(MATERIALS.cladding, "breakThreshold", 50, 3000);
    mat.add(MATERIALS.concrete, "breakThreshold", 50, 8000);
    mat.add(MATERIALS.metal, "breakThreshold", 50, 6000);
    mat.close();
  }

  update(dt: number): void {
    this.time += dt;

    // FPS (exponential moving average keeps the readout from flickering)
    if (dt > 0) this.smoothedFps += (1 / dt - this.smoothedFps) * 0.05;

    // World counters at 1 Hz — awake/bodies/released come straight off the
    // public structure runtimes; orphan-lit re-probes every live fixture.
    this.counterTimer += dt;
    if (this.counterTimer >= 1) {
      this.counterTimer = 0;
      let awakeBig = 0;
      let bodies = 0;
      let released = 0;
      for (const s of this.structures.structures) {
        if (s.state === "awake" && s.blocks.length > 4) awakeBig++;
        released += s.releasedCount;
        for (const b of s.blocks) if (b.body) bodies++;
      }
      this.counterText =
        ` · awake ${awakeBig}/${GameConfig.tornado.maxAwakeSections}` +
        ` · bodies ${bodies} · released ${released}` +
        ` · debris ${this.debris.active}/${this.debris.budget}` +
        ` · orphanLit ${this.interiorLights.countOrphanLit()}` +
        ` · draw ${this.renderer.info.render.calls}`;
    }

    const sens = this.player.sensitivity / GameConfig.player.mouseSensitivity;
    // Round phase (from the tornado state) + siren state — the two readouts for
    // watching the final-pass resolution: `phase:` must go pass N/N → done with
    // NO gap after the last pass, and `siren:` must read off from that point.
    const t = this.tornado;
    const phase =
      t.state === "pass"
        ? `pass ${t.passIndex + 1}/${t.passesTotal}`
        : t.state === "gap"
          ? `gap ${t.passIndex + 1}/${t.passesTotal}`
          : t.state; // "idle" | "done"
    const siren = this.alarm.playing ? "on" : "off";
    this.label.textContent =
      `${this.smoothedFps.toFixed(0)} fps · flow: ${this.flow.state} · sens: ${sens.toFixed(2)}` +
      ` · phase: ${phase} · siren: ${siren}` +
      ` · tornado ` +
      (this.tornado.active
        ? `${this.tornado.position.distanceTo(this.player.position).toFixed(0)}m @ ${(
            this.tornado.intensity * 100
          ).toFixed(0)}%`
        : "idle") +
      this.counterText;

    // Wind arrow at the player
    this.windField.sample(this.wind, this.player.position, this.time);
    const speed = this.wind.length();
    if (speed > 0.5) {
      this.arrowOrigin.copy(this.player.position).y += 1.2;
      this.windArrow.position.copy(this.arrowOrigin);
      this.windArrow.setDirection(this.wind.normalize());
      this.windArrow.setLength(THREE.MathUtils.clamp(speed * 0.12, 0.5, 8));
      this.windArrow.visible = true;
    } else {
      this.windArrow.visible = false;
    }

    // Tornado breadcrumb path
    this.pathTimer += dt;
    if (this.tornado.active && this.pathTimer > 0.3 && this.pathCount < PATH_CAPACITY) {
      this.pathTimer = 0;
      const j = this.pathCount * 3;
      this.pathPositions[j] = this.tornado.position.x;
      this.pathPositions[j + 1] = 0.3;
      this.pathPositions[j + 2] = this.tornado.position.z;
      this.pathCount++;
      const attr = this.pathLine.geometry.getAttribute("position") as THREE.BufferAttribute;
      attr.needsUpdate = true;
      this.pathLine.geometry.setDrawRange(0, this.pathCount);
    }

    // Section readouts (stairwell-light mounts §1 / ground gap §2 / fall dmg §3).
    this.levelLabel.textContent = [
      this.traversalReadout(),
      this.stairReadout(),
      this.tornadoReadout(),
      this.groundGapReadout(),
      `last landing: ${this.player.lastFallSpeed.toFixed(1)} m/s -> ${this.player.lastFallDamage.toFixed(0)} hp`,
      this.lightningReadout(),
    ].join("\n");
  }

  /**
   * Restart-parity readout: log the section count + released-block count on each
   * entry to `playing` (Game.buildSession calls this). After a restart or a
   * menu→play round-trip these must match the very first spawn — released back
   * to 0, section count unchanged — proving teardown reconstructed the baseline.
   */
  logSessionBaseline(): void {
    let released = 0;
    for (const s of this.structures.structures) released += s.releasedCount;
    console.info(
      `[session] entered playing · sections ${this.structures.structures.length} · released ${released}`,
    );
  }

  /** Storm-lightning + alarm readout: whether strikes are enabled, the
   *  next-strike countdown, the last strike (impact point, hit type, blocks
   *  destroyed with the per-strike cap), and the alarm state paired with the
   *  tornado-present flag it keys off. */
  private lightningReadout(): string {
    const l = this.lightning;
    const last = l.lastStrike;
    const lastStr = last
      ? `(${last.x.toFixed(0)},${last.y.toFixed(0)},${last.z.toFixed(0)}) ${
          last.ground ? "GROUND" : "STRUCTURE"
        } blocks ${last.destroyed}/${LightningConfig.maxBlocksPerStrike}`
      : "-";
    const present = this.tornado.active; // a funnel is up this pass
    return (
      `§L lightning ${LightningConfig.enabled ? "on" : "OFF"}` +
      ` · next ${Math.max(0, l.nextStrikeCountdown).toFixed(1)}s · last ${lastStr}\n` +
      `§A alarm ${this.alarm.playing ? "PLAYING" : "stopped"}` +
      ` (starts ${this.alarm.starts}/stops ${this.alarm.stops}) · tornado-present ${present ? "YES" : "no"}`
    );
  }

  /** §2 — the multi-funnel readout: this round's funnel count + the
   *  through-building flag (so ~20% / ~30% is observable over rounds), each
   *  live funnel's path center, the nearest-funnel distance, the darkness ramp
   *  (== Atmosphere's danger, recomputed from the same feltIntensity formula),
   *  and the GLOBAL debris count vs cap — the "total debris ≤ cap with two
   *  funnels" assertion. */
  private tornadoReadout(): string {
    const t = this.tornado;
    const p = this.player.position;
    const centers =
      t.funnels.map((f) => `(${f.position.x.toFixed(0)},${f.position.z.toFixed(0)})`).join(" ") ||
      "-";
    const dist = t.funnels.length ? t.nearestFunnelDist(p.x, p.z) : Infinity;
    const darkness = t.feltIntensity(p.x, p.z, 150);
    const capOk = this.debris.active <= this.debris.budget ? "≤cap✓" : "OVER✗";
    return (
      `§2 funnels ${t.funnels.length}${t.funnelCount === 2 ? " (DOUBLE)" : ""}` +
      ` · through-bldg ${t.throughBuilding ? "YES" : "no"} · centers ${centers}` +
      ` · nearest ${dist === Infinity ? "-" : dist.toFixed(0) + "m"} · darkness ${darkness.toFixed(2)}` +
      ` · debris ${this.debris.active}/${this.debris.budget} ${capOk}`
    );
  }

  /** §2 — cast straight down from the player's feet (excluding the player's own
   *  capsule) and report the distance to the first solid. Standing on a floor
   *  it reads ~0; walking over an unclosed gap it spikes to the drop below. */
  private groundGapReadout(): string {
    const p = this.player.position;
    const feetY = p.y - GameConfig.player.height / 2;
    this.downRay.origin.x = p.x;
    this.downRay.origin.y = feetY + 0.1; // start just inside the capsule bottom
    this.downRay.origin.z = p.z;
    const hit = this.physics.world.castRay(
      this.downRay,
      60,
      true,
      undefined,
      undefined,
      this.player.collider,
    );
    const gap = hit ? Math.max(hit.timeOfImpact - 0.1, 0) : Infinity;
    return `ground below feet: ${gap === Infinity ? ">60" : gap.toFixed(2)} m (spikes over a gap)`;
  }

  /** §1 — house/hospital TRAVERSAL probe. Reports whether the player is being
   *  blocked (intended horizontal move ≫ achieved while grounded → a doorstep/
   *  ledge the autostep can't clear) and the live head clearance to the ceiling
   *  above the crown (ray up, excluding the player). Walk into a house door and
   *  up the stairs: "blocked" should stay low and "head" should stay positive
   *  (min tracks the tightest point of the climb). */
  private traversalReadout(): string {
    const p = this.player;
    const intended = p.dbgIntendedHoriz;
    const achieved = p.dbgAchievedHoriz;
    const blocked = intended > 1e-4 ? Math.max(0, 1 - achieved / intended) : 0;
    const stuck = p.isGrounded && intended > 0.005 && blocked > 0.6;

    // Head clearance: cast up from just below the crown to the first solid.
    this.upRay.origin.x = this.player.position.x;
    this.upRay.origin.y = p.capsuleTopY - 0.05;
    this.upRay.origin.z = this.player.position.z;
    const hit = this.physics.world.castRay(
      this.upRay,
      6,
      true,
      undefined,
      undefined,
      this.player.collider,
    );
    const head = hit ? Math.max(hit.timeOfImpact - 0.05, 0) : Infinity;
    if (p.isGrounded && head !== Infinity) this.minHeadroom = Math.min(this.minHeadroom, head);
    else if (!p.isGrounded) this.minHeadroom = Infinity; // airborne — restart the run
    const headStr = head === Infinity ? ">6" : head.toFixed(2);
    const minStr = this.minHeadroom === Infinity ? "-" : this.minHeadroom.toFixed(2);
    return (
      `§1 traversal: ${p.isGrounded ? "grounded" : "air"} · feet ${p.capsuleBottomY.toFixed(2)} crown ${p.capsuleTopY.toFixed(2)}` +
      ` · move want ${intended.toFixed(3)}/${achieved.toFixed(3)}m ${stuck ? "BLOCKED✗" : "ok"}` +
      ` · head ${headStr}m (min ${minStr}m)`
    );
  }

  /** §1 — per-floor stairwell-light mount target + current live state, per
   *  stair. Reads live: a floor's light should read ✓ until its flight/landing
   *  is torn out, then ✗ (never lingering lit in mid-air). */
  private stairReadout(): string {
    const lines: string[] = [];
    for (const stair of ["A", "B"] as const) {
      const cells = this.stairLights
        .filter((l) => l.stair === stair)
        .map(
          (l) => `f${l.floor}·${l.mount}${this.interiorLights.isLit(l.fixtureIndex) ? "✓" : "✗"}`,
        );
      lines.push(`stair ${stair}: ${cells.join("  ")}`);
    }
    return lines.join("\n");
  }
}
