/**
 * All gameplay tuning constants in one place.
 *
 * This file grows with each system (wind field params, break thresholds,
 * stamina rates, damage numbers, round timings). The numbers here are the
 * ones to nudge when balancing — systems should not hide magic constants
 * locally. Deliberately NOT `as const`: the ?debug lil-gui panel mutates
 * these live while tuning.
 */
export const GameConfig = {
  physics: {
    gravity: -9.81, // m/s²
    fixedDt: 1 / 60, // physics step; rendering runs on rAF at whatever rate
    maxCatchUpSteps: 3, // cap physics catch-up after a slow frame / tab switch
  },

  world: {
    groundSize: 300, // the industrial yard is a groundSize × groundSize square
  },

  // The ground substrate (level/Terrain.ts). ONE pure height function every
  // ground consumer asks instead of assuming the plane y = 0. This run keeps
  // `amplitude` and `padY` at 0, so heightAt returns 0 everywhere and the world
  // is byte-identical to the flat plane — the heightfield mesh + Rapier
  // heightfield collider are real, only their values are flat. Relief is a later
  // run: raise `amplitude` and `padY` and the mesh/collider/consumers follow with
  // no code change. All developer tuning (NOT user Settings).
  terrain: {
    cellSize: 3, // m — 300 m ground ÷ 3 → 100×100 cells, 101×101 samples
    amplitude: 0, // m of field relief — 0 THIS RUN (see the run note above)
    // Characteristic period of the field undulation (m). The valueNoise frequency
    // is 1/terrainWavelength — this is the SECOND shape axis alongside amplitude:
    // amplitude alone does NOT set the gradient, wavelength does too (a big
    // amplitude at a long wavelength is still shallow). See docs/terrain-shape.md.
    terrainWavelength: 16,
    padY: 0, // m — building-pad height; 0 keeps the world byte-identical to main
    padMargin: 3, // m — each building footprint dilates this far into a flat pad
    // Pad edge → open field ramp width, in GRID CELLS (× cellSize = 9 m). Specified
    // in cells, not metres, because its ONLY required property is cell-alignment:
    // the apron/field split (verify:terrain 4a vs 4b) must fall on a cell boundary.
    // apronWidth is DERIVED (apronCells × cellSize) at every TerrainSpec build site,
    // so the two can never desync — same grid-lines discipline as the paved rects.
    apronCells: 3,
    // The two shape bounds, DE-CONFLATED (they were one `maxStep`, which silently
    // bounded the field's own gradient with an apron-ramp number):
    apronMaxStep: 0.5, // m — per-cell Δh bound INSIDE the apron band (verify 4a).
    fieldMaxSlope: 0.166, // rise/run cap on field cells off-pad & off-apron (verify 4b).
    maxWalkable: 0.6, // slope (rise/run) cap inside PlayArea (assertion 5 limit)
  },

  // The playable square — a hard, readable map edge (systems/PlayArea.ts + the
  // boundary in systems/Boundary.ts read this). `halfExtent` is THE size dial:
  // everything (walls, dressing ring, warning band) derives from it, so
  // enlarging the map later is a change to this ONE number. Kept == groundSize/2
  // so the boundary sits at the existing ground edge — the play area does NOT
  // change size here. Heights/depths in metres are size-INDEPENDENT by design
  // (a bigger map isn't a taller fence); band + slot POSITIONS scale with the dial.
  PLAY_AREA: {
    halfExtent: 150, // m from centre to each edge (== world.groundSize / 2)
    wallHeight: 12, // m — tall enough the player can't mount/jump/clear it
    wallThickness: 2, // m
    dressingBandFraction: 0.06, // treeline depth as a fraction of halfExtent (→ ~9 m)
    slotsPerSide: 26, // dressing props per edge → 104 total, deterministic
    dressingSeed: 20260709,
    warnBand: 14, // m from the edge: the "leaving the area" nudge turns on
    warnHysteresis: 5, // m of extra re-entry before it clears (anti-flicker latch)
  },

  round: {
    // Longer than the old 12s so there's a fair window to run into the large
    // hospital, find a stairwell, climb, and pick a room before the first
    // pass. Round total ≈ 25 + (23s pass + 28s gap)×N ≈ 1.7 min (2 passes) to
    // 2.5 min (3 passes) — inside the 2–5 min target.
    warningTime: 15,
  },

  // Application shell (menu → play → survived/died → restart). Transition
  // timings live here so systems/AppFlow.ts + ui/Screens.ts carry no inline
  // literals. See the app-shell section for how the flow drives these.
  shell: {
    // DOM opacity fade-in for the menu / result overlays (ui/Screens.ts). This
    // is a READABILITY fade on the overlay only — the round resolves to its
    // terminal state (and the siren stops) IMMEDIATELY on the funnel-gone edge;
    // this constant never gates the state transition. Kept short so the result
    // reads at once.
    fadeDuration: 0.25, // s
    // Grace window after a Play / Resume / Restart-round click during which the
    // "click to resume" overlay is suppressed while pointer lock is (re)acquired.
    // Sized to outlast the browser's post-Esc re-lock COOLDOWN (~1.25 s): after
    // Esc opens the pause overlay, an immediate re-lock silently fails, so
    // Game.update re-requests every lockRetryInterval across this window until it
    // takes (one click restarts even straight after Esc). If lock never takes,
    // the overlay reappears here as the manual fallback.
    lockAcquireGrace: 2.0, // s
    lockRetryInterval: 0.3, // s between pointer-lock re-requests within the grace
  },

  player: {
    spawn: { x: 10, y: 18, z: -15 }, // feet position on the ground
    height: 1.45, // capsule total height (m)
    radius: 0.35, // capsule radius (m)
    eyeHeight: 1.65, // camera height above the feet

    walkSpeed: 4.5, // m/s
    sprintMultiplier: 1.8, // × walkSpeed while sprinting (hold Shift)
    crouchMultiplier: 0.5, // × walkSpeed while crouched (hold C)
    crouchHeight: 1.1, // capsule TOTAL height while fully crouched (m) — the
    // collider really shrinks to this (bottom pinned to the standing foot line),
    // so you fit under lower gaps; must stay > 2×radius so the capsule is valid.
    crouchEyeHeight: 0.95, // camera height above the feet while fully crouched (m)
    crouchLerp: 14, // 1/s — how fast the view dips into / rises out of a crouch
    // --- sprint stamina (HUD "SPRINT" bar) ---
    sprintDrain: 0.2, // /s while sprinting → a full bar ≈ 5 s of running
    sprintRegen: 0.3, // /s recovered while walking / standing
    sprintRecoverThreshold: 0.2, // after emptying, must refill this far before sprint re-enables
    climbSpeed: 3, // m/s up/down a ladder
    jumpSpeed: 5.3, // m/s upward → apex ≈ v²/2g ≈ 1.2 m
    // Jump input is buffered (captured every rendered frame) and consumed on
    // the next fixed step, so a jump is never lost on frames that run zero
    // fixed steps (common above 60 Hz). Coyote time lets you jump just after
    // walking off a ledge / stair edge.
    jumpBufferTime: 0.13, // s a pressed jump stays queued
    coyoteTime: 0.1, // s after leaving the ground you can still jump
    airControl: 3, // 1/s — how quickly airborne velocity steers toward input
    mouseSensitivity: 0.0023, // radians of look per pixel of mouse travel
    pitchLimit: 1.45, // rad (~83°) — stop short of straight up/down

    // --- wind vs player ---
    sweepPressure: 900, // |w|² (≈30 m/s wind) — above this, ungripped → flung
    windPush: 0.5, // 1/s — stagger acceleration factor below the sweep point
    gripRange: 1.6, // m to the nearest intact block to be able to hold on
    staminaDrain: 0.24, // /s at exactly sweepPressure (scales with strain, capped)
    // Cap on the pressure/sweep strain multiplier used for stamina drain.
    // Without a cap the drain scaled with pressure UNBOUNDED, so deep in a pass
    // a full stamina bar emptied in a fraction of a second and grip did nothing
    // ("grip doesn't work"). Capped, a full bar always buys ~3 s of hold even in
    // the worst wind, and ~6 s near the sweep threshold. (Bug 4.)
    gripStrainCap: 2,
    staminaRegen: 0.2, // /s when not straining

    // --- ragdoll fling ---
    ragdollArea: 0.8, // m² wind "sail" of a tumbling body
    ragdollDensity: 160, // kg/m³ on the capsule → ≈80 kg body
    // Damping + friction so a landed body settles in ~1s instead of rolling
    // forever (a capsule on its side rolls almost frictionlessly, which
    // otherwise keeps its speed above the recovery threshold for many
    // seconds — the recovery-never-fires bug).
    ragdollLinearDamping: 0.5,
    ragdollAngularDamping: 2.5,
    ragdollFriction: 0.9,
    recoverTime: 1.2, // s grounded & settled before getting back up
    recoverMaxSpeed: 3.5, // m/s below which a grounded body counts as settled
    safeImpactSpeed: 8, // m/s of sudden velocity change that starts to hurt
    impactDamageFactor: 4, // hp per m/s beyond safe

    // --- fall damage (ON-FOOT landings only) ---
    // Deliberately SEPARATE from the ragdoll impact/jolt constants above so
    // making falls dangerous doesn't also change storm-fling lethality. The old
    // on-foot fall used the shared safeImpactSpeed 8 / impactDamageFactor 4, so
    // a full storey (≈8.4 m/s) barely dealt 1.6 hp and 3 storeys wasn't lethal.
    // Raised so a ~2-storey drop (≈11.9 m/s → ~65 hp) is clearly dangerous and
    // ~3+ storeys (≥14.5 m/s → ~94 hp, 4 storeys lethal) will kill. The 6 m/s
    // safe floor stays above a normal jump landing (~4.8 m/s) so jumping and
    // ≤1.8 m hops never hurt. Tunable live via the fall readout in ?debug.
    fallSafeSpeed: 8, // m/s of landing speed below which a fall is harmless
    fallDamageFactor: 20, // hp per m/s of landing speed beyond fallSafeSpeed
  },

  damage: {
    crushForceThreshold: 25000, // N of contact force before debris hits hurt
    crushDamageDivisor: 2500, // hp = (force − threshold) / divisor
    maxCrushHit: 55, // cap a single impact

    // --- sustained storm battering (the direct-exposure lethal path) ---
    // Before this, the ONLY damage was impacts/crush/fling, so standing in the
    // storm below the sweep threshold cost nothing, and a swept body skidding on
    // open ground plateaued health just above zero without ever dying. This
    // steady battering (sandblasting debris + pressure) makes direct exposure
    // genuinely lethal over time and near-misses sting — while shelter, which
    // lowers the FELT pressure this reads, still protects you.
    batterPressure: 400, // |w|² (≈20 m/s felt) below which exposure is harmless
    batterPerSec: 12, // hp/s at exactly sweepPressure; scales with felt pressure
  },

  camera: {
    fov: 85,
    chaseDistance: 6.5, // m behind the flung body
    chaseHeight: 3, // m above it
    chaseLerp: 4, // 1/s spring toward the desired chase position
  },

  // Player flashlight (systems/Flashlight.ts) — a head-mounted spot toggled
  // with F, glued to the view each frame. No shadow map (a shadow-casting spot
  // is a whole extra depth pass); these are the live-tunable beam knobs for the
  // ?debug panel. Units match the PBR point lights used by InteriorLights.
  flashlight: {
    color: 0xfff1d6, // warm white
    intensity: 100, // luminous intensity when on (0 = off) — a modest beam
    distance: 48, // m — beam cutoff
    angle: 0.34, // rad — half-cone (~19°): a tighter, focused band
    penumbra: 0.45, // soft cone edge
    decay: 1.1, // distance falloff exponent
  },

  wind: {
    dragK: 1.2, // scalar on the quadratic drag force (see WindField.dragForce)
    /** Skip wind work on debris where |wind|² is below this (lets far debris sleep). */
    debrisMinWindSq: 25,
  },

  debris: {
    settleLinger: 2.5, // s a slept block lies around before fading
    fadeTime: 1.5, // s to shrink away
    killY: -10, // safety: despawn anything that falls through the world
  },

  // Where the hospital is centered on the ground (the tornado passes aim here
  // + a lateral offset). Kept in sync with level/hospital/params.ts
  // (footprint X[-32,32] × Z[-48,0] → center (0,-24)).
  hospitalCenter: { x: 0, z: -24 },

  tornado: {
    // --- wind field shape (see WindField.ts for the math) ---
    coreRadius: 9, // R — radius of maximum winds (m)
    maxTangential: 65, // m/s swirl speed at the core edge, at full intensity
    inflowFactor: 0.45, // radial inflow as a fraction of local swirl speed
    updraftSpeed: 30, // m/s vertical at the funnel center, at full intensity
    updraftRadius: 1.6, // × coreRadius — how far out the updraft reaches
    // α in (R/d)^α — how fast swirl decays outside the core. Steepened from
    // 0.7 so damage is LOCAL: a grazing pass guts the near wings while the far
    // side keeps its structure. Higher = tighter destruction band. This plus
    // the offset standoff below is what makes a single pass partial.
    falloffExp: 1.1,
    height: 200, // funnel height; winds fade out above ~80% of this
    gustAmp: 0.5, // ±35% gust modulation from noise
    gustScale: 0.05, // spatial gust frequency (1/m)
    gustSpeed: 1.1, // temporal gust frequency (1/s)

    // --- passes (see TornadoSystem) ---
    // A round is 2–3 straight passes, each spawning on a circle of passRadius
    // around the hospital, travelling a straight line (+ lateral jitter) that
    // aims at hospitalCenter offset sideways, then exiting → calm gap → next.
    moveSpeed: 12, // m/s ground speed during a pass
    passRadius: 120, // m — spawn/exit distance from the hospital center (scaled with the 64×48 footprint)
    passRampIn: 5, // s — intensity 0→1 as the funnel approaches
    passRampOut: 5, // s — intensity 1→0 as it recedes
    passCountMin: 2,
    passCountMax: 3,
    gapDuration: 20, // s of calm between passes (the near-miss tension)
    // Lateral aim offset (perpendicular standoff of the pass line from the
    // hospital center). A MINIMUM standoff guarantees the funnel core never
    // bullseyes the building — it always passes to one side, so the opposite
    // wings survive. Diagnosis: a dead-center pass (offset≈0) legitimately
    // guts the whole footprint because the building is smaller than the
    // damage swath; grazing reliably leaves the far side intact. Rescaled
    // from 26–46 for the 64×48 footprint: min 30 keeps the far facade
    // (≥ ~54 m from the pass line) outside the ~32 m cladding-kill band.
    lateralOffsetMin: 10,
    lateralOffsetMax: 50,
    lateralJitter: 4, // rad/s-ish authority of the noise wobble on the path

    // --- §2 path variety + multi-funnel ---
    // A slow, per-pass lateral MEANDER on top of the fast jitter above, so a
    // pass drifts and curves instead of tracking a repeatable ruler-line —
    // "less predictable path" (§2c). Seeded per funnel (independent channels),
    // so it stays deterministic and tuneable, NOT fully random.
    pathCurveAmp: 6, // m/s of lateral authority of the meander
    pathCurveFreq: 0.13, // 1/s temporal frequency of the meander
    // Per-ROUND rolls (decided in TornadoSystem.begin, shown in the ?debug HUD):
    doubleTornadoChance: 0.2, // 20% — a concurrent SECOND funnel this round (§2a)
    throughBuildingChance: 0.3, // 30% — path centered THROUGH the footprint (§2b)
    // Through-building lateral offset range (|offset| ≤ this): small enough that
    // the core crosses the 64×48 m footprint instead of skirting an edge.
    throughOffsetMax: 14,
    // Hard cap on concurrent funnels — sizes the funnel-visual pools and the
    // "total debris ≤ global cap" reasoning (the DebrisManager budget is ONE
    // global pool shared across all funnels, so the cap holds by construction).
    maxFunnels: 2,

    // A section wakes into per-block physics when the funnel is within this
    // horizontal distance. ABSOLUTE (tied to how far destructive wind reaches:
    // cladding fails to ~32 m), NOT scaled to the building — on the big
    // hospital this leaves far wings dormant, giving true per-pass locality.
    wakeRadius: 30,
    // Max section-blocks converted to individual fixed bodies per frame, so a
    // wave of wakes spreads over frames instead of hitching (see StructureSystem).
    wakeBudgetPerFrame: 300,
    // RE-SLEEP: once the funnel is this far from an awake section that still has
    // surviving blocks, merge them back into a single dormant compound body
    // instead of leaving hundreds of individual fixed bodies awake for the rest
    // of the round. Larger than wakeRadius (hysteresis) so a wobbling funnel
    // doesn't thrash a section wake↔sleep. (Perf pass 1.4.)
    sleepRadius: 44,
    // Safety ceiling on simultaneously-awake sections. Re-sleep is the real
    // mechanism; this only guards the rare dead-centre pass from a huge spike.
    maxAwakeSections: 26,
  },

  // Interior emergency lighting (systems/InteriorLights.ts). A small pool of
  // real point lights follows the player; unlimited emissive fixtures glow.
  interiorLights: {
    range: 100, // m — point-light reach
    // Modest lift over the original 54 for the FURNISHED rooms (equipment was
    // eating the light), but the steep decay 1.8 is RESTORED after an over-bright
    // first pass (74/1.55 read washed-out): keeps the scary POOL-of-light-with-
    // shadow-between look rather than flat fill. The real dark-corridor fix was
    // the fixture-run bug in partition.ts, not cranking this. Exterior storm
    // darkening (Atmosphere hemisphere/fog) is untouched.
    baseIntensity: 10,
    decay: 1,
    flickerAmount: 0, // deeper, more unstable emergency flicker
    fixtureColor: 0x9fb08a, // sickly green-white emergency tint
    // A fixture is stranded (goes dark AND its box vanishes) when NO intact
    // block remains within this radius of its housing. A ceiling fixture sits
    // EMBEDDED in the deck slab it hangs from (point-to-slab distance ≈ 0),
    // while the room's partition walls are ≥ ~0.85 m away (≥ a grid half-cell),
    // so this radius is deliberately TIGHT: it keys on the deck MOUNT, not on
    // lateral walls. At the old 1.5 m a stray surviving wall kept a fixture lit
    // after its ceiling was torn out — the "floating light" bug. Must stay above
    // the embedded-mount distance (~0.06 m for the 6 cm-hung stair lights) and
    // below the wall distance (~0.85 m). verify:hospital asserts 0 orphans here.
    strandRange: 0.4,
  },

  // Interior wind shelter (StructureSystem.shelterExposureAt). Cheap AABB
  // probes decide how much raw wind the PLAYER actually feels.
  shelter: {
    roofProbeUp: 2.0, // m above the head to look for a roof/ceiling
    torsoUp: 1.0, // m above the feet for the windward-wall probe
    windwardProbe: 4.0, // m toward the tornado to look for a sheltering wall
    probeRange: 1.2, // m: how close an intact block must be to count as "there"
    shelteredExposure: 0.15, // roof + windward wall intact → mostly safe
    breachedExposure: 0.55, // roofed but windward side breached → dangerous
  },
};
