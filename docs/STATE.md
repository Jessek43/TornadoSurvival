<!--
STATE.md — the single machine-maintained description of what is built, verified, and open.
Rules for this file (see CLAUDE.md § docs/STATE.md for the obligation to keep it current):
- Hard cap: 150 lines. Over that means entries are being appended, not replaced. Collapse them.
- Replace, never append. Git holds history. This file is the present tense only. No changelog, ever.
- No hedging vocabulary. A thing is Confirmed (with a tag), or Unverified, or Open — never a maybe or a claim of progress.
- Bullets, not prose. No paragraph exceeds one sentence.
- Confirmed bullets MUST end with a backticked evidence tag: a `verify:*` script or a `?debug` field.
-->

# STATE

## Confirmed

- AppFlow is a 4-state machine (menu/playing/survived/died); all reachable, illegals throw. `verify:flow`
- Objective returns exactly one terminal verdict (won/lost/pending) per round. `verify:flow`
- Win/lose are direct playing→terminal edges — no intermediate timer/gap state. `verify:flow`
- Pause-restart and died-restart converge on the same `restart` transition. `verify:flow`
- Settings: sensitivity clamps, and loadSettings returns the default for 7 corrupt inputs without throwing. `verify:flow`
- Live app state is on the HUD. `?debug flow:`
- Restart parity — sections/released/lights/dressing print on each entry to playing. `?debug logSessionBaseline`
- BootFlow is a 5-state machine; all 20 (state,input) pairs resolve; unsupported and error are terminal. `verify:boot`
- Error is idempotent (1 transition of 50) and reachable from every non-terminal state. `verify:boot`
- Loading progress is monotonic (100/100 orders) and ready fires once, only on the full task set. `verify:boot`
- Capability truth table: 16 input combos → exactly 1 playable, 15 unsupported. `verify:boot`
- Capability reasons (webgl2/wasm/pointerlock) select correctly; pointer sub-checks collapse to 3 distinct. `verify:boot`
- Capability probe reads (pointer: fine) and carries no UA/touch signal (0/4 banned). `verify:boot`
- Post-ready error and contextLost route to distinct screens and request one loop-cancel each. `verify:boot`
- Debug widgets are gated behind ?debug; ?bare alone builds 0. `verify:boot`
- AlarmController is edge-triggered: 2 starts / 2 stops over warning→pass→gap→pass→done. `verify:lightning`
- No phantom gap after the final pass; the siren stays silent once the round resolves. `verify:lightning`
- Two-funnel pass: a single start/stop while any funnel is present. `verify:lightning`
- maxBlocksPerStrike ≤ debrisBudget on every quality preset. `verify:lightning`
- Live siren state, alarm start/stop counts, next-strike countdown, and last strike. `?debug §A/§L`
- Boundary coverage: 360/360 rays from centre hit a wall segment. `verify:boundary`
- Containment matches the analytic square at 10000/10000 grid points. `verify:boundary`
- Warn latch yields 2 transitions clean and 2 under 40× sub-hysteresis jitter. `verify:boundary`
- Boundary geometry (walls + dressing slots) scales exactly with halfExtent. `verify:boundary`
- Live edge-zone, signed edge distance, and boundary collider/prop counts. `?debug §B`
- Hospital coplanar same-facing overlaps == 0, bare and detailed. `verify:hospital`
- Unsupported-at-birth blocks == 0. `verify:hospital`
- Every room reachable from the stairs; ≥5 rooms/floor; no single region > 40% of plate. `verify:hospital`
- Each stair core is enclosed with exactly one corridor doorway per floor. `verify:hospital`
- Door headers 0 open samples; 0 room cells open to the outside. `verify:hospital`
- Corridor dressing chokes 0 corridor cells (capsule flood). `verify:hospital`
- Glass exists only on the registered perimeter faces. `verify:hospital`
- ≥8 light fixtures, each within strandRange of a durable block. `verify:hospital`
- 7 structurally distinct floors and exactly 1 kitchen. `verify:hospital`
- Section blocks ≤ 1400, total ≤ 16000; stair rise/run inside autostep bounds. `verify:hospital`
- Hospital sections never overlap a neighborhood section. `verify:hospital`
- Live orphan-lit count and per-stair per-floor fixture lit state. `?debug orphanLit/§1`
- FPS, awake sections, block bodies, released, debris/budget, and draw calls for manual read. `?debug fps`
- Live scene light count vs baseline and live vs total fixtures. `?debug lights/dressing`
- Multi-funnel felt intensity, funnel count, nearest distance, and global debris ≤ cap. `?debug §2`
- WindField superposes every live funnel; felt intensity tracks the nearest. `?debug §2`
- 60 fps holds through a heavy destruction pass. `?debug fps`
- Restart re-enters playing with no GPU/AudioContext re-creation. `?debug logSessionBaseline`
- Terrain.heightAt is total (0/10201 non-finite) and deterministic (0 mismatches, two builds). `verify:terrain`
- Every building section footprint lies inside a pad (0/65 outside); 43 trees field-planted. `verify:terrain`
- Pad, hospital-footprint and on-pad-boundary samples are exactly padY (inclusive, stable). `verify:terrain`
- At amplitude 0 all 10201 samples are padY; 4a apron step 0/1952, 4b field slope 0/16653, 0 newly accepted. `verify:terrain`
- Ground is a subdivided height mesh + Rapier heightfield collider over one shared grid. `?debug §T`
- Live heightAt/foot gap + in-pad flag show the heightfield holds the player up. `?debug §T`

## Working, not asserted
- Player toolkit: move / look / jump / sprint / crouch / flashlight / grip.
- Storm sky dome, lightning bolt visuals, thunder audio, and atmosphere mood flasher.
- In-place teardown/rebuild runs without GPU or AudioContext churn.
- Pointer-lock loss pauses the whole sim and one click re-locks across the browser cooldown.
- Hospital furnish vertical slice (Floor-3 wards) vs the leaner base furnish on other departments.
- Exterior detail: ground textures, ambulance model, tree-vs-building nudge.
- Vercel Analytics reporting from the deployed site.

## Verification

| Script | Asserts | Prints |
| --- | --- | --- |
| `verify:flow` | AppFlow reachability/edges, Objective verdict, Settings load | 4 states, 5 edges, 24 combos, 7 corrupt inputs |
| `verify:boot` | BootFlow table, capability gate, post-ready routing | 20 pairs, 16 combos→1, 5 screen keys, 0/4 banned |
| `verify:lightning` | strike cap vs debris budget, alarm edges | LightningConfig dump, starts/stops (2/2, 1/1) |
| `verify:boundary` | wall coverage, containment, warn latch, scaling | 360/360, 10000/10000, 2 transitions |
| `verify:hospital` | coplanar/support/reachability/enclosure/circulation | overlaps 0, unsupported 0, choked 0, rooms/floor |
| `verify:terrain` | heightAt totality/determinism, pad flatness, building-on-pad, apron step (4a) vs field slope (4b), boundary stability | 10201 samples, 0/65 outside, 4a 0/1952, 4b 0/16653, flat 10201/10201 |
| `sweep:terrain` | **measurement, asserts nothing** — prices field relief over amplitude × wavelength | table of field/paved slope, main-street relief, meshGap; max amp per wavelength |

## Debug readout

- `fps` — smoothed frame rate (EMA over 1/dt).
- `flow:` — AppFlow.state.
- `sens:` — player sensitivity ÷ config default.
- `phase:` — tornado round phase (pass N/N | gap | idle | done).
- `siren:` — AlarmController.playing.
- `tornado` — primary-funnel distance @ intensity.
- `awake / bodies / released` — StructureSystem runtime counters.
- `debris` — DebrisManager active / budget.
- `orphanLit` — InteriorLights.countOrphanLit.
- `lights` — scene THREE.Light count / spawn baseline.
- `dressing` — InteriorLights live / total fixtures.
- `draw` — renderer.info.render.calls.
- `§1 traversal` — grounded state, feet/crown, move want/achieved, head clearance.
- `stair A/B` — per-floor stairwell fixture lit state.
- `§2 funnels` — count, through-building, centers, nearest, darkness, debris/cap.
- `ground below feet` — downward raycast gap.
- `last landing` — PlayerController fall speed → fall damage.
- `§L lightning` — enabled, next-strike countdown, last strike point/type/blocks.
- `§A alarm` — playing, start/stop counts, tornado-present.
- `§B bounds` — zone, edge distance, boundary colliders / props.
- `§T terrain` — grid @ cellSize, amplitude, pad count, heightAt(feet), foot gap, in-pad, collider kind.

## Open

- Paved quads meet relief (Path A: vertices to the mesh surface + tier) — not yet built; the amplitude/wavelength cap is now a measured quantity (docs/terrain-shape.md via `sweep:terrain`), not an artefact; amplitude stays 0 until Path A lands.
- Neighborhood and ground planes are not under the coplanar z-fight assert (symptom: possible flicker).
- Hospital z-fight and Floor-3 furnish slice are not re-confirmed in the browser.
- A grazing pass that strips cladding but leaves the slab keeps ceiling fixtures lit under it.
- Mobile / low-end frame rate is not measured.
- `verify:lightning` §1 prints LightningConfig defaults with no assertion behind them.

## Deferred

- Per-room "destroyed" fixture signal — design change, not scheduled.
- Code-splitting Game off the unsupported path — out of scope.
- Neighborhood/ground z-fight static assert — not yet added.
- Quality-preset selection UI — not built.
- Service workers, telemetry SDKs, error-reporting — out of scope.
- Progression, multiplayer, NPCs, mobile input — out of scope.
- @dimforge/rapier3d (non-compat) swap — breaks the WASM-less boot guarantee.
