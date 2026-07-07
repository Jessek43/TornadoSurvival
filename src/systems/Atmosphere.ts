import * as THREE from "three";
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";
import type { QualitySettings } from "../config/QualitySettings";
import type { TornadoSystem } from "./TornadoSystem";

/**
 * Everything mood — this file is where "Teardown, not Roblox" happens.
 *
 *  - A gradient STORM SKY DOME: green-black at the zenith easing to a
 *    lighter desaturated grey-green at the horizon, with faint drifting
 *    cloud mottling. A flat background color read as one dead-black mass;
 *    the gradient gives the scene cheap depth and a horizon to silhouette
 *    against.
 *  - Heavy exponential fog whose color matches the HORIZON (not the black
 *    zenith), so distance fades to haze — depth — instead of to black. Fog
 *    is doing double duty: dread device AND draw-distance limiter.
 *  - A slanted directional "storm light" (the only shadow caster) plus a
 *    cool hemisphere fill bright enough to keep shadowed faces readable —
 *    moody, not pitch-dark.
 *  - The post chain, via `postprocessing`: bloom → chromatic aberration,
 *    then ACES tone map → film grain → vignette → SMAA. The vignette is
 *    kept gentle so it doesn't stack with the dark base and crush the
 *    edges to black.
 *  - A LIGHTNING scheduler: strikes are a Poisson process whose rate rises
 *    as the funnel closes in. A strike spikes the sun, washes the sky/fog
 *    pale green for a few frames, and notifies listeners (thunder, camera
 *    impulse) via onLightning. The flashes are the intended visual PEAK —
 *    everything above aims to make the between-flash scene readable, while
 *    leaving the flash timing and intensity exactly as they were.
 *
 * Flagged trade from the plan: no true motion blur (needs velocity
 * buffers) — grain + hard shake + chromatic aberration sell the violence.
 */

// Sky palette — grounded storm look (the [STORM-SKY] reference): a charcoal
// blue-grey cloud mass overhead with real tonal depth, a BRIGHT dramatic band
// low on the horizon (late-afternoon light under the shelf cloud), and the
// sickly tornado-green demoted to an ACCENT near the cloud base — not a wash
// over the whole scene.
const SKY_ZENITH = 0x14171c; // charcoal blue-grey overhead
const SKY_HORIZON = 0x565c60; // clearly brighter desaturated grey at the horizon
const HORIZON_GLOW = 0x9c8f74; // warm band right at the horizon line
const GREEN_ACCENT = 0x4d5a42; // tornado-green, cloud-base accent only
// Fog matches the horizon so the world dissolves into the sky, not into black.
const FOG_COLOR = 0x3b4043;
// Flash tint recolored to a pale blue-white to match the new palette (a
// CONSTANT — the flash implementation/timing/intensity is untouched).
const FLASH_COLOR = 0xb9c3c9;

export class Atmosphere {
  /** Wired by Game: fires once per lightning strike. */
  onLightning: (() => void) | null = null;

  private readonly composer: EffectComposer;
  private readonly sun: THREE.DirectionalLight;
  private readonly sunBaseIntensity = 1.45;
  private readonly hemi: THREE.HemisphereLight;
  private readonly hemiBaseIntensity = 1.6;

  private readonly sky: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly fog: THREE.FogExp2;
  private readonly vignette: VignetteEffect;
  private static readonly VIGNETTE_BASE = 0.48; // deepened for mood

  /** 0..1 proximity-driven darkness ramp (nearest funnel). Public so the
   *  ?debug HUD can report the exact ramp value (§2d readout). */
  danger = 0;

  private readonly fogBase = new THREE.Color(FOG_COLOR);
  private readonly flashColor = new THREE.Color(FLASH_COLOR);
  // Where the fog is pushed as a funnel bears down: a dark grey-green
  // pre-storm murk, so the world dims AND desaturates toward the storm (§2d).
  private readonly stormFog = new THREE.Color(0x171c18);
  private readonly fogScratch = new THREE.Color();

  /** 1 right at a strike, exponentially decaying to 0. */
  private flash = 0;
  private nextStrikeIn = 5;
  private time = 0;

  // --- BACKGROUND lightning: dim, frequent, far-off flashes that light the
  // cloud base at a random azimuth (shader-only — no scene lights, no sun
  // spike, no thunder/camera hooks). Constant low-level dread UNDER the big
  // close strikes, which remain the untouched visual peak. ---
  private bgFlash = 0;
  private nextBgFlashIn = 2;
  private readonly bgFlashDir = new THREE.Vector2(1, 0);

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    quality: QualitySettings,
    private readonly tornado: TornadoSystem,
  ) {
    // --- gradient sky dome ---
    // Sits just inside the far plane and follows the camera so its edge is
    // never reached. Rendered first, behind everything, and NOT fogged (the
    // sky shouldn't fade into its own fog).
    const radius = Math.min(quality.drawDistance * 0.9, 360);
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(SKY_ZENITH) },
        uHorizon: { value: new THREE.Color(SKY_HORIZON) },
        uGlow: { value: new THREE.Color(HORIZON_GLOW) },
        uGreen: { value: new THREE.Color(GREEN_ACCENT) },
        uFlashColor: { value: this.flashColor },
        uFlash: { value: 0 },
        uBgFlash: { value: 0 },
        uBgFlashDir: { value: this.bgFlashDir },
        uTime: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), this.skyMat);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.fog = new THREE.FogExp2(FOG_COLOR, quality.fogDensity);
    scene.fog = this.fog;

    // Cool hemisphere fill: sky side is a cold blue-grey matching the new
    // cloud mass, ground bounce a neutral warm-dark. Brighter than the old
    // green pass (1.35 vs 0.9) because the new sky/horizon is brighter — the
    // world must not read as black cutouts against it (readability rule).
    // The warm interior pinpricks still pop against this cold exterior fill.
    // Stored so the proximity ramp (update) can dim it as a funnel closes in.
    this.hemi = new THREE.HemisphereLight(0x6a7480, 0x443e34, this.hemiBaseIntensity);
    scene.add(this.hemi);

    // Low, slanted "storm light" — the only shadow caster. Slightly warmed for
    // the late-afternoon-under-the-shelf feel.
    this.sun = new THREE.DirectionalLight(0xd8d2c0, this.sunBaseIntensity);
    this.sun.position.set(-40, 55, -30);
    this.sun.castShadow = quality.shadowsEnabled;
    this.sun.shadow.mapSize.setScalar(quality.shadowMapSize);
    // Ortho shadow frustum widened (±80 → ±110) to cover the near neighborhood
    // houses/trees; same map size (slightly softer texels — acceptable, distant
    // content is fog-swallowed anyway).
    this.sun.shadow.camera.left = -110;
    this.sun.shadow.camera.right = 110;
    this.sun.shadow.camera.top = 110;
    this.sun.shadow.camera.bottom = -110;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 250;
    scene.add(this.sun);

    // --- the grade ---
    // Tone mapping happens inside the chain (ToneMappingEffect), so the
    // renderer must not tone-map on top of it.
    renderer.toneMapping = THREE.NoToneMapping;
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(scene, camera));

    // Bloom threshold raised (0.6 → 0.72) so only genuinely bright things
    // (lightning, the emergency lights) bloom — grey concrete debris no longer
    // blows out to glowing white cubes. The lightning flash is far brighter
    // than this, so it still blooms hard (flash look preserved).
    const bloom = new BloomEffect({
      intensity: 0.7,
      luminanceThreshold: 0.72,
      luminanceSmoothing: 0.25,
      mipmapBlur: true,
    });
    const chromatic = new ChromaticAberrationEffect();
    chromatic.offset.set(0.0011, 0.0006);
    const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    grain.blendMode.opacity.value = 0.24;
    // Deepened vignette (moodier); tightens toward "tunnel vision" as the
    // funnel closes in (see update()).
    this.vignette = new VignetteEffect({ offset: 0.26, darkness: Atmosphere.VIGNETTE_BASE });
    const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });

    // Bloom + CA run in linear HDR; tone map, then grain/vignette/AA on the
    // final image.
    this.composer.addPass(new EffectPass(camera, bloom, chromatic));
    this.composer.addPass(new EffectPass(camera, toneMapping, grain, this.vignette, new SMAAEffect()));
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    this.time += dt;

    // Keep the sky dome centered on the camera so its edge is never reached.
    this.sky.position.copy(this.camera.position);
    this.skyMat.uniforms.uTime.value = this.time;

    // Danger 0..1 — how much the storm should own the sky right now. Keyed off
    // the NEAREST funnel (§2a), so a second funnel darkens the scene on its own.
    const danger = this.tornado.feltIntensity(playerPos.x, playerPos.z, 150);
    this.danger = danger;

    // The vignette tightens toward tunnel-vision as the funnel bears down —
    // a cheap, continuously-scaling dread cue (independent of the lightning).
    this.vignette.darkness = Atmosphere.VIGNETTE_BASE + danger * 0.28;

    // Proximity darkness ramp (§2d): dim the ambient fill + storm light and
    // push the fog toward a dark grey-green as the funnel nears. Ramped by
    // distance (via `danger`), never a hard switch. The sun's danger dimming is
    // folded into its base BEFORE the lightning spike below, so a strike still
    // blows out at full strength.
    this.hemi.intensity = this.hemiBaseIntensity * (1 - 0.5 * danger);
    this.fogScratch.copy(this.fogBase).lerp(this.stormFog, 0.65 * danger);

    // Poisson lightning: exponentially-distributed gaps whose rate rises
    // with danger (a strike every ~20 s far away, every ~2.5 s in the thick
    // of it).
    this.nextStrikeIn -= dt;
    if (this.nextStrikeIn <= 0) {
      const rate = 0.05 + 0.35 * danger;
      this.nextStrikeIn = -Math.log(Math.random()) / rate;
      this.flash = 1;
      this.onLightning?.();
    }
    this.flash *= Math.exp(-8 * dt); // a strike lights the world for ~1/4 s

    // BACKGROUND lightning: an independent, faster Poisson-ish schedule of
    // dim far-off flashes. Shader-only (cloud-base illumination at a random
    // azimuth) — deliberately does NOT spike the sun, tint the fog, or fire
    // onLightning, so the close strikes stay the unmistakable peak.
    this.nextBgFlashIn -= dt;
    if (this.nextBgFlashIn <= 0) {
      // 30% of flashes are quick double-flickers (the reference look).
      this.nextBgFlashIn = Math.random() < 0.3 ? 0.12 + Math.random() * 0.15 : 2 + Math.random() * 4.5;
      this.bgFlash = 0.7 + Math.random() * 0.3;
      const az = Math.random() * Math.PI * 2;
      this.bgFlashDir.set(Math.cos(az), Math.sin(az));
    }
    this.bgFlash *= Math.exp(-11 * dt); // shorter than a close strike — a flicker

    // Flash response — the flash spike/decay/tint strength are unchanged; the
    // sun's danger dimming is folded into its base so a strike still blows out
    // at full strength, and the flash lerps FROM the already-darkened storm fog.
    this.sun.intensity = this.sunBaseIntensity * (1 - 0.45 * danger) * (1 + this.flash * 5);
    this.skyMat.uniforms.uFlash.value = this.flash;
    this.skyMat.uniforms.uBgFlash.value = this.bgFlash;
    this.fog.color.copy(this.fogScratch).lerp(this.flashColor, this.flash * 0.6);
  }

  /** Replaces renderer.render — the whole frame goes through the grade. */
  render(dt: number): void {
    this.composer.render(dt);
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }
}

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // Sphere is centered on origin in object space, so the vertex position
    // is also the view direction to that point on the dome.
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  uniform vec3 uGreen;
  uniform vec3 uFlashColor;
  uniform float uFlash;
  uniform float uBgFlash;
  uniform vec2 uBgFlashDir;
  uniform float uTime;
  varying vec3 vDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    return vnoise(p) * 0.5 + vnoise(p * 2.13) * 0.3 + vnoise(p * 4.31) * 0.2;
  }

  void main() {
    // Vertical gradient: 0 at/below the horizon → 1 overhead.
    float h = smoothstep(-0.12, 0.7, vDir.y);
    vec3 col = mix(uHorizon, uZenith, h);

    // Cloud mottling — strengthened for real tonal depth in the charcoal
    // mass (the reference sky is heavy TEXTURE, not a flat wash).
    vec2 st = vDir.xz / max(abs(vDir.y) + 0.35, 0.35);
    float clouds = fbm(st * 2.2 + vec2(uTime * 0.01, uTime * 0.006));
    col *= 1.0 + (clouds - 0.5) * 0.34 * (1.0 - h * 0.45);

    // Tornado-green as an ACCENT near the cloud base only (a sickly tint in
    // the band just above the horizon), not smeared over the whole dome.
    float gband = smoothstep(0.0, 0.07, vDir.y) * smoothstep(0.34, 0.10, vDir.y);
    col = mix(col, uGreen, gband * 0.30);

    // The bright dramatic band right at the horizon — the warm late-afternoon
    // light escaping under the shelf cloud. Gives the sky depth and the
    // buildings something to silhouette against.
    col += uGlow * exp(-abs(vDir.y) * 6.5) * 0.5;

    // BACKGROUND lightning: a dim far-off flash lights the cloud base in one
    // azimuth sector; modulating by inverted mottling silhouettes the cloud
    // layers against the lit backdrop. Cheap — a few ALU ops on the dome only.
    float sector = smoothstep(0.15, 0.95, dot(normalize(vDir.xz + vec2(1e-4)), uBgFlashDir));
    float low = exp(-max(vDir.y, 0.0) * 5.0);
    col += uFlashColor * uBgFlash * sector * low * (0.5 + 0.6 * (1.0 - clouds)) * 0.4;

    // CLOSE lightning wash — identical strength/timing to before.
    col = mix(col, uFlashColor, uFlash * 0.6);

    gl_FragColor = vec4(col, 1.0);
  }
`;
