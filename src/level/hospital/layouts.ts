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

export type RoomContent =
  | "patient"
  | "office"
  | "kitchen"
  | "lab"
  | "records"
  // §3.4 floor-theme room types — the signature department equipment.
  | "imaging" // X-ray / CT scanner rooms (floor 1)
  | "surgical" // operating theatres (floor 2)
  | "icu" // critical-care bays: bed + ventilator + crash cart (floor 4)
  | "maternity"; // delivery / nursery: bed + incubator (floor 5)

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
  /** What the FACADE rooms are furnished as (except the one kitchen, which
   *  takes the last facade room of its wing). */
  content: RoomContent;
  /** What the BLIND interior rooms are furnished as — the per-floor UNIQUE
   *  room type, so every floor has a room the others don't (a lab, a records
   *  archive, a ward office). Defaults to `content` when omitted. */
  interiorContent?: RoomContent;
  /** IV stand + monitor + chair in wide rooms — the denser, dressed floors. */
  extras: boolean;
  /** The building's SINGLE kitchen: the [gx, gz] wing that hosts it on THIS
   *  floor (its last facade room becomes a kitchen). Exactly one entry in the
   *  table sets this — verify asserts total kitchens == 1. */
  kitchenWing?: readonly [number, number];
}

/** Structural signature of a floor — the tuple that must differ between any two
 *  floors so no two read alike (verify asserts uniqueness; the distinct `id` is
 *  the human label, this is the machine-checkable distinctness). */
export function floorSignature(l: FloorLayout): string {
  return [
    l.archetype,
    `f${l.facadeRooms}`,
    `i${l.interiorRooms}`,
    l.content,
    l.interiorContent ?? l.content,
    l.extras ? "x" : "-",
    l.kitchenWing ? "K" : "-",
  ].join("/");
}

// Floors 0..6 (FLOORS_MAX storeys). Outer columns are 5 floors, inner 7, so a
// short wing simply stops consuming the table early — every floor it DOES have
// is furnished. Densities are tuned to keep the tallest wing's section under
// the 600-block cap (verify) with headroom.
// Every entry has a DISTINCT floorSignature (verify asserts it) so no two
// floors read alike: the facade content alternates patient wards with an office
// (diagnostics) floor, densities step from dense lower floors to sparse quiet
// upper floors, and each floor's blind interior room is a different type — the
// per-floor "unique room" (records archive, path lab, ward office, the kitchen).
export const FLOOR_LAYOUTS: readonly FloorLayout[] = [
  {
    // §3.4 f0 — Entrance & Emergency: open concourse (front-center wings) plus
    // ED treatment bays with a crash cart; a records/pharmacy room off the lobby.
    id: "L0-entrance-emergency",
    archetype: "entrance",
    facadeRooms: 1,
    interiorRooms: 1,
    content: "patient", // ED resus/treatment bays in the non-concourse wings
    interiorContent: "records", // records / pharmacy store off the lobby
    extras: true,
  },
  {
    // §3.4 f1 — Outpatient & Imaging: X-ray / CT scanner rooms, a radiology
    // reading office across the corridor.
    id: "L1-outpatient-imaging",
    archetype: "ward",
    facadeRooms: 2,
    interiorRooms: 1,
    content: "imaging",
    interiorContent: "office", // radiology reading room
    extras: false,
  },
  {
    // §3.4 f2 — Surgical: operating theatres (table + ceiling light + anaesthesia
    // cart), a scrub/sterile office across the corridor.
    id: "L2-surgical-theatres",
    archetype: "ward",
    facadeRooms: 2,
    interiorRooms: 1,
    content: "surgical",
    interiorContent: "office", // scrub / sterile supply
    extras: true,
  },
  {
    // §3.4 f3 — Inpatient Wards: patient beds + the building's single (staff)
    // kitchen on the west front wing.
    id: "L3-inpatient-wards",
    archetype: "ward",
    facadeRooms: 2,
    interiorRooms: 1,
    content: "patient",
    interiorContent: "office", // ward office / nurse admin
    extras: false,
    kitchenWing: [0, 2], // the one kitchen: west front wing, this floor
  },
  {
    // §3.4 f4 — ICU / Critical Care: bed + ventilator + crash cart bays, dense
    // facade, no blind rooms (an open critical-care floor).
    id: "L4-intensive-care",
    archetype: "ward",
    facadeRooms: 2,
    interiorRooms: 0,
    content: "icu",
    extras: true,
  },
  {
    // §3.4 f5 — Maternity & Paediatrics: delivery rooms + nursery incubators, a
    // single ward office.
    id: "L5-maternity-paediatrics",
    archetype: "ward",
    facadeRooms: 1,
    interiorRooms: 1,
    content: "maternity",
    interiorContent: "office",
    extras: false,
  },
  {
    // §3.4 f6 — Labs & Admin: pathology lab benches + specimen fridges, a records
    // archive across the corridor (the sparsest, most claustrophobic floor).
    id: "L6-labs-admin",
    archetype: "ward",
    facadeRooms: 1,
    interiorRooms: 1,
    content: "lab",
    interiorContent: "records",
    extras: false,
  },
];
