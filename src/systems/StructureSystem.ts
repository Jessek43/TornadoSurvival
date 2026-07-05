import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GameConfig } from "../config/GameConfig";
import type { SectionSpec } from "../level/Blueprints";
import { MATERIALS, type BlockMaterialDef, type MaterialId } from "../level/Materials";
import type { Physics } from "../core/Physics";
import type { DebrisManager } from "./DebrisManager";
import type { TornadoSystem } from "./TornadoSystem";
import type { WindField } from "./WindField";

/**
 * Builds structures from blueprints and runs their destruction lifecycle.
 *
 * Perf design:
 *  - Rendering: ONE InstancedMesh per material for ALL structures — a unit
 *    cube whose per-instance matrix encodes each block's position + size.
 *    The whole yard is 3 draw calls, and intact blocks never update.
 *  - DORMANT: a structure collides as ONE fixed rigid body carrying a
 *    compound of box colliders. The player can walk on and climb it, but
 *    nothing simulates.
 *  - AWAKE (the tornado's danger radius reaches it): the compound is
 *    swapped for one fixed body per block, so blocks become individually
 *    releasable. Still zero dynamics cost — fixed bodies don't simulate.
 *    Once awake, a structure stays awake for the round (simplification).
 *  - RELEASED (per block): wind dynamic pressure |w|² at the block beats
 *    the material's breakThreshold → the block's static instance is
 *    zero-scaled away and the block respawns as a dynamic body inside
 *    DebrisManager, initially thrown by the wind.
 *
 * Break checks run at ~10 Hz per structure (staggered start offsets), not
 * every frame — wind doesn't change fast enough to justify more.
 *
 * SUPPORT FLOOD-FILL: blueprints precompute which blocks touch (the
 * neighbor graph) and which touch the ground. After any wind release we
 * re-walk the graph from the ground up; intact blocks that are no longer
 * connected to the ground release too. That's what makes a shed cave in
 * when its walls go, and it guarantees no floating chunks.
 *
 * PROGRESSIVE SPLITTING: if the release pressure comfortably exceeds the
 * threshold (material.splitFactor) the block fractures into two halves
 * along its longest axis — reads as real breakage for near-zero cost.
 */

const NEIGHBOR_EPS = 0.05; // boxes within ~5 cm count as touching
const BREAK_CHECK_INTERVAL = 0.1; // s between break sweeps per structure
const MIN_SPLIT_DIM = 0.7; // don't split blocks already smaller than this
// Fraction of a section's blocks that must be gone before it counts as
// "destroyed" (its room geometry is effectively gone) — used to extinguish
// that section's interior lights. Deliberately high so a lightly-grazed
// survivor keeps its lights. (Bug 1.)
const SECTION_DESTROYED_FRACTION = 0.6;
// Sections at or below this block count (trees: 3 blocks) don't count toward
// maxAwakeSections — that cap exists to bound the per-block-body explosion of
// waking a whole WING, and a handful of 3-body trees is negligible. Without
// the exemption, a tree-lined pass would starve the wings of wake slots.
const TINY_SECTION_BLOCKS = 4;

export interface RuntimeBlock {
  materialId: MaterialId;
  material: BlockMaterialDef;
  /** World-space center while intact (instances don't move until released). */
  center: THREE.Vector3;
  size: THREE.Vector3;
  mesh: THREE.InstancedMesh;
  instanceId: number;
  /** Indices into the owning structure's blocks array. */
  neighbors: number[];
  touchesGround: boolean;
  released: boolean;
  /** Per-block fixed body, created when the structure wakes. */
  body: RAPIER.RigidBody | null;
}

export class StructureRuntime {
  state: "dormant" | "awake" = "dormant";
  /** The single fixed body carrying the compound collider while dormant. */
  compoundBody: RAPIER.RigidBody | null = null;
  releasedCount = 0;
  /** Staggered so all structures don't run their sweep on the same frame. */
  checkTimer = Math.random() * BREAK_CHECK_INTERVAL;
  climbDisabled = false;

  constructor(
    readonly name: string,
    readonly blocks: RuntimeBlock[],
    /** Horizontal center of the structure's footprint (y = 0). */
    readonly center: THREE.Vector3,
    /** Horizontal bounding radius — used for the wake distance check. */
    readonly radius: number,
    readonly climbVolumes: THREE.Box3[],
    /** Trees: wind-sway the canopy while awake (visual only — see swayPass). */
    readonly sway: boolean = false,
  ) {}
}

export class StructureSystem {
  readonly structures: StructureRuntime[] = [];
  /** All climb volumes in the yard (world-space), read by PlayerController. */
  readonly climbVolumes: THREE.Box3[] = [];
  /** Fired once per break sweep that released blocks (count = how many) — Game
   *  wires this to the audio break-impact. */
  onBreak: ((count: number) => void) | null = null;

  private readonly meshes = new Map<MaterialId, THREE.InstancedMesh>();

  // scratch
  private readonly windVec = new THREE.Vector3();
  private readonly spawnVel = new THREE.Vector3();
  private readonly spawnAngVel = new THREE.Vector3();
  private readonly childCenter = new THREE.Vector3();
  private readonly childSize = new THREE.Vector3();
  private static readonly ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    sections: SectionSpec[],
    private readonly windField: WindField,
    private readonly tornado: TornadoSystem,
    private readonly debris: DebrisManager,
  ) {
    // Pass 1 — count blocks per material so each InstancedMesh is sized exactly.
    const counts = new Map<MaterialId, number>();
    for (const s of sections) {
      for (const block of s.blocks) {
        counts.set(block.material, (counts.get(block.material) ?? 0) + 1);
      }
    }

    const cube = new THREE.BoxGeometry(1, 1, 1);
    for (const [id, count] of counts) {
      const def: BlockMaterialDef = MATERIALS[id];
      const mesh = new THREE.InstancedMesh(
        cube,
        // Base color lives in per-instance colors (see below); the material
        // color stays white so it doesn't double-tint.
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: def.roughness,
          metalness: def.metalness,
          transparent: def.transparent ?? false,
          opacity: def.opacity ?? 1,
          // Glass: don't write depth so panes behind it still show through.
          depthWrite: !(def.transparent ?? false),
        }),
        count,
      );
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // updated on release
      mesh.castShadow = def.castShadow ?? true;
      mesh.receiveShadow = true;
      // Instances span the whole building; skip per-mesh culling (1 draw call).
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.set(id, mesh);
    }

    // Pass 2 — stamp each section into the world. Blocks are world-space.
    const nextInstance = new Map<MaterialId, number>();
    const mat4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const color = new THREE.Color();

    for (const spec of sections) {
      const blocks: RuntimeBlock[] = [];

      // One fixed body per section carrying its compound collider (dormant
      // state): the player can walk/climb on it, but nothing simulates.
      const compound = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

      for (const def of spec.blocks) {
        const mesh = this.meshes.get(def.material)!;
        const instanceId = nextInstance.get(def.material) ?? 0;
        nextInstance.set(def.material, instanceId + 1);

        const center = new THREE.Vector3(...def.position);
        const size = new THREE.Vector3(...def.size);

        mat4.compose(center, quat, size);
        mesh.setMatrixAt(instanceId, mat4);

        // Slight deterministic per-block brightness jitter so flat walls
        // read as individual blocks instead of one untextured slab.
        const jitter = 0.88 + 0.24 * (((instanceId * 2654435761) >>> 0) % 1000) / 1000;
        color.setHex(MATERIALS[def.material].color).multiplyScalar(jitter);
        mesh.setColorAt(instanceId, color);

        physics.world.createCollider(
          RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setTranslation(
            center.x,
            center.y,
            center.z,
          ),
          compound,
        );

        blocks.push({
          materialId: def.material,
          material: MATERIALS[def.material],
          center,
          size,
          mesh,
          instanceId,
          neighbors: [],
          touchesGround: center.y - size.y / 2 <= NEIGHBOR_EPS,
          released: false,
          body: null,
        });
      }

      computeNeighbors(blocks);

      // Footprint center + horizontal bounding radius (for wake checks).
      const footprint = new THREE.Box3();
      for (const block of blocks) {
        footprint.expandByPoint(block.center.clone().add(block.size.clone().multiplyScalar(0.5)));
        footprint.expandByPoint(block.center.clone().sub(block.size.clone().multiplyScalar(0.5)));
      }
      const center = new THREE.Vector3(
        (footprint.min.x + footprint.max.x) / 2,
        0,
        (footprint.min.z + footprint.max.z) / 2,
      );
      const radius = Math.hypot(
        (footprint.max.x - footprint.min.x) / 2,
        (footprint.max.z - footprint.min.z) / 2,
      );

      const climbVolumes = (spec.climbVolumes ?? []).map((v) =>
        new THREE.Box3().setFromCenterAndSize(
          new THREE.Vector3(...v.position),
          new THREE.Vector3(...v.size),
        ),
      );
      this.climbVolumes.push(...climbVolumes);

      const structure = new StructureRuntime(
        spec.name,
        blocks,
        center,
        radius,
        climbVolumes,
        spec.sway ?? false,
      );
      structure.compoundBody = compound;
      this.structures.push(structure);
    }

    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Grip support: is there an intact block within `range` of this point?
   * Cheap two-level test — structure bounding circles first, then exact
   * point-to-AABB distance per intact block.
   */
  anyIntactBlockNear(pos: THREE.Vector3, range: number): boolean {
    const rangeSq = range * range;
    for (const s of this.structures) {
      const dx = pos.x - s.center.x;
      const dz = pos.z - s.center.z;
      if (Math.hypot(dx, dz) > s.radius + range) continue;
      for (const block of s.blocks) {
        if (block.released) continue;
        const ex = Math.max(Math.abs(pos.x - block.center.x) - block.size.x / 2, 0);
        const ey = Math.max(Math.abs(pos.y - block.center.y) - block.size.y / 2, 0);
        const ez = Math.max(Math.abs(pos.z - block.center.z) - block.size.z / 2, 0);
        if (ex * ex + ey * ey + ez * ez <= rangeSq) return true;
      }
    }
    return false;
  }

  /**
   * True once section `index` has lost enough blocks to count as destroyed.
   * Monotonic (released blocks never return) and independent of wake/sleep —
   * a re-slept intact section reads NOT destroyed — so InteriorLights can kill
   * a room's lights on real destruction without killing them on re-sleep.
   */
  isSectionDestroyed(index: number): boolean {
    const s = this.structures[index];
    if (!s) return false;
    return s.releasedCount >= s.blocks.length * SECTION_DESTROYED_FRACTION;
  }

  update(dt: number, time: number): void {
    const cfg = GameConfig.tornado;

    // Between passes (gap / done) the funnel is gone entirely — re-sleep every
    // section that still has surviving blocks, so the awake body count resets
    // to ~zero and doesn't accumulate across a multi-pass round. This is the
    // bulk of the re-sleep win: the sustained cost between passes stays low.
    // Spread over frames (a couple per frame) so re-merging isn't a hitch — a
    // gap is tens of seconds, far more than enough.
    if (!this.tornado.active) {
      let budget = 2;
      for (const s of this.structures) {
        if (s.state === "awake" && s.releasedCount < s.blocks.length) {
          this.sleep(s);
          if (--budget <= 0) break;
        }
      }
      return;
    }

    // Per-frame wake budget: a big building can have several sections cross
    // the wake radius on the same frame; converting hundreds of blocks to
    // individual fixed bodies at once would hitch. We spend at most
    // wakeBudgetPerFrame blocks per frame, so a wave of wakes spreads over a
    // few frames instead of spiking. Dormant sections stay cheap until then.
    let wakeBudget = cfg.wakeBudgetPerFrame;

    // The awake-section cap only tracks BIG sections (wings): waking a wing
    // converts hundreds of blocks to individual bodies, which is what the cap
    // bounds. Tiny sections (trees — 3 bodies) are exempt so a tree-lined pass
    // can't starve the wings of wake slots.
    let awakeCount = 0;
    for (const s of this.structures) {
      if (s.state === "awake" && s.blocks.length > TINY_SECTION_BLOCKS) awakeCount++;
    }

    for (const s of this.structures) {
      const dx = this.tornado.position.x - s.center.x;
      const dz = this.tornado.position.z - s.center.z;
      const dist = Math.hypot(dx, dz);
      const tiny = s.blocks.length <= TINY_SECTION_BLOCKS;

      if (s.state === "dormant") {
        // WAKE when the funnel is close enough (and we have budget/headroom).
        if (dist > cfg.wakeRadius + s.radius) continue;
        if (wakeBudget <= 0) continue; // wake next frame
        if (!tiny && awakeCount >= cfg.maxAwakeSections) continue; // safety ceiling
        wakeBudget -= s.blocks.length;
        this.wake(s);
        if (!tiny) awakeCount++;
      } else {
        // RE-SLEEP: the funnel has moved well past this section and it still
        // has surviving blocks → collapse its per-block fixed bodies back into
        // one dormant compound so they stop costing broadphase/iteration for
        // the rest of the round. (A fully-destroyed section already has no
        // bodies, so nothing to do.)
        if (dist > cfg.sleepRadius + s.radius && s.releasedCount < s.blocks.length) {
          this.sleep(s);
          if (!tiny) awakeCount--;
          continue;
        }
      }

      // BREAK sweep at ~10 Hz per awake section.
      if (s.state !== "awake") continue;
      s.checkTimer += dt;
      if (s.checkTimer < BREAK_CHECK_INTERVAL) continue;
      s.checkTimer = 0;
      this.runBreakSweep(s, time);
    }

    // Tree canopies bend in the wind (visual only; awake trees are by
    // definition near the funnel, so this touches a handful of instances).
    this.swayPass(time);
  }

  // scratch for the sway pass
  private readonly swayQuat = new THREE.Quaternion(); // identity — blocks stay axis-aligned
  private readonly swayMat = new THREE.Matrix4();
  private readonly swayPos = new THREE.Vector3();

  /**
   * Wind-sway for AWAKE tree sections: lean each surviving canopy block
   * downwind (taller canopy leans further) with a per-tree wobble, by
   * recomposing its instance matrix. This is the update-LOD for trees —
   * dormant/distant trees never touch their matrices (instanced-while-static
   * stands), and sleep() restores the rest pose. Colliders are NOT moved:
   * sway is look, the physics stays at the rest pose.
   */
  private swayPass(time: number): void {
    const touched = new Set<THREE.InstancedMesh>();
    for (const s of this.structures) {
      if (!s.sway || s.state !== "awake") continue;
      for (const block of s.blocks) {
        if (block.released || block.materialId !== "foliage") continue;
        this.windField.sample(this.windVec, block.center, time);
        const len = this.windVec.length();
        if (len < 1) continue;
        // Lean scales with wind strength and canopy height; the sin wobble
        // (phase from position → neighboring trees desynchronize) makes the
        // whole row thrash rather than tilt in lockstep.
        const lean = Math.min(len / 45, 1) * 0.09 * block.center.y;
        const wob = 1 + 0.35 * Math.sin(time * 3.1 + block.center.x * 2.3 + block.center.z);
        this.swayPos.set(
          block.center.x + (this.windVec.x / len) * lean * wob,
          block.center.y,
          block.center.z + (this.windVec.z / len) * lean * wob,
        );
        this.swayMat.compose(this.swayPos, this.swayQuat, block.size);
        block.mesh.setMatrixAt(block.instanceId, this.swayMat);
        touched.add(block.mesh);
      }
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Player wind SHELTER. Returns 0..1 exposure (1 = fully exposed) for a
   * point, given the direction the wind is blowing FROM (toward the
   * tornado). The player's sweep/stagger/grip/lift use raw wind × this, so
   * a roofed interior with an intact windward wall is safe — until the
   * tornado tears the shell open, when exposure climbs on its own.
   *
   * Break-sweeps on blocks deliberately use RAW wind (not this), so the
   * shell keeps failing regardless of where the player hides.
   */
  shelterExposureAt(pos: THREE.Vector3, windDir: THREE.Vector3): number {
    const cfg = GameConfig.shelter;
    // Roof/ceiling overhead? No roof → open air → fully exposed.
    this.probePoint.set(pos.x, pos.y + cfg.roofProbeUp, pos.z);
    if (!this.anyIntactBlockNear(this.probePoint, cfg.probeRange)) return 1;

    // Windward wall between the player and the tornado at torso height?
    // windDir points FROM the tornado toward the player, so step back along
    // −windDir to probe the windward side.
    this.probePoint
      .copy(pos)
      .addScaledVector(windDir, -cfg.windwardProbe)
      .setY(pos.y + cfg.torsoUp);
    const windwardIntact = this.anyIntactBlockNear(this.probePoint, cfg.probeRange);
    return windwardIntact ? cfg.shelteredExposure : cfg.breachedExposure;
  }

  private readonly probePoint = new THREE.Vector3();

  /** Swap the dormant compound for one fixed body per SURVIVING block. */
  private wake(s: StructureRuntime): void {
    s.state = "awake";
    if (s.compoundBody) {
      this.physics.world.removeRigidBody(s.compoundBody); // takes colliders with it
      s.compoundBody = null;
    }
    for (const block of s.blocks) {
      if (block.released) continue; // already debris — no body (matters on re-wake)
      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          block.center.x,
          block.center.y,
          block.center.z,
        ),
      );
      this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(block.size.x / 2, block.size.y / 2, block.size.z / 2),
        body,
      );
      block.body = body;
    }
  }

  /**
   * Inverse of wake: the funnel has left, so merge this section's surviving
   * per-block fixed bodies back into ONE dormant compound (many bodies → one),
   * cutting broadphase + per-body iteration cost for the rest of the round.
   * If the funnel returns, wake() rebuilds the per-block bodies for whatever
   * survived.
   */
  private sleep(s: StructureRuntime): void {
    s.state = "dormant";
    const compound = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const block of s.blocks) {
      if (block.released) continue;
      if (block.body) {
        this.physics.world.removeRigidBody(block.body);
        block.body = null;
      }
      this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(
          block.size.x / 2,
          block.size.y / 2,
          block.size.z / 2,
        ).setTranslation(block.center.x, block.center.y, block.center.z),
        compound,
      );
      // Trees: the sway pass moved this block's instance matrix — restore the
      // rest pose, since a dormant section's instances must sit still exactly
      // where their colliders are.
      if (s.sway) {
        this.swayMat.compose(block.center, this.swayQuat, block.size);
        block.mesh.setMatrixAt(block.instanceId, this.swayMat);
        block.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    s.compoundBody = compound;
  }

  /** Test every intact block's local wind pressure against its threshold. */
  private runBreakSweep(s: StructureRuntime, time: number): void {
    let releasedCount = 0;
    for (let i = 0; i < s.blocks.length; i++) {
      const block = s.blocks[i];
      if (block.released) continue;
      this.windField.sample(this.windVec, block.center, time);
      const pressure = this.windVec.lengthSq(); // "dynamic pressure" |w|²
      if (pressure > block.material.breakThreshold) {
        this.release(s, block, pressure, /* windThrown */ true);
        releasedCount++;
      }
    }
    if (releasedCount > 0) {
      this.collapseUnsupported(s, time);
      this.onBreak?.(releasedCount);
    }
  }

  /**
   * Tear one block free: retire its static presence and respawn it as a
   * dynamic body in the debris pool, thrown by the local wind.
   */
  private release(
    s: StructureRuntime,
    block: RuntimeBlock,
    pressure: number,
    windThrown: boolean,
  ): void {
    block.released = true;
    s.releasedCount++;
    if (block.body) {
      this.physics.world.removeRigidBody(block.body);
      block.body = null;
    }
    block.mesh.setMatrixAt(block.instanceId, StructureSystem.ZERO_SCALE);
    block.mesh.instanceMatrix.needsUpdate = true;

    // Once a structure is mostly gone its ladder shouldn't work anymore —
    // drop its climb volumes from the shared list the player reads.
    if (!s.climbDisabled && s.climbVolumes.length > 0 && s.releasedCount / s.blocks.length > 0.5) {
      s.climbDisabled = true;
      for (const v of s.climbVolumes) {
        const idx = this.climbVolumes.indexOf(v);
        if (idx !== -1) this.climbVolumes.splice(idx, 1);
      }
    }

    // Initial throw: a bite of the local wind plus randomness so a wall
    // doesn't peel off as one rigid sheet of parallel blocks.
    if (windThrown) {
      this.spawnVel
        .copy(this.windVec)
        .multiplyScalar(0.3)
        .add(this.randomIn(2, 3));
    } else {
      // Support failure: it just drops, with a nudge.
      this.spawnVel.copy(this.randomIn(1, 1.5));
    }
    this.spawnAngVel.set(rand(-4, 4), rand(-4, 4), rand(-4, 4));

    // PROGRESSIVE SPLIT: strong hits fracture the block into two halves
    // along its longest axis (each half keeps the block's material).
    const mat = block.material;
    const maxDim = Math.max(block.size.x, block.size.y, block.size.z);
    const shouldSplit =
      windThrown &&
      mat.splitFactor !== null &&
      pressure > mat.splitFactor * mat.breakThreshold &&
      maxDim > MIN_SPLIT_DIM;

    if (shouldSplit) {
      const axis =
        block.size.x === maxDim ? "x" : block.size.y === maxDim ? "y" : ("z" as const);
      for (const sign of [-1, 1]) {
        this.childSize.copy(block.size);
        this.childSize[axis] /= 2;
        this.childCenter.copy(block.center);
        this.childCenter[axis] += (sign * maxDim) / 4;
        this.debris.spawn(
          block.materialId,
          this.childCenter,
          this.childSize,
          this.spawnVel,
          this.spawnAngVel,
          true, // children never split again
        );
      }
    } else {
      this.debris.spawn(
        block.materialId,
        block.center,
        block.size,
        this.spawnVel,
        this.spawnAngVel,
      );
    }
  }

  /**
   * SUPPORT FLOOD-FILL. Standard graph reachability: start from every
   * intact block that touches the ground, walk the precomputed neighbor
   * graph through intact blocks only, and mark everything reachable as
   * supported. Whatever's left is hanging in the air → release it too.
   * One pass suffices because reachability is computed after ALL of this
   * sweep's wind releases are applied.
   */
  private collapseUnsupported(s: StructureRuntime, time: number): void {
    const supported = new Array<boolean>(s.blocks.length).fill(false);
    const stack: number[] = [];
    for (let i = 0; i < s.blocks.length; i++) {
      if (!s.blocks[i].released && s.blocks[i].touchesGround) {
        supported[i] = true;
        stack.push(i);
      }
    }
    while (stack.length > 0) {
      const i = stack.pop()!;
      for (const n of s.blocks[i].neighbors) {
        if (!supported[n] && !s.blocks[n].released) {
          supported[n] = true;
          stack.push(n);
        }
      }
    }
    for (let i = 0; i < s.blocks.length; i++) {
      const block = s.blocks[i];
      if (!block.released && !supported[i]) {
        // Sample wind anyway so the falling chunk inherits a bit of swirl.
        this.windField.sample(this.windVec, block.center, time);
        this.release(s, block, 0, /* windThrown */ false);
      }
    }
  }

  private readonly randVec = new THREE.Vector3();
  private randomIn(horizontal: number, up: number): THREE.Vector3 {
    return this.randVec.set(
      rand(-horizontal, horizontal),
      Math.random() * up,
      rand(-horizontal, horizontal),
    );
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Two blocks are neighbors when their boxes overlap after a small expansion. */
function computeNeighbors(blocks: RuntimeBlock[]): void {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      if (
        Math.abs(a.center.x - b.center.x) <= (a.size.x + b.size.x) / 2 + NEIGHBOR_EPS &&
        Math.abs(a.center.y - b.center.y) <= (a.size.y + b.size.y) / 2 + NEIGHBOR_EPS &&
        Math.abs(a.center.z - b.center.z) <= (a.size.z + b.size.z) / 2 + NEIGHBOR_EPS
      ) {
        a.neighbors.push(j);
        b.neighbors.push(i);
      }
    }
  }
}
