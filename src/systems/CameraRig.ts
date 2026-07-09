import * as THREE from "three";
import { GameConfig } from "../config/GameConfig";
import type { Noise } from "../core/Noise";
import type { PlayerController } from "./PlayerController";
import type { WindField } from "./WindField";

/**
 * Owns the camera. Two modes, switched by the player's physical state:
 *
 *  FIRST_PERSON — glued to the player's eyes with standard no-roll FPS
 *  rotation ("YXZ": yaw around world-up first, then pitch).
 *
 *  CHASE (the "fling cam") — the moment the player ragdolls we CUT (no
 *  blend) to a third-person view that spring-follows the tumbling body, so
 *  you watch yourself slam into the ground. On recovery we cut straight
 *  back to first person. The chase camera keeps whatever side of the body
 *  it's already on (rather than chasing behind the velocity vector) so it
 *  doesn't whip around while the body tumbles.
 *
 * SCREEN SHAKE: noise-driven rotation offsets applied on top of either
 * mode, scaled by (a) the wind pressure at the player — the storm is felt
 * before it's survivable — and (b) short impulses fed in by Game for
 * lightning strikes and damage hits.
 */
export class CameraRig {
  private mode: "first" | "chase" = "first";
  private impulse = 0;

  // scratch
  private readonly eye = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly wind = new THREE.Vector3();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly player: PlayerController,
    private readonly windField: WindField,
    private readonly noise: Noise,
  ) {}

  /** Kick the camera (lightning, taking a hit). Strength ~0..1. */
  addImpulse(strength: number): void {
    this.impulse = Math.min(this.impulse + strength, 1.5);
  }

  /** Drop back to first-person with no residual shake (restart parity). */
  reset(): void {
    this.mode = "first";
    this.impulse = 0;
  }

  update(dt: number, time: number): void {
    const cfg = GameConfig.camera;

    if (this.player.isRagdoll) {
      this.target.copy(this.player.position);

      // Keep the camera on its current side of the body, at a fixed
      // distance and height — stable while the body spins.
      this.toCamera.copy(this.camera.position).sub(this.target);
      this.toCamera.y = 0;
      if (this.toCamera.lengthSq() < 0.01) this.toCamera.set(0, 0, 1);
      this.toCamera.normalize();
      this.desired.copy(this.target).addScaledVector(this.toCamera, cfg.chaseDistance);
      this.desired.y += cfg.chaseHeight;

      if (this.mode !== "chase") {
        // Hard CUT into the fling cam — the jolt is the point.
        this.mode = "chase";
        this.camera.position.copy(this.desired);
      } else {
        // Frame-rate-independent spring toward the desired offset.
        this.camera.position.lerp(this.desired, 1 - Math.exp(-cfg.chaseLerp * dt));
      }
      this.camera.lookAt(this.target);
      this.applyShake(dt, time, 0.4); // gentler while third-person
      return;
    }

    // FIRST_PERSON (an instant cut back — position is set absolutely).
    this.mode = "first";
    this.player.getEyePosition(this.eye);
    this.camera.position.copy(this.eye);
    this.camera.rotation.set(this.player.pitch, this.player.yaw, 0, "YXZ");
    this.applyShake(dt, time, 1);
  }

  /** Rotational shake on top of the base transform. */
  private applyShake(dt: number, time: number, scale: number): void {
    this.impulse *= Math.exp(-5 * dt);

    this.windField.sample(this.wind, this.player.position, time);
    const windAmp = Math.min(this.wind.lengthSq() / GameConfig.player.sweepPressure, 1.2) * 0.028;
    const amp = (windAmp + this.impulse * 0.05) * scale;
    if (amp < 0.0005) return;

    // Three independent noise streams — jitter, not oscillation.
    this.camera.rotation.x += this.noise.noise1(time * 9.0, 11) * amp;
    this.camera.rotation.y += this.noise.noise1(time * 8.3, 12) * amp;
    this.camera.rotation.z += this.noise.noise1(time * 7.1, 13) * amp * 0.6;
  }
}
