import * as THREE from "three";
import GUI from "lil-gui";
import { GameConfig } from "../config/GameConfig";
import { MATERIALS } from "../level/Materials";
import type { WindField } from "../systems/WindField";
import type { TornadoSystem } from "../systems/TornadoSystem";
import type { PlayerController } from "../systems/PlayerController";

const PATH_CAPACITY = 2000; // ≈10 min of breadcrumbs at 0.3 s intervals

/**
 * Developer overlay, enabled with ?debug in the URL:
 *  - FPS meter
 *  - a live wind arrow at the player (direction + magnitude of the field)
 *  - a breadcrumb line tracing the tornado's path
 *  - a lil-gui panel that mutates GameConfig / MATERIALS live for balancing
 */
export class DebugTools {
  static enabled(): boolean {
    return new URLSearchParams(location.search).has("debug");
  }

  private readonly label: HTMLDivElement;
  private smoothedFps = 60;

  private readonly windArrow: THREE.ArrowHelper;
  private readonly pathLine: THREE.Line;
  private readonly pathPositions: Float32Array;
  private pathCount = 0;
  private pathTimer = 0;
  private time = 0;

  // scratch
  private readonly wind = new THREE.Vector3();
  private readonly arrowOrigin = new THREE.Vector3();

  constructor(
    uiRoot: HTMLElement,
    scene: THREE.Scene,
    private readonly windField: WindField,
    private readonly tornado: TornadoSystem,
    private readonly player: PlayerController,
  ) {
    this.label = document.createElement("div");
    this.label.style.cssText =
      "position:absolute;top:8px;left:8px;color:#9f9;font:12px monospace;" +
      "background:rgba(0,0,0,.5);padding:2px 6px;border-radius:3px;";
    uiRoot.appendChild(this.label);

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
    this.label.textContent =
      `${this.smoothedFps.toFixed(0)} fps · tornado ` +
      (this.tornado.active
        ? `${this.tornado.position.distanceTo(this.player.position).toFixed(0)}m @ ${(
            this.tornado.intensity * 100
          ).toFixed(0)}%`
        : "idle");

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
  }
}
