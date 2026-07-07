import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GameConfig } from "../config/GameConfig";
import { MATERIALS, type BlockMaterialDef, type MaterialId } from "../level/Materials";
import type { Physics } from "../core/Physics";
import type { QualitySettings } from "../config/QualitySettings";
import type { WindField } from "./WindField";
import { applyWorldSpaceMap, getBlockTexture } from "./BlockTextures";

/**
 * Owns every loose dynamic block, under a hard budget (QualitySettings).
 *
 * Rendering: one pooled InstancedMesh per material, sized to the budget at
 * construction. A spawned block claims an instance slot; a despawned block
 * zero-scales it and returns it to the free list. Instance SLOTS are pooled;
 * rigid BODIES are created/removed per spawn — debris blocks vary in size,
 * so a pooled body's collider would have to be recreated anyway.
 *
 * Lifecycle per block: flying → (physics puts the body to sleep) settled →
 * linger a moment → fading (shrink) → despawned. When the budget is full,
 * the oldest settled block is evicted first so airborne debris — the part
 * the player actually sees — is preserved.
 *
 * While flying, each block gets quadratic wind drag from the WindField every
 * fixed step: that's what makes debris orbit the funnel and turn into
 * projectiles instead of just dropping.
 */

type DebrisState = "flying" | "settled" | "fading";

interface DebrisSlot {
  active: boolean;
  materialId: MaterialId;
  instanceId: number;
  mesh: THREE.InstancedMesh;
  body: RAPIER.RigidBody | null;
  size: THREE.Vector3;
  /** Mean face area (m²) — the "sail" the wind pushes against. */
  area: number;
  state: DebrisState;
  stateTime: number;
  spawnOrder: number; // monotonically increasing — for oldest-first eviction
  hasSplit: boolean; // a block may fracture at most once
}

export class DebrisManager {
  readonly budget: number;

  private readonly slots = new Map<MaterialId, DebrisSlot[]>();
  private readonly free = new Map<MaterialId, number[]>();
  private activeCount = 0;
  private spawnCounter = 0;

  // scratch
  private readonly mat4 = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly vec = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly windVec = new THREE.Vector3();
  private readonly forceVec = new THREE.Vector3();
  private readonly bodyVel = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private static readonly ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    quality: QualitySettings,
  ) {
    this.budget = quality.debrisBudget;

    const cube = new THREE.BoxGeometry(1, 1, 1);
    for (const id of Object.keys(MATERIALS) as MaterialId[]) {
      const def: BlockMaterialDef = MATERIALS[id];
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff, // base color lives in per-instance colors
        roughness: def.roughness,
        metalness: def.metalness,
        transparent: def.transparent ?? false,
        opacity: def.opacity ?? 1,
        depthWrite: !(def.transparent ?? false),
      });
      // Same world-space detail texture as the standing structures, so a
      // block keeps its surface when it tears free (see BlockTextures).
      const detail = getBlockTexture(id);
      if (detail) {
        material.map = detail;
        applyWorldSpaceMap(material);
      }
      const mesh = new THREE.InstancedMesh(cube, material, this.budget);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = def.castShadow ?? true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < this.budget; i++) {
        mesh.setMatrixAt(i, DebrisManager.ZERO_SCALE); // slots start hidden
      }
      scene.add(mesh);

      this.slots.set(
        id,
        Array.from({ length: this.budget }, (_, i): DebrisSlot => ({
          active: false,
          materialId: id,
          instanceId: i,
          mesh,
          body: null,
          size: new THREE.Vector3(1, 1, 1),
          area: 1,
          state: "flying",
          stateTime: 0,
          spawnOrder: 0,
          hasSplit: false,
        })),
      );
      this.free.set(id, Array.from({ length: this.budget }, (_, i) => i));
    }
  }

  /** Debug readout: currently active debris bodies (≤ budget). */
  get active(): number {
    return this.activeCount;
  }

  /** Hand a block over to the debris system as a dynamic rigid body. */
  spawn(
    materialId: MaterialId,
    center: THREE.Vector3,
    size: THREE.Vector3,
    linvel: THREE.Vector3,
    angvel: THREE.Vector3,
    hasSplit = false,
  ): void {
    // Enforce the global budget before claiming a slot.
    if (this.activeCount >= this.budget) {
      const victim = this.pickEviction(null);
      if (victim) this.despawn(victim);
    }
    const freeList = this.free.get(materialId)!;
    if (freeList.length === 0) {
      // This material's instance pool is exhausted — recycle its oldest.
      const victim = this.pickEviction(materialId);
      if (!victim) return; // shouldn't happen, but never crash the storm
      this.despawn(victim);
    }

    const instanceId = freeList.pop()!;
    const slot = this.slots.get(materialId)![instanceId];
    const def = MATERIALS[materialId];

    slot.body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setLinvel(linvel.x, linvel.y, linvel.z)
        .setAngvel({ x: angvel.x, y: angvel.y, z: angvel.z })
        .setLinearDamping(0.05)
        .setAngularDamping(0.3),
    );
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setDensity(def.density)
        // Contact-force events feed impact damage + crush detection (step 6).
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(2000),
      slot.body,
    );

    slot.active = true;
    slot.size.copy(size);
    slot.area = (size.x * size.y + size.y * size.z + size.z * size.x) / 3;
    slot.state = "flying";
    slot.stateTime = 0;
    slot.spawnOrder = this.spawnCounter++;
    slot.hasSplit = hasSplit;
    this.activeCount++;

    // Same deterministic brightness jitter as intact structure blocks, so a
    // block doesn't visibly change shade the moment it breaks free.
    const jitter = 0.88 + 0.24 * (((instanceId * 2654435761) >>> 0) % 1000) / 1000;
    this.color.setHex(def.color).multiplyScalar(jitter);
    slot.mesh.setColorAt(instanceId, this.color);
    if (slot.mesh.instanceColor) slot.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Quadratic wind drag on every active block — called once per FIXED step
   * (from Game's physics callback). This is what turns loose blocks into
   * orbiting projectiles. Blocks in weak wind are skipped so distant debris
   * can fall asleep and get evicted.
   */
  applyWindForces(windField: WindField, time: number, dt: number): void {
    for (const slots of this.slots.values()) {
      for (const slot of slots) {
        if (!slot.active || !slot.body) continue;
        const t = slot.body.translation();
        this.vec.set(t.x, t.y, t.z);
        windField.sample(this.windVec, this.vec, time);
        if (this.windVec.lengthSq() < GameConfig.wind.debrisMinWindSq) continue;

        const v = slot.body.linvel();
        this.bodyVel.set(v.x, v.y, v.z);
        windField.dragForce(
          this.forceVec,
          this.windVec,
          this.bodyVel,
          slot.area,
          GameConfig.wind.dragK,
        );
        // impulse = force × dt; `true` wakes the body — debris in real wind
        // should never sleep.
        this.forceVec.multiplyScalar(dt);
        slot.body.applyImpulse(this.forceVec, true);

        if (slot.state !== "flying") {
          slot.state = "flying"; // re-mobilized by the wind
          slot.stateTime = 0;
        }
      }
    }
  }

  /** Lifecycle: sleeping → settled → fading → despawn (+ fall-through safety). */
  update(dt: number): void {
    const cfg = GameConfig.debris;
    for (const slots of this.slots.values()) {
      for (const slot of slots) {
        if (!slot.active || !slot.body) continue;

        if (slot.body.translation().y < cfg.killY) {
          this.despawn(slot);
          continue;
        }

        switch (slot.state) {
          case "flying":
            if (slot.body.isSleeping()) {
              slot.state = "settled";
              slot.stateTime = 0;
            }
            break;
          case "settled":
            slot.stateTime += dt;
            if (slot.stateTime > cfg.settleLinger) {
              slot.state = "fading";
              slot.stateTime = 0;
            }
            break;
          case "fading":
            slot.stateTime += dt;
            if (slot.stateTime >= cfg.fadeTime) this.despawn(slot);
            break;
        }
      }
    }
  }

  /** Copy rigid-body transforms into instance matrices (after the physics step). */
  syncTransforms(): void {
    const touched = new Set<THREE.InstancedMesh>();
    for (const slots of this.slots.values()) {
      for (const slot of slots) {
        if (!slot.active || !slot.body) continue;
        const t = slot.body.translation();
        const r = slot.body.rotation();
        this.quat.set(r.x, r.y, r.z, r.w);
        // Fading blocks shrink to nothing instead of popping out.
        const f =
          slot.state === "fading"
            ? Math.max(1 - slot.stateTime / GameConfig.debris.fadeTime, 0.001)
            : 1;
        this.vec.copy(slot.size).multiplyScalar(f);
        this.pos.set(t.x, t.y, t.z);
        this.mat4.compose(this.pos, this.quat, this.vec);
        slot.mesh.setMatrixAt(slot.instanceId, this.mat4);
        touched.add(slot.mesh);
      }
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Iterate active airborne blocks (whoosh audio + damage, step 6/7). */
  forEachActive(cb: (body: RAPIER.RigidBody, area: number) => void): void {
    for (const slots of this.slots.values()) {
      for (const slot of slots) {
        if (slot.active && slot.body) cb(slot.body, slot.area);
      }
    }
  }

  /**
   * Choose which block to sacrifice when the budget is hit: prefer settled/
   * fading blocks (the player isn't watching them), oldest first; fall back
   * to the oldest flying block.
   */
  private pickEviction(materialId: MaterialId | null): DebrisSlot | null {
    let bestSettled: DebrisSlot | null = null;
    let bestAny: DebrisSlot | null = null;
    for (const [id, slots] of this.slots) {
      if (materialId !== null && id !== materialId) continue;
      for (const slot of slots) {
        if (!slot.active) continue;
        if (!bestAny || slot.spawnOrder < bestAny.spawnOrder) bestAny = slot;
        if (
          slot.state !== "flying" &&
          (!bestSettled || slot.spawnOrder < bestSettled.spawnOrder)
        ) {
          bestSettled = slot;
        }
      }
    }
    return bestSettled ?? bestAny;
  }

  private despawn(slot: DebrisSlot): void {
    if (slot.body) {
      this.physics.world.removeRigidBody(slot.body);
      slot.body = null;
    }
    slot.mesh.setMatrixAt(slot.instanceId, DebrisManager.ZERO_SCALE);
    slot.mesh.instanceMatrix.needsUpdate = true;
    slot.active = false;
    this.free.get(slot.materialId)!.push(slot.instanceId);
    this.activeCount--;
  }
}
