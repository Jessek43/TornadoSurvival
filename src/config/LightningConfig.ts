/**
 * All storm-lightning tuning in one object (sibling to GameConfig).
 *
 * Every knob for the 3D strike feature lives here — frequency, targeting, the
 * bolt look, the screen flash, structure damage, and thunder — so no magic
 * number leaks into LightningSystem. Deliberately NOT `as const` (like
 * GameConfig) so a future ?debug lil-gui panel can mutate it live.
 *
 * Colors are hex ints (consumed as `new THREE.Color(hex)` in the system) so
 * this module stays THREE-free and can be imported by the terminating
 * verify-lightning.ts without pulling in the renderer.
 */
export type TargetBias = "uniform" | "nearTornado" | "tallStructures";

export interface LightningConfigT {
  /** Master switch — false disables the whole strike system. */
  enabled: boolean;
  /** Only strike while a funnel is active in the storm window (gates on
   *  TornadoSystem.active). false = strikes any time the game runs. */
  onlyDuringTornado: boolean;
  /** Average strikes per second while strikes are allowed ("every now and
   *  then"). 0.18 ≈ one every ~5.5 s, so ~3–4 over a 20 s pass. */
  strikeRatePerSecond: number;
  /** ± fraction of the nominal interval (1/rate) rolled per strike, so the
   *  cadence isn't metronomic. 0.6 = each gap is 40–160% of nominal. */
  rateJitter: number;

  /** How the (x,z) impact point is chosen each strike. */
  targetBias: TargetBias;
  /** Radius (m) around the funnel that "nearTornado" scatters strikes within. */
  nearTornadoRadius: number;
  /** If false, a pick that resolves to bare ground is re-rolled toward a
   *  structure (a few attempts) — only structures get struck. */
  groundStrikeAllowed: boolean;

  // --- bolt visual (generated geometry, disposed after boltLifetimeMs) ---
  /** Searing blue-white; bright enough to bloom through the post chain. */
  boltColor: number;
  /** HDR multiplier on boltColor (unlit + un-tone-mapped, so >1 blows past the
   *  bloom threshold hard — the "make it brighter" dial for the bolt itself). */
  boltBrightness: number;
  /** Jaggedness: number of vertical segments cloud→ground. */
  boltSegments: number;
  /** Lateral wander (m) applied per interior segment. */
  boltJitter: number;
  /** Tube diameter (m) of the main bolt (bloom makes it read wider). */
  boltWidth: number;
  /** 0–1 probability a side-branch forks off each interior segment. */
  boltBranchChance: number;
  /** How long the bolt geometry lives before disposal (ms). */
  boltLifetimeMs: number;
  /** On/off flickers over the lifetime (the strobing lightning look). */
  boltFlickerCount: number;

  // --- screen / sky flash (layered on Atmosphere's own mood flasher) ---
  boltFlashColor: number;
  /** Peak brightness spike (may exceed 1 for a blown-out sun). */
  flashIntensity: number;
  /** Flash decays to ~5% over this long (ms). */
  flashDurationMs: number;
  /** A real point light spiked at the impact for `flashDurationMs`, so the
   *  struck structure lights up locally (not just a global sky flash). 0 = off. */
  strikeLightIntensity: number;
  strikeLightDistance: number;

  // --- structure damage ---
  damageStructures: boolean;
  /** Break radius (m) around the impact point. */
  damageRadius: number;
  /** Outward+downward fling speed (m/s) imparted to blown-off blocks. */
  damageImpulse: number;
  /** HARD cap on directly-destroyed blocks per strike, so a single strike can
   *  never try to dump more than a slice of the (globally capped) debris pool.
   *  Support-collapse beyond this is the structure system's own realism and is
   *  bounded separately by the debris budget. */
  maxBlocksPerStrike: number;

  // --- audio ---
  /** Strike volume for AudioSystem.thunder — the SAME deep rumble as the ambient
   *  sky-flash thunder (which peaks ~0.35–0.65), just louder for a close strike. */
  thunderVolume: number;
  /** Delay from flash to the rumble (ms). 0 = paired with the flash; >0 = the
   *  light-then-sound gap (short here — strikes are close). */
  thunderDelayMs: number;

  // --- extra tunables (kept here so nothing is hard-coded in the system) ---
  /** Bolt origin height / raycast start height (m above ground). */
  cloudHeight: number;
  /** Disc radius (m) around the hospital that "uniform" bias samples within. */
  targetAreaRadius: number;
  /** Concurrent bolt meshes before the oldest is force-disposed (pool guard
   *  for a cranked rate — keeps live geometry bounded). */
  maxLiveBolts: number;
  /** Camera kick on a strike (reuses CameraRig.addImpulse; ~0..1). */
  cameraImpulse: number;
  /** Leave a fading scorch disc where a bolt hits bare ground. */
  groundScorch: boolean;
  scorchRadius: number;
  scorchLifetimeMs: number;
  /** Pooled scorch discs (oldest reused when exceeded). */
  maxScorchMarks: number;
}

export const LightningConfig: LightningConfigT = {
  enabled: true,
  onlyDuringTornado: true,
  strikeRatePerSecond: 0.18,
  rateJitter: 0.6,

  // "nearTornado" now PREFERS a real structure near the funnel (a building/tree
  // roof), only scattering onto nearby ground when nothing is in range — so
  // bolts hit objects, or land close to them.
  targetBias: "nearTornado",
  nearTornadoRadius: 70,
  groundStrikeAllowed: true,

  boltColor: 0xeaf3ff, // near-white with a cold cast (× boltBrightness → HDR)
  boltBrightness: 5,
  boltSegments: 12,
  boltJitter: 4.5,
  boltWidth: 0.9,
  boltBranchChance: 0.35,
  boltLifetimeMs: 400,
  boltFlickerCount: 4,

  boltFlashColor: 0xcfe4ff,
  flashIntensity: 6.0,
  flashDurationMs: 280,
  strikeLightIntensity: 1600,
  strikeLightDistance: 95,

  damageStructures: true,
  damageRadius: 6,
  damageImpulse: 18,
  maxBlocksPerStrike: 22,

  thunderVolume: 3.5, // ~2× the ambient rumble's average peak → clearly louder
  thunderDelayMs: 120,

  cloudHeight: 150,
  targetAreaRadius: 130,
  maxLiveBolts: 40,
  cameraImpulse: 0.5,
  groundScorch: true,
  scorchRadius: 1.8,
  scorchLifetimeMs: 6000,
  maxScorchMarks: 8,
};
