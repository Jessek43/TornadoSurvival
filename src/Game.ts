import * as THREE from "three";
import { GameConfig } from "./config/GameConfig";
import { resolveQuality, type QualitySettings } from "./config/QualitySettings";
import { InputManager } from "./core/InputManager";
import { Noise } from "./core/Noise";
import { Physics } from "./core/Physics";
import { Level } from "./level/Level";
import { buildHospital } from "./level/Hospital";
import { buildNeighborhood } from "./level/Neighborhood";
import { Atmosphere } from "./systems/Atmosphere";
import { AudioSystem } from "./systems/AudioSystem";
import { CameraRig } from "./systems/CameraRig";
import { DamageSystem } from "./systems/DamageSystem";
import { DebrisManager } from "./systems/DebrisManager";
import { AlarmController } from "./systems/AlarmController";
import { Flashlight } from "./systems/Flashlight";
import { FunnelVisual } from "./systems/FunnelVisual";
import { InteriorLights } from "./systems/InteriorLights";
import { LightningSystem } from "./systems/LightningSystem";
import { PlayerController } from "./systems/PlayerController";
import { StructureSystem } from "./systems/StructureSystem";
import { TornadoSystem } from "./systems/TornadoSystem";
import { WindField } from "./systems/WindField";
import { DebugTools } from "./debug/DebugTools";
import { HUD } from "./ui/HUD";
import { RoundUI } from "./ui/RoundUI";

/** One round: scout & shelter → tornado walks in → survive or die → restart. */
export type RoundPhase = "warning" | "active" | "result";

/**
 * Owns every system and runs THE game loop.
 *
 * update(dt) below is the whole game, top to bottom — to find where
 * something happens, start there and follow the numbered stages. Systems
 * never call each other's update; Game decides the order.
 */
export class Game {
  readonly quality: QualitySettings;

  // Rendering
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  // Core
  private readonly physics: Physics;
  private readonly input: InputManager;
  private readonly noise = new Noise();
  /** Wall-clock game time (s) — noise phase for wind gusts, shader time. */
  private time = 0;

  // World & systems (public so debug tooling can poke at them)
  readonly level: Level;
  readonly windField: WindField;
  readonly tornado: TornadoSystem;
  readonly funnelVisual: FunnelVisual;
  readonly structures: StructureSystem;
  readonly debris: DebrisManager;
  readonly player: PlayerController;
  readonly damage: DamageSystem;
  readonly cameraRig: CameraRig;
  readonly flashlight: Flashlight;
  readonly atmosphere: Atmosphere;
  readonly audio: AudioSystem;
  readonly interiorLights: InteriorLights;
  readonly lightning: LightningSystem;
  /** Edge-triggered siren: audible while warning/receding, silent while a
   *  funnel is present (see the alarm block in update). */
  readonly alarm: AlarmController;

  // UI
  readonly hud: HUD;
  readonly roundUI: RoundUI;
  private readonly debug: DebugTools | null;

  /** Round state machine — driven in update() stage 2. */
  phase: RoundPhase = "warning";
  private lastHealth = 100;

  constructor(container: HTMLElement, uiRoot: HTMLElement) {
    this.quality = resolveQuality();

    // antialias:false — the post chain renders into its own targets and SMAA
    // does the anti-aliasing, so an MSAA default framebuffer is wasted cost.
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    // Cap the pixel ratio (QualitySettings): the fill-bound post chain runs at
    // this × logical resolution, so on a HiDPI display this is the biggest GPU win.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Tone mapping happens inside Atmosphere's post chain, not here.
    this.renderer.shadowMap.enabled = this.quality.shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      GameConfig.camera.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      this.quality.drawDistance,
    );

    this.physics = new Physics();
    this.input = new InputManager(this.renderer.domElement);

    this.level = new Level(this.scene, this.physics);
    this.tornado = new TornadoSystem(this.noise);
    this.windField = new WindField(this.tornado, this.noise);
    this.funnelVisual = new FunnelVisual(this.scene, this.tornado, this.quality);
    this.debris = new DebrisManager(this.scene, this.physics, this.quality);
    // ?bare = Phase-1 structural shell only (the perf-gate measurement mode);
    // the default requests full detailing once the Phase-2 furnish pass lands.
    const hospital = buildHospital({
      detail: !new URLSearchParams(location.search).has("bare"),
    });
    // Neighborhood sections (houses, shops, trees) are appended AFTER the
    // hospital's: fixture→section ownership indices point into the hospital
    // range, so the hospital must come first.
    const sections = [...hospital.sections, ...buildNeighborhood()];
    this.structures = new StructureSystem(
      this.scene,
      this.physics,
      sections,
      this.windField,
      this.tornado,
      this.debris,
    );
    this.interiorLights = new InteriorLights(
      this.scene,
      hospital.lightFixtures,
      this.quality,
      this.noise,
      // A fixture dies exactly when its room is gone: no intact block remains
      // within strandRange of its housing. Robust to which block survives (the
      // durable concrete deck/columns can outlive the room without stranding a
      // light — this keys on local enclosure, not on any one anchor block).
      (pos) => !this.structures.anyIntactBlockNear(pos, GameConfig.interiorLights.strandRange),
    );
    this.damage = new DamageSystem();
    this.player = new PlayerController(this.scene, this.physics, this.windField, this.damage);
    this.player.setClimbVolumes(this.structures.climbVolumes);
    this.player.setGripQuery((pos) =>
      this.structures.anyIntactBlockNear(pos, GameConfig.player.gripRange),
    );
    // Interior wind shelter: the player feels less raw wind inside an intact
    // enclosure (roof + windward wall). See StructureSystem.shelterExposureAt.
    this.player.setWindExposureQuery((pos, dir) => this.structures.shelterExposureAt(pos, dir));
    this.cameraRig = new CameraRig(this.camera, this.player, this.windField, this.noise);
    this.flashlight = new Flashlight(this.scene);
    this.atmosphere = new Atmosphere(
      this.scene,
      this.camera,
      this.renderer,
      this.quality,
      this.tornado,
    );
    this.audio = new AudioSystem(this.tornado, this.player, this.windField, this.debris);
    this.atmosphere.onLightning = () => {
      this.cameraRig.addImpulse(0.35);
      this.audio.thunder();
    };
    // Blocks tearing free → a weighty crash (throttled inside AudioSystem).
    this.structures.onBreak = (count) => this.audio.impact(count);

    // Storm lightning: 3D bolts that flash the sky, damage struck structures
    // (reusing the block-break + debris path), and clap thunder — gated to the
    // storm window. Constructed after its dependencies (atmosphere/audio/camera).
    this.lightning = new LightningSystem(
      this.scene,
      this.tornado,
      this.structures,
      this.atmosphere,
      this.audio,
      this.cameraRig,
    );
    // Alarm: start/stop the siren ONCE per transition (edge-triggered), never
    // per frame. Desired state is decided in update()'s alarm block.
    this.alarm = new AlarmController(
      () => this.audio.setSirenLevel(1),
      () => this.audio.setSirenLevel(0),
    );

    this.hud = new HUD(uiRoot);
    this.roundUI = new RoundUI(uiRoot);
    // Restart = full page reload: the simplest guaranteed-clean rebuild of
    // scene, physics world, audio graph, and listeners (flagged in the plan).
    this.roundUI.onRestart = () => location.reload();
    this.debug = DebugTools.enabled()
      ? new DebugTools(
          uiRoot,
          this.scene,
          this.windField,
          this.tornado,
          this.player,
          this.structures,
          this.debris,
          this.interiorLights,
          this.renderer,
          this.physics,
          hospital.stairLights,
          this.lightning,
          this.alarm,
        )
      : null;
  }

  update(dt: number): void {
    // (1) Input — one snapshot per frame; systems never read the DOM directly.
    const input = this.input.poll();
    if (input.flashlightPressed) this.flashlight.toggle();

    // (2) Round state machine: warning (siren, scout, pick shelter) →
    //     active (the storm walks in) → result (survived or died, restart).
    this.time += dt;
    switch (this.phase) {
      case "warning": {
        const left = GameConfig.round.warningTime - this.time;
        this.roundUI.showWarning(left);
        if (left <= 0) {
          this.roundUI.hideWarning();
          this.tornado.begin(); // start the 2–3 pass sequence
          this.phase = "active";
        }
        break;
      }
      case "active":
        if (this.damage.dead) {
          this.player.forceRagdoll(); // collapse — the fling cam becomes the death cam
          this.roundUI.showResult("died");
          this.phase = "result";
        } else if (this.tornado.state === "done") {
          this.roundUI.showResult("survived");
          this.phase = "result";
        } else {
          // Live pass/gap state readout (incoming vs receding/clear).
          this.roundUI.showPassState(
            this.tornado.phase,
            this.tornado.passIndex + 1,
            this.tornado.passesTotal,
            this.tornado.funnelCount,
          );
        }
        break;
      case "result":
        break;
    }
    if (input.restartPressed) location.reload();

    // (3) Tornado passes: straight-line travel + intensity envelope + gaps.
    this.tornado.update(dt);

    // (4) Structures: wake near the tornado, run staggered break checks.
    this.structures.update(dt, this.time);

    // (4b) Storm lightning: schedule strikes, build/strobe/dispose bolts, and
    //      route strike damage through the same block-break + debris path (so
    //      it respects the debris budget). Runs before the physics step so any
    //      blown-off blocks are simulated this frame.
    this.lightning.update(dt, this.time);

    // (5+6) Physics — fixed-timestep step(s) with catch-up cap. The callback
    //       runs before EACH fixed step: things that feed the simulation
    //       (wind drag on debris, the player's kinematic move) belong there
    //       so they always see a constant dt.
    this.physics.step(
      dt,
      (fixedDt) => {
        this.debris.applyWindForces(this.windField, this.time, fixedDt);
        this.player.fixedUpdate(fixedDt, input, this.time);
      },
      // Drain contact-force events per step (they auto-clear on the next
      // step) — this is where debris hits and crushes become damage.
      () => this.damage.drainContactEvents(this.physics, this.player.contactDamageHandle),
    );

    // (7) Player per-frame work: mouse look, mesh/dummy sync.
    this.player.update(dt, input);

    // (8) Sync render transforms from rigid bodies.
    this.debris.syncTransforms();

    // (9) Damage bookkeeping (contact events are drained per fixed step
    //     above); taking a hit also kicks the camera.
    this.damage.update(dt);
    if (this.damage.health < this.lastHealth) {
      this.cameraRig.addImpulse(Math.min((this.lastHealth - this.damage.health) / 25, 1));
    }
    this.lastHealth = this.damage.health;

    // (10) Debris lifecycle: sleep → fade → despawn under budget.
    this.debris.update(dt);

    // (11) Camera mode + shake, then glue the flashlight to the final view.
    this.cameraRig.update(dt, this.time);
    this.flashlight.update(this.camera);

    // (12) Mood: interior lights, funnel visual, atmosphere, audio bed.
    this.interiorLights.update(this.player.position, dt);
    this.funnelVisual.update(dt);
    this.atmosphere.update(dt, this.player.position);
    // Alarm tied to tornado PRESENCE: audible while the storm is warned/incoming
    // (warning phase) and after it recedes between passes (a live pass's state
    // is "gap"), but SILENT while a funnel is actually present (state "pass") so
    // it isn't blaring over the tornado. With a double tornado the state only
    // returns to "gap" once ALL funnels have receded, so the alarm resumes only
    // then. Edge-triggered inside AlarmController — start/stop fire once per
    // transition, never per frame.
    const alarmOn =
      this.phase === "warning" || (this.phase === "active" && this.tornado.state === "gap");
    this.alarm.set(alarmOn);
    this.audio.update(dt, this.time);

    // (13) Render — the whole frame goes through the post chain.
    this.atmosphere.render(dt);

    this.hud.update(
      this.damage.health,
      this.player.stamina * 100,
      this.player.runStamina * 100,
      !this.input.isPointerLocked && this.phase !== "result",
    );
    this.debug?.update(dt);
  }

  onResize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.atmosphere.setSize(width, height);
  }
}
