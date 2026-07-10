# Paved surfaces × heightfield — diagnosis

**Branch:** `paved-surfaces-diagnosis`. No code changes; this note is the deliverable.

## 1. The question

The streets, sidewalks and parking lot are six flat `PlaneGeometry` quads, each set to `heightAt`
at a single centre sample — correct at `terrainAmplitude 0`, floating/buried the moment amplitude
is non-zero. How should these paved surfaces meet the heightfield?

**Recommendation up front: Path A** — subdivide the paved quads and lift their vertices to the
terrain **mesh surface** (not analytic `heightAt`) plus their existing per-class y-tier. §4 states
why and §3 prices the alternatives.

## 2. Findings

Numbers below were computed by a throwaway `tsx` script (scratchpad, not committed) that
instantiates the real `Terrain` from the real world footprints exactly as
[`verify-terrain.ts:29-61`](../scripts/verify-terrain.ts#L29-L61) does, at amplitude 1. Off-pad,
`heightAt` is linear in amplitude ([`Terrain.ts:141`](../src/level/Terrain.ts#L141)), so every
relief figure reads "per metre of amplitude". Run two's verify section re-derives the load-bearing
ones as committed asserts (§5).

### Inventory

- **The six paved quads.** `StreetPatch` ([`Neighborhood.ts:34-49`](../src/level/Neighborhood.ts#L34-L49));
  five patches in `STREET_PATCHES` ([`Neighborhood.ts:58-67`](../src/level/Neighborhood.ts#L58-L67)):
  main street 150×7, two sidewalk strips 150×1.8 / 150×1.0, two cross streets 7×90. The sixth is
  the parking-lot literal, 58×20 at (0, 10) ([`Level.ts:48`](../src/level/Level.ts#L48)).
  `surface` picks the texture by name — `"asphalt" | "sidewalk"` ([`Neighborhood.ts:42`](../src/level/Neighborhood.ts#L42))
  → `makeGroundMaterial(surface, w, d)` ([`Level.ts:90-92`](../src/level/Level.ts#L90-L92)).
- **How patches become meshes.** `Level.addPatch` ([`Level.ts:79-102`](../src/level/Level.ts#L79-L102)):
  an **unsubdivided** `PlaneGeometry(w, d)` at `y = terrain.heightAt(centre) + tier`
  ([`Level.ts:99`](../src/level/Level.ts#L99)). **Purely visual — no collider**; the only ground
  collider is the Rapier heightfield ([`Level.ts:62-70`](../src/level/Level.ts#L62-L70)).
- **The paint y-tiers** (these are NOT in the hospital lift table): lot 0.02
  ([`Level.ts:48`](../src/level/Level.ts#L48)), `Y_STREET 0.03`, `Y_CROSS 0.045`
  ([`Neighborhood.ts:54-55`](../src/level/Neighborhood.ts#L54-L55)). Overlapping pairs (cross×main,
  cross×both sidewalks, lot×south sidewalk) are separated by ≥ 0.01.
- **GroundTextures' plane assumptions.** Header: "ordinary UV-mapped PlaneGeometry meshes … plain
  0..1 UVs and RepeatWrapping" ([`GroundTextures.ts:4-9`](../src/level/GroundTextures.ts#L4-L9));
  repeat derived from plane size, `round(worldW / REPEAT_METERS)`
  ([`GroundTextures.ts:273-275`](../src/level/GroundTextures.ts#L273-L275)). Nothing else assumes
  flatness — displacing vertices in y leaves planar UVs valid (worst texel stretch 1/cos θ ≈ 1.3%
  at the amplitude cap below).
- **The z-fight lift table** ([`params.ts:42-51`](../src/level/hospital/params.ts#L42-L51)):
  `lifts: { ground: 0.06, roof: 0.04 }` — minimum lift **0.04** — consumed by `deckTopY`/`roofTopY`
  ([`params.ts:156-164`](../src/level/hospital/params.ts#L156-L164)). It defends hospital deck/roof
  planes against each other and against the ground; it has never contained the street paint.
- **`worldPadFootprints`** ([`Terrain.ts:207-213`](../src/level/Terrain.ts#L207-L213)): hospital
  envelope + every non-tree section footprint, dilated by `padMargin 3`
  ([`Terrain.ts:117-120`](../src/level/Terrain.ts#L117-L120)). Path B's entire change is appending
  the six paved rects to `authoredPadRects` ([`Terrain.ts:54`](../src/level/Terrain.ts#L54),
  "START EMPTY"), wired at [`Game.ts:177-186`](../src/Game.ts#L177-L186).
- **Other ground consumers.** Lightning scorch: a flat unit disc scaled to radius 1.8
  ([`LightningSystem.ts:386-398`](../src/systems/LightningSystem.ts#L386-L398)) at
  `heightAt + 0.03` ([`LightningSystem.ts:408`](../src/systems/LightningSystem.ts#L408)) — max edge
  gap 1.8 × slope ≈ **0.29 m at the amplitude cap**: floats downslope, clips upslope. Same defect
  class as the quads in miniature; indifferent to the street decision (fix is conforming its verts
  or a shader stamp — mildly prefers C's mechanism, doesn't decide anything). Boundary walls +
  treeline sample `heightAt` per instance ([`Boundary.ts:45`](../src/systems/Boundary.ts#L45),
  [`Boundary.ts:89`](../src/systems/Boundary.ts#L89)) and are guarded by verify assertion 9 —
  indifferent. Debris settles on the heightfield **collider** (no sampling) — indifferent. The
  ambulance-bay ambulance/canopy are hospital sections on the hospital pad, lifted rigidly by
  `liftSectionsToTerrain` ([`Terrain.ts:225-236`](../src/level/Terrain.ts#L225-L236)) — indifferent.

### The numbers (per metre of amplitude)

| paved quad | height range | max slope | on-pad |
|---|---|---|---|
| parking lot 58×20 | 0.033 m | 0.064 | 97.8% |
| main street 150×7 | **1.290 m** | 0.216 | **9.2%** |
| sidewalk 150×1.8 | 0.957 m | 0.179 | 26.9% |
| sidewalk 150×1.0 | 0.746 m | 0.183 | 72.4% |
| cross street −40 | 0.675 m | 0.096 | 18.2% |
| cross street +40 | 0.989 m | 0.209 | 19.3% |

- Whole-map max slope: **0.245/m of amplitude** (field noise, wavelength 16 m,
  [`Terrain.ts:72-74`](../src/level/Terrain.ts#L72-L74)).
- Max grid Δh: **0.660/m of amplitude** → verify assertion 4 (`maxStep 0.5` at `cellSize 3`,
  [`verify-terrain.ts:110-121`](../scripts/verify-terrain.ts#L110-L121)) **caps amplitude at
  ≈ 0.76 m** as tuned. `maxWalkable 0.6` binds only at amplitude ≈ 2.4 m — not the constraint.
- Max |analytic `heightAt` − triangulated-mesh interpolation| over the paved footprints:
  **0.204 m per metre of amplitude** (concentrated where the 3 m mesh cuts the `heightAt` creases
  at pad/apron edges). This is Path A's trap — see §3.
- Path B pad fractions: PlayArea 9.0% → 11.4%; neighbourhood core (x ±75, z −59..41) flat-pad
  **52.1% → 66.0%**, pad components **12 → 2**; core inside pad-or-apron 86.2% → 88.6%.

### The steepest-slope answer

Neither of the anticipated arms holds. Streets do **not** mostly run between pads — the main
street is 9.2% on-pad; the network crosses open field. But the slope is still bounded, by the
field itself: 0.216/m of amplitude on paved footprints, and assertion 4 caps amplitude at ≈ 0.76 m,
so **the steepest slope a paved surface can sit on, without touching any verify assert, is
≈ 0.216 × 0.76 ≈ 0.16 (9.3°)**. Path A is cheap — not for the pad-connectivity reason, but because
the assert regime keeps the entire field shallow. The street↔pad relationship is well-defined
(pads are computed from section footprints before `Level` draws patches, `heightAt` is total and
continuous across pad edges) — the §6 stop condition is not met.

## 3. The three paths

**Path A — subdivide the quads, lift vertices to the terrain surface.**
*Changes:* `Level.addPatch` subdivides each patch (vertices snapped to the 3 m grid lines crossing
the rect) and lifts each vertex the same way the ground mesh does
([`Level.ts:30-37`](../src/level/Level.ts#L30-L37)), plus the patch's existing tier. *The trap:*
lifting to **analytic** `heightAt` leaves the paint and the mesh disagreeing by up to 0.204/m of
amplitude — more than every tier (0.02–0.045) once amplitude ≥ 0.15 m: streets visibly sink into /
float off the ground mesh. The vertices must sample the terrain's **piecewise-linear surface**
(the shared `samples` grid + the mesh triangulation), making paint and ground parallel by
construction; on grid lines the interpolation is diagonal-independent, so snapping subdivision to
grid lines removes any dependence on `PlaneGeometry`'s triangulation convention. *z-fight answer:*
no shared curve — parallel surfaces separated vertically by the tier stack (min pair gap 0.01,
same as today); at the 0.76 m cap, cos θ ≥ 0.987, so vertical separation ≈ normal separation and a
constant lift holds at every slope the field can produce. It fails only under the analytic-sampling
mistake. *Invariant cost:* none — the hospital lift table, `GroundTextures`
(UVs stay planar), and all verify asserts are untouched; run two only adds asserts (§5).
*What breaks:* nothing identified; cost is one pure surface-interpolation helper on `Terrain` +
a vertex loop, both verifiable headless.

**Path B — the paved network joins the pad union.**
*Changes:* six rects appended to `authoredPadRects` ([`Terrain.ts:54`](../src/level/Terrain.ts#L54)).
Zero geometry code; fully reversible. *z-fight answer:* unchanged from today — flat quads at
distinct tiers over a flat pad; no coincident surface. *Cost:* flat-pad fraction of the core rises
52.1% → 66.0% and the pad graph merges 12 → 2 components — the neighbourhood becomes one plate, and
the flattening lands exactly on the most-travelled, most-seen ground (spawn is on the lot; the main
street corridor carries 1.29 m/amp of relief under Path A, zero under B). Honest counterpoint: the
core is already 86.2% pad-or-apron from buildings alone, so B forfeits a 14-point marginal, not
rolling hills — but that marginal is the visible part.

**Path C — delete the quads, paint roads into the terrain mesh.**
*Changes:* the ground material ([`Level.ts:40`](../src/level/Level.ts#L40)) becomes a mask/splat
shader choosing asphalt/sidewalk/earth per fragment; `GroundTextures`' painters survive as texture
sources; `makeGroundMaterial`'s per-plane repeat ([`GroundTextures.ts:273-275`](../src/level/GroundTextures.ts#L273-L275))
degenerates to world-size constants (`REPEAT_METERS` keeps meaning: repeat 75 / 200 over the 300 m
plane — the logic survives in degenerate form). *Two-texture-path rule:* survives with an
amendment — the block/ground boundary stands, but "flat ground paint = UV planes" becomes "ground
paint = splat on the terrain mesh"; a paragraph, not a one-liner. *z-fight answer:* structurally
immune — there is no second surface. *Cost:* the game's first custom ground shader; edge quality —
a 2048² mask over 300 m is 14.6 cm/texel, making the 1.0 m sidewalk 7 aliased texels wide, and the
crisp alternative (the 6 rects as shader uniforms) hard-codes the network's shape into GLSL; the
`Y_CROSS` layering trick becomes shader priority ordering; sidewalk control-joint alignment breaks
across one global UV. Hardest of the three to reverse.

## 4. Recommendation

**Path A.** At every amplitude reachable under the current asserts (≤ 0.76 m) the field is shallow
(paved slope ≤ 0.16), a constant tier lift over a parallel-by-construction surface is airtight, and
the whole cost is a pure helper plus a vertex loop — while B deletes the relief exactly where the
player sees it and C buys immunity to a z-fight that A already avoids, at shader + edge-quality +
reversal cost.

**Second-best: Path B.** It wins if amplitude is ever pushed past ≈ 1.4 m (paved slope > 0.3,
requiring `maxStep` ≥ 0.93 first) — there a draped road reads wrong and roads should grade the
terrain instead, which is exactly B's mechanism; at that amplitude B's flattening is the desired
behaviour, not a loss. C never wins on this map while the paved network is six axis-aligned rects.
The recommendation flips at **amplitude ≈ 1.4 m**; below it A, above it B.

## 5. What run two asserts (verify:terrain additions)

1. `paved vertices on terrain grid lines: N / N` — every subdivision vertex lies on a 3 m grid
   line (diagonal-independent interpolation).
2. `paved vertices lifted to surface + tier: max |Δ| 0.0000 m over N vertices` — vertex y equals
   the terrain surface interpolation plus the patch tier, exactly.
3. `paved↔terrain clearance: min X.XXX m over M probes ≥ 0.01` — 0.25 m-grid probes across all six
   footprints; the paint never dips into the terrain surface between vertices.
4. `overlapping paint pairs under-separated: 0 / P` — every XZ-overlapping patch pair keeps
   |Δtier| ≥ 0.01 (the lot/street/cross stack restated over the curved surface).
5. Existing assertions 4/5/9/10 unchanged (10 flips to its `SKIP` branch when amplitude ≠ 0,
   [`verify-terrain.ts:212-221`](../scripts/verify-terrain.ts#L212-L221)).

Follow-on defect, either way: the scorch disc (§2) needs the same conforming treatment once
amplitude is non-zero; it is out of scope for the street decision.
