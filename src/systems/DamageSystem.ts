import { GameConfig } from "../config/GameConfig";
import type { Physics } from "../core/Physics";

/**
 * Player health.
 *
 * Damage sources:
 *  - Debris impacts / crushes while on foot: Rapier CONTACT-FORCE events.
 *    Debris colliders emit an event whenever a contact pushes harder than
 *    their threshold; we drain those after every fixed step and count the
 *    ones involving the player's collider. A fast plank and a slowly
 *    settling concrete roof both show up here — the force magnitude is the
 *    common currency for "hit" and "crushed".
 *  - Fling landings & mid-air hits while ragdolled: PlayerController
 *    measures sudden velocity changes of the ragdoll body and reports them
 *    via takeDamage() directly (no event plumbing needed there).
 *  - Hard landings on foot: PlayerController reports those too.
 */
export class DamageSystem {
  health = 100;

  get dead(): boolean {
    return this.health <= 0;
  }

  takeDamage(amount: number, _source: "fall" | "impact" | "crush"): void {
    if (amount <= 0 || this.dead) return;
    this.health = Math.max(0, this.health - amount);
  }

  /**
   * Called after every fixed physics step (see Physics.step). `colliderHandle`
   * is the player's currently-hittable collider — or -1 while ragdolled,
   * because ragdoll damage is measured by velocity change instead (counting
   * both would double-bill the same hit).
   */
  drainContactEvents(physics: Physics, colliderHandle: number): void {
    const cfg = GameConfig.damage;
    physics.eventQueue.drainContactForceEvents((event) => {
      if (colliderHandle === -1) return;
      if (event.collider1() !== colliderHandle && event.collider2() !== colliderHandle) return;
      const force = event.totalForceMagnitude();
      if (force <= cfg.crushForceThreshold) return;
      this.takeDamage(
        Math.min((force - cfg.crushForceThreshold) / cfg.crushDamageDivisor, cfg.maxCrushHit),
        "crush",
      );
    });
  }

  update(_dt: number): void {
    // Nothing periodic yet — death handling lives in the round loop (step 8).
  }

  reset(): void {
    this.health = 100;
  }
}
