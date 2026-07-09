import * as THREE from "three";
import { GameConfig } from "./config/GameConfig";
import { resolveQuality, type QualitySettings } from "./config/QualitySettings";
import { InputManager, type InputState } from "./core/InputManager";
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
import { AppFlow, type AppState } from "./systems/AppFlow";
import { SurviveAllPasses } from "./systems/Objective";
import { loadSettings } from "./config/Settings";
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
import { Screens, type ResultSummary } from "./ui/Screens";

/**
 * Sub-phase WITHIN an app-flow "playing" round: warning (siren, scout, pick
 * shelter) → active (the storm walks in). The terminal (survived/died) is an
 * AppFlow state, not a round phase: the active phase asks the Objective every
 * tick and, the frame it turns terminal, hands straight to the flow — no
 * intermediate phase, no timer (the overlay's own opacity fade is the only
 * softening; see GameConfig.shell.fadeDuration).
 */
export type RoundPhase = "warning" | "active";

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
  private readonly screens: Screens;
  private readonly debug: DebugTools | null;

  /** Application flow: menu → playing → survived/died → restart. The shell owns
   *  session build/teardown + whether the sim ticks; it never ticks systems. */
  readonly flow: AppFlow;
  /** The one place the win condition lives — asked each active tick. */
  private readonly objective = new SurviveAllPasses();

  /** Round sub-phase within `playing` — driven in the sim tick. */
  phase: RoundPhase = "warning";
  private lastHealth = 100;
  /** Round summary captured at resolution, shown on the result screen. */
  private lastResult: ResultSummary | null = null;
  /** Guard the first simulated frame after (re)acquiring pointer lock so a
   *  paused stretch doesn't feed one huge dt into the storm. */
  private resumeGuard = true;
  /** Countdown suppressing the resume overlay while pointer lock is being
   *  acquired (granted a frame or two after the Play/Resume click gesture). */
  private lockGrace = 0;

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

    // Application flow. Every session build/teardown side-effect happens in
    // onFlowChange — the pure AppFlow just owns the legal transitions. Restart
    // is now an IN-PLACE rebuild (buildSession), not a page reload.
    this.flow = new AppFlow((from, to) => this.onFlowChange(from, to));

    // Screen overlays (menu / result / resume). Buttons drive the flow; Play /
    // Resume additionally grab pointer lock from the click gesture. The goal
    // line + result prose come from the single Objective (no duplicated text).
    this.screens = new Screens(
      uiRoot,
      {
        onPlay: () => this.startPlaying("start"),
        onPlayAgain: () => this.startPlaying("playAgain"),
        onRetry: () => this.startPlaying("retry"),
        onToMenu: () => this.flow.transition("toMenu"),
        onResume: () => this.acquirePointerLock(),
      },
      this.objective.describe(),
    );

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
          this.flow,
        )
      : null;

    // Land on the menu: no session runs behind it (tear the constructor's build
    // down to the clean menu state). The Play button starts the first round.
    this.teardownSession();
    this.screens.showMenu();
  }

  /** Enter (or restart) a round from a click gesture: grab pointer lock, then
   *  drive the flow. Both happen inside the gesture so the lock request is
   *  honored. `startPlaying` is used by Play / Play-again / Retry. */
  private startPlaying(event: "start" | "playAgain" | "retry"): void {
    this.acquirePointerLock();
    this.flow.transition(event);
  }

  /** Request pointer lock and open the acquire-grace window (suppresses the
   *  resume overlay until the browser grants the lock a frame or two later). */
  private acquirePointerLock(): void {
    this.lockGrace = GameConfig.shell.lockAcquireGrace;
    void this.renderer.domElement.requestPointerLock();
  }

  /**
   * React to a flow transition — the shell's side effects. Building a session
   * (structures rebuild + system resets) and tearing it down to the menu both
   * live here; the pure AppFlow does none of this.
   */
  private onFlowChange(_from: AppState, to: AppState): void {
    switch (to) {
      case "playing":
        this.buildSession();
        this.screens.hideAll();
        break;
      case "survived":
        document.exitPointerLock();
        this.screens.showResult("survived", this.lastResult);
        break;
      case "died":
        document.exitPointerLock();
        this.screens.showResult("died", this.lastResult);
        break;
      case "menu":
        this.teardownSession();
        this.screens.showMenu();
        break;
    }
  }

  /**
   * Enter a fresh round: rebuild the destructible world and reset every stateful
   * system to its first-spawn baseline (restart parity), then apply the user's
   * persisted look sensitivity (read ONCE here, not threaded through update).
   */
  private buildSession(): void {
    this.structures.rebuild();
    this.debris.reset();
    this.tornado.reset();
    this.damage.reset();
    this.player.reset();
    this.lightning.reset();
    this.cameraRig.reset();
    this.flashlight.reset();
    this.player.sensitivity =
      GameConfig.player.mouseSensitivity * loadSettings().sensitivity;

    this.phase = "warning";
    this.time = 0;
    this.lastHealth = this.damage.health;
    this.roundUI.hideWarning();

    // Snap the camera + mood to the fresh spawn ONCE (dt 0) so the couple of
    // frames rendered before pointer lock is granted show the correct view, not
    // a stale/default camera. The per-frame sim stages take over once locked.
    this.cameraRig.update(0, this.time);
    this.atmosphere.update(0, this.player.position);

    // Parity readout: sections + released-block count on entry (see ?debug).
    this.debug?.logSessionBaseline();
  }

  /** Return to the menu: drop the world so nothing simulates behind it. */
  private teardownSession(): void {
    this.structures.dispose();
    this.debris.reset();
    this.tornado.reset();
    this.lightning.reset();
    this.roundUI.hideWarning();
  }

  update(dt: number): void {
    // (1) Input — one snapshot per frame (always polled so mouse deltas don't
    // accumulate while paused); systems never read the DOM directly.
    const input = this.input.poll();

    // The shell decides whether the SIMULATION ticks: only while actively
    // playing AND the pointer is locked. The menu, the result screens, and a
    // lost pointer lock all freeze the sim — the round timer included — as one
    // unit. There is still ONE update() and ONE caller (main.ts); render +
    // overlays below always run so the canvas is never black while paused.
    this.lockGrace = Math.max(0, this.lockGrace - dt);
    const locked = this.input.isPointerLocked;
    const playing = this.flow.state === "playing";
    // Resume overlay: playing but lock lost (Esc / tab away), once the
    // acquire-grace after a Play/Resume click has elapsed.
    this.screens.setResumeVisible(playing && !locked && this.lockGrace <= 0);

    if (playing && locked) {
      // Guard the first frame after (re)acquiring lock against a dt spike from
      // the paused stretch.
      const simDt = this.resumeGuard ? Math.min(dt, GameConfig.physics.fixedDt) : dt;
      this.resumeGuard = false;
      this.tickSimulation(simDt, input);
    } else {
      this.resumeGuard = true;
    }

    // Siren gate — evaluated EVERY frame (re-reading flow.state AFTER the sim
    // tick, which may have just resolved the round), through the edge-triggered
    // AlarmController. Audible only while actively playing (pointer locked) and
    // the storm is warned/incoming (warning) or receding between passes (a live
    // pass's tornado state is "gap"); SILENT while a funnel is present, and — the
    // fix — silent the instant the round resolves (flow leaves "playing"), on
    // pause (lock lost), and on the menu. One stop edge, fired once, no per-frame
    // re-trigger (AlarmController dedupes); no round knowledge inside it.
    const sirenOn =
      this.flow.state === "playing" &&
      locked &&
      (this.phase === "warning" || (this.phase === "active" && this.tornado.state === "gap"));
    this.alarm.set(sirenOn);

    // (13) Render + overlays — every frame, even paused / on a menu.
    this.atmosphere.render(dt);
    this.hud.update(
      this.damage.health,
      this.player.stamina * 100,
      this.player.runStamina * 100,
      false, // click-to-play prompt superseded by the menu + resume overlay
    );
    this.debug?.update(dt);
  }

  /**
   * The whole simulation — the round sub-phase machine plus the numbered sim
   * stages. Runs only while playing with pointer lock (the shell's gate above);
   * systems still never call each other's update, Game decides the order.
   */
  private tickSimulation(dt: number, input: InputState): void {
    if (input.flashlightPressed) this.flashlight.toggle();

    // (2) Round sub-phase within `playing`: warning (siren, scout, pick shelter)
    //     → active (the storm walks in). The win condition is the Objective's —
    //     this loop only ASKS it, and the frame the verdict turns terminal it
    //     hands straight to the flow (no intermediate phase, no timer).
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
      case "active": {
        const verdict = this.objective.evaluate({
          dead: this.damage.dead,
          tornadoDone: this.tornado.state === "done",
          passesTotal: this.tornado.passesTotal,
        });
        if (verdict === "pending") {
          // Live pass/gap state readout (incoming vs receding/clear).
          this.roundUI.showPassState(
            this.tornado.phase,
            this.tornado.passIndex + 1,
            this.tornado.passesTotal,
            this.tornado.funnelCount,
          );
        } else {
          // Terminal — resolve on THIS edge, no intermediate phase, no timer.
          // Snapshot the summary first (tornado state is reset only next round),
          // collapse on death, then hand straight to the flow. The result
          // overlay's opacity fade (shell.fadeDuration) is the only softening;
          // the siren stops immediately via the flow-aware gate in update().
          this.lastResult = {
            passesSurvived:
              verdict === "won" ? this.tornado.passesTotal : this.tornado.passIndex,
            passesTotal: this.tornado.passesTotal,
            timeSec: Math.max(0, this.time - GameConfig.round.warningTime),
          };
          if (verdict === "lost") this.player.forceRagdoll(); // collapse → death cam
          this.roundUI.hideWarning();
          this.flow.transition(verdict === "won" ? "win" : "lose");
        }
        break;
      }
    }

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

    // (12) Mood: interior lights, funnel visual, atmosphere, audio bed. (The
    // siren gate lives in update() so it can stop as an edge on the terminal /
    // pause / menu transition, when this method no longer runs.)
    this.interiorLights.update(this.player.position, dt);
    this.funnelVisual.update(dt);
    this.atmosphere.update(dt, this.player.position);
    this.audio.update(dt, this.time);
  }

  onResize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.atmosphere.setSize(width, height);
  }
}
