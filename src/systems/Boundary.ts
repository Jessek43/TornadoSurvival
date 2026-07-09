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
  /** Count of instanced perimeter props (one tree per dressing slot). */
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

    this.buildDressing();
  }

  /**
   * Instanced, INDESTRUCTIBLE treeline just inside the edge — the band that
   * makes the boundary visible before it is felt. One InstancedMesh per prop
   * part (trunk + canopy = 2 draw calls) parented to the permanent group. These
   * are static scenery: NOT section blocks, NOT registered with any dressing
   * binder, NOT bound to a host block, NOT part of the fracture pipeline — so the
   * hospital `dressing:` count is untouched. Built once from PlayArea.dressingSlots.
   */
  private buildDressing(): void {
    const slots = this.playArea.dressingSlots();
    // Base tree (unit scale): a stubby trunk with a conifer cone, kept well under
    // the wall height so the wall stays the hard stop while the treeline reads.
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.36, 3, 6);
    const canopyGeo = new THREE.ConeGeometry(2.2, 5.5, 7);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3f3326, roughness: 0.95 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2f4a2c, roughness: 0.9 });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, slots.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, slots.length);
    for (const m of [trunks, canopies]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false; // the ring spans the whole map — cull as one draw call
    }

    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const scale = s.scale;
      quat.setFromEuler(euler.set(0, s.rotationY, 0));
      scl.set(scale, scale, scale);
      // Trunk: geo is centred, so lift its centre to (height/2)*scale to sit on ground.
      mat4.compose(pos.set(s.x, 1.5 * scale, s.z), quat, scl);
      trunks.setMatrixAt(i, mat4);
      // Canopy: base meets the trunk top (3*scale); cone centre is base + 5.5/2.
      mat4.compose(pos.set(s.x, 5.75 * scale, s.z), quat, scl);
      canopies.setMatrixAt(i, mat4);
      // Deterministic per-tree shade jitter so the row doesn't read as one clone.
      const j = 0.85 + 0.3 * (((i * 2654435761) >>> 0) % 1000) / 1000;
      canopies.setColorAt(i, color.setHex(0x2f4a2c).multiplyScalar(j));
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;

    this.parent.add(trunks, canopies);
    this.propCount = slots.length;
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
