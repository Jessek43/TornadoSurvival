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

  round: {
    // Longer than the old 12s so there's a fair window to run into the large
    // hospital, find a stairwell, climb, and pick a room before the first
    // pass. Round total ≈ 25 + (23s pass + 28s gap)×N ≈ 1.7 min (2 passes) to
    // 2.5 min (3 passes) — inside the 2–5 min target.
    warningTime: 25,
  },

  player: {
    spawn: { x: 0, y: 0, z: 20 }, // feet position on the ground
    height: 1.8, // capsule total height (m)
    radius: 0.35, // capsule radius (m)
    eyeHeight: 1.65, // camera height above the feet

    walkSpeed: 5.5, // m/s
    climbSpeed: 3, // m/s up/down a ladder
    jumpSpeed: 4.8, // m/s upward → apex ≈ v²/2g ≈ 1.2 m
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
    staminaDrain: 0.16, // /s at exactly sweepPressure (scales with strain, capped)
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
    batterPerSec: 8, // hp/s at exactly sweepPressure; scales with felt pressure
  },

  camera: {
    fov: 75,
    chaseDistance: 6.5, // m behind the flung body
    chaseHeight: 3, // m above it
    chaseLerp: 4, // 1/s spring toward the desired chase position
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
  // + a lateral offset). Kept in sync with level/Hospital.ts.
  hospitalCenter: { x: 0, z: -20 },

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
    height: 60, // funnel height; winds fade out above ~80% of this
    gustAmp: 0.35, // ±35% gust modulation from noise
    gustScale: 0.05, // spatial gust frequency (1/m)
    gustSpeed: 1.1, // temporal gust frequency (1/s)

    // --- passes (see TornadoSystem) ---
    // A round is 2–3 straight passes, each spawning on a circle of passRadius
    // around the hospital, travelling a straight line (+ lateral jitter) that
    // aims at hospitalCenter offset sideways, then exiting → calm gap → next.
    moveSpeed: 6, // m/s ground speed during a pass
    passRadius: 70, // m — spawn/exit distance from the hospital center
    passRampIn: 5, // s — intensity 0→1 as the funnel approaches
    passRampOut: 5, // s — intensity 1→0 as it recedes
    passCountMin: 2,
    passCountMax: 3,
    gapDuration: 28, // s of calm between passes (the near-miss tension)
    // Lateral aim offset (perpendicular standoff of the pass line from the
    // hospital center). A MINIMUM standoff guarantees the funnel core never
    // bullseyes the building — it always passes to one side, so the opposite
    // wings survive. Diagnosis: a dead-center pass (offset≈0) legitimately
    // guts the whole footprint because the building is smaller than the
    // damage swath; grazing (offset ≥ ~24 m) reliably leaves the far side
    // intact. The pass still threatens whichever side it grazes.
    lateralOffsetMin: 26,
    lateralOffsetMax: 46,
    lateralJitter: 4, // rad/s-ish authority of the noise wobble on the path

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
    range: 16, // m — point-light reach
    // Sharper falloff (decay 1.8) than before so lights read as POOLS of light
    // with deep shadow between — scarier and more legible-by-contrast than flat
    // even fill (and it pairs with the reduced 5-light pool). Higher base to
    // keep the near-fixture area readable despite the steeper falloff.
    baseIntensity: 54,
    decay: 1.8,
    flickerAmount: 0.62, // deeper, more unstable emergency flicker
    fixtureColor: 0x9fb08a, // sickly green-white emergency tint
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
