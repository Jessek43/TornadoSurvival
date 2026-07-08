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
// The storm sky panorama (assets/images/storm_texture.png). Imported so Vite
// bundles + hashes it; it becomes the scene background (mapped onto the sky
// dome, equirectangular) in place of the old procedural gradient.
import stormTextureUrl from "../../assets/images/storm_texture.png";

/**
 * Everything mood — this file is where "Teardown, not Roblox" happens.
 *
 *  - A STORM SKY DOME textured with the storm panorama
 *    (assets/images/storm_texture.png), sampled equirectangularly and drifting
 *    slowly so it reads as a live cloud mass. It's the scene background: the
 *    dome follows the camera and is drawn first, so looking around reveals the
 *    panorama while moving keeps it fixed to the world. The lightning washes
 *    below still layer on top of it.
 *  - Heavy exponential fog (desaturated grey) so distance fades to haze —
 *    depth — instead of to black. Fog is doing double duty: dread device AND
 *    draw-distance limiter.
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

// The sky dome now shows the storm PANORAMA (stormTextureUrl) instead of a
// procedural gradient; the lightning washes below still layer on top of it.
// Fog stays a desaturated grey so the world dissolves into haze, not into black.
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
    // The storm panorama, sampled equirectangularly in the dome shader. sRGB so
    // the GPU decodes it to linear on sample (matches the linear HDR buffer the
    // post chain tone-maps); RepeatWrapping so the longitude seam wraps cleanly.
    const stormTex = new THREE.TextureLoader().load(stormTextureUrl);
    stormTex.colorSpace = THREE.SRGBColorSpace;
    stormTex.wrapS = THREE.RepeatWrapping;
    stormTex.wrapT = THREE.ClampToEdgeWrapping;
    stormTex.anisotropy = 4;
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uSky: { value: stormTex },
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
  uniform sampler2D uSky;
  uniform vec3 uFlashColor;
  uniform float uFlash;
  uniform float uBgFlash;
  uniform vec2 uBgFlashDir;
  uniform float uTime;
  varying vec3 vDir;

  const float PI = 3.14159265;

  void main() {
    vec3 dir = normalize(vDir);
    // Equirectangular sample of the storm panorama. A very slow longitude drift
    // keeps the cloud mass alive rather than a frozen backdrop (RepeatWrapping
    // makes the drift + the ±PI seam wrap cleanly). uSky is sRGB → the sample
    // is already linear, matching the HDR buffer the post chain tone-maps.
    vec2 uv = vec2(
      atan(dir.z, dir.x) / (2.0 * PI) + 0.5 + uTime * 0.0015,
      clamp(asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5, 0.0, 1.0)
    );
    vec3 col = texture2D(uSky, uv).rgb;

    // BACKGROUND lightning: a dim far-off flash lifts the cloud base in one
    // azimuth sector near the horizon. Cheap — a few ALU ops on the dome only.
    float sector = smoothstep(0.15, 0.95, dot(normalize(dir.xz + vec2(1e-4)), uBgFlashDir));
    float low = exp(-max(dir.y, 0.0) * 5.0);
    col += uFlashColor * uBgFlash * sector * low * 0.5;

    // CLOSE lightning wash — identical strength/timing to before.
    col = mix(col, uFlashColor, uFlash * 0.6);

    gl_FragColor = vec4(col, 1.0);
  }
`;
