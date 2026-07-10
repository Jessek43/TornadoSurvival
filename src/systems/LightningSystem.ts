import * as THREE from "three";
import { GameConfig } from "../config/GameConfig";
import { LightningConfig } from "../config/LightningConfig";
import type { Atmosphere } from "./Atmosphere";
import type { AudioSystem } from "./AudioSystem";
import type { CameraRig } from "./CameraRig";
import type { StructureSystem } from "./StructureSystem";
import type { TornadoSystem } from "./TornadoSystem";

/**
 * Storm LIGHTNING strikes — the "every now and then a bolt slams down" system.
 *
 * Each strike, gated to the storm window (LightningConfig.onlyDuringTornado →
 * TornadoSystem.active), does five things in one event, then gets out of the
 * per-frame budget's way:
 *
 *   1. TARGET  — pick an (x,z) by bias (uniform / near the funnel / toward tall
 *      structures), then vertical-raycast the block world to find the impact
 *      point + whether it's a structure or the ground.
 *   2. BOLT    — build ONE jagged emissive tube cloud→impact (+ optional side
 *      branches), add it to the scene, strobe its visibility over its lifetime,
 *      then dispose the geometry. Built per strike, never per frame; a hard
 *      cap on concurrent bolts pools memory if the rate is cranked.
 *   3. FLASH   — spike the sky/scene via Atmosphere's dedicated strike-flash
 *      channel (its own colour/decay, so the ambient mood flasher is untouched).
 *   4. DAMAGE  — a structure hit routes through StructureSystem.strikeDamage,
 *      which reuses the block-break + support-collapse + debris path, capped at
 *      maxBlocksPerStrike and bounded by the global debris budget. Ground hits
 *      are flash + thunder (+ an optional scorch disc) only.
 *   5. THUNDER — the existing AudioSystem.thunder one-shot, at the configured
 *      volume and light-then-sound delay.
 *
 * Perf: work happens on strike EVENTS. The per-frame update only counts down a
 * timer and strobes/expires any live bolts (a handful of boolean writes,
 * zero allocation) — so 60 fps holds even mid-strike.
 */
interface LiveBolt {
  group: THREE.Group;
  ageMs: number;
}

interface TallTarget {
  x: number;
  z: number;
  jx: number; // footprint half-extent for the aim jitter
  jz: number;
  h: number; // nominal height (weight for "tallStructures" bias)
}

interface ScorchSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  ageMs: number;
  active: boolean;
}

/** Public snapshot of the most recent strike (the ?debug readout). */
export interface StrikeInfo {
  x: number;
  y: number;
  z: number;
  ground: boolean;
  destroyed: number;
}

export class LightningSystem {
  private readonly boltMaterial: THREE.MeshBasicMaterial;
  private readonly flashColor: THREE.Color;
  private readonly liveBolts: LiveBolt[] = [];

  /** A real point light spiked at each impact so the struck structure lights up
   *  locally (reused across strikes; decays on its own schedule). */
  private readonly strikeLight: THREE.PointLight;
  private strikeLightDecay = 11;

  private readonly tallTargets: TallTarget[] = [];

  private readonly scorch: ScorchSlot[] = [];
  private scorchNext = 0;

  private nextStrikeIn: number;
  /** Last strike (for the ?debug readout); null until the first strike. */
  lastStrike: StrikeInfo | null = null;

  /** Seconds until the next scheduled strike (?debug countdown). */
  get nextStrikeCountdown(): number {
    return this.nextStrikeIn;
  }

  // scratch (no per-frame allocation)
  private readonly tmpTarget = new THREE.Vector2();

  constructor(
    /** Render parent — the world-lights Group the shell detaches on teardown
     *  (bolts / strike light / scorch leave with the world), not the scene root. */
    private readonly scene: THREE.Object3D,
    private readonly tornado: TornadoSystem,
    private readonly structures: StructureSystem,
    private readonly atmosphere: Atmosphere,
    private readonly audio: AudioSystem,
    private readonly cameraRig: CameraRig,
    /** Ground height at (x,z): a GROUND strike lands here instead of at y = 0, and
     *  its scorch disc lies on the substrate. strikeRaycastDown already tells
     *  structure from ground (empty column → null), so this is only the ground
     *  fallback height. No-op offset at amplitude 0. */
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    // Unlit + un-fogged + un-tone-mapped so the bolt stays a searing near-white
    // at any distance and blows past the bloom threshold (glows via the post
    // chain, so boltWidth reads wider than the tube).
    this.boltMaterial = new THREE.MeshBasicMaterial({
      // HDR colour (× boltBrightness, un-tone-mapped) so the tube blows past the
      // bloom threshold and reads as a searing, brilliant bolt.
      color: new THREE.Color(LightningConfig.boltColor).multiplyScalar(LightningConfig.boltBrightness),
      toneMapped: false,
      fog: false,
      depthWrite: false,
    });
    this.flashColor = new THREE.Color(LightningConfig.boltFlashColor);

    // Local impact light (off until a strike positions + spikes it).
    this.strikeLight = new THREE.PointLight(
      this.flashColor,
      0,
      LightningConfig.strikeLightDistance,
      2,
    );
    this.strikeLight.castShadow = false;
    this.scene.add(this.strikeLight);

    // Precompute tall-structure aim points once (footprint centre + nominal
    // height). raycastDown re-derives the CURRENT top at strike time, so a
    // since-flattened building just resolves to a lower hit or the ground.
    for (const s of this.structures.structures) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = 0;
      for (const b of s.blocks) {
        minX = Math.min(minX, b.center.x - b.size.x / 2);
        maxX = Math.max(maxX, b.center.x + b.size.x / 2);
        minZ = Math.min(minZ, b.center.z - b.size.z / 2);
        maxZ = Math.max(maxZ, b.center.z + b.size.z / 2);
        top = Math.max(top, b.center.y + b.size.y / 2);
      }
      if (top <= 0) continue;
      this.tallTargets.push({
        x: (minX + maxX) / 2,
        z: (minZ + maxZ) / 2,
        jx: ((maxX - minX) / 2) * 0.8,
        jz: ((maxZ - minZ) / 2) * 0.8,
        h: top,
      });
    }

    if (LightningConfig.groundScorch) this.buildScorchPool();

    this.nextStrikeIn = this.nextInterval();
  }

  /** Clear any live bolts / impact light / scorch marks and re-prime the strike
   *  timer for a fresh round (restart parity). The precomputed `tallTargets` are
   *  aim coordinates only and stay valid across a rebuild of the same layout —
   *  strikeRaycastDown re-derives the current top each strike. */
  reset(): void {
    for (const b of this.liveBolts) this.disposeBolt(b.group);
    this.liveBolts.length = 0;
    this.strikeLight.intensity = 0;
    for (const s of this.scorch) {
      s.active = false;
      s.mesh.visible = false;
      s.mat.opacity = 0;
    }
    this.scorchNext = 0;
    this.lastStrike = null;
    this.nextStrikeIn = this.nextInterval();
  }

  update(dt: number, time: number): void {
    const cfg = LightningConfig;

    if (cfg.enabled) {
      // Gate on the storm window. When ungated, keep the timer primed with a
      // fresh interval so strikes don't burst the instant a pass begins.
      const gated = cfg.onlyDuringTornado ? this.tornado.active : true;
      if (gated) {
        this.nextStrikeIn -= dt;
        if (this.nextStrikeIn <= 0) {
          this.strike(time);
          this.nextStrikeIn = this.nextInterval();
        }
      } else {
        this.nextStrikeIn = this.nextInterval();
      }
    }

    // Strobe + expire live bolts (boolean writes only — no allocation).
    for (let i = this.liveBolts.length - 1; i >= 0; i--) {
      const b = this.liveBolts[i];
      b.ageMs += dt * 1000;
      if (b.ageMs >= cfg.boltLifetimeMs) {
        this.disposeBolt(b.group);
        this.liveBolts.splice(i, 1);
        continue;
      }
      // Split the lifetime into 2·flickerCount slots, alternating on/off.
      const slot = Math.floor((b.ageMs / cfg.boltLifetimeMs) * cfg.boltFlickerCount * 2);
      b.group.visible = slot % 2 === 0;
    }

    // Impact light decays on its own schedule (set from flashDurationMs).
    if (this.strikeLight.intensity > 0.01) {
      this.strikeLight.intensity *= Math.exp(-this.strikeLightDecay * dt);
    } else {
      this.strikeLight.intensity = 0;
    }

    this.updateScorch(dt);
  }

  /** Seconds until the next strike: nominal 1/rate jittered by ±rateJitter. */
  private nextInterval(): number {
    const cfg = LightningConfig;
    const nominal = 1 / Math.max(cfg.strikeRatePerSecond, 1e-3);
    return Math.max(0.15, nominal * (1 + (Math.random() * 2 - 1) * cfg.rateJitter));
  }

  private strike(time: number): void {
    const cfg = LightningConfig;

    // Pick an impact point, re-rolling toward a structure if ground is banned.
    let hit: { point: THREE.Vector3 } | null = null;
    const attempts = cfg.groundStrikeAllowed ? 1 : 6;
    for (let i = 0; i < attempts; i++) {
      this.pickTarget(this.tmpTarget);
      hit = this.structures.strikeRaycastDown(this.tmpTarget.x, this.tmpTarget.y);
      if (hit) break;
    }
    if (!hit && !cfg.groundStrikeAllowed) return; // structures-only, none found

    const ground = !hit;
    const px = hit ? hit.point.x : this.tmpTarget.x;
    const pz = hit ? hit.point.z : this.tmpTarget.y;
    const py = hit ? hit.point.y : this.heightAt(px, pz);

    this.spawnBolt(px, pz, py);
    this.atmosphere.triggerStrikeFlash(cfg.flashIntensity, cfg.flashDurationMs, this.flashColor);
    this.cameraRig.addImpulse(cfg.cameraImpulse);

    // Local impact light — a brief blaze at the strike so the struck structure
    // lights up (a bit above the impact, aimed down into it).
    if (cfg.strikeLightIntensity > 0) {
      this.strikeLight.position.set(px, py + 6, pz);
      this.strikeLight.intensity = cfg.strikeLightIntensity;
      this.strikeLightDecay = 3000 / Math.max(cfg.flashDurationMs, 1);
    }

    let destroyed = 0;
    if (hit && cfg.damageStructures) {
      destroyed = this.structures.strikeDamage(
        hit.point,
        cfg.damageRadius,
        cfg.damageImpulse,
        cfg.maxBlocksPerStrike,
        time,
      );
    } else if (ground && cfg.groundScorch) {
      this.addScorch(px, pz);
    }

    // The strike sound = the same deep rumble as the ambient sky-flash thunder,
    // just LOUDER (thunderVolume) and prompter (thunderDelayMs) — no separate
    // "crack" layer, which read as an electric zap.
    this.audio.thunder(cfg.thunderVolume, cfg.thunderDelayMs);
    this.lastStrike = { x: px, y: py, z: pz, ground, destroyed };
  }

  /** Choose the (x,z) impact column per targetBias (out.x = x, out.y = z). */
  private pickTarget(out: THREE.Vector2): void {
    const cfg = LightningConfig;
    const f = this.tornado.funnels[0];

    if (cfg.targetBias === "nearTornado" && f) {
      // PREFER a real structure near the funnel so the bolt hits an object; only
      // if none is in range, scatter onto ground close to the funnel (still
      // near the action).
      if (this.pickStructureNear(f.position.x, f.position.z, cfg.nearTornadoRadius, out)) return;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * cfg.nearTornadoRadius;
      out.set(f.position.x + Math.cos(a) * r, f.position.z + Math.sin(a) * r);
      return;
    }

    // Toward a tall structure anywhere (weighted by height).
    if (cfg.targetBias === "tallStructures" && this.pickStructureNear(0, 0, Infinity, out)) return;

    // Uniform over a disc around the hospital (also the fallback when
    // nearTornado has no live funnel or there are no structures in range).
    const c = GameConfig.hospitalCenter;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * cfg.targetAreaRadius;
    out.set(c.x + Math.cos(a) * r, c.z + Math.sin(a) * r);
  }

  /** Pick a structure whose footprint centre is within `radius` of (cx,cz),
   *  weighted by height, and aim at its roof (jittered inside the footprint).
   *  Returns false if none is in range (caller falls back to a ground scatter). */
  private pickStructureNear(cx: number, cz: number, radius: number, out: THREE.Vector2): boolean {
    let total = 0;
    for (const t of this.tallTargets) {
      if (Math.hypot(t.x - cx, t.z - cz) <= radius) total += t.h;
    }
    if (total <= 0) return false;
    let pick = Math.random() * total;
    for (const t of this.tallTargets) {
      if (Math.hypot(t.x - cx, t.z - cz) > radius) continue;
      pick -= t.h;
      if (pick <= 0) {
        out.set(t.x + rand(-t.jx, t.jx) * 0.6, t.z + rand(-t.jz, t.jz) * 0.6);
        return true;
      }
    }
    return false;
  }

  // --- bolt geometry -------------------------------------------------------

  private spawnBolt(x: number, z: number, groundY: number): void {
    const cfg = LightningConfig;
    const top = new THREE.Vector3(x + rand(-8, 8), cfg.cloudHeight, z + rand(-8, 8));
    const bottom = new THREE.Vector3(x, groundY, z);

    const group = new THREE.Group();
    this.buildBoltPath(group, top, bottom, cfg.boltSegments, cfg.boltJitter, true);
    this.scene.add(group);
    this.liveBolts.push({ group, ageMs: 0 });

    // Pool guard: cap concurrent bolt geometry (dispose the oldest).
    while (this.liveBolts.length > cfg.maxLiveBolts) {
      const oldest = this.liveBolts.shift()!;
      this.disposeBolt(oldest.group);
    }
  }

  /** One jagged tube `from`→`to`, plus recursive side branches (non-branching). */
  private buildBoltPath(
    group: THREE.Group,
    from: THREE.Vector3,
    to: THREE.Vector3,
    segments: number,
    jitter: number,
    allowBranch: boolean,
  ): void {
    const cfg = LightningConfig;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const p = new THREE.Vector3().lerpVectors(from, to, i / segments);
      if (i > 0 && i < segments) {
        p.x += rand(-jitter, jitter);
        p.z += rand(-jitter, jitter);
        p.y += rand(-jitter, jitter) * 0.5;
      }
      pts.push(p);

      // Fork a short downward branch off an interior node.
      if (allowBranch && i > 1 && i < segments - 1 && Math.random() < cfg.boltBranchChance) {
        const end = p
          .clone()
          .add(new THREE.Vector3(rand(-1, 1), -Math.random() - 0.2, rand(-1, 1)).multiplyScalar(jitter * 3));
        this.buildBoltPath(group, p.clone(), end, Math.max(3, segments >> 1), jitter * 0.7, false);
      }
    }

    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, segments * 3, cfg.boltWidth / 2, 4, false);
    group.add(new THREE.Mesh(geo, this.boltMaterial));
  }

  private disposeBolt(group: THREE.Group): void {
    this.scene.remove(group);
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose(); // shared material NOT disposed
    });
  }

  // --- ground scorch (pooled decals) --------------------------------------

  private buildScorchPool(): void {
    const geo = new THREE.CircleGeometry(1, 20); // unit disc, scaled per mark
    for (let i = 0; i < LightningConfig.maxScorchMarks; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x0a0a0a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; // lie flat on the ground
      mesh.scale.setScalar(LightningConfig.scorchRadius);
      mesh.visible = false;
      this.scene.add(mesh);
      this.scorch.push({ mesh, mat, ageMs: 0, active: false });
    }
  }

  private addScorch(x: number, z: number): void {
    const slot = this.scorch[this.scorchNext];
    this.scorchNext = (this.scorchNext + 1) % this.scorch.length;
    slot.mesh.position.set(x, this.heightAt(x, z) + 0.03, z);
    slot.mesh.visible = true;
    slot.mat.opacity = 0.6;
    slot.ageMs = 0;
    slot.active = true;
  }

  private updateScorch(dt: number): void {
    const life = LightningConfig.scorchLifetimeMs;
    for (const s of this.scorch) {
      if (!s.active) continue;
      s.ageMs += dt * 1000;
      if (s.ageMs >= life) {
        s.active = false;
        s.mesh.visible = false;
      } else {
        s.mat.opacity = 0.6 * (1 - s.ageMs / life);
      }
    }
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
