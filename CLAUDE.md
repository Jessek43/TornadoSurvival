# CLAUDE.md

Guidance for Claude Code working in this repository. Read the [README](README.md) first for what the game is and how to run it; this file is about *how to work here*.

## Commands

```bash
npm run dev         # dev server (Vite) — HMR
npm run build       # production build to dist/
npm run typecheck   # tsc --noEmit, strict — run this after every change
npm run preview     # serve the production build
```

There is **no test suite** and no linter beyond `tsc`. `tsconfig` is strict with `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch` — dead code and unused params are hard errors, so keep edits tidy.

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

`block.released` is **monotonic** and is never set by `sleep()`/`wake()` — it means genuine destruction. Use it (not section state) whenever you need "is this geometry actually gone" (e.g. interior-light teardown anchors to a specific block's `released`).

## Performance is a feature — don't regress it

Target is **60 fps at high preset** with a large destructible city. Before adding geometry or per-frame cost, check it against: instanced-while-static, wake-near-tornado, re-sleep, the debris budget, and the pixel-ratio/light-pool/particle caps in `QualitySettings`. Prefer **update-LOD** (only animate awake/near objects) over new rendering paths. If you change something perf-sensitive, re-measure (see below) and report idle + peak `update()` ms.

## Verification workflow (headless)

There is no test runner, so behaviour is verified with **temporary, clearly-marked harnesses** driven by headless Chrome, then removed. Pattern used throughout this project:

1. Add a `?<name>=…` branch in [`main.ts`](src/main.ts) (and a temp `skipRender` flag on `Game` when you don't need pixels) that drives `game.update(1/60)` in a synchronous loop and `console.log`s results with a distinct prefix. Mark it `// TEMP … REMOVE`.
2. Run it: `chrome --headless=new --enable-unsafe-swiftshader --enable-logging=stderr --v=1 --virtual-time-budget=… "http://localhost:PORT/?<name>=…" 2> log`, then grep the `CONSOLE` lines.
3. Screenshots: add `--screenshot=out.png --window-size=1280,720` with a camera pose that falls through to the live rAF loop.
4. **Remove all harness code** and re-run `typecheck` + `build` before finishing. Grep for your temp markers to be sure.

Gotchas learned the hard way:
- **`performance.now()` is frozen under `--virtual-time-budget`** — for CPU timing, run in real wall-clock time (no virtual-time budget) and drive the loop synchronously.
- Headless WebGL needs `--enable-unsafe-swiftshader`; screenshots are **flaky** — retry a couple times.
- For isolated physics/geometry questions, a Node `.mjs` script importing `@dimforge/rapier3d-compat` (see prior scratchpad probes) is faster and more reliable than the browser.
- "Fixed" means **verified**, not eyeballed — assert a concrete pass/fail (e.g. capsule reached the top floor; zero blocks intrude the void; zero floating fixtures).

## Style

- Comments explain **why**, not what — match the existing density (systems carry a header comment explaining their design and trade-offs). Keep that convention when adding a system.
- Match surrounding naming and idiom; scratch vectors/matrices are reused per-frame to avoid allocation — follow that in hot paths.
- Reference code as `file_path:line` in explanations.

## Out of scope unless asked

Menus / main menu / pause, progression/economy, level-complete UI, roof access, multiple simultaneous tornados, additional levels, multiplayer, NPCs. Atmosphere/fog/exposure/ground styling is treated as its own concern — don't retune mood while doing structural or gameplay work.
