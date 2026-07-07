import * as THREE from "three";

/**
 * Procedural surface textures for the FLAT GROUND PAINT — the streets,
 * sidewalks and parking-lot planes stamped by Level.ts. This is a separate
 * concern from BlockTextures.ts: the ground paint is a handful of ordinary
 * UV-mapped PlaneGeometry meshes (not the instanced block world), so it takes
 * the normal MeshStandardMaterial map/bumpMap path with plain 0..1 UVs and
 * RepeatWrapping — no world-space triplanar shader patch needed.
 *
 * Each surface is drawn ONCE into a shared offscreen canvas (albedo + a
 * grayscale height/bump companion), then handed out as fresh CanvasTextures
 * per plane so each plane can carry its own `repeat` (a texture's repeat is a
 * per-texture property; the streets and the lot are different sizes and must
 * tile at the same real-world texel density). Only ~6 ground planes exist, so
 * the per-plane texture objects are a negligible upload.
 *
 * Tones are kept in the storm palette deliberately: asphalt stays near the
 * old flat ASPHALT color, concrete is a muted mid-grey (clearly lighter than
 * the road, with legible control joints) rather than a bright noon sidewalk —
 * the references drive the PATTERN and relative value, not a mood change.
 */

export type GroundSurface = "asphalt" | "sidewalk";

const TEX_SIZE = 256;

/** Real-world meters spanned by one texture tile (sets tiling density). */
const REPEAT_METERS: Record<GroundSurface, number> = {
  asphalt: 4.0, // one 4 m asphalt tile — cracks/aggregate read but don't obviously repeat
  sidewalk: 1.5, // one poured slab per tile → a ~1.5 m control-joint grid
};

const BUMP_SCALE: Record<GroundSurface, number> = {
  asphalt: 0.012, // coarse aggregate tooth
  sidewalk: 0.03, // grooved joints catch the storm light / lightning
};

const ROUGHNESS: Record<GroundSurface, number> = {
  asphalt: 0.97,
  sidewalk: 0.9,
};

// Deterministic PRNG, re-seeded per surface so the pattern is identical across
// rounds and independent of draw order (mirrors BlockTextures.ts).
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
function randRange(a: number, b: number): number {
  return a + (b - a) * rand();
}

interface Canvases {
  albedo: HTMLCanvasElement;
  bump: HTMLCanvasElement;
}

/**
 * Worn asphalt: dense two-tone aggregate speckle over a dark base, a few sealed
 * patches (darker blotches), and jagged hairline cracks — the top-left road
 * reference. Non-directional so it reads the same on the E–W main street and
 * the N–S cross streets.
 */
function paintAsphalt(): Canvases {
  reseed("asphalt");
  const s = TEX_SIZE;
  const albedo = document.createElement("canvas");
  albedo.width = albedo.height = s;
  const a = albedo.getContext("2d")!;
  const bump = document.createElement("canvas");
  bump.width = bump.height = s;
  const bctx = bump.getContext("2d")!;

  // Base coat (near the old flat ASPHALT tone, lifted a hair so aggregate reads).
  a.fillStyle = "#282a2b";
  a.fillRect(0, 0, s, s);
  bctx.fillStyle = "#7a7a7a"; // mid height
  bctx.fillRect(0, 0, s, s);

  // Broad tonal mottle — a few soft blobs so the 4 m tile isn't a flat field.
  for (let i = 0; i < 22; i++) {
    const shade = rand() < 0.5 ? 12 : 60;
    a.fillStyle = `rgba(${shade},${shade},${shade + 2},0.06)`;
    a.beginPath();
    a.arc(rand() * s, rand() * s, randRange(18, 46), 0, Math.PI * 2);
    a.fill();
  }

  // Aggregate: dense fine stones, brighter grit + dark voids (raised in bump).
  for (let i = 0; i < 5200; i++) {
    const light = rand() < 0.55;
    const v = light ? randRange(58, 92) : randRange(8, 26);
    a.fillStyle = `rgb(${v},${v},${v + 1})`;
    const x = rand() * s;
    const y = rand() * s;
    const r = randRange(0.6, 1.9);
    a.fillRect(x, y, r, r);
    // Brighter stones sit slightly proud, voids sink.
    const h = light ? randRange(150, 200) : randRange(40, 80);
    bctx.fillStyle = `rgb(${h},${h},${h})`;
    bctx.fillRect(x, y, r, r);
  }

  // Sealed patches — soft darker asphalt repairs.
  for (let i = 0; i < 3; i++) {
    a.fillStyle = "rgba(10,11,12,0.30)";
    a.beginPath();
    a.ellipse(rand() * s, rand() * s, randRange(20, 40), randRange(14, 30), rand() * Math.PI, 0, Math.PI * 2);
    a.fill();
  }

  // Hairline cracks — jagged dark polylines, cut into the bump.
  const cracks = 5;
  for (let i = 0; i < cracks; i++) {
    let x = rand() * s;
    let y = rand() * s;
    const steps = 6 + Math.floor(rand() * 6);
    a.strokeStyle = "rgba(8,8,9,0.55)";
    a.lineWidth = randRange(0.7, 1.4);
    bctx.strokeStyle = "rgba(30,30,30,0.9)"; // recessed
    bctx.lineWidth = a.lineWidth;
    a.beginPath();
    bctx.beginPath();
    a.moveTo(x, y);
    bctx.moveTo(x, y);
    const dir = rand() * Math.PI * 2;
    for (let k = 0; k < steps; k++) {
      x += Math.cos(dir + randRange(-0.9, 0.9)) * randRange(8, 20);
      y += Math.sin(dir + randRange(-0.9, 0.9)) * randRange(8, 20);
      a.lineTo(x, y);
      bctx.lineTo(x, y);
    }
    a.stroke();
    bctx.stroke();
  }

  return { albedo, bump };
}

/**
 * Poured-concrete sidewalk: light-grey slabs divided by grooved control joints
 * at the tile edges (so tiling yields a continuous joint grid), fine pores, a
 * gentle across-slab gradient and the odd hairline crack — the bottom-left
 * sidewalk reference.
 */
function paintSidewalk(): Canvases {
  reseed("sidewalk");
  const s = TEX_SIZE;
  const albedo = document.createElement("canvas");
  albedo.width = albedo.height = s;
  const a = albedo.getContext("2d")!;
  const bump = document.createElement("canvas");
  bump.width = bump.height = s;
  const bctx = bump.getContext("2d")!;

  // Concrete base — muted mid-grey (lighter than the road, kept storm-toned).
  a.fillStyle = "#6f706a";
  a.fillRect(0, 0, s, s);
  bctx.fillStyle = "#b0b0b0"; // slab face sits high; joints carve down from here
  bctx.fillRect(0, 0, s, s);

  // Faint diagonal cure gradient so a slab isn't a flat swatch.
  const grad = a.createLinearGradient(0, 0, s, s);
  grad.addColorStop(0, "rgba(255,255,255,0.05)");
  grad.addColorStop(1, "rgba(0,0,0,0.05)");
  a.fillStyle = grad;
  a.fillRect(0, 0, s, s);

  // Cement pores / fine speckle.
  for (let i = 0; i < 2600; i++) {
    const dark = rand() < 0.6;
    const v = dark ? randRange(60, 95) : randRange(150, 190);
    a.fillStyle = `rgba(${v},${v},${v - 2},${randRange(0.05, 0.22)})`;
    a.fillRect(rand() * s, rand() * s, randRange(0.6, 1.6), randRange(0.6, 1.6));
  }

  // A couple of small air-bubble pits (tiny dark dots, sunk in bump).
  for (let i = 0; i < 40; i++) {
    const x = rand() * s;
    const y = rand() * s;
    const r = randRange(0.8, 1.6);
    a.fillStyle = "rgba(30,30,28,0.35)";
    a.beginPath();
    a.arc(x, y, r, 0, Math.PI * 2);
    a.fill();
    bctx.fillStyle = "rgba(70,70,70,0.6)";
    bctx.beginPath();
    bctx.arc(x, y, r, 0, Math.PI * 2);
    bctx.fill();
  }

  // Control joints along the top and left edges: each tile draws two of its
  // edges, so adjacent tiles complete a seamless grid. A groove = dark trough
  // with a faint bright lip on the slab side (a chamfered edge).
  const jw = 3.2; // joint width in px
  const drawJoint = (x0: number, y0: number, x1: number, y1: number): void => {
    a.strokeStyle = "rgba(40,41,38,0.85)";
    a.lineWidth = jw;
    a.beginPath();
    a.moveTo(x0, y0);
    a.lineTo(x1, y1);
    a.stroke();
    // Bright chamfer just inside the groove.
    a.strokeStyle = "rgba(230,230,225,0.10)";
    a.lineWidth = 1;
    // Bump: deep trough.
    bctx.strokeStyle = "rgba(40,40,40,1)";
    bctx.lineWidth = jw;
    bctx.beginPath();
    bctx.moveTo(x0, y0);
    bctx.lineTo(x1, y1);
    bctx.stroke();
  };
  drawJoint(0, 1.6, s, 1.6); // top edge (runs along U)
  drawJoint(1.6, 0, 1.6, s); // left edge (runs along V)

  // One or two hairline cracks meandering across a slab.
  for (let i = 0; i < 2; i++) {
    let x = randRange(s * 0.2, s * 0.8);
    let y = randRange(s * 0.2, s * 0.8);
    a.strokeStyle = "rgba(35,35,33,0.4)";
    a.lineWidth = 0.8;
    bctx.strokeStyle = "rgba(80,80,80,0.7)";
    bctx.lineWidth = 0.8;
    a.beginPath();
    bctx.beginPath();
    a.moveTo(x, y);
    bctx.moveTo(x, y);
    const dir = rand() * Math.PI * 2;
    for (let k = 0; k < 7; k++) {
      x += Math.cos(dir + randRange(-1, 1)) * randRange(6, 14);
      y += Math.sin(dir + randRange(-1, 1)) * randRange(6, 14);
      a.lineTo(x, y);
      bctx.lineTo(x, y);
    }
    a.stroke();
    bctx.stroke();
  }

  return { albedo, bump };
}

const canvasCache = new Map<GroundSurface, Canvases>();

function canvasesFor(surface: GroundSurface): Canvases {
  let c = canvasCache.get(surface);
  if (!c) {
    c = surface === "asphalt" ? paintAsphalt() : paintSidewalk();
    canvasCache.set(surface, c);
  }
  return c;
}

/**
 * Build a MeshStandardMaterial for one ground plane of the given world size,
 * tiled at the surface's real-world texel density. Fresh CanvasTextures are
 * minted per call so each plane owns its own `repeat` (the shared source
 * canvas is drawn only once and reused).
 */
export function makeGroundMaterial(
  surface: GroundSurface,
  worldW: number,
  worldD: number,
): THREE.MeshStandardMaterial {
  const { albedo, bump } = canvasesFor(surface);
  const per = REPEAT_METERS[surface];
  const ru = Math.max(1, Math.round(worldW / per));
  const rv = Math.max(1, Math.round(worldD / per));

  const map = new THREE.CanvasTexture(albedo);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(ru, rv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4; // the streets are viewed at a grazing angle

  const bumpMap = new THREE.CanvasTexture(bump);
  bumpMap.wrapS = bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.repeat.set(ru, rv);

  return new THREE.MeshStandardMaterial({
    map,
    bumpMap,
    bumpScale: BUMP_SCALE[surface],
    roughness: ROUGHNESS[surface],
    metalness: 0,
  });
}
