import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GameConfig } from "../config/GameConfig";
import type { Physics } from "../core/Physics";
import type { InputState } from "../core/InputManager";
import type { WindField } from "./WindField";
import type { DamageSystem } from "./DamageSystem";

/**
 * First-person player. Two physical representations, one at a time:
 *
 *  ACTIVE — a KINEMATIC capsule: gravity and forces don't act on it; we
 *  integrate a velocity by hand each fixed step and Rapier's character
 *  controller trims the displacement against the world. Tight, non-bouncy
 *  FPS movement. Modifiers within ACTIVE: climbing (inside a ladder
 *  volume) and GRIPPING (anchored to structure, draining stamina against
 *  the wind).
 *
 *  RAGDOLL — when wind pressure beats sweepPressure and the player isn't
 *  gripping, the kinematic collider is disabled and a DYNAMIC capsule
 *  (wearing a blocky humanoid dummy mesh) takes over: real gravity, wind
 *  drag, tumbling. The fling cam (CameraRig) watches this body. Once it
 *  lies still in calm-enough wind for recoverTime, control cuts back to
 *  the kinematic rig where the body landed.
 *
 * Wind interaction while ACTIVE, by rising pressure:
 *   stagger (velocity pushed downwind) → must grip (stamina drains ∝
 *   pressure) → swept (ragdoll fling). Fall/impact damage is measured as
 *   sudden velocity change and reported to DamageSystem.
 */

type PlayerState = "active" | "ragdoll";

export class PlayerController {
  state: PlayerState = "active";
  /** 0..1 — grip endurance. Drains while holding on in wind, regens in calm. */
  stamina = 1;
  /** 0..1 — sprint endurance. Drains while running, regens while walking/idle. */
  runStamina = 1;
  gripping = false;

  /** Debug/tuning readout (§3): the downward speed and hp dealt on the last
   *  on-foot landing. Refreshed every time the player becomes grounded (0 hp
   *  for a soft landing), so the ?debug HUD shows the number to tune against. */
  lastFallSpeed = 0;
  lastFallDamage = 0;

  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly mesh: THREE.Mesh;

  /** Look angles (radians). Yaw steers movement; pitch is view-only. */
  yaw = 0;
  pitch = 0;

  private readonly velocity = new THREE.Vector3();
  private grounded = false;
  /** 0 = standing, 1 = fully crouched. Smoothed each fixed step; drives both
   *  the collider shrink and the eye-height dip. */
  private crouchAmount = 0;
  /** Capsule total height currently applied to the collider — resize only when
   *  the crouch target actually moves it. */
  private appliedCapsuleH = GameConfig.player.height;
  /** Sprint locked out until runStamina recovers past the threshold. */
  private exhausted = false;
  /** Buffered jump: set every frame the key is pressed, consumed on a fixed
   *  step. Decouples the one-frame input edge from fixed-step timing. */
  private jumpBuffer = 0;
  /** Coyote window: time you can still jump after leaving the ground. */
  private coyote = 0;

  private readonly controller: RAPIER.KinematicCharacterController;

  // --- ragdoll rig ---
  private ragdollBody: RAPIER.RigidBody | null = null;
  private readonly dummy: THREE.Group;
  private ragdollStillTime = 0;
  private readonly prevRagdollVel = new THREE.Vector3();

  /** World-space ladder volumes (from StructureSystem); climb while inside. */
  private climbVolumes: THREE.Box3[] = [];
  /** "Is there intact structure within grip range of this point?" */
  private gripQuery: (pos: THREE.Vector3) => boolean = () => false;
  /** How much raw wind the player feels here, 0..1 (1 = fully exposed). */
  private windExposureQuery: (pos: THREE.Vector3, windDir: THREE.Vector3) => number = () => 1;

  // scratch vectors — reused every step to avoid per-frame allocation
  private readonly desiredMove = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly wind = new THREE.Vector3();
  private readonly windDir = new THREE.Vector3();
  private readonly windForce = new THREE.Vector3();
  private readonly ragdollVel = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly windField: WindField,
    private readonly damage: DamageSystem,
  ) {
    const { spawn, height, radius } = GameConfig.player;
    // spawn is a feet position; the body origin is the capsule center.
    const center = new THREE.Vector3(spawn.x, spawn.y + height / 2, spawn.z);

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(center.x, center.y, center.z),
    );
    // Rapier capsules are (half-height of the cylinder section, cap radius).
    const halfCylinder = height / 2 - radius;
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(halfCylinder, radius),
      this.body,
    );

    // The character controller turns "I want to move this far" into "here's
    // how far you can move" after resolving collisions.
    this.controller = physics.world.createCharacterController(0.02); // 2 cm skin
    this.controller.enableAutostep(0.5, 0.2, true); // walk up ≤ 0.5 m ledges
    this.controller.enableSnapToGround(0.3); // hug the ground going down slopes
    this.controller.setApplyImpulsesToDynamicBodies(true); // shove loose debris

    // First-person body mesh stays hidden (the camera sits inside it).
    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, height - 2 * radius),
      new THREE.MeshStandardMaterial({ color: 0xb0a67c, roughness: 0.8 }),
    );
    this.mesh.visible = false;
    this.mesh.position.copy(center);
    scene.add(this.mesh);

    // The blocky dummy the fling cam watches tumble.
    this.dummy = buildDummy();
    this.dummy.visible = false;
    scene.add(this.dummy);

    // §3 — record the fall-damage tuning at startup (the "print the current
    // constants before changing them" step): the on-foot fall used to share the
    // ragdoll constants and is now on dedicated, much steeper ones.
    const p = GameConfig.player;
    console.info(
      `[falldamage] before (shared w/ ragdoll): safe ${p.safeImpactSpeed} m/s, ` +
        `factor ${p.impactDamageFactor} hp per m/s · now (dedicated on-foot): ` +
        `safe ${p.fallSafeSpeed} m/s, factor ${p.fallDamageFactor} hp per m/s`,
    );
  }

  setClimbVolumes(volumes: THREE.Box3[]): void {
    this.climbVolumes = volumes;
  }

  setGripQuery(query: (pos: THREE.Vector3) => boolean): void {
    this.gripQuery = query;
  }

  setWindExposureQuery(query: (pos: THREE.Vector3, windDir: THREE.Vector3) => number): void {
    this.windExposureQuery = query;
  }

  get isRagdoll(): boolean {
    return this.state === "ragdoll";
  }

  /** Collider that debris contact-events should hurt; -1 while ragdolled
   *  (ragdoll damage is measured as velocity change instead). */
  get contactDamageHandle(): number {
    return this.state === "active" ? this.collider.handle : -1;
  }

  /**
   * Runs once per FIXED physics step (not per rendered frame): wind
   * interaction, grip, movement — or ragdoll bookkeeping.
   */
  fixedUpdate(dt: number, input: InputState, time: number): void {
    if (this.state === "ragdoll") {
      this.ragdollFixedUpdate(dt, time);
      return;
    }
    const cfg = GameConfig.player;

    const t0 = this.body.translation();
    this.tmpPos.set(t0.x, t0.y, t0.z);

    // --- local wind, attenuated by interior shelter ---
    // The wind field is positional (no wall occlusion). Inside an intact
    // enclosure the player should be protected, so we scale the wind we FEEL
    // by an exposure factor (roofed + windward wall intact → near-zero). The
    // wind field itself — and thus structural breakage — is untouched, so the
    // shell keeps failing and shelter degrades as it's torn open.
    this.windField.sample(this.wind, this.tmpPos, time);
    if (this.wind.lengthSq() > 1) {
      this.windDir.copy(this.wind).normalize();
      this.wind.multiplyScalar(this.windExposureQuery(this.tmpPos, this.windDir));
    }
    const pressure = this.wind.lengthSq(); // dynamic pressure |w|² (as felt)

    // --- sustained storm battering: the direct-exposure lethal path ---
    // Uses FELT pressure, so shelter (which lowers it) still protects; applies
    // whether or not you're gripping (holding on delays the fling but the storm
    // still wears you down). This is what makes standing in the open storm
    // lethal over time and near-misses hurt — before, only impacts/crush/fling
    // dealt damage, so sub-sweep exposure cost nothing. (Bug 3.)
    const dmg = GameConfig.damage;
    if (pressure > dmg.batterPressure) {
      this.damage.takeDamage((dmg.batterPerSec * pressure * dt) / cfg.sweepPressure, "crush");
    }

    // --- jump timers (this.grounded reflects the previous step) ---
    if (this.jumpBuffer > 0) this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? cfg.coyoteTime : Math.max(0, this.coyote - dt);
    const wantJump = this.jumpBuffer > 0;

    // --- grip: hold on to nearby structure, paying stamina ∝ pressure ---
    let inClimbVolume = false;
    for (const v of this.climbVolumes) {
      if (v.containsPoint(this.tmpPos)) {
        inClimbVolume = true;
        break;
      }
    }
    const canGrip = inClimbVolume || this.gripQuery(this.tmpPos);
    this.gripping = input.gripHeld && canGrip && this.stamina > 0;

    if (this.gripping) {
      // Strain multiplier is CAPPED (gripStrainCap): unbounded, it emptied a
      // full stamina bar in a fraction of a second under strong wind, so grip
      // never held and felt broken. Capped, a full bar buys a usable hold. (Bug 4.)
      const strain = Math.min(pressure / cfg.sweepPressure, cfg.gripStrainCap);
      this.stamina = Math.max(0, this.stamina - cfg.staminaDrain * strain * dt);
    } else {
      this.stamina = Math.min(1, this.stamina + cfg.staminaRegen * dt);
    }

    // --- swept off your feet: too much wind and nothing to hold ---
    if (pressure > cfg.sweepPressure && !this.gripping) {
      this.enterRagdoll();
      return;
    }

    // --- crouch: shrink the real capsule, pin its BOTTOM to the standing foot
    // line via a collider offset. The body centre never moves (so the character
    // controller and ground contact are untouched), only the head comes down —
    // you truly fit under gaps between crouchHeight and standing height. ---
    const crouchTarget = input.crouchHeld ? 1 : 0;
    this.crouchAmount += (crouchTarget - this.crouchAmount) * (1 - Math.exp(-cfg.crouchLerp * dt));
    const capsuleH = cfg.height + (cfg.crouchHeight - cfg.height) * this.crouchAmount;
    if (Math.abs(capsuleH - this.appliedCapsuleH) > 1e-4) {
      this.collider.setHalfHeight(Math.max(0.05, capsuleH / 2 - cfg.radius));
      this.collider.setTranslationWrtParent({ x: 0, y: (capsuleH - cfg.height) / 2, z: 0 });
      this.appliedCapsuleH = capsuleH;
    }

    // --- sprint stamina: drains while actually running, regens otherwise; an
    // empty bar locks sprint out until it recovers past the threshold. ---
    const moving = input.moveX !== 0 || input.moveY !== 0;
    const sprinting =
      input.sprintHeld && !input.crouchHeld && moving && !this.exhausted && this.runStamina > 0;
    if (sprinting) {
      this.runStamina = Math.max(0, this.runStamina - cfg.sprintDrain * dt);
      if (this.runStamina === 0) this.exhausted = true;
    } else {
      this.runStamina = Math.min(1, this.runStamina + cfg.sprintRegen * dt);
      if (this.exhausted && this.runStamina >= cfg.sprintRecoverThreshold) this.exhausted = false;
    }

    // Crouch overrides sprint (no sprint-crouch); grip zeroes movement below.
    const speed =
      cfg.walkSpeed * (input.crouchHeld ? cfg.crouchMultiplier : sprinting ? cfg.sprintMultiplier : 1);

    // Input is camera-relative: rotate the (strafe, forward) stick by yaw.
    // With three.js conventions, yaw 0 faces −Z, so forward = (−sin, 0, −cos)
    // and right = (cos, 0, −sin).
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.desiredMove.set(
      (input.moveX * cos - input.moveY * sin) * speed,
      0,
      (-input.moveX * sin - input.moveY * cos) * speed,
    );

    if (this.gripping) {
      // Anchored: no voluntary movement, no wind stagger.
      this.velocity.set(0, this.grounded ? -1 : 0, 0);
    } else if (inClimbVolume && (input.moveY !== 0 || !this.grounded)) {
      // On the ladder: forward/back maps to up/down, gravity is off, and a
      // reduced horizontal response lets the player push onto the platform
      // at the top or step away at the bottom.
      this.velocity.y = input.moveY * cfg.climbSpeed;
      this.velocity.x = this.desiredMove.x * 0.4;
      this.velocity.z = this.desiredMove.z * 0.4;
      if (wantJump) {
        this.velocity.y = cfg.jumpSpeed * 0.6; // hop off the ladder
        this.jumpBuffer = 0;
      }
    } else if (this.grounded) {
      // On the ground, velocity follows input directly — snappy control.
      this.velocity.x = this.desiredMove.x;
      this.velocity.z = this.desiredMove.z;
      if (wantJump) {
        this.velocity.y = cfg.jumpSpeed;
        this.jumpBuffer = 0;
        this.coyote = 0; // spent — no double jump
      } else {
        this.velocity.y = -1; // small downward bias keeps ground contact solid
      }
    } else {
      // Airborne: limited steering toward the input direction, full gravity.
      // Coyote time: a buffered jump still fires just after leaving a ledge.
      if (wantJump && this.coyote > 0) {
        this.velocity.y = cfg.jumpSpeed;
        this.jumpBuffer = 0;
        this.coyote = 0;
      } else {
        this.velocity.y += GameConfig.physics.gravity * dt;
      }
      const blend = Math.min(cfg.airControl * dt, 1);
      this.velocity.x += (this.desiredMove.x - this.velocity.x) * blend;
      this.velocity.z += (this.desiredMove.z - this.velocity.z) * blend;
    }

    // Sub-sweep wind stagger: the storm shoves the player downwind. Scaled
    // by pressure/sweepPressure so a distant tornado is a lean, a close one
    // a losing fight.
    if (!this.gripping && pressure > 1) {
      const shove = cfg.windPush * Math.min(pressure / cfg.sweepPressure, 1);
      this.velocity.x += this.wind.x * shove * dt;
      this.velocity.z += this.wind.z * shove * dt;
    }

    // Collide-and-slide: ask the controller how much of the desired
    // displacement actually fits, then move the kinematic body there.
    this.controller.computeColliderMovement(this.collider, {
      x: this.velocity.x * dt,
      y: this.velocity.y * dt,
      z: this.velocity.z * dt,
    });
    const moved = this.controller.computedMovement();
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: t.x + moved.x,
      y: t.y + moved.y,
      z: t.z + moved.z,
    });
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();

    // Hard landing on foot → fall damage (velocity.y still holds fall speed).
    // Uses the dedicated fall constants so tuning falls is independent of the
    // ragdoll jolt tuning. Records the last landing for the ?debug readout.
    if (this.grounded && !wasGrounded) {
      const landingSpeed = Math.max(-this.velocity.y, 0);
      this.lastFallSpeed = landingSpeed;
      this.lastFallDamage =
        landingSpeed > cfg.fallSafeSpeed
          ? (landingSpeed - cfg.fallSafeSpeed) * cfg.fallDamageFactor
          : 0;
      if (this.lastFallDamage > 0) this.damage.takeDamage(this.lastFallDamage, "fall");
    }

    // Bumped a ceiling while ascending: kill upward velocity so we fall
    // immediately instead of "sticking" until gravity winds back down.
    if (this.velocity.y > 0 && moved.y < this.velocity.y * dt * 0.5) {
      this.velocity.y = 0;
    }
  }

  /** Round logic: collapse on death even if the wind didn't fling us. */
  forceRagdoll(): void {
    if (this.state === "active") this.enterRagdoll();
  }

  /** The storm won: swap the kinematic rig for a tumbling dynamic body. */
  private enterRagdoll(): void {
    const cfg = GameConfig.player;
    this.state = "ragdoll";
    this.gripping = false;
    this.ragdollStillTime = 0;

    // The kinematic body stays parked but stops colliding.
    this.collider.setEnabled(false);

    const t = this.body.translation();
    this.ragdollBody = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(t.x, t.y, t.z)
        // Launch with current motion plus a bite of the wind and a hop up —
        // the moment of being ripped off your feet should read instantly.
        .setLinvel(
          this.velocity.x + this.wind.x * 0.5,
          Math.max(this.velocity.y, 0) + this.wind.y * 0.5 + 3,
          this.velocity.z + this.wind.z * 0.5,
        )
        .setAngvel({
          x: (Math.random() - 0.5) * 8,
          y: (Math.random() - 0.5) * 8,
          z: (Math.random() - 0.5) * 8,
        })
        .setLinearDamping(cfg.ragdollLinearDamping)
        .setAngularDamping(cfg.ragdollAngularDamping),
    );
    const halfCylinder = GameConfig.player.height / 2 - GameConfig.player.radius;
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(halfCylinder, GameConfig.player.radius)
        .setDensity(cfg.ragdollDensity)
        // Friction so the landed capsule stops rolling and actually settles.
        .setFriction(cfg.ragdollFriction),
      this.ragdollBody,
    );

    const v = this.ragdollBody.linvel();
    this.prevRagdollVel.set(v.x, v.y, v.z);
    this.dummy.visible = true;
    this.syncDummy();
  }

  private ragdollFixedUpdate(dt: number, time: number): void {
    const cfg = GameConfig.player;
    const rb = this.ragdollBody!;

    // Wind drag keeps the body flying/tumbling instead of just arcing down.
    const t = rb.translation();
    this.tmpPos.set(t.x, t.y, t.z);
    this.windField.sample(this.wind, this.tmpPos, time);

    // Storm battering on the tumbling body (raw wind — a flung body has no
    // shelter). Without this, a ragdoll skidding on open ground stopped taking
    // jolt damage once its impacts fell below the threshold and health stalled
    // just above zero forever — the "can't die under sustained exposure" bug. (Bug 3.)
    const dmg = GameConfig.damage;
    const exposedPressure = this.wind.lengthSq();
    if (exposedPressure > dmg.batterPressure) {
      this.damage.takeDamage((dmg.batterPerSec * exposedPressure * dt) / cfg.sweepPressure, "impact");
    }

    const v = rb.linvel();
    this.ragdollVel.set(v.x, v.y, v.z);
    this.windField.dragForce(
      this.windForce,
      this.wind,
      this.ragdollVel,
      cfg.ragdollArea,
      GameConfig.wind.dragK,
    );
    this.windForce.multiplyScalar(dt);
    // Only WAKE the body when the wind push is real. Force-waking every step
    // (the old bug) kept Rapier from ever sleeping the body, so a settled
    // capsule's residual roll bled off through damping alone and stayed above
    // the recovery threshold for many seconds. In calm air we let it sleep.
    const meaningfulWind = this.windForce.lengthSq() > 1e-4;
    rb.applyImpulse(this.windForce, meaningfulWind);

    // Impact damage = sudden velocity change between steps. This covers
    // slamming into the ground, walls, and being hit by debris, without any
    // contact-event bookkeeping. (Gravity/wind only change velocity by
    // ~0.2–0.7 m/s per step — far below the threshold.)
    const newV = rb.linvel();
    const jolt = Math.hypot(
      newV.x - this.prevRagdollVel.x,
      newV.y - this.prevRagdollVel.y,
      newV.z - this.prevRagdollVel.z,
    );
    // Note: prevRagdollVel was captured AFTER last step's impulses, so the
    // solver's collision response is what dominates this difference.
    if (jolt > cfg.safeImpactSpeed) {
      this.damage.takeDamage((jolt - cfg.safeImpactSpeed) * cfg.impactDamageFactor, "impact");
    }
    this.prevRagdollVel.set(newV.x, newV.y, newV.z);

    // Recovery. Dead players stay down — the fling cam becomes the death cam.
    if (this.damage.dead) return;
    // "Settled" = near the ground AND not violently moving. A grounded check
    // (rather than a hard near-zero speed) is the robust signal: a landed
    // capsule keeps some rolling speed for a moment, so a strict speed gate
    // never opened. The wind gate is the sweep pressure itself: we only get
    // up once the storm has eased below the point that would instantly
    // re-fling us, which avoids a first-person ↔ fling-cam flip-flop.
    const grounded = t.y < GameConfig.player.height * 0.75;
    const settled =
      grounded &&
      this.ragdollVel.length() < cfg.recoverMaxSpeed &&
      this.wind.lengthSq() < cfg.sweepPressure;
    if (settled) {
      this.ragdollStillTime += dt;
      if (this.ragdollStillTime >= cfg.recoverTime) this.exitRagdoll();
    } else {
      this.ragdollStillTime = 0;
    }
  }

  /** Back on your feet where the body came to rest. */
  private exitRagdoll(): void {
    const rb = this.ragdollBody!;
    const t = rb.translation();
    this.physics.world.removeRigidBody(rb);
    this.ragdollBody = null;
    this.dummy.visible = false;

    this.collider.setEnabled(true);
    // Stand the capsule up at the rest position (never below the ground).
    this.body.setTranslation(
      { x: t.x, y: Math.max(t.y, GameConfig.player.height / 2 + 0.05), z: t.z },
      true,
    );
    this.velocity.set(0, -1, 0);
    this.grounded = false;
    this.state = "active";
  }

  /** Per-frame (render-rate) update: mouse look + jump buffering + mesh sync.
   *  (Crouch smoothing + capsule resize live in fixedUpdate so the collider and
   *  the eye height stay in lockstep with the physics body.) */
  update(_dt: number, input: InputState): void {
    const cfg = GameConfig.player;
    this.yaw -= input.lookX * cfg.mouseSensitivity;
    this.pitch -= input.lookY * cfg.mouseSensitivity;
    this.pitch = Math.max(-cfg.pitchLimit, Math.min(cfg.pitchLimit, this.pitch));

    // Capture the jump edge EVERY frame (this always runs; fixedUpdate may run
    // zero times on a frame). fixedUpdate consumes the buffer on its next step,
    // so a jump is never lost to fixed-step timing (the >60 Hz jump bug).
    if (input.jumpPressed) this.jumpBuffer = cfg.jumpBufferTime;

    if (this.state === "ragdoll") {
      this.syncDummy();
      this.mesh.position.copy(this.dummy.position);
    } else {
      const t = this.body.translation();
      this.mesh.position.set(t.x, t.y, t.z);
    }
  }

  private syncDummy(): void {
    if (!this.ragdollBody) return;
    const t = this.ragdollBody.translation();
    const r = this.ragdollBody.rotation();
    this.dummy.position.set(t.x, t.y, t.z);
    this.dummy.quaternion.set(r.x, r.y, r.z, r.w);
  }

  /** Capsule-center world position — or the tumbling body while ragdolled. */
  get position(): THREE.Vector3 {
    return this.mesh.position;
  }

  /** World position of the eyes — the first-person camera anchor. Dips toward
   *  crouchEyeHeight as the player crouches. */
  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    const { height, eyeHeight, crouchEyeHeight } = GameConfig.player;
    const eye = eyeHeight + (crouchEyeHeight - eyeHeight) * this.crouchAmount;
    const t = this.body.translation();
    return out.set(t.x, t.y - height / 2 + eye, t.z);
  }
}

/** Blocky humanoid in a rigid pose — the body the fling cam watches. */
function buildDummy(): THREE.Group {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xb0a67c, roughness: 0.85 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x4a4f42, roughness: 0.95 });

  const add = (
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  };

  add(cloth, 0.5, 0.65, 0.28, 0, 0.18, 0); // torso
  add(skin, 0.26, 0.26, 0.26, 0, 0.66, 0); // head
  add(cloth, 0.14, 0.55, 0.14, -0.34, 0.15, 0); // arms
  add(cloth, 0.14, 0.55, 0.14, 0.34, 0.15, 0);
  add(cloth, 0.17, 0.7, 0.17, -0.13, -0.5, 0); // legs
  add(cloth, 0.17, 0.7, 0.17, 0.13, -0.5, 0);
  return group;
}
