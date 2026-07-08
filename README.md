# Tornado Survival

A first-person 3D tornado survival game. A tornado walks through a neighborhood in 2–3 bounded passes; you scout the block, shelter inside a large multi-story hospital, and survive as the storm tears the world apart around you. Buildings partially destruct block-by-block, trees snap and uproot, cars and debris fly, and the funnel bears down with swelling audio and lightning.

Built with **TypeScript**, **Three.js** (rendering + postprocessing), and **Rapier** (physics), bundled by **Vite**. Almost no asset pipeline — all geometry is procedurally generated from blocks and all audio is synthesized at runtime; the sole image asset is the storm sky (`assets/images/`) drawn on the sky dome.

## Quick start

```bash
npm install
npm run dev        # start the Vite dev server, then open the printed localhost URL
```

Click the canvas to lock the pointer and play.

### Other scripts

```bash
npm run build            # production build to dist/
npm run preview          # serve the production build locally
npm run typecheck        # tsc --noEmit (strict)
npm run verify:hospital  # static hospital build-time invariants (terminating)
```

Requires a recent Node (18+) and a WebGL2-capable browser.

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
| **R** | Restart the round |

Bars in the corner show **Health** and **Grip** (stamina). Shelter inside the hospital: an intact roof + windward wall shields you from the wind, but the storm tears the shell open over time.

## How it plays

- A round opens with a **tornado warning** — run into the neighborhood and find shelter before the first pass.
- The tornado makes **2–3 straight passes** separated by calm gaps. Each pass grazes one side of the map, so which side is safe is a gamble every pass.
- **Direct exposure is lethal** — sustained wind batters your health and a strong pass sweeps you off your feet (a ragdoll fling). Debris impacts and falls hurt too.
- **Lightning** cracks down during a pass — bolts strike buildings near the funnel, flash the sky, and tear blocks off whatever they hit. The tornado siren wails during the warning and between passes but falls silent while a funnel is bearing down.
- Survive every pass to win; die at any point and the round ends.

## URL parameters

- `?quality=high|medium|low` — graphics preset (default `high`). Controls pixel ratio, shadows, fog/draw distance, debris budget, interior-light pool, and particle caps. See [`src/config/QualitySettings.ts`](src/config/QualitySettings.ts).
- `?debug` — developer overlay: FPS meter + a live `lil-gui` panel that mutates tuning constants (`GameConfig`, `MATERIALS`) for balancing.

## Architecture

One explicit fixed-timestep loop drives everything. [`src/Game.ts`](src/Game.ts) owns every system and runs `update(dt)` top-to-bottom in numbered stages — start there and follow the numbers to find where anything happens. Systems never call each other's `update`; `Game` decides the order.

```
src/
├── main.ts                 # bootstrap (awaits Rapier WASM, starts the rAF loop)
├── Game.ts                 # owns all systems; THE update(dt) loop
├── config/
│   ├── GameConfig.ts       # all gameplay tuning constants in one place
│   ├── LightningConfig.ts  # storm-lightning strike tuning (frequency, bolt, flash, damage)
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
│   ├── InteriorLights.ts   # pooled follow-lights + emissive fixtures
│   ├── LightningSystem.ts  # 3D bolt strikes: flash, structure damage, thunder
│   ├── AlarmController.ts  # edge-triggered siren gate (silent while a funnel is present)
│   ├── Atmosphere.ts       # storm sky dome (image), fog, grade, lightning
│   └── AudioSystem.ts      # procedural WebAudio (rumble, wind, thunder…)
├── ui/                     # HUD + round banners (HTML overlay)
└── debug/DebugTools.ts     # ?debug FPS + lil-gui tuning panel
```

### Performance discipline

The game targets **60 fps** at the high preset with a large destructible city. The load-bearing ideas:

- **Instanced-while-static** — one `InstancedMesh` per material for the whole world; intact blocks never update their transforms.
- **Wake-near-tornado** — a structure collides as a single compound body until the funnel's danger radius reaches it; only then does it split into per-block bodies.
- **Re-sleep** — once the funnel moves on, surviving blocks merge back into one dormant body, so awake-body count doesn't accumulate across a multi-pass round.
- **Hard debris budget** — a fixed pool of dynamic bodies; the oldest settled debris is evicted first.

`QualitySettings` is the single place performance knobs live; a weaker GPU drops to `?quality=medium` / `low`.

## License

Unlicensed / private project.
