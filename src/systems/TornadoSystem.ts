import * as THREE from "three";
import { GameConfig } from "../config/GameConfig";
import type { Noise } from "../core/Noise";

/**
 * Tornado lifecycle: a round is 2–3 bounded PASSES separated by calm GAPS.
 *
 * The old design was one continuous stalk of the player for the whole round,
 * which — over minutes — drifted near every side of the building and so gutted
 * everything, just spread over time. Bounding the tornado into short straight
 * passes bounds each section's exposure, so the existing per-section
 * partial-destruction "just works": only wings a pass travels near take
 * damage, and the far side survives.
 *
 * A pass: spawn on a circle of `passRadius` around the hospital, travel a
 * straight line (+ lateral noise wobble) aimed at the hospital center offset
 * SIDEWAYS by a random amount — so each pass can score a direct hit, graze an
 * edge, or miss entirely, preserving the "which side is safe" guess per pass.
 * Intensity ramps up as the funnel forms, holds, then ramps down as it
 * dissipates at the far edge → a calm gap (wind dies, funnel gone, sirens
 * quiet — the "did it leave, or circle back?" tension) → the next pass.
 *
 * `intensity` is the funnel's own strength (how developed it is), NOT its
 * proximity — a full-strength funnel passing far away still LOOKS like a
 * tornado; the damage falloff with distance is the WindField's job.
 */
export type TornadoState = "idle" | "pass" | "gap" | "done";
export type TornadoPhase = "idle" | "incoming" | "receding" | "clear" | "done";

export class TornadoSystem {
  /** Funnel center on the ground plane. Parked far away between passes. */
  readonly position = new THREE.Vector3(9999, 0, 9999);
  /** 0 = calm, 1 = full strength. Scales the wind field, funnel, and audio. */
  intensity = 0;
  state: TornadoState = "idle";

  passesTotal = 0;
  passIndex = 0;

  // Current pass geometry (2D on the ground plane).
  private readonly spawnPos = new THREE.Vector2();
  private readonly heading = new THREE.Vector2(0, 1);
  private readonly perp = new THREE.Vector2(1, 0);
  private travelLen = 0;
  private traveled = 0;
  private passAge = 0;
  private gapTimer = 0;

  constructor(private readonly noise: Noise) {}

  /** True while a pass's wind field is up (structures/audio gate on this). */
  get active(): boolean {
    return this.state === "pass";
  }

  /** Coarse phase for the HUD. */
  get phase(): TornadoPhase {
    if (this.state === "idle") return "idle";
    if (this.state === "done") return "done";
    if (this.state === "gap") return "clear";
    // In a pass: receding once we're past the ramp-out point.
    const total = this.travelLen / GameConfig.tornado.moveSpeed;
    return this.passAge > total - GameConfig.tornado.passRampOut ? "receding" : "incoming";
  }

  /** Begin the round's pass sequence. */
  begin(): void {
    const cfg = GameConfig.tornado;
    this.passesTotal =
      cfg.passCountMin +
      Math.floor(Math.random() * (cfg.passCountMax - cfg.passCountMin + 1));
    this.passIndex = 0;
    this.startPass();
  }

  update(dt: number): void {
    const cfg = GameConfig.tornado;

    if (this.state === "gap") {
      this.gapTimer -= dt;
      if (this.gapTimer <= 0) {
        this.passIndex++;
        if (this.passIndex >= this.passesTotal) {
          this.state = "done";
          this.intensity = 0;
          this.position.set(9999, 0, 9999);
        } else {
          this.startPass();
        }
      }
      return;
    }

    if (this.state !== "pass") return;

    // --- advance along the straight path, with a small lateral wobble ---
    this.passAge += dt;
    const step = cfg.moveSpeed * dt;
    this.traveled += step;
    this.position.x += this.heading.x * step;
    this.position.z += this.heading.y * step;
    // Lateral simplex wobble so the path isn't a ruler-straight line.
    const wob = this.noise.noise1(this.passAge * 0.5, 3) * cfg.lateralJitter * dt;
    this.position.x += this.perp.x * wob;
    this.position.z += this.perp.y * wob;

    // --- intensity envelope: form (ramp in) → hold → dissipate (ramp out) ---
    const total = this.travelLen / cfg.moveSpeed;
    if (this.passAge < cfg.passRampIn) {
      this.intensity = this.passAge / cfg.passRampIn;
    } else if (this.passAge > total - cfg.passRampOut) {
      this.intensity = Math.max(0, (total - this.passAge) / cfg.passRampOut);
    } else {
      this.intensity = 1;
    }

    // --- exit: the funnel has crossed and left the play area ---
    if (this.traveled >= this.travelLen) {
      this.state = "gap";
      this.gapTimer = cfg.gapDuration;
      this.intensity = 0;
      this.position.set(9999, 0, 9999);
    }
  }

  private startPass(): void {
    const cfg = GameConfig.tornado;
    const c = GameConfig.hospitalCenter;

    // Spawn somewhere on a circle around the hospital.
    const spawnAngle = Math.random() * Math.PI * 2;
    this.spawnPos.set(
      c.x + Math.cos(spawnAngle) * cfg.passRadius,
      c.z + Math.sin(spawnAngle) * cfg.passRadius,
    );

    // Direction from spawn toward the hospital center, and its perpendicular.
    const toCenter = new THREE.Vector2(c.x - this.spawnPos.x, c.z - this.spawnPos.y).normalize();
    this.perp.set(-toCenter.y, toCenter.x);

    // Lateral offset with a MINIMUM standoff, random side: the funnel core
    // always passes ≥ lateralOffsetMin from center (grazing one side), so the
    // opposite wings survive — a single pass is partial by construction. The
    // side and magnitude are random each pass, keeping the "which side is
    // safe" gamble.
    const sign = Math.random() < 0.5 ? -1 : 1;
    const off =
      sign * (cfg.lateralOffsetMin + Math.random() * (cfg.lateralOffsetMax - cfg.lateralOffsetMin));

    // Aim at center + sideways offset; head straight for it.
    const aimX = c.x + this.perp.x * off;
    const aimZ = c.z + this.perp.y * off;
    this.heading.set(aimX - this.spawnPos.x, aimZ - this.spawnPos.y).normalize();
    // Recompute perp from the actual heading (for the wobble axis).
    this.perp.set(-this.heading.y, this.heading.x);

    // Travel far enough to cross the play area and exit the far side.
    this.travelLen = cfg.passRadius * 2;
    this.traveled = 0;
    this.passAge = 0;
    this.intensity = 0;
    this.position.set(this.spawnPos.x, 0, this.spawnPos.y);
    this.state = "pass";
  }
}
