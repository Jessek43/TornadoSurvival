import * as THREE from "three";
import { GameConfig } from "../config/GameConfig";

/**
 * Player flashlight — a head-mounted SpotLight the player toggles with F to
 * cut through the storm-dark hospital. Each frame it's glued to the camera:
 * positioned at the eye and aimed along the view direction, so it inherits
 * look and camera shake for free.
 *
 * Performance notes (this is a light in a 60 fps budget):
 *  - NO shadow map. A shadow-casting spot is a whole extra depth pass every
 *    frame; the interior reads fine as an unshadowed cone against the dark.
 *  - It stays in the scene at all times and toggles via INTENSITY, not
 *    `visible`. Removing a light (or hiding it) changes the shader's light
 *    counts and forces a material recompile — toggling `visible` would hitch
 *    on every press. Intensity 0 costs one idle spotlight term and never
 *    recompiles. One extra light, O(1) in world size.
 */
export class Flashlight {
  private readonly light: THREE.SpotLight;
  private readonly target: THREE.Object3D;
  private on = false;
  private readonly dir = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const cfg = GameConfig.flashlight;
    this.light = new THREE.SpotLight(
      cfg.color,
      0, // start off
      cfg.distance,
      cfg.angle,
      cfg.penumbra,
      cfg.decay,
    );
    this.light.castShadow = false;
    scene.add(this.light);
    // The spot aims at its target's world position; keep a dedicated node we
    // reposition each frame (also in the scene so its matrix updates on render).
    this.target = new THREE.Object3D();
    scene.add(this.target);
    this.light.target = this.target;
  }

  get isOn(): boolean {
    return this.on;
  }

  toggle(): void {
    this.on = !this.on;
    this.light.intensity = this.on ? GameConfig.flashlight.intensity : 0;
  }

  /** Per-frame: ride the camera. Cheap-outs when off. */
  update(camera: THREE.PerspectiveCamera): void {
    if (!this.on) return;
    const cfg = GameConfig.flashlight;
    // Re-read the tunables so the ?debug panel can adjust the beam live.
    this.light.intensity = cfg.intensity;
    this.light.distance = cfg.distance;
    this.light.angle = cfg.angle;
    this.light.penumbra = cfg.penumbra;
    this.light.decay = cfg.decay;

    camera.getWorldPosition(this.light.position);
    camera.getWorldDirection(this.dir);
    this.target.position.copy(this.light.position).add(this.dir);
  }
}
