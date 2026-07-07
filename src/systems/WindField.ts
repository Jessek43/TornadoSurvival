import * as THREE from "three";
import { GameConfig } from "../config/GameConfig";
import type { Noise } from "../core/Noise";
import type { TornadoSystem } from "./TornadoSystem";

/**
 * THE wind force field — the one system everything else reads.
 *
 * sample(pos, t) returns a wind VELOCITY vector built from a Rankine-vortex
 * profile around the funnel center. The Rankine model is the standard
 * simple tornado approximation:
 *
 *   swirl speed(d) = Vmax · d/R            inside the core   (d < R)
 *                  = Vmax · (R/d)^α        outside the core  (d ≥ R)
 *
 * i.e. the air rotates like a solid disc inside the core radius R and the
 * swirl decays with distance outside it (α tunes how local the danger is).
 * On top of the swirl we add:
 *   - radial INFLOW proportional to local swirl (zero at the center, peak
 *     at the core edge) — this is what drags loose things toward the funnel
 *   - an UPDRAFT that peaks at the center and fades by ~1.6R — this is what
 *     lifts players and debris
 *   - a simplex GUST multiplier so tearing is non-uniform and organic
 *   - a vertical fade above ~80% of funnel height so flung debris stops
 *     accelerating once it's above the storm
 *
 * Consumers:
 *   StructureSystem  — compares |wind|² ("dynamic pressure") to thresholds
 *   PlayerController — knockback / lift / sweep-off-feet decisions
 *   DebrisManager    — dragForce() on every active debris body
 */
export class WindField {
  constructor(
    private readonly tornado: TornadoSystem,
    private readonly noise: Noise,
  ) {}

  /** Wind velocity (m/s) at a world position. Zero when no tornado is up.
   *
   *  MULTI-FUNNEL (§2a): the field is the linear SUPERPOSITION of every live
   *  funnel's Rankine vortex — a point between two funnels feels both, so
   *  breakage/lift there is genuinely worse. The gust and height-fade are
   *  position-based, so they modulate the summed field once (not per funnel).
   *  Cost scales with the funnel count (1–2), all still off the single
   *  `tornado.funnels` source of truth. */
  sample(out: THREE.Vector3, pos: THREE.Vector3, time: number): THREE.Vector3 {
    out.set(0, 0, 0);
    const t = this.tornado;
    if (t.funnels.length === 0) return out;

    const cfg = GameConfig.tornado;
    const R = cfg.coreRadius;

    for (const funnel of t.funnels) {
      if (funnel.intensity <= 0) continue;
      const dx = pos.x - funnel.position.x;
      const dz = pos.z - funnel.position.z;
      const d = Math.max(Math.hypot(dx, dz), 0.001);

      // Rankine profile (see class comment).
      const profile = d < R ? d / R : Math.pow(R / d, cfg.falloffExp);
      const swirl = cfg.maxTangential * funnel.intensity * profile;
      const inflow = -cfg.inflowFactor * swirl; // negative = toward the funnel
      const updraft =
        cfg.updraftSpeed * funnel.intensity * Math.max(0, 1 - d / (cfg.updraftRadius * R));

      // Unit vectors on the ground plane: radial (outward) and tangential
      // (counter-clockwise seen from above — northern-hemisphere spin).
      const rx = dx / d;
      const rz = dz / d;

      out.x += -rz * swirl + rx * inflow;
      out.y += updraft;
      out.z += rx * swirl + rz * inflow;
    }

    // Gusts: one smooth noise field over space+time, ±gustAmp around 1.
    const gust =
      1 +
      cfg.gustAmp *
        this.noise.noise3(pos.x * cfg.gustScale, pos.z * cfg.gustScale, time * cfg.gustSpeed);

    // Above the storm the wind lets go — fade from 80% to 120% of height.
    const hFade = THREE.MathUtils.clamp(
      1 - (pos.y - cfg.height * 0.8) / (cfg.height * 0.4),
      0,
      1,
    );

    return out.multiplyScalar(gust * hFade);
  }

  /**
   * Quadratic drag: a force that pushes a body's velocity toward the local
   * wind velocity, growing with the square of the difference —
   *   F = k · area · |w − v| · (w − v)
   * This is the standard aerodynamic drag shape; it's stable because the
   * force shrinks to zero as the body reaches wind speed.
   */
  dragForce(
    out: THREE.Vector3,
    wind: THREE.Vector3,
    bodyVel: THREE.Vector3,
    area: number,
    k = 1,
  ): THREE.Vector3 {
    const rel = out.copy(wind).sub(bodyVel);
    return rel.multiplyScalar(k * area * rel.length());
  }
}
