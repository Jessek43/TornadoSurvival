import RAPIER from "@dimforge/rapier3d-compat";
import { GameConfig } from "../config/GameConfig";

/**
 * Thin wrapper around the Rapier physics world.
 *
 * Rendering runs at whatever rate the display gives us (rAF), but physics
 * must step at a FIXED dt or behavior changes with frame rate — forces,
 * break thresholds, and body sleeping all assume a constant step. So we
 * accumulate frame time and run 0..N fixed steps per rendered frame: the
 * standard "fixed timestep with accumulator" pattern.
 */
export class Physics {
  readonly world: RAPIER.World;
  /** Drained each frame by DamageSystem for impact/crush detection. */
  readonly eventQueue: RAPIER.EventQueue;

  private accumulator = 0;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: GameConfig.physics.gravity, z: 0 });
    this.world.timestep = GameConfig.physics.fixedDt;
    this.eventQueue = new RAPIER.EventQueue(true);
  }

  /**
   * Advance physics by one rendered frame's worth of time. Returns the
   * number of fixed steps taken (usually 1 at 60fps). Catch-up is capped so
   * a long hitch slows the game down instead of spiraling — each extra step
   * costs CPU, which lengthens the frame, which demands more steps...
   *
   * `beforeStep` runs before EACH fixed step. Anything that feeds the
   * simulation — wind forces, the player's kinematic move — belongs there,
   * so it always sees the same constant dt as the solver.
   *
   * `afterStep` runs after EACH fixed step and must drain the event queue
   * (contact-force events for damage): the queue auto-clears on the next
   * step, so waiting until end-of-frame would drop events on multi-step
   * frames.
   */
  step(
    frameDt: number,
    beforeStep?: (fixedDt: number) => void,
    afterStep?: (fixedDt: number) => void,
  ): number {
    const { fixedDt, maxCatchUpSteps } = GameConfig.physics;
    this.accumulator += frameDt;

    let steps = 0;
    while (this.accumulator >= fixedDt && steps < maxCatchUpSteps) {
      beforeStep?.(fixedDt);
      this.world.step(this.eventQueue);
      afterStep?.(fixedDt);
      this.accumulator -= fixedDt;
      steps++;
    }

    // If we hit the cap, drop the leftover backlog — losing a little sim
    // time beats a death spiral.
    if (this.accumulator >= fixedDt) this.accumulator %= fixedDt;
    return steps;
  }
}
