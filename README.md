# Tornado Survival

A first-person survival game: a tornado walks through a neighborhood in 2–3 bounded passes and you shelter inside a large multi-story hospital while it tears the world apart block by block.

## Play it

**[tornadosurvivalv0.vercel.app](https://tornadosurvivalv0.vercel.app)** — no install, click **Play**.

It runs in a desktop browser and needs a mouse: mouse look uses pointer lock.

## What's interesting about it

Built with **TypeScript**, **Three.js** (rendering + postprocessing), and **Rapier** (physics), bundled by **Vite**. There is almost no asset pipeline — all geometry is procedurally generated from blocks and all audio is synthesized at runtime; the sole image asset is the storm sky (`assets/images/`, generated with Google Gemini) drawn on the sky dome.

It targets **60 fps** at the high preset with a large destructible city, and the destruction model is built to hold that:

- **Instanced-while-static** — one `InstancedMesh` per material for the whole world; intact blocks never update their transforms, so a static city is nearly free to draw.
- **Wake-near-tornado** — a structure collides as a single compound body until the funnel's danger radius reaches it, then splits into per-block bodies; only geometry near the storm pays for physics.
- **Re-sleep** — once the funnel moves on, surviving blocks merge back into one dormant body, so awake-body count doesn't accumulate across a multi-pass round.
- **Hard debris budget** — a fixed pool of dynamic bodies; the oldest settled debris is evicted first, so flying debris can never blow the frame budget.

`QualitySettings` is the single place performance knobs live; a weaker GPU drops to `?quality=medium` / `low`.

## How it plays

- A round opens with a **tornado warning** — run into the neighborhood and find shelter before the first pass.
- The tornado makes **2–3 straight passes** separated by calm gaps. Each pass grazes one side of the map, so which side is safe is a gamble every pass. Some rounds spawn a **second funnel** on the same pass — two danger zones to read at once.
- **Direct exposure is lethal** — sustained wind batters your health and a strong pass sweeps you off your feet (a ragdoll fling). Debris impacts and falls hurt too.
- The map is a **bounded square** ringed by a treeline; stray toward the edge and a **"leaving the area — turn back"** warning appears (a wall stops you at the perimeter — nothing teleports you).
- **Lightning** cracks down during a pass — bolts strike buildings near the funnel, flash the sky, and tear blocks off whatever they hit. The tornado siren wails during the warning and between passes but falls silent while a funnel is bearing down (and the instant the round ends).
- Survive every pass to **win** (a "you survived" screen); die at any point and the round **ends** (a "you died" screen). Both offer **Play again / Retry** (an in-place restart, no reload) and **Main menu**. The loop: `menu → play → survived | died → restart / menu`.

| Input | Action |
|---|---|
| **WASD** | Move |
| **Mouse** | Look |
| **Space** | Jump |
| **Shift** | Sprint |
| **C** | Crouch |
| **F** | Toggle flashlight |
| **E** | Hold on to nearby structure in high wind (drains grip stamina) |
| **Esc** | Release the pointer → a **Resume / Restart round / Main menu** overlay (the sim pauses) |

Three bars in the corner track **Health**, **Grip**, and **Sprint** stamina. Shelter inside the hospital: an intact roof + windward wall shields you from the wind, but the storm tears the shell open over time. The **main menu** (title screen) has Play and a **mouse-sensitivity** slider that persists across sessions; restart and return-to-menu are on the survived/died result screen and the pause overlay.

## Verification

Runtime behaviour is confirmed by hand in a browser; everything a static check can assert is asserted by a terminating script that prints a count (no dev server, no headless game loop). Each script below prints one line per invariant.

- `npm run verify:flow` — the app-flow machine (menu → playing → survived/died), objective, and settings are exhaustive and total: **20/20 (state, event) combos classified**, and **7** corrupt settings inputs each load the default without throwing.
- `npm run verify:boot` — the boot machine resolves every input and the capability gate is a pure truth table: **20/20 (state, input) pairs**, **16 capability combos → exactly 1 playable**, and **0/4** banned device-detection signals in the probe.
- `npm run verify:boundary` — the map edge's pure geometry and warn latch: **360/360** rays from centre hit a wall, and **10000/10000** grid points match the analytic square.
- `npm run verify:lightning` — a strike can't exhaust the debris pool and the siren is edge-triggered: **maxBlocksPerStrike 22 ≤ every preset's debris budget (120 / 100 / 55)**, and the alarm fires exactly **2 starts / 2 stops** across warning → pass → gap → pass → done.
- `npm run verify:hospital` — the generated hospital's build-time invariants: **coplanar same-facing overlaps 0** (bare and detailed), unsupported-at-birth blocks **0**, **0** corridor cells choked, and **14** stair cores each walled off with exactly one doorway.

## Startup & robustness

A separate boot state machine ([`BootFlow.ts`](src/systems/BootFlow.ts), wired in [`main.ts`](src/main.ts)) guards the launch so a first-time visitor never gets a black screen, kept deliberately separate from the in-game menu/round flow. It feature-tests WebGL2, WebAssembly, and a mouse (pointer lock + a fine pointer) and — if any is missing — shows a static fallback screen naming what's absent instead of starting the game; it drives a loading bar from the real awaited work (Rapier's WASM init + the world build) that only reaches 100% at the menu. The first uncaught error or promise rejection latches an overlay and **stops the render loop** so it can't re-throw every frame (the stack under `?debug`, a distinct message for a lost WebGL context, and the original always logged to the console).

## Architecture

One explicit fixed-timestep loop drives everything. [`src/Game.ts`](src/Game.ts) owns every system and runs `update(dt)` top-to-bottom in numbered stages — start there and follow the numbers to find where anything happens. Systems never call each other's `update`; `Game` decides the order.

```
src/
├── main.ts                 # bootstrap: boot flow (capability + loading gate, error latch) → menu → rAF loop
├── Game.ts                 # owns all systems; THE update(dt) loop
├── boot/
│   └── capabilities.ts     # WebGL2 + WebAssembly feature-test (no THREE/Rapier import)
├── config/
│   ├── GameConfig.ts       # all gameplay tuning constants in one place
│   ├── LightningConfig.ts  # storm-lightning strike tuning (frequency, bolt, flash, damage)
│   ├── Settings.ts         # persisted USER prefs (mouse sensitivity) — localStorage, not dev tuning
│   └── QualitySettings.ts  # performance presets (the perf dials)
├── core/
│   ├── Physics.ts          # Rapier world + fixed-timestep accumulator
│   ├── InputManager.ts     # keyboard/mouse → InputState snapshot
│   └── Noise.ts            # simplex noise helpers
├── level/
│   ├── Materials.ts        # block materials (color, density, break threshold)
│   ├── Blueprints.ts       # data-only structure/section types
│   ├── Hospital.ts         # hospital orchestrator (shell → partition → furnish → verify)
│   ├── hospital/           # per-floor interior: cell grid, authored floor plans,
│   │                       #   walls + doors + fixtures, dept furnish, static invariants
│   ├── Neighborhood.ts     # streets, houses, shops, trees
│   ├── GroundTextures.ts   # UV asphalt/concrete paint for the flat ground planes
│   └── Level.ts            # ground plane + street/lot paint
├── systems/
│   ├── TornadoSystem.ts    # multi-pass lifecycle (spawn → travel → gap)
│   ├── WindField.ts        # the Rankine-vortex wind field everything reads
│   ├── StructureSystem.ts  # instanced destruction: wake / break / re-sleep
│   ├── BlockTextures.ts    # triplanar world-space detail for instanced blocks
│   ├── DebrisManager.ts    # pooled dynamic debris under a hard budget
│   ├── PlayArea.ts         # pure map-edge geometry + edge-warning latch (the size dial)
│   ├── Boundary.ts         # perimeter walls + treeline built from PlayArea (permanent)
│   ├── PlayerController.ts # kinematic FPS + grip + ragdoll fling
│   ├── DamageSystem.ts     # health / death
│   ├── CameraRig.ts        # first-person + fling chase cam + shake
│   ├── FunnelVisual.ts     # funnel cone + dust particles
│   ├── InteriorLights.ts   # pooled follow-lights + emissive fixtures (strand on the deck mount)
│   ├── Flashlight.ts       # head-mounted spotlight (F)
│   ├── LightningSystem.ts  # 3D bolt strikes: flash, structure damage, thunder
│   ├── AlarmController.ts  # pure edge-triggered siren gate (silent while a funnel is present / paused / on menu)
│   ├── BootFlow.ts         # pure boot state machine: checking → unsupported|loading → ready|error
│   ├── AppFlow.ts          # pure app state machine: menu → playing → survived|died → restart/menu
│   ├── Objective.ts        # the win condition in ONE seam (SurviveAllPasses)
│   ├── Atmosphere.ts       # storm sky dome (image), fog, grade, lightning
│   └── AudioSystem.ts      # procedural WebAudio (rumble, wind, thunder…)
├── ui/                     # HUD + round banners + app-shell Screens + BootOverlay (loading/unsupported/error)
└── debug/                  # ?debug FPS + counters + lil-gui tuning panel (DebugTools) + debugFlag gate
```

## URL parameters

- `?quality=high|medium|low` — graphics preset (default `high`). Controls pixel ratio, shadows, fog/draw distance, debris budget, interior-light pool, and particle caps. See [`src/config/QualitySettings.ts`](src/config/QualitySettings.ts).
- `?debug` — developer overlay: FPS meter, world counters (awake sections, bodies, released blocks, debris, **lights / dressing**), the app-flow + round readouts (`flow` / `phase` / `siren` / `sens`), and a live `lil-gui` panel that mutates tuning constants (`GameConfig`, `MATERIALS`) for balancing.
- `?bare` — the Phase-1 structural shell of the hospital (columns instead of partition walls), the perf baseline.

Dev-only flags for confirming the boot fallback screens in-browser (they inject at the boot state machine's inputs, adding no branch to the renderer or loop):

- `?forceUnsupported=webgl` / `?forceUnsupported=wasm` / `?forceUnsupported=pointerlock` — force each unsupported-capability screen (the last is the "play on a computer" mouse-required message); the game never starts.
- `?forceDesktop` — bypass the mouse/pointer-lock gate only (never WebGL2/WASM), so the game can be loaded on a touch device for testing.
- `?forceError` — raise a synthetic error one second after the menu loads: the error overlay appears once and the render loop stops.
- `?forceContextLost` — exercise the distinct "graphics context lost" message.

## Quick start

```bash
npm install
npm run dev        # start the Vite dev server, then open the printed localhost URL
```

Click **Play** on the main menu to lock the pointer and start the round. Requires a recent Node (18+).

```bash
npm run build            # production build to dist/
npm run preview          # serve the production build locally
npm run typecheck        # tsc --noEmit (strict)
npm run verify:hospital  # static hospital build-time invariants (terminating)
npm run verify:lightning # static lightning / alarm / round-resolution invariants
npm run verify:flow      # static app-flow (menu → play → win/lose → restart) invariants
npm run verify:boot      # static boot-flow (capability gate / loading gate / error latch) invariants
npm run verify:boundary  # static map-boundary (PlayArea) invariants
```

## License

[MIT](LICENSE) © 2026 Jesse.
