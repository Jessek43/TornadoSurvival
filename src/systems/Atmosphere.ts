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
// The storm sky image (assets/images/storm_texture_2.png). Imported so Vite
// bundles + hashes it; it is mapped onto the world-fixed sky DOME (see the dome
// shader below) in place of the old procedural gradient.
import stormTextureUrl from "../../assets/images/storm_texture_2.png";

/**
 * Everything mood — this file is where "Teardown, not Roblox" happens.
 *
 *  - A world-fixed STORM SKY DOME showing the storm image. The dome follows the
 *    camera POSITION but not its rotation, so the sky stays put in the world as
 *    you look around. Because the source is a flat photo (not a 360 pano), the
 *    dome shader MIRRORS the horizontal wrap so its edges meet with no seam, and
 *    caps the zenith/nadir with a solid colour so the poles can't swirl. The
 *    lightning washes still layer on top.
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

  // --- STRIKE flash: an externally-triggered flash (LightningSystem, one per
  // 3D bolt) layered on the SAME sun-spike + sky-wash path as the ambient
  // flasher above, but with its own value / decay / colour so triggering it
  // never disturbs the ambient flash's timing or intensity (mood untouched).
  private strikeFlash = 0;
  private strikeFlashDecay = 11; // per-sec, derived from durationMs on trigger
  private readonly strikeFlashColor = new THREE.Color(FLASH_COLOR);

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
    // --- storm sky dome ---
    // A world-fixed dome (it follows the camera POSITION but not its rotation,
    // so the sky stays put as you look around). Sits just inside the far plane,
    // drawn first, un-fogged. The source is a flat photo, so the dome shader
    // MIRRORS the horizontal wrap (edges meet themselves — no seam) and blends
    // to a solid CAP colour near straight-up/down (no pole swirl). sRGB → the
    // GPU decodes to linear for the HDR buffer the post chain tone-maps;
    // ClampToEdge + anisotropy keep the sampled band crisp, not smeared.
    const radius = Math.min(quality.drawDistance * 0.9, 360);
    const stormTex = new THREE.TextureLoader().load(stormTextureUrl);
    stormTex.colorSpace = THREE.SRGBColorSpace;
    stormTex.wrapS = THREE.ClampToEdgeWrapping;
    stormTex.wrapT = THREE.ClampToEdgeWrapping;
    stormTex.anisotropy = 8;
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uSky: { value: stormTex },
        uFlashColor: { value: this.flashColor },
        uFlash: { value: 0 },
        uBgFlash: { value: 0 },
        uBgFlashDir: { value: this.bgFlashDir },
        // Strike flash — its own scalar + colour so a 3D bolt washes the sky
        // independently of the ambient flasher's uFlash.
        uStrikeFlash: { value: 0 },
        uStrikeFlashColor: { value: this.strikeFlashColor },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), this.skyMat);
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

  /**
   * Fire a strike flash (LightningSystem, one per 3D bolt). Layers onto the
   * existing sun-spike + sky-wash path via a private channel, so the ambient
   * flasher is left exactly as it was. `intensity` may exceed 1 for a
   * blown-out sun; the decay is set so the flash falls to ~5% over durationMs.
   */
  triggerStrikeFlash(intensity: number, durationMs: number, color: THREE.Color): void {
    this.strikeFlash = Math.max(this.strikeFlash, intensity);
    // e^{-k·d} = 0.05 → k = 3/d (seconds).
    this.strikeFlashDecay = 3000 / Math.max(durationMs, 1);
    this.strikeFlashColor.copy(color);
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    // Keep the dome centered on the camera so its edge is never reached — it
    // follows POSITION only, so the sky stays world-fixed as you look around.
    this.sky.position.copy(this.camera.position);

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

    // BACKGROUND lightning: an independent, faster Poisson-ish schedule of dim
    // far-off flashes that light the dome's cloud base at a random azimuth —
    // deliberately does NOT spike the sun, tint the fog, or fire onLightning, so
    // the close strikes stay the unmistakable peak.
    this.nextBgFlashIn -= dt;
    if (this.nextBgFlashIn <= 0) {
      // 30% of flashes are quick double-flickers (the reference look).
      this.nextBgFlashIn = Math.random() < 0.3 ? 0.12 + Math.random() * 0.15 : 2 + Math.random() * 4.5;
      this.bgFlash = 0.7 + Math.random() * 0.3;
      const az = Math.random() * Math.PI * 2;
      this.bgFlashDir.set(Math.cos(az), Math.sin(az));
    }
    this.bgFlash *= Math.exp(-11 * dt); // shorter than a close strike — a flicker

    // STRIKE flash decays on its own schedule (set from durationMs on trigger).
    this.strikeFlash *= Math.exp(-this.strikeFlashDecay * dt);

    // Flash response — the ambient flash spike/decay/tint strength are
    // unchanged; the strike flash is ADDED into the sun spike and washes the
    // sky/fog via its own colour. The sun's danger dimming is folded into its
    // base so a strike still blows out at full strength, and the flash lerps
    // FROM the already-darkened storm fog.
    const flashTotal = this.flash + this.strikeFlash;
    this.sun.intensity = this.sunBaseIntensity * (1 - 0.45 * danger) * (1 + flashTotal * 5);
    this.skyMat.uniforms.uFlash.value = this.flash;
    this.skyMat.uniforms.uStrikeFlash.value = this.strikeFlash;
    this.skyMat.uniforms.uBgFlash.value = this.bgFlash;
    this.fog.color
      .copy(this.fogScratch)
      .lerp(this.flashColor, this.flash * 0.6)
      .lerp(this.strikeFlashColor, Math.min(this.strikeFlash, 1) * 0.5);
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
    // The dome is centered on the origin in object space, so a vertex position
    // is also the view direction toward that point on the sky.
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
  uniform float uStrikeFlash;
  uniform vec3 uStrikeFlashColor;
  varying vec3 vDir;

  const float PI = 3.14159265;

  void main() {
    vec3 dir = normalize(vDir);

    // The source is a FLAT photo, not a seamless 360 pano. Two tricks keep it
    // artefact-free on the world-fixed dome:
    //  1. HORIZONTAL — a triangle wave of the compass angle, so the photo shows
    //     across the front and MIRRORED across the back. Its left/right edges
    //     meet THEMSELVES, so there is no colour-mismatch seam behind you.
    //  2. VERTICAL — the photo rises from the horizon toward the zenith, then
    //     blends into a solid CAP colour (sampled from the photo's own top row)
    //     as you near straight up, so the pole can't pinch or swirl. A darker
    //     cap covers straight-down.
    // vTop / vHorizon are the tunable band: where the photo sits vertically.
    float ang = fract(atan(dir.z, dir.x) / (2.0 * PI) + 0.5); // 0..1 compass
    float u = 1.0 - abs(2.0 * ang - 1.0);                     // 0..1..0 triangle
    float v = mix(0.30, 0.97, clamp(dir.y, 0.0, 1.0));        // horizon..zenith band
    vec3 col = texture2D(uSky, vec2(u, v)).rgb;

    // Zenith cap — a constant colour from the photo's top so straight-up is a
    // smooth sky, never a swirl. Nadir cap — a darker floor (rarely seen; the
    // ground geometry usually covers it) that also kills any bottom-pole swirl.
    vec3 topCap = texture2D(uSky, vec2(0.5, 0.985)).rgb;
    col = mix(col, topCap, smoothstep(0.58, 0.90, dir.y));
    vec3 botCap = texture2D(uSky, vec2(0.5, 0.05)).rgb * 0.6;
    col = mix(col, botCap, smoothstep(0.0, -0.35, dir.y));

    // BACKGROUND lightning: a dim far-off flash lifts the cloud base in one
    // azimuth sector near the horizon. Cheap — a few ALU ops on the dome only.
    float sector = smoothstep(0.15, 0.95, dot(normalize(dir.xz + vec2(1e-4)), uBgFlashDir));
    float low = exp(-max(dir.y, 0.0) * 5.0);
    col += uFlashColor * uBgFlash * sector * low * 0.5;

    // CLOSE lightning wash — identical strength/timing to before.
    col = mix(col, uFlashColor, uFlash * 0.6);

    // 3D-STRIKE wash — an independent flash channel (LightningSystem) so a
    // positioned bolt lights the whole sky in its own colour.
    col = mix(col, uStrikeFlashColor, clamp(uStrikeFlash, 0.0, 1.0) * 0.6);

    gl_FragColor = vec4(col, 1.0);
  }
`;
