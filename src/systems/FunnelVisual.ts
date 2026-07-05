import * as THREE from "three";
import { GameConfig } from "../config/GameConfig";
import type { QualitySettings } from "../config/QualitySettings";
import type { TornadoSystem } from "./TornadoSystem";

/**
 * The tornado's look — deliberately fake and cheap:
 *  - a tapered open cylinder (wide aloft, narrow at the ground) whose
 *    surface alpha comes from procedural value-noise in the fragment
 *    shader, scrolled downward to read as rising rotation; the vertex
 *    shader adds a low-frequency sway so the column never looks rigid
 *  - one THREE.Points pool for orbiting dust + the ground-dust skirt.
 *    Particles are SCRIPTED to orbit (angle += ω·dt) rather than
 *    integrating the real wind field — integration looks similar but can
 *    spiral out of the visual envelope; scripted stays art-directable.
 * No volumetrics — the fear budget is spent on audio and lighting.
 */
export class FunnelVisual {
  private readonly group = new THREE.Group();
  private readonly column: THREE.Mesh;
  private readonly columnMat: THREE.ShaderMaterial;

  private readonly dust: THREE.Points;
  private readonly dustMat: THREE.PointsMaterial;
  private readonly positions: Float32Array;
  // per-particle orbit state (parallel arrays — cheap and cache-friendly)
  private readonly angle: Float32Array;
  private readonly radius: Float32Array;
  private readonly height: Float32Array;
  private readonly rise: Float32Array;
  private readonly maxY: Float32Array;
  private readonly count: number;

  private time = 0;

  constructor(
    scene: THREE.Scene,
    private readonly tornado: TornadoSystem,
    quality: QualitySettings,
  ) {
    const cfg = GameConfig.tornado;

    // --- the column ---
    const geo = new THREE.CylinderGeometry(
      cfg.coreRadius * 2.4, // wide at the top
      cfg.coreRadius * 0.28, // narrow tip at the ground
      cfg.height,
      28,
      16,
      true, // open-ended
    );
    this.columnMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uHeight: { value: cfg.height },
      },
      vertexShader: COLUMN_VERT,
      fragmentShader: COLUMN_FRAG,
      transparent: true,
      depthWrite: false, // translucent smoke shouldn't occlude itself
      side: THREE.DoubleSide,
    });
    this.column = new THREE.Mesh(geo, this.columnMat);
    this.column.position.y = cfg.height / 2;
    this.column.frustumCulled = false;
    this.group.add(this.column);

    // --- dust pool ---
    // Heavily reduced (was particleCap·0.8): the orbiting sprites were the
    // tell that leaked the funnel's bearing to sheltering players — tall
    // column-riding particles rose above the building and showed through door
    // gaps / stair voids / glass. Keep only a sparse, mostly-low skirt; the
    // darkened column mesh now carries the funnel's look. (Bug 6.)
    this.count = Math.min(Math.floor(quality.particleCap * 0.15), 220);
    this.positions = new Float32Array(this.count * 3);
    this.angle = new Float32Array(this.count);
    this.radius = new Float32Array(this.count);
    this.height = new Float32Array(this.count);
    this.rise = new Float32Array(this.count);
    this.maxY = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) this.resetParticle(i, true);

    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    // Dark dirt/debris, NOT glowing dust — a low, desaturated brown-grey so
    // the particles read as torn earth and rubble rather than bright cubes.
    // toneMapped keeps ACES from lifting them, and the low value keeps them
    // below the bloom threshold so they don't blow out to white.
    this.dustMat = new THREE.PointsMaterial({
      color: 0x231f18,
      size: 1.5,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.dust = new THREE.Points(dustGeo, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);

    this.group.visible = false;
    scene.add(this.group);
  }

  private resetParticle(i: number, randomHeight = false): void {
    const cfg = GameConfig.tornado;
    const R = cfg.coreRadius;
    // Radius skews HARD inward (pow 2.2) and the column is tighter, so the core
    // reads dense and chaotic rather than a loose sparse cloud.
    this.radius[i] = R * (0.4 + 2.0 * Math.pow(Math.random(), 2.2));
    this.angle[i] = Math.random() * Math.PI * 2;
    this.rise[i] = 2 + Math.random() * 7;
    // ~90% live in the low ground skirt (occluded by walls from inside); only a
    // few ride the column, and no higher than ~0.3·height so none tower over
    // the building and betray the funnel's position through gaps. (Bug 6.)
    this.maxY[i] =
      Math.random() < 0.9 ? 2 + Math.random() * 5 : cfg.height * (0.15 + Math.random() * 0.15);
    this.height[i] = randomHeight ? Math.random() * this.maxY[i] : Math.random() * 0.8;
  }

  update(dt: number): void {
    const t = this.tornado;
    this.group.visible = t.intensity > 0.01;
    if (!this.group.visible) return;

    const cfg = GameConfig.tornado;
    this.time += dt;

    this.group.position.set(t.position.x, 0, t.position.z);
    // Spin the whole tube — combined with the shader's vertical scroll this
    // sells rotation without a seamless texture.
    this.column.rotation.y -= dt * 2.2;
    const squeeze = 0.35 + 0.65 * t.intensity; // thin while ramping up
    this.column.scale.set(squeeze, 1, squeeze);
    this.columnMat.uniforms.uTime.value = this.time;
    this.columnMat.uniforms.uIntensity.value = t.intensity;

    // Scripted dust orbit: angular speed falls off with radius like the
    // real swirl does, so inner dust visibly outruns outer dust.
    for (let i = 0; i < this.count; i++) {
      const r = this.radius[i];
      // Faster inner spin (÷max(r,2)) so the core churns violently; a little
      // per-particle radius wobble adds chaos without a real turbulence sim.
      const omega = (cfg.maxTangential * t.intensity * 0.7) / Math.max(r, 2);
      this.angle[i] += omega * dt;
      const wob = 1 + 0.12 * Math.sin(this.angle[i] * 3.3 + i);
      this.height[i] += this.rise[i] * t.intensity * dt;
      if (this.height[i] > this.maxY[i]) this.resetParticle(i);

      const j = i * 3;
      const rw = r * wob;
      this.positions[j] = Math.cos(this.angle[i]) * rw;
      this.positions[j + 1] = this.height[i];
      this.positions[j + 2] = Math.sin(this.angle[i]) * rw;
    }
    (this.dust.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.dustMat.opacity = 0.42 * t.intensity;
  }
}

const COLUMN_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uHeight;
  varying vec2 vUv;
  varying float vH;

  void main() {
    vUv = uv;
    // Normalized height 0 (ground tip) → 1 (top), independent of UV layout.
    vH = (position.y + uHeight * 0.5) / uHeight;

    // Low-frequency sway, stronger near the ground tip, so the column
    // snakes instead of standing like a pillar.
    vec3 p = position;
    float amp = mix(2.4, 0.6, vH);
    p.x += (sin(vH * 9.0 + uTime * 2.1) + 0.6 * sin(vH * 4.3 - uTime * 1.3)) * amp * 0.5;
    p.z += (cos(vH * 7.1 + uTime * 1.7) + 0.6 * cos(vH * 3.7 - uTime * 2.6)) * amp * 0.5;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const COLUMN_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vUv;
  varying float vH;

  // Cheap value noise + 3-octave fbm — enough texture for smoke at a
  // fraction of a texture fetch's authoring cost.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    return vnoise(p) * 0.5 + vnoise(p * 2.17) * 0.3 + vnoise(p * 4.53) * 0.2;
  }

  void main() {
    // Scroll the noise downward → reads as material rising up the funnel.
    vec2 st = vec2(vUv.x * 3.0 + uTime * 0.10, vH * 4.0 - uTime * 0.55);
    float n = fbm(st);
    float body = smoothstep(0.28, 0.72, n);

    // Fade into the sky at the top; keep the ground tip slightly soft.
    float fade = smoothstep(1.0, 0.75, vH) * mix(0.75, 1.0, smoothstep(0.0, 0.15, vH));
    float alpha = body * fade * (0.6 + 0.4 * uIntensity) * uIntensity;

    // Darker, dirtier funnel — near-black in the dense folds easing to a muddy
    // brown-grey, so the column reads as a menacing wall of debris, not pale smoke.
    vec3 col = mix(vec3(0.035, 0.035, 0.03), vec3(0.14, 0.13, 0.10), n);
    gl_FragColor = vec4(col, alpha);
  }
`;
