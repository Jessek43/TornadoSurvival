# Light ownership — Phase 1 diagnosis (STOP: hypothesis refuted)

**Branch:** `light-ownership` (off `app-shell`, since the teardown/menu that symptom 2 is defined
against lives there and isn't merged to `main` yet).

**Verdict: the STOP condition is met — do not proceed to the prescribed fix.** The two-ownership
hypothesis is half-right on render ownership and **wrong on fracture ownership**. The floating set is
**not** an orphan-dressing-binding problem: there is no dressing layer and no host-binding concept, and
the prescribed "bind each light to a host block" fix is the approach this codebase **already tried and
abandoned** because it produced this exact floating symptom. Details below.

---

## 1. Full light inventory

Every place a light (or light-like emissive) is created, what it is parented to, its type, and its
fracture/dressing registration:

| # | Source | Creation site | Parent | Type | Fracture / dressing / neither |
|---|--------|---------------|--------|------|-------------------------------|
| A | Interior emissive **fixtures** | [`InteriorLights.ts:83,92`](../src/systems/InteriorLights.ts#L83) — one `InstancedMesh` of emissive boxes, positions from `hospital.lightFixtures` ([`Game.ts:155-157`](../src/Game.ts#L155)) | **scene root** | Emissive `MeshBasicMaterial` boxes (unlit, bloom-read); **not** `THREE.Light` | **Neither.** Not section blocks, not a dressing record. Removed by an **enclosure latch** (`dead[]`), not by a host binding — see §3. |
| B | Interior **pool** point lights | [`InteriorLights.ts:96-105`](../src/systems/InteriorLights.ts#L96) — `quality.interiorLightPool` real `PointLight`s that follow the player | **scene root** | `THREE.PointLight` (shadowless) | Neither. Snap to the nearest *alive* fixture each frame; a dead fixture (§3) gets no pool light. |
| C | Exterior **sun** | [`Atmosphere.ts:165,178`](../src/systems/Atmosphere.ts#L165) | **scene root** | `THREE.DirectionalLight`, **shadow-casting** (owns a shadow map) | Neither — global scene light, **legitimately durable** (lights the sky/menu). |
| D | Exterior **hemisphere** fill | [`Atmosphere.ts:160-161`](../src/systems/Atmosphere.ts#L160) | **scene root** | `THREE.HemisphereLight` | Neither — global, **legitimately durable**. |
| E | Lightning **strike** light | [`LightningSystem.ts:115,122`](../src/systems/LightningSystem.ts#L115) | **scene root** | `THREE.PointLight`, intensity 0 when idle | Neither. `reset()` disposes live bolts + zeroes it; the light object stays. |
| F | Player **flashlight** | [`Flashlight.ts:27,36`](../src/systems/Flashlight.ts#L27) (+ a target `Object3D` at :40) | **scene root** | `THREE.SpotLight`, no shadow, intensity 0 when off | Neither — player tool, durable. |

**Emissive "lights" that are actually destructible section blocks** (fracture normally, do **not**
float): the ambulance roof light-bar ([`props.ts:308`](../src/level/hospital/props.ts#L308)) and the
surgical-light cluster ([`props.ts:353`](../src/level/hospital/props.ts#L353)) are coloured/`accent`
**blocks** pushed into their section's `blocks[]`. Corridor "dressing" (cart/wheelchair/bin/cone/
extinguisher/pylon) is likewise pushed into wing-section `blocks[]`
([`furnish.ts:63-68`](../src/level/hospital/furnish.ts#L63)) — *"so props ride the per-section support
flood-fill and are released with the room"* ([`furnish.ts:16-17`](../src/level/hospital/furnish.ts#L16)).

**There are no street lamps** (grep of `Neighborhood.ts` finds none) and **no non-destructible dressing
layer** — every prop is a destructible block. So the "third category" the prompt asks about does not
exist; there is no separate free-standing-light system.

## 2. Counts (integers, current build)

- **Interior fixtures** (emissive boxes, source A): **19** instances in one `InstancedMesh`
  (`verify:hospital` → `fixtures: 19`). *(Was 962 at the last run; the hospital has since been reduced
  — the mechanism is identical either way.)*
- **Orphan fixtures at spawn: 0.** [`verify.ts:145-164 findOrphanFixtures`](../src/level/hospital/verify.ts#L145)
  already asserts every fixture has a **durable** block (`breakThreshold ≥ 550` → concrete/metal) within
  `strandRange` (1.5 m). `verify:hospital` prints `fixtures without enclosure: 0`.
- **Real `THREE.Light` instances at spawn (high preset):** pool 6 (B) + sun 1 (C) + hemi 1 (D) +
  strike 1 (E) + flashlight 1 (F) = **10**. Of these, **2 are menu-legitimate** (sun + hemi); the other
  8 are world-tied.
- **Fixtures with a host-block binding: 0.** No fixture, and no prop record, carries a host-block
  reference. The `stairLights[].mount` field ([`shell.ts:391,416`](../src/level/hospital/shell.ts#L391))
  is a **debug label string** (`"f1 landing"`, `"head roof"`), not a block id.

## 3. Which subset floats — and why it does NOT match the hypothesis

The floating fixtures are **source A** fixtures whose room has been torn open **but whose durable
anchor block survives within `strandRange`**. The removal mechanism already exists and is an **enclosure
latch**, not a host binding:

- [`InteriorLights.ts:145-155`](../src/systems/InteriorLights.ts#L145) probes each alive fixture and
  latches it `dead` (zero-scales the box, kills its pool light) when
  `isStrandedFixture(pos)` → `!structures.anyIntactBlockNear(pos, strandRange)`
  ([`Game.ts:164`](../src/Game.ts#L164)).
- `strandRange` is **1.5 m and deliberately "sized to comfortably reach the ceiling deck… that mounts a
  live fixture"** ([`GameConfig.ts` interiorLights.strandRange comment](../src/config/GameConfig.ts)).

So a ceiling fixture is anchored to the **concrete deck** above it — and concrete is the toughest
material in the level, so the deck routinely **outlives the room's cladding walls**. When the walls tear
off but the deck survives, `anyIntactBlockNear` still finds the deck → the fixture is **not** stranded →
it stays lit and its box stays visible, glowing under a bare surviving slab. **"Some, not all"** is
exactly this: it depends per-fixture on whether its durable deck-anchor survived the pass.

**This is the crux:** the prompt's prescribed fracture-ownership fix — *"every dressing item declares a
host block; when that block releases, its bound dressing is removed"* — is the approach the codebase
**already tried and abandoned**, documented verbatim at
[`InteriorLights.ts:132-140`](../src/systems/InteriorLights.ts#L132):

> *"prior fixes tied the light to one durable block (the ground-floor concrete deck, the toughest thing
> in the level) that survives partial collapse by design, so the light hung in the air above it.
> Checking 'is anything still here?' is robust to WHICH block happens to survive."*

Binding a fixture to a host block reintroduces the bug whenever the host is durable (the natural mount).
Binding it to a *non-durable* wall instead would make the light die too eagerly (a light must survive
its room losing one flimsy wall). The enclosure heuristic was the reaction to exactly this, and it has
the mirror failure mode. **The floating set is therefore neither "the orphan set" (orphans = 0) nor
"exactly one creation site" cleanly — it is a runtime-conditional subset of the single fixture site,
gated on durable-deck survival. Per the prompt's own instruction, that means the hypothesis is wrong.**

## 4. Teardown path

[`Game.teardownSession()` (Game.ts:337-344)](../src/Game.ts#L337) disposes/`reset()`s **only**:
`structures.dispose()`, `debris.reset()`, `tornado.reset()`, `lightning.reset()`, `roundUI.hideWarning()`.

It **does not touch** `InteriorLights`, `Flashlight`, or `Atmosphere`. Those are **durable systems**
built once in the `Game` constructor and never rebuilt/reset (like `AudioSystem`). Their scene-root
objects therefore persist onto the menu:

- **A (fixtures)** — the emissive `InstancedMesh` is the visible culprit on the menu (`toneMapped:false`
  + bloom → glowing boxes floating where the hospital was).
- **B/E/F** — pool lights, strike light, flashlight persist too (mostly intensity 0, so invisible, but
  still `THREE.Light`s in the scene list).
- **C/D** — sun + hemi persist, which is **correct** (the menu backdrop needs them).

So symptom 2's cause is **"the lights live in durable systems the teardown never walks,"** *not*
"parented to the scene root instead of a group." Even a world-group wouldn't be disposed today (teardown
disposes `StructureSystem` specifically, not a group), and 2 of the lights **must** survive teardown.
This is the second reason the render half of the hypothesis doesn't map cleanly onto a single-group fix.

**Bonus finding (a third, distinct issue):** because `InteriorLights` is never reset in
[`buildSession()`](../src/Game.ts#L310), its `dead[]` latch and zero-scaled instance matrices **persist
across a restart**. After menu→play or died→restart, fixtures stranded in the previous round stay dark
in the fresh (rebuilt) world — a restart-parity violation for lights that the app-shell run's
section/released-block parity checks don't cover. This is a *lifecycle* bug (missing `reset()`), again
unrelated to scene-root-vs-group parenting.

## 5. Object3D vs Light disposal

The codebase currently does **neither dispose nor detach** the light systems on teardown — they simply
persist. Where it *does* dispose (e.g. [`StructureSystem.dispose()`](../src/systems/StructureSystem.ts),
[`LightningSystem.disposeBolt`](../src/systems/LightningSystem.ts#L351)) it disposes geometry + material
and removes from the scene. **Nothing currently disposes a shadow map.** Source **C (the sun)** is the
only shadow-caster and owns a `shadow.map` render target
([`Atmosphere.ts:167-177`](../src/systems/Atmosphere.ts#L167)); since the sun must stay durable, its
shadow map should **not** be disposed on teardown at all. So the prompt's "dispose the shadow map for
any shadow-casting light" step has no valid target here (the interior pool, flashlight, and strike light
are all `castShadow = false`).

---

## Why STOP (both STOP-condition clauses are hit)

1. **"The floating set is not explained by orphan bindings."** True. Orphans = 0 at spawn; the floating
   set is fixtures whose durable deck-anchor survived their room. It is an enclosure-heuristic artifact,
   and the host-binding fix the prompt prescribes is the exact approach already tried and abandoned
   (§3). Implementing it as written would reintroduce the documented bug.
2. **"The teardown misses lights for a reason unrelated to parenting."** True. The lights persist
   because they belong to durable systems the teardown never walks (a lifecycle issue), and 2 of them
   (sun/hemi) are legitimately durable and must not be disposed (§4). Plus a distinct missing-`reset()`
   restart-parity bug.

More than one root cause, and the prescribed fix rests on a refuted premise. Per the run's instruction —
*"I would rather have a correct diagnosis than a fix built on a second guess"* — I am stopping here and
not implementing Phase 2.

## Recommended direction (for your decision — not implemented)

- **Symptom 2 (menu):** give `InteriorLights` (and the world-tied portions of `Flashlight` /
  `LightningSystem`) a `hide()`/`show()` or `reset()` driven from `teardownSession()`/`buildSession()`,
  in the idiom of the other systems' `reset()`s — **not** a dispose+recreate, and explicitly **excluding
  sun/hemi**. This also fixes the bonus restart-parity bug (reset `dead[]` + restore instance matrices).
  The "post-teardown light count == baseline" invariant is implementable, but the baseline is **2**
  (sun+hemi), not 0 — worth confirming that framing before I assert it.
- **Symptom 1 (floating):** this is a **design decision**, not a binding bug: *when should a ceiling
  fixture die?* Options — (a) strand on loss of a **non-durable** neighbour (walls), i.e. probe for
  enclosing cladding rather than any durable block; (b) require enclosure on ≥2 sides; (c) a per-room
  "destroyed" signal from `StructureSystem` (the room, not a block, owns the light). Each has trade-offs
  against the mirror failure (dying too eagerly). I'd want your call on the intended rule before coding
  it. **The prescribed single-host-block binding is not viable here** for the reason in §3.
