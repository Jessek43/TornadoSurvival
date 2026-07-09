# CLAUDE.md

Guidance for Claude Code working in this repository. Read the [README](README.md) first for what the game is and how to run it; this file is about *how to work here*.

## Commands

```bash
npm run dev              # dev server (Vite) — HMR
npm run build            # production build to dist/
npm run typecheck        # tsc --noEmit, strict — run this after every change
npm run preview          # serve the production build
npm run verify:hospital  # static hospital invariants (terminating; no dev server)
npm run verify:lightning # static lightning/alarm invariants (config caps + alarm edges)
```

## Skills

Project skills live under `.claude/skills/` in two collections. They **auto-activate from their own `SKILL.md` when the task matches — this doc neither enables nor invokes them.**

- **`web-engines/`** — per-engine web-rendering skills; the subset relevant here is **three.js** (`threejs-scene-setup`, `threejs-materials-lighting`, `threejs-gltf-loading` — Scene/renderer/loop, PBR materials & lighting, glTF loading + animation). Also ships `phaser-core`, `phaser-arcade-physics`, and `pixijs-rendering` for other web engines this project doesn't use.
- **`disciplines/`** — engine-neutral game-craft: `performance-optimization`, `physics-tuning`, `game-feel`, `camera-systems`, `game-ui-ux`, `input-systems`, `level-design`, `procedural-gen`, `save-systems`, `audio-design`, `shader-programming`, `dialogue-systems`, `game-ai`.

Lean on the **three.js** skills for Three.js geometry, mesh, material, lighting, and model-loading work; lean on the **discipline** skills (notably `performance-optimization` and `physics-tuning`) for the perf-budget and physics/collider work behind the norms below. Matching keys off each `SKILL.md` description, so **name the stack explicitly (Three.js / Rapier / TypeScript) in prompts** to make the right skill fire — Rapier has no dedicated skill, so physics work leans on `physics-tuning`.

There is **no test suite** and no linter beyond `tsc`. `tsconfig` is strict with `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch` — dead code and unused params are hard errors, so keep edits tidy.

## Deployment (live)

- Live on Vercel: **tornadosurvivalv0.vercel.app**.
- Production deploys **automatically on push to `main`** (connected GitHub repo).
- For anything non-trivial: work on a **branch** → check the Vercel **preview deploy** → merge to `main` to ship. **Don't push untested changes straight to `main`** — it's the public link.
- **Web Analytics:** wired via `@vercel/analytics` — `inject()` is called once at the top of [`main.ts`](src/main.ts)'s `boot()` (framework-agnostic path, since this is a plain Vite/TS SPA — not the React/Next helper). It's a no-op in local dev and only reports from the deployed site. **Data only flows once Analytics is enabled for the project in the Vercel dashboard** (Analytics tab → Enable) — a one-time toggle, not something in the code.

## Current status

- **Game loop / app shell:** now closed by a pure, THREE-free flow controller ([`AppFlow.ts`](src/systems/AppFlow.ts), the [`AlarmController`](src/systems/AlarmController.ts) idiom): **menu → playing → survived | died → (restart) → playing / → menu** ✅. Main menu (title, Play, control legend, mouse-sensitivity slider) ✅ · explicit **survived / died** result screens with passes+time summary ✅ · **in-place restart** (no page reload) ✅. The win condition lives in ONE seam — [`Objective.ts`](src/systems/Objective.ts) `SurviveAllPasses` (`dead → lost`, else `tornadoDone → won`, else `pending`); AppFlow asks it, never reads round state. Within `playing` the round runs warning → passes → a short `resolving` beat (`shell.resultDelay`) → terminal. Screens are DOM overlays ([`Screens.ts`](src/ui/Screens.ts)) over the existing canvas. Static invariants: `npm run verify:flow`.
- **Shell teardown / pause:** restart/return-to-menu **rebuild the destructible world in place** — `StructureSystem.rebuild()` (dispose+build from the same section specs; never reverses monotonic `block.released`) + `reset()` on the stateful systems, all on **stable instances** in the shared Rapier world (renderer / camera / audio context stay durable; no GPU/AudioContext churn). Entity + released-block counts return to the first-spawn baseline by construction (readable in the `?debug` overlay on each entry to playing). The shell **gates whether `Game.update` ticks the sim** (playing + pointer locked); losing pointer lock **pauses everything** (round timer included) behind a "click to resume" overlay — still ONE loop, ONE caller. **User settings** (mouse sensitivity) persist via [`Settings.ts`](src/config/Settings.ts) (localStorage, total `loadSettings`), applied once at look-init.
- **Tornado:** now **multi-funnel** — 1 funnel normally, 2 on a per-round roll. [`WindField.sample`](src/systems/WindField.ts) **superposes** every live funnel (still the single wind source); consumers that must react to all funnels use `tornado.nearestFunnelDist` / `feltIntensity`, while `.position`/`.intensity` track the PRIMARY funnel for the HUD/siren.
- **Player toolkit:** move / look / jump ✅ · **sprint** (Shift — drains the SPRINT stamina bar, regens while walking) ✅ · **crouch** (C — really shrinks the capsule, bottom-pinned so only the head drops) ✅ · **flashlight** (F — camera-mounted spot, [`Flashlight.ts`](src/systems/Flashlight.ts)) ✅. Grip / hold-on is now **E only** (Shift moved to sprint); wind stagger, grip stamina and the ragdoll fling are unchanged.
- **Hospital interior:** REBUILT as a per-floor cell-grid **partition layer** (see [the hospital section](#the-hospital-interior-per-floor-partition-layer) below). All 7 storeys are now genuinely enclosed — themed rooms + winding corridors + doorways, stair cores walled off with one doorway per floor — replacing the old open plate. Every build-time invariant is green (bare + detailed): coplanar 0, unsupported 0, every room reachable, 7 distinct floors, no open plate.
- **Hospital furnishing & decoration** (branch `hospital-overhaul`, in progress): a **vertical slice** on the Floor-3 ward room types — `patient`/`office`/`kitchen`/`nurse_station` routines enriched with department equipment scaled to room size; every room carries a **department-colour soffit band** (`deptAccent`, reuses existing accent ids); **corridors are now DRESSED** with a sparse wall-hugging floor-standing prop scatter (cart / wheelchair / bin / cone / extinguisher / wayfinding pylon) — the old "corridors stay bare" rule is retired, and `verify.ts` proves circulation with a capsule flood (`checkCorridorCirculation`). **Interior lighting lifted for readability** (brighter/steeper-falloff follow-light pool + a corridor-fixture-run fix in `partition.ts`). An **intact** fixture now always keeps a visible brightness floor in [`InteriorLights.baseBrightness`](src/systems/InteriorLights.ts) (failing 0.3 / weak 0.55 / full 1) so it still glows and casts light — the old 0.03 "burned-out" tier rendered as a solid black box that emitted nothing; a fixture only goes fully dark when its **room is destroyed** (the `dead` enclosure latch), never merely for variety. Verify green (coplanar 0, choked 0, enterability 0). **Pending Jesse's in-browser confirm; the OTHER departments (ICU / surgical / imaging / maternity / labs) still use the leaner base furnish — the "replicate" phase.**
- **Exterior detail:** streets / sidewalks / lot carry procedural **asphalt + concrete-slab** textures ([`GroundTextures.ts`](src/level/GroundTextures.ts)); the ambulance-bay **ambulance** is a detailed white Type-III rig (existing materials only — no new draw call). **Street trees are kept clear of buildings**: [`Neighborhood.ts`](src/level/Neighborhood.ts) snapshots every house/shop footprint (widest extent — roof eaves + porches) after placement, and each tree goes through an `addTree` pass that shoves a colliding tree out along its shallower-penetration axis (min-translation, keeping a 0.4 m gap) and drops it only if it can't clear within 2.5 m — so a canopy never grows through a wall. Trees are decorative sections appended AFTER the hospital, so nudging/dropping one never disturbs the hospital fixture→section indices.
- **Performance:** ~165 fps on dev desktop + laptop — comfortable headroom over the 60 fps target. Mobile / low-end not yet verified; quality-preset selection path not built.
- **Atmosphere:** the storm SKY is now an imported image — `assets/images/storm_texture_2.png` mapped onto the world-fixed sky DOME in [`Atmosphere.ts`](src/systems/Atmosphere.ts) (mirrored horizontal wrap so a non-panoramic photo's edges meet with no seam + a solid zenith/nadir cap so the poles don't swirl; the lightning washes still layer on top). The rest is still dark / green-tinted; de-haze pass pending.
- **Storm lightning + alarm** (see [the lightning section](#storm-lightning--alarm) below): [`LightningSystem.ts`](src/systems/LightningSystem.ts) fires infrequent 3D bolts during a pass — a jagged emissive tube cloud→impact, a sky/scene flash (via a **separate** strike-flash channel in `Atmosphere` so the ambient mood flasher is untouched) + a brief local impact light, structure damage routed through the existing block-break/debris path, and a loud thunder rumble. All tuned in [`LightningConfig.ts`](src/config/LightningConfig.ts). The **siren is now edge-triggered** ([`AlarmController.ts`](src/systems/AlarmController.ts)): audible during the warning + between-pass gaps, SILENT while a funnel is present, so it isn't blaring over the actual pass.

## Known issues

- **Floor z-fighting:** the **hospital** is now z-fight-free by construction — `verify:hospital` asserts **coplanar same-facing overlaps == 0** (bare + detailed), and the z-fight lift table gives each horizontal surface class its own y-plane. The **neighborhood / ground planes** are not yet under the same static assert, so if flicker resurfaces it'll be there. *Hospital fix not yet visually re-confirmed in-browser.*

## Architecture invariants (do not break these)

- **One loop owns everything.** [`Game.ts`](src/Game.ts) `update(dt)` runs numbered stages top-to-bottom. Systems **never** call each other's `update` — `Game` decides order. Add new per-frame work as a stage in `Game.update`, not as a hidden callback between systems.
- **Fixed timestep.** Anything that feeds the simulation (wind forces, the player's kinematic move) runs in `Physics.step`'s per-fixed-step callback so it sees a constant `dt`. Render-rate work (mouse look, mesh sync) runs once per frame.
- **One WindField, read by all.** [`WindField.ts`](src/systems/WindField.ts) `sample(pos, t)` is the single source of wind. Structures, player, debris, funnel, and audio all key off it — change wind behaviour there, not in consumers.
- **Tuning lives in config.** Gameplay numbers go in [`GameConfig.ts`](src/config/GameConfig.ts); performance knobs in [`QualitySettings.ts`](src/config/QualitySettings.ts). Don't scatter magic numbers into systems.

## The destructible-section model (reuse it, don't fork it)

The world is a list of `SectionSpec`s (wings, houses, trees, props) turned into instanced, destructible structures by [`StructureSystem.ts`](src/systems/StructureSystem.ts). New destructible content = **more sections**, never a parallel system. A section:

- renders in the shared per-material `InstancedMesh` (instanced-while-static),
- is **dormant** (one compound body) until the funnel's `wakeRadius` reaches it, then **awake** (one fixed body per block, individually releasable),
- **re-sleeps** (merges survivors back to one compound) when the funnel moves on,
- feeds the capped [`DebrisManager`](src/systems/DebrisManager.ts) pool when blocks break.

`block.released` is **monotonic** and is never set by `sleep()`/`wake()` — it means genuine destruction. Use it (not section state) whenever you need "is this geometry actually gone." Interior lights key off this indirectly via **local enclosure**: a fixture is extinguished when `anyIntactBlockNear(pos, strandRange)` finds nothing — the room is gone — which is robust to *which* block survives and is retained through a mere re-sleep.

## Storm lightning & alarm

Both features **reuse existing systems** — no parallel destruction, audio, or state machine. Everything is tuned in [`LightningConfig.ts`](src/config/LightningConfig.ts) (a THREE-free sibling of `GameConfig`, so the verify script can import it). Static invariants: `npm run verify:lightning`.

- **Strikes** ([`LightningSystem.ts`](src/systems/LightningSystem.ts), Game `update` stage **4b**, before the physics step). Work happens on strike **events**; the per-frame update only counts a timer down and strobes/expires live bolts (no allocation), so 60 fps holds mid-strike. Each strike: pick a target (biased — `nearTornado` prefers a real structure near the funnel, then scatters), `StructureSystem.strikeRaycastDown` finds the impact + structure-vs-ground, build one jagged emissive tube (+ branches, disposed after `boltLifetimeMs`), flash + local impact light, damage, thunder.
- **Damage reuses the block-break path.** `StructureSystem.strikeDamage(point, radius, impulse, maxBlocks, time)` breaks the nearest intact blocks via the **same** `release()` + `collapseUnsupported()` + `onBreak` machinery as a wind sweep. It hits a **dormant** section in place — `release()` detaches that block's collider from the compound via the new `RuntimeBlock.dormantCollider` handle — so there's **no full-section wake/re-sleep churn** for a one-off hit. Direct destruction is hard-capped at `maxBlocksPerStrike`; any support-collapse beyond that is bounded by the global debris budget (`DebrisManager` evicts before every spawn), so a strike can never exhaust the pool.
- **Flash is a separate channel.** `Atmosphere.triggerStrikeFlash()` layers onto the same sun-spike + sky-wash path but with its **own** value/decay/colour uniforms (`uStrikeFlash`/`uStrikeFlashColor`), so the ambient Poisson mood flasher is left **byte-identical** (respecting "don't retune mood").
- **Thunder reuses `AudioSystem.thunder`.** A strike is the **same** deep rumble as the ambient sky-flash thunder, just louder (`thunderVolume`) and prompter — no separate "crack" layer (it read as an electric zap). `thunder(volume?, delayMs?)` stays backward-compatible with the ambient caller.
- **Alarm is edge-triggered** ([`AlarmController.ts`](src/systems/AlarmController.ts)) — a pure, THREE-free gate that fires start/stop **once per transition**, never per frame. Game drives it audible during `warning` + between-pass `gap`, silent while `tornado.active` (a funnel present). Double tornado: `state` returns to `gap` only after **all** funnels recede, so the alarm resumes only then. The pure class is what `verify:lightning` drives through a synthetic state sequence to prove the edges.

## The hospital interior (per-floor partition layer)

The hospital is generated in [`src/level/hospital/`](src/level/hospital/) by a strict pipeline, orchestrated by [`Hospital.ts`](src/level/Hospital.ts): **`params` → `shell` → `partition` → `furnish` → `verify`**. Each stage only *appends* to the sections the previous one produced, so the append-only contract (asserted) holds.

- [`params.ts`](src/level/hospital/params.ts) — the **size dial** + derived spatial truth (footprint, wing grid, stair voids, the **z-fight lift table** that gives each horizontal surface class its own y-plane). Change the building here; everything downstream re-derives.
- [`shell.ts`](src/level/hospital/shell.ts) — the **envelope only**: decks, exterior/step walls (glass is perimeter-only), stair cores + switchback, roof. It builds **no interior walls** anymore. The detailed build passes `interiorColumns:false` (the partition walls carry the decks); `?bare` keeps columns as the perf baseline.
- [`grid.ts`](src/level/hospital/grid.ts) — the interior **CELL grid** (2 m module, 32×24), core rasterization from the stair voids, per-floor usable bounds (massing-step aware). The interior layer speaks cells, not world coords.
- [`floorplans.ts`](src/level/hospital/floorplans.ts) — **authored data**: one `FloorSpec` per storey (corridor network as cell rects + content palette), distinct per floor. This is a builder-from-data, **not** a runtime random generator.
- [`partition.ts`](src/level/hospital/partition.ts) — the **builder**: rasterize each plan → cell map, carve rooms (each room spans its bay so it always touches a corridor), then emit full-height interior walls + **jamb-aware door headers** into the wing sections, plus ceiling fixtures. Cardinal rules: walls **abut, never overlap** at corners; a corridor **lobby ring** is forced around each stair core so the shaft is walled off with exactly **one doorway per floor**.
- [`furnish.ts`](src/level/hospital/furnish.ts) + [`archetypes.ts`](src/level/hospital/archetypes.ts) + [`props.ts`](src/level/hospital/props.ts) — dress each enclosed room by its `RoomContent` (department equipment via `furnishRoom`), all from the existing block/instancing vocabulary so fracture still works. `furnish()` also runs a **corridor-dressing** pass (`dressCorridor`/`scan`): a sparse, deterministic scatter of FLOOR-STANDING props hugging a solid wall on door-free through-corridor cells (deck-supported so no cross-section wall dependency), leaving a clear lane. `archetypes.deptAccent(content)` gives each department a reused-accent hue (the per-room soffit band + corridor pylon blades). **Placement discipline that keeps z-fight/support asserts green:** a wall band must clear the tallest wall-backed item (soffit sits at 2.05 m); floor props must not overlap another floor item / a wall at the shared deck plane; sub-blocks stack-with-inset or embed (only same-facing coplanar faces with overlap AREA fail the assert).
- [`verify.ts`](src/level/hospital/verify.ts) — **static invariants** proven without running the game (coplanar 0, unsupported 0, perimeter-glass, stair-top gaps 0, reachability, enclosure, not-one-big-room, corridor connectivity, stair-core enclosure, door headers, room-facade coverage, distinct floors, one kitchen, section caps, **corridor circulation** — `checkCorridorCirculation` capsule-inflates every corridor prop and floods the corridor free-space, requiring every corridor cell to stay reachable: 0 choked). Run it: `npm run verify:hospital` (or `npx tsx scripts/verify-hospital.ts`).

**New interior content = a new `FloorSpec` and/or `RoomContent` + a `furnishRoom` cluster (or a `dressCorridor` prop) — never a parallel system.** Anything you add must keep every `verify.ts` assert green; it prints a per-floor summary line + a count per invariant.

## Two texture paths (don't cross them)

World **surfaces** are procedural — **no image files** for geometry. There are two separate paths; pick by what you're texturing:

- **Instanced blocks** (walls, props, cars, the ambulance): [`BlockTextures.ts`](src/systems/BlockTextures.ts) patches each shared per-material `MeshStandardMaterial` to sample a near-white detail canvas in **world space** (triplanar on the dominant normal axis), so one small texture tiles at uniform density across every block size while the per-instance tint still drives hue. New block look = a `PAINTERS` entry keyed by `MaterialId`.
- **Flat ground paint** (streets, sidewalks, parking lot): [`GroundTextures.ts`](src/level/GroundTextures.ts) builds full-color **UV-mapped** asphalt / concrete materials (albedo + bump) for the plain `PlaneGeometry` planes in [`Level.ts`](src/level/Level.ts); each `StreetPatch.surface` (in [`Neighborhood.ts`](src/level/Neighborhood.ts)) picks the texture and the repeat is derived from the plane's size. New ground surface = a painter + a `GroundSurface` case.

Don't route ground planes through the block triplanar shader, or blocks through the UV ground path.

**The one image asset** is the storm SKY: `assets/images/storm_texture_2.png`, imported in [`Atmosphere.ts`](src/systems/Atmosphere.ts) (Vite bundles + hashes it; `src/vite-env.d.ts` supplies the `*.png` import types) and drawn on the world-fixed sky DOME. It is NOT a world surface — don't route new surfaces through image files; keep those procedural.

## Performance is a feature — don't regress it

Target is **60 fps at high preset** with a large destructible city (currently ~165 fps on desktop, so there's headroom — spend it deliberately). Before adding geometry or per-frame cost, check it against: instanced-while-static, wake-near-tornado, re-sleep, the debris budget, and the pixel-ratio/light-pool/particle caps in `QualitySettings`. Prefer **update-LOD** (only animate awake/near objects) over new rendering paths. Frame rate is read from the **`?debug` FPS overlay in the browser** (see the verification norm) — if you touch something perf-sensitive, say so and give Jesse the readout to watch.

## Verification norm (applies to every run)

Runtime behavior is verified **manually by Jesse in the browser**. Claude Code does the checks that **terminate on their own**; it does **not** try to prove runtime behavior headlessly.

- **Do** (run these, report the numbers): `typecheck` (`tsc --noEmit` / project script) + a **one-shot** `vite build`; any assertion computable **without running the game** — static counts/invariants on code, geometry, or data (e.g. coplanar-surface-pair count, entity count after reset vs. baseline).
- **Never** (these hang runs): run the game / physics / render loop headlessly; build a scripted-pass / simulation / screenshot harness; start a dev server or any watch / non-terminating command.
- **For runtime-only checks:** add a lightweight **on-screen debug readout** (or one `console.log`) of the relevant value, **leave it in**, and give Jesse a 1–2 line "what to look at / what a correct result looks like." He confirms in the browser.
- Every failure mode still gets a **concrete number** — an assertion Claude Code computes, or an on-screen readout Jesse reads. Never hand back "should be fixed" with no number behind it.
- **Hard stop:** attempt the terminating checks **once**; if they fail, fix **once** and re-run **once**; then report and stop. **No looping on verification.**

## Style

- Comments explain **why**, not what — match the existing density (systems carry a header comment explaining their design and trade-offs). Keep that convention when adding a system.
- Match surrounding naming and idiom; scratch vectors/matrices are reused per-frame to avoid allocation — follow that in hot paths.
- Reference code as `file_path:line` in explanations.

## Out of scope unless asked

Progression/economy, additional independent tornados (the single system already superposes up to 2 funnels), additional levels, multiplayer, NPCs, mobile/touch input. Atmosphere/fog/exposure/ground styling is treated as its own concern — don't retune mood while doing structural or gameplay work; in particular the lightning **strike** flash is its own channel and the ambient sky-flash flasher is left untouched (see [Storm lightning & alarm](#storm-lightning--alarm)). (Roof access via the stair head is already built.)

The **main menu, level-complete (survived/died) UI, and in-place restart are now BUILT** (see the Game-loop / app-shell bullet under [Current status](#current-status)) — they are no longer out of scope; extend that app shell (new `Objective`, new screen) rather than forking a parallel one. A **pause MENU** (a distinct settings/quit surface mid-round) is still out of scope — the only pause today is the lightweight "click to resume" overlay when pointer lock is lost.
