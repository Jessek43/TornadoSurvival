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
 * straight line (+ lateral noise wobble + a slower per-pass meander) aimed at
 * the hospital center offset SIDEWAYS by a random amount — so each pass can
 * score a direct hit, graze an edge, or miss entirely, preserving the "which
 * side is safe" guess per pass. Intensity ramps up as the funnel forms, holds,
 * then ramps down as it dissipates at the far edge → a calm gap → the next
 * pass.
 *
 * §2 MULTI-FUNNEL: a round rolls, once, for a second concurrent funnel (20%)
 * and for a path that tracks THROUGH the footprint rather than skirting it
 * (30%). Each funnel is an independent `Funnel` (own path, offset, meander
 * seed); everything downstream reads the `funnels` array — the WindField sums
 * all of them (so a block/player between two funnels feels both), and
 * structures/audio/atmosphere react to the NEAREST funnel. The DebrisManager
 * budget is a single global pool, so "total active debris ≤ the global cap"
 * holds across any number of funnels by construction.
 *
 * `position`/`intensity` are kept in sync with the PRIMARY (funnel 0) as a
 * single representative for the HUD, breadcrumb, and siren; consumers that must
 * react to every funnel iterate `funnels` (or the `nearestFunnelDist` /
 * `feltIntensity` helpers) instead.
 *
 * A funnel's `intensity` is how developed it is, NOT its proximity — a
 * full-strength funnel passing far away still LOOKS like a tornado; the damage
 * falloff with distance is the WindField's job.
 */
export type TornadoState = "idle" | "pass" | "gap" | "done";
export type TornadoPhase = "idle" | "incoming" | "receding" | "clear" | "done";

/** One funnel core travelling one straight-ish pass. Pooled and reused across
 *  passes (see `pool`) so a pass transition allocates nothing. */
export class Funnel {
  /** Funnel center on the ground plane. */
  readonly position = new THREE.Vector3(9999, 0, 9999);
  /** 0 = calm, 1 = full strength. */
  intensity = 0;

  // Current pass geometry (2D on the ground plane).
  readonly spawnPos = new THREE.Vector2();
  readonly heading = new THREE.Vector2(0, 1);
  readonly perp = new THREE.Vector2(1, 0);
  travelLen = 0;
  traveled = 0;
  passAge = 0;
  /** Noise channel — independent wobble/meander per funnel and per pass. */
  seed = 0;
}

export class TornadoSystem {
  /** Live funnels this pass (empty between passes). 1 normally, 2 on a double. */
  readonly funnels: Funnel[] = [];
  /** Pooled funnel bodies (reused so a pass transition never allocates). */
  private readonly pool: Funnel[] = [];

  /** Primary funnel center (HUD path-center readout, debug breadcrumb). Parked
   *  far away between passes. Consumers that must react to BOTH funnels use
   *  `funnels` / `nearestFunnelDist` / `feltIntensity`. */
  readonly position = new THREE.Vector3(9999, 0, 9999);
  /** Strongest funnel intensity (siren + "is a pass live" reads). */
  intensity = 0;
  state: TornadoState = "idle";

  passesTotal = 0;
  passIndex = 0;

  // --- per-round rolls (decided in begin(); surfaced in the ?debug HUD) ---
  /** 1 normally, 2 when the double-tornado roll hits (§2a). */
  funnelCount = 1;
  /** True when this round's passes track THROUGH the footprint (§2b). */
  throughBuilding = false;

  private travelLen = 0; // pass length (shared: passRadius·2)
  private gapTimer = 0;

  // scratch (avoid per-pass allocation)
  private readonly toCenter = new THREE.Vector2();

  constructor(private readonly noise: Noise) {
    const max = GameConfig.tornado.maxFunnels;
    for (let i = 0; i < max; i++) this.pool.push(new Funnel());
  }

  /** True while a pass's wind field is up (structures/audio gate on this). */
  get active(): boolean {
    return this.state === "pass";
  }

  /** Coarse phase for the HUD (driven by the primary funnel; all funnels share
   *  the same pass clock). */
  get phase(): TornadoPhase {
    if (this.state === "idle") return "idle";
    if (this.state === "done") return "done";
    if (this.state === "gap") return "clear";
    const f = this.funnels[0];
    const total = this.travelLen / GameConfig.tornado.moveSpeed;
    return f && f.passAge > total - GameConfig.tornado.passRampOut ? "receding" : "incoming";
  }

  /** Min horizontal distance from (x, z) to any live funnel core (Infinity if
   *  no pass is up). Structures wake/sleep on the NEAREST funnel, so a second
   *  funnel wakes its own neighborhood independently of the first. */
  nearestFunnelDist(x: number, z: number): number {
    let best = Infinity;
    for (const f of this.funnels) {
      const d = Math.hypot(x - f.position.x, z - f.position.z);
      if (d < best) best = d;
    }
    return best;
  }

  /** Nearest-funnel "felt" strength at (x, z): the max over funnels of
   *  intensity·(1 − dist/range), clamped ≥ 0. Audio + atmosphere key their
   *  dread ramps off this, so a second funnel drives them on its own. */
  feltIntensity(x: number, z: number, range: number): number {
    let m = 0;
    for (const f of this.funnels) {
      if (f.intensity <= 0) continue;
      const d = Math.hypot(x - f.position.x, z - f.position.z);
      const v = f.intensity * Math.max(0, 1 - d / range);
      if (v > m) m = v;
    }
    return m;
  }

  /** Begin the round's pass sequence. Rolls the per-round double-funnel and
   *  through-building flags ONCE here so ~20% / ~30% is observable over rounds. */
  begin(): void {
    const cfg = GameConfig.tornado;
    this.passesTotal =
      cfg.passCountMin + Math.floor(Math.random() * (cfg.passCountMax - cfg.passCountMin + 1));
    this.passIndex = 0;
    this.funnelCount = Math.random() < cfg.doubleTornadoChance ? 2 : 1;
    this.funnelCount = Math.min(this.funnelCount, cfg.maxFunnels);
    this.throughBuilding = Math.random() < cfg.throughBuildingChance;
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
          this.endPass();
        } else {
          this.startPass();
        }
      }
      return;
    }

    if (this.state !== "pass") return;

    let anyTraveling = false;
    let maxIntensity = 0;
    for (const f of this.funnels) {
      // --- advance along the straight path, with wobble + a slow meander ---
      f.passAge += dt;
      const step = cfg.moveSpeed * dt;
      f.traveled += step;
      f.position.x += f.heading.x * step;
      f.position.z += f.heading.y * step;
      // Fast lateral simplex wobble + a slower per-pass meander (§2c). Both key
      // off this funnel's own noise channel, so two funnels never wobble alike.
      const wob = this.noise.noise1(f.passAge * 0.5, f.seed) * cfg.lateralJitter;
      const curve = this.noise.noise1(f.passAge * cfg.pathCurveFreq, f.seed + 3) * cfg.pathCurveAmp;
      f.position.x += f.perp.x * (wob + curve) * dt;
      f.position.z += f.perp.y * (wob + curve) * dt;

      // --- intensity envelope: form (ramp in) → hold → dissipate (ramp out) ---
      const total = f.travelLen / cfg.moveSpeed;
      if (f.passAge < cfg.passRampIn) {
        f.intensity = f.passAge / cfg.passRampIn;
      } else if (f.passAge > total - cfg.passRampOut) {
        f.intensity = Math.max(0, (total - f.passAge) / cfg.passRampOut);
      } else {
        f.intensity = 1;
      }

      if (f.traveled < f.travelLen) anyTraveling = true;
      if (f.intensity > maxIntensity) maxIntensity = f.intensity;
    }

    // Sync the single representative used by the HUD / siren / breadcrumb.
    if (this.funnels.length > 0) this.position.copy(this.funnels[0].position);
    this.intensity = maxIntensity;

    // --- exit: every funnel has crossed and left the play area → calm gap ---
    if (!anyTraveling) {
      this.state = "gap";
      this.gapTimer = cfg.gapDuration;
      this.endPass();
    }
  }

  /** Park the funnels off-map and clear the live list (gap / done). */
  private endPass(): void {
    this.intensity = 0;
    this.position.set(9999, 0, 9999);
    this.funnels.length = 0;
  }

  private startPass(): void {
    const cfg = GameConfig.tornado;
    const c = GameConfig.hospitalCenter;

    this.travelLen = cfg.passRadius * 2;
    this.funnels.length = 0;

    // First funnel spawns anywhere on the circle; each additional funnel is
    // forced onto a DIFFERENT arc (≥120° away, wrapping) so a double never
    // spawns two cores on top of each other — they always approach from
    // distinct sides and cross the map on visibly separate routes (§2a).
    const baseAngle = Math.random() * Math.PI * 2;
    for (let k = 0; k < this.funnelCount; k++) {
      const f = this.pool[k];
      // Independent noise channel per funnel AND per pass (so the same funnel
      // doesn't repeat its meander pass to pass).
      f.seed = this.passIndex * 13 + k * 101 + 7;

      // Spawn on the circle: funnel 0 anywhere, later funnels ≥120° offset.
      const spawnAngle =
        k === 0
          ? baseAngle
          : baseAngle + ((2 * Math.PI) / 3) * k + Math.random() * ((2 * Math.PI) / 3);
      f.spawnPos.set(
        c.x + Math.cos(spawnAngle) * cfg.passRadius,
        c.z + Math.sin(spawnAngle) * cfg.passRadius,
      );

      // Direction from spawn toward the hospital center, and its perpendicular.
      this.toCenter.set(c.x - f.spawnPos.x, c.z - f.spawnPos.y).normalize();
      f.perp.set(-this.toCenter.y, this.toCenter.x);

      // Lateral aim offset. THROUGH-building (§2b): a small offset so the core
      // crosses the footprint. Otherwise a min-standoff skirt (§2c widened) that
      // grazes one side and spares the far wings. Side + magnitude random.
      const sign = Math.random() < 0.5 ? -1 : 1;
      const off = this.throughBuilding
        ? sign * Math.random() * cfg.throughOffsetMax
        : sign *
          (cfg.lateralOffsetMin + Math.random() * (cfg.lateralOffsetMax - cfg.lateralOffsetMin));

      // Aim at center + sideways offset; head straight for it.
      const aimX = c.x + f.perp.x * off;
      const aimZ = c.z + f.perp.y * off;
      f.heading.set(aimX - f.spawnPos.x, aimZ - f.spawnPos.y).normalize();
      // Recompute perp from the actual heading (for the wobble/meander axis).
      f.perp.set(-f.heading.y, f.heading.x);

      f.travelLen = this.travelLen;
      f.traveled = 0;
      f.passAge = 0;
      f.intensity = 0;
      f.position.set(f.spawnPos.x, 0, f.spawnPos.y);
      this.funnels.push(f);
    }
    this.intensity = 0;
    this.position.copy(this.funnels[0].position);
    this.state = "pass";
  }
}
