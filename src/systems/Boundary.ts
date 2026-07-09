import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Physics } from "../core/Physics";
import { PlayArea } from "./PlayArea";
import { BOUNDARY_GROUPS } from "./CollisionGroups";

/**
 * The map edge, made hard and readable — the THREE/Rapier construction that
 * READS a pure PlayArea. Two things, built ONCE and never torn down:
 *
 *  - four static cuboid colliders (the invisible walls) on the BOUNDARY
 *    collision group, so the character controller resolves against them while
 *    debris/structures pass straight through (see CollisionGroups). The boundary
 *    is a collider the controller stops at — nothing clamps or teleports the
 *    player.
 *  - instanced, indestructible perimeter dressing (a treeline; added in a later
 *    step) so the edge is visible before it is felt.
 *
 * It lives in a PERMANENT scene group outside the session teardown subtree and
 * owns no Rapier bodies that restart touches, so its counts survive a restart by
 * construction. It is not a "manager": no registry, no lifecycle, no per-frame
 * update — geometry is derived from PlayArea at construction and left alone.
 */
export class Boundary {
  private readonly colliderHandles: number[] = [];
  /** Instanced perimeter props (built in a later step). */
  propCount = 0;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly physics: Physics,
    readonly playArea: PlayArea,
  ) {
    // One fixed body carrying all four wall colliders. BOUNDARY_GROUPS filters
    // only the PLAYER bit, so these stop the kinematic capsule and are invisible
    // to the solver for debris/structures/ragdoll.
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const seg of playArea.wallSegments()) {
      const collider = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(seg.halfExtents.x, seg.halfExtents.y, seg.halfExtents.z)
          .setTranslation(seg.center.x, seg.center.y, seg.center.z)
          .setCollisionGroups(BOUNDARY_GROUPS),
        body,
      );
      this.colliderHandles.push(collider.handle);
    }
    void this.parent; // dressing (a later step) parents its instanced meshes here
  }

  get colliderCount(): number {
    return this.colliderHandles.length;
  }

  /** Boundary colliders still present in the physics world — the restart-parity
   *  number. They live outside the teardown subtree, so this must always read
   *  == colliderCount, before and after any restart / return-to-menu. */
  liveColliderCount(): number {
    let n = 0;
    for (const h of this.colliderHandles) if (this.physics.world.getCollider(h)) n++;
    return n;
  }
}
