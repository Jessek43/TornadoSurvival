import * as THREE from "three";
import { type MaterialId } from "../level/Materials";

/**
 * Procedural surface detail for the block world — no asset files, no new
 * render paths. Each MaterialId gets one small canvas texture (near-white,
 * so the per-instance tint colors still drive the hue and the pattern only
 * modulates), and the shared per-material InstancedMesh materials are
 * patched to sample it in WORLD SPACE.
 *
 * Why world-space mapping: every block is one instance of a unit cube whose
 * scale encodes its size, so classic 0..1 UVs would stretch a wall pattern
 * across a 5.4 m deck tile and cram it onto a 0.3 m sill. Projecting by the
 * dominant world-normal axis (a branch-light triplanar pick — blocks are
 * axis-aligned, so exactly one axis dominates) gives uniform texel density
 * on every block for one texture fetch. Draw calls are unchanged; this is
 * the same MeshStandardMaterial pipeline (lights, shadows, fog) with a map.
 */

const TEX_SIZE = 128;
/** World meters covered by one texture repeat. */
const WORLD_REPEAT = 1.6;

// Deterministic PRNG, re-seeded PER TEXTURE from the material id, so every
// texture's speckle is identical across rounds AND independent of the order
// in which materials first request their texture.
let seed = 1;
function reseed(id: string): void {
  seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = ((seed ^ id.charCodeAt(i)) * 16777619) >>> 0;
  seed = (seed % 2147483646) + 1;
}
function rand(): number {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}

type Painter = (ctx: CanvasRenderingContext2D, s: number) => void;

function speckle(ctx: CanvasRenderingContext2D, s: number, n: number, alpha: number): void {
  for (let i = 0; i < n; i++) {
    const shade = rand() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${shade},${shade},${shade},${alpha * (0.4 + rand() * 0.6)})`;
    ctx.fillRect(rand() * s, rand() * s, 1 + rand() * 2, 1 + rand() * 2);
  }
}

const PAINTERS: Partial<Record<MaterialId, Painter>> = {
  // Poured concrete: fine speckle + faint horizontal pour bands.
  concrete: (ctx, s) => {
    speckle(ctx, s, 700, 0.08);
    ctx.fillStyle = "rgba(0,0,0,0.05)";
    for (let y = 0; y < s; y += 32) ctx.fillRect(0, y, s, 2);
  },
  // Wall panels: seam grid + a whisper of noise.
  cladding: (ctx, s) => {
    speckle(ctx, s, 250, 0.05);
    ctx.strokeStyle = "rgba(0,0,0,0.13)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.75, 0.75, s / 2 - 1.5, s - 1.5);
    ctx.strokeRect(s / 2 + 0.75, 0.75, s / 2 - 1.5, s / 2 - 1.5);
    ctx.strokeRect(s / 2 + 0.75, s / 2 + 0.75, s / 2 - 1.5, s / 2 - 1.5);
  },
  // Brickwork: running-bond courses.
  brick: (ctx, s) => {
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 2;
    const rows = 8;
    const rh = s / rows;
    for (let r = 0; r < rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * rh + 1);
      ctx.lineTo(s, r * rh + 1);
      ctx.stroke();
      const off = r % 2 === 0 ? 0 : s / 4;
      for (let x = off; x <= s; x += s / 2) {
        ctx.beginPath();
        ctx.moveTo(x, r * rh);
        ctx.lineTo(x, (r + 1) * rh);
        ctx.stroke();
      }
    }
    speckle(ctx, s, 300, 0.07);
  },
  // Planks: vertical boards with grain streaks.
  wood: (ctx, s) => {
    const boards = 4;
    for (let b = 0; b < boards; b++) {
      ctx.fillStyle = `rgba(0,0,0,${0.04 + rand() * 0.05})`;
      ctx.fillRect((b * s) / boards, 0, s / boards, s);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo((b * s) / boards + 0.75, 0);
      ctx.lineTo((b * s) / boards + 0.75, s);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.06)";
      for (let i = 0; i < 5; i++) {
        const gx = (b * s) / boards + 3 + rand() * (s / boards - 6);
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.bezierCurveTo(gx + 3, s * 0.3, gx - 3, s * 0.7, gx, s);
        ctx.stroke();
      }
    }
  },
  // Brushed metal: fine horizontal streaks.
  metal: (ctx, s) => {
    for (let i = 0; i < 90; i++) {
      const shade = rand() < 0.5 ? 0 : 255;
      ctx.fillStyle = `rgba(${shade},${shade},${shade},${0.04 + rand() * 0.05})`;
      ctx.fillRect(0, rand() * s, s, 1);
    }
  },
  // Painted asphalt-ish body with a soft weathering mottle.
  car: (ctx, s) => speckle(ctx, s, 350, 0.06),
  furniture: (ctx, s) => speckle(ctx, s, 400, 0.07),
  propWhite: (ctx, s) => speckle(ctx, s, 250, 0.04),
  trunk: (ctx, s) => {
    for (let i = 0; i < 22; i++) {
      ctx.strokeStyle = `rgba(0,0,0,${0.08 + rand() * 0.1})`;
      ctx.lineWidth = 1 + rand() * 2;
      const x = rand() * s;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (rand() - 0.5) * 8, s);
      ctx.stroke();
    }
  },
};

// Sheeted floor finish (the reference wards/lobby): a large tile grid with
// grout lines and a sheen speckle. Shared painter for all three floor colors.
const floorPainter: Painter = (ctx, s) => {
  speckle(ctx, s, 200, 0.04);
  ctx.strokeStyle = "rgba(0,0,0,0.16)";
  ctx.lineWidth = 1.5;
  for (const c of [0.75, s / 2 + 0.75]) {
    ctx.beginPath();
    ctx.moveTo(c, 0);
    ctx.lineTo(c, s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, c);
    ctx.lineTo(s, c);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  for (let i = 0; i < 40; i++) ctx.fillRect(rand() * s, rand() * s, 3, 1);
};
PAINTERS.floorBeige = floorPainter;
PAINTERS.floorMustard = floorPainter;
PAINTERS.floorTeal = floorPainter;
PAINTERS.accentOrange = (ctx, s) => speckle(ctx, s, 150, 0.03);
PAINTERS.accentBlue = PAINTERS.accentOrange;
PAINTERS.accentTeal = PAINTERS.accentOrange;
PAINTERS.signRed = PAINTERS.accentOrange;

const cache = new Map<MaterialId, THREE.CanvasTexture | null>();

/** One shared near-white detail texture per material (null = no map: glass
 *  stays clean, foliage stays a cheap flat canopy). */
export function getBlockTexture(id: MaterialId): THREE.CanvasTexture | null {
  if (cache.has(id)) return cache.get(id)!;
  const painter = PAINTERS[id];
  if (!painter) {
    cache.set(id, null);
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f2f2f2"; // near-white base: per-instance colors keep the hue
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  reseed(id); // per-texture seed → speckle independent of first-request order
  painter(ctx, TEX_SIZE);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace; // albedo maps are sRGB
  cache.set(id, tex);
  return tex;
}

/**
 * Patch a block material to sample its map by WORLD position, projected on
 * the dominant normal axis. Instancing-aware: position and normal go through
 * instanceMatrix (blocks are axis-aligned, so the non-uniform instance scale
 * never changes which axis dominates).
 */
export function applyWorldSpaceMap(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWorldRepeat = { value: 1 / WORLD_REPEAT };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vBlockWorldPos;\nvarying vec3 vBlockWorldNormal;",
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        vec4 blockPos = vec4( transformed, 1.0 );
        vec3 blockNormal = objectNormal;
        #ifdef USE_INSTANCING
          blockPos = instanceMatrix * blockPos;
          blockNormal = mat3( instanceMatrix ) * blockNormal;
        #endif
        vBlockWorldPos = ( modelMatrix * blockPos ).xyz;
        vBlockWorldNormal = normalize( mat3( modelMatrix ) * blockNormal );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vBlockWorldPos;\nvarying vec3 vBlockWorldNormal;\nuniform float uWorldRepeat;",
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec3 wAbs = abs( vBlockWorldNormal );
          vec2 wUv = ( wAbs.y > wAbs.x && wAbs.y > wAbs.z )
            ? vBlockWorldPos.xz
            : ( wAbs.x > wAbs.z ? vBlockWorldPos.zy : vBlockWorldPos.xy );
          diffuseColor *= texture2D( map, wUv * uWorldRepeat );
        #endif`,
      );
  };
  // Distinct program cache key so patched and stock standard materials never
  // share a compiled program.
  material.customProgramCacheKey = () => "block-world-uv";
}
