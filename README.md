# Tornado Survival

A first-person 3D tornado survival game. A tornado walks through a neighborhood in 2–3 bounded passes; you scout the block, shelter inside a large multi-story hospital, and survive as the storm tears the world apart around you. Buildings partially destruct block-by-block, trees snap and uproot, cars and debris fly, and the funnel bears down with swelling audio and lightning.

Built with **TypeScript**, **Three.js** (rendering + postprocessing), and **Rapier** (physics), bundled by **Vite**. Almost no asset pipeline — all geometry is procedurally generated from blocks and all audio is synthesized at runtime; the sole image asset is the storm sky (`assets/images/`, generated with Google Gemini) drawn on the sky dome.

## Quick start

```bash
npm install
npm run dev        # start the Vite dev server, then open the printed localhost URL
```

Click **Play** on the main menu to lock the pointer and start the round.

### Other scripts

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

Requires a recent Node (18+) and a **WebGL2- and WebAssembly-capable** browser. On startup the game feature-tests both; a browser or device missing either gets a static "can't run this browser" screen instead of a black canvas, and the game never starts.

## Controls

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

Bars in the corner show **Health** and **Grip** (stamina). Shelter inside the hospital: an intact roof + windward wall shields you from the wind, but the storm tears the shell open over time. The **main menu** (title screen) has Play and a **mouse-sensitivity** slider that persists across sessions; restart and return-to-menu are on the survived/died result screen and the pause overlay.

## How it plays

- A round opens with a **tornado warning** — run into the neighborhood and find shelter before the first pass.
- The tornado makes **2–3 straight passes** separated by calm gaps. Each pass grazes one side of the map, so which side is safe is a gamble every pass.
- **Direct exposure is lethal** — sustained wind batters your health and a strong pass sweeps you off your feet (a ragdoll fling). Debris impacts and falls hurt too.
- **Lightning** cracks down during a pass — bolts strike buildings near the funnel, flash the sky, and tear blocks off whatever they hit. The tornado siren wails during the warning and between passes but falls silent while a funnel is bearing down (and the instant the round ends).
- Survive every pass to **win** (a "you survived" screen); die at any point and the round **ends** (a "you died" screen). Both offer **Play again / Retry** (an in-place restart, no reload) and **Main menu**. The loop: `menu → play → survived | died → restart / menu`.

## Startup & robustness

Before the game itself runs, a small **boot state machine** guards the launch so a first-time visitor never gets a black screen:

1. **Capability check** — feature-tests a real WebGL2 context and WebAssembly. If either is missing, a static fallback screen names what's absent and the game never starts (no renderer is executed).
2. **Loading gate** — a progress bar driven by the *actual* awaited work (Rapier's WASM init + the world build). It only reaches 100% when the menu is ready — it never fakes progress.
3. **Error overlay** — the first uncaught error or promise rejection shows an overlay and **stops the render loop** (so it can't re-throw every frame); the original error is always logged to the console. With `?debug` the overlay shows the stack, otherwise a short message and a reload button. A lost WebGL context gets its own distinct message.

This is a separate machine from the in-game menu/round flow; see [`src/systems/BootFlow.ts`](src/systems/BootFlow.ts) and [`src/main.ts`](src/main.ts).

## URL parameters

- `?quality=high|medium|low` — graphics preset (default `high`). Controls pixel ratio, shadows, fog/draw distance, debris budget, interior-light pool, and particle caps. See [`src/config/QualitySettings.ts`](src/config/QualitySettings.ts).
- `?debug` — developer overlay: FPS meter, world counters (awake sections, bodies, released blocks, debris, **lights / dressing**), the app-flow + round readouts (`flow` / `phase` / `siren` / `sens`), and a live `lil-gui` panel that mutates tuning constants (`GameConfig`, `MATERIALS`) for balancing.
- `?bare` — the Phase-1 structural shell of the hospital (columns instead of partition walls), the perf baseline.

Dev-only flags for confirming the boot fallback screens in-browser (they inject at the boot state machine's inputs, adding no branch to the renderer or loop):

- `?forceUnsupported=webgl` / `?forceUnsupported=wasm` — force the "can't run this browser" screen; the game never starts.
- `?forceError` — raise a synthetic error one second after the menu loads: the error overlay appears once and the render loop stops.
- `?forceContextLost` — exercise the distinct "graphics context lost" message.

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
│   └── Level.ts            # ground plane + street/lot paint
├── systems/
│   ├── TornadoSystem.ts    # multi-pass lifecycle (spawn → travel → gap)
│   ├── WindField.ts        # the Rankine-vortex wind field everything reads
│   ├── StructureSystem.ts  # instanced destruction: wake / break / re-sleep
│   ├── DebrisManager.ts    # pooled dynamic debris under a hard budget
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

### Performance discipline

The game targets **60 fps** at the high preset with a large destructible city. The load-bearing ideas:

- **Instanced-while-static** — one `InstancedMesh` per material for the whole world; intact blocks never update their transforms.
- **Wake-near-tornado** — a structure collides as a single compound body until the funnel's danger radius reaches it; only then does it split into per-block bodies.
- **Re-sleep** — once the funnel moves on, surviving blocks merge back into one dormant body, so awake-body count doesn't accumulate across a multi-pass round.
- **Hard debris budget** — a fixed pool of dynamic bodies; the oldest settled debris is evicted first.

`QualitySettings` is the single place performance knobs live; a weaker GPU drops to `?quality=medium` / `low`.

## License

[MIT](LICENSE) © 2026 Jesse.
