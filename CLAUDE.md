# CLAUDE.md

Guidance for Claude Code working in this repository. Read the [README](README.md) first for what the game is and how to run it; this file is about *how to work here*.

## Commands

```bash
npm run dev         # dev server (Vite) — HMR
npm run build       # production build to dist/
npm run typecheck   # tsc --noEmit, strict — run this after every change
npm run preview     # serve the production build
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

## Current status

- **Game loop:** rounds (2–3 passes, gaps, warning → passes → result) ✅ · restart ✅ · win / "survived" result ✅. **Not yet:** main menu; a confirmed explicit lose/death result path.
- **Hospital rebuild:** live. Phase 1 (shell) gated in ✅ · Phase 2 (ward detailing) in progress — rooms enterable, interior fit-out ongoing.
- **Performance:** ~165 fps on dev desktop + laptop — comfortable headroom over the 60 fps target. Mobile / low-end not yet verified; quality-preset selection path not built.
- **Atmosphere:** still dark / green-tinted; de-haze pass pending.

## Known issues

- **Floor z-fighting:** floors flicker where two coplanar surfaces overlap — occurs both inside and outside. *Being addressed in the hospital overhaul; not yet verified fixed in-browser.*

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

Menus / main menu / pause, progression/economy, level-complete UI, roof access, multiple simultaneous tornados, additional levels, multiplayer, NPCs. Atmosphere/fog/exposure/ground styling is treated as its own concern — don't retune mood while doing structural or gameplay work.
