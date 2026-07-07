/**
 * PHASE 2 — the hospital's per-floor LAYOUT TABLE. One explicit config object
 * per storey (index = floor), authored by hand: this is the "layout as data"
 * mandate — NOT a runtime procedural generator. The furnish pass (furnish.ts)
 * reads this table and dispatches each wing/floor to its archetype; all
 * per-floor variety (room counts, room sizes, density, the single kitchen,
 * dead-end alcoves) comes from these authored numbers, never from randomness.
 *
 * Why the STRUCTURAL corridors (spine + ribs + stair voids in shell.ts) are
 * NOT varied per floor: they carry the load path, the stair climb, and the
 * z-fight lift table, all asserted by verify.ts. Varying the walkable maze is
 * done at THIS layer instead — different room subdivisions per floor open and
 * close different stretches of each wing, so every floor reads distinct and
 * claustrophobic while the shell invariants stay locked.
 *
 * Distinctness of `id` and the single-kitchen rule are asserted by verify.ts.
 */

export type RoomContent = "patient" | "office" | "kitchen";

export interface FloorLayout {
  /** Distinct human id per floor (verify asserts distinctness + prints them). */
  id: string;
  /** Floor-0 entrance concourse vs the upper ward/office floors. */
  archetype: "entrance" | "ward";
  /** Windowed facade rooms furnished per OUTER wing (0–3). Lower = plainer,
   *  longer bare corridor stretches; higher = denser, more claustrophobic. */
  facadeRooms: number;
  /** Blind interior rooms across the ward corridor per outer wing (0–2). */
  interiorRooms: number;
  /** What the FACADE rooms are furnished as (interior rooms follow, except the
   *  one kitchen). */
  content: RoomContent;
  /** IV stand + monitor + chair in wide rooms — the denser, dressed floors. */
  extras: boolean;
  /** The building's SINGLE kitchen: the [gx, gz] wing that hosts it on THIS
   *  floor (its blind interior room becomes a kitchen). Exactly one entry in
   *  the table sets this — verify asserts total kitchens == 1. */
  kitchenWing?: readonly [number, number];
}

// Floors 0..6 (FLOORS_MAX storeys). Outer columns are 5 floors, inner 7, so a
// short wing simply stops consuming the table early — every floor it DOES have
// is furnished. Densities are tuned to keep the tallest wing's section under
// the 600-block cap (verify) with headroom.
export const FLOOR_LAYOUTS: readonly FloorLayout[] = [
  {
    id: "L0-entrance-concourse",
    archetype: "entrance",
    facadeRooms: 1,
    interiorRooms: 1,
    content: "office",
    extras: false,
  },
  {
    id: "L1-triage-ward",
    archetype: "ward",
    facadeRooms: 2,
    interiorRooms: 1,
    content: "patient",
    extras: true,
  },
  {
    id: "L2-long-ward",
    archetype: "ward",
    facadeRooms: 2,
    interiorRooms: 1,
    content: "patient",
    extras: true,
  },
  {
    id: "L3-service-ward",
    archetype: "ward",
    facadeRooms: 2,
    interiorRooms: 1,
    content: "patient",
    extras: false,
    kitchenWing: [0, 2], // the one kitchen: west front wing, this floor
  },
  {
    id: "L4-recovery-ward",
    archetype: "ward",
    facadeRooms: 2,
    interiorRooms: 0,
    content: "patient",
    extras: true,
  },
  {
    id: "L5-quiet-ward",
    archetype: "ward",
    facadeRooms: 1,
    interiorRooms: 1,
    content: "patient",
    extras: false,
  },
  {
    id: "L6-isolation-ward",
    archetype: "ward",
    facadeRooms: 1,
    interiorRooms: 0,
    content: "patient",
    extras: false,
  },
];
