import type { CellRect } from "./grid";
import type { RoomContent } from "./layouts";

/**
 * THE AUTHORED FLOOR PLANS — one entry per storey, hand-authored as DATA (a
 * builder-from-data, never a runtime random generator). Each spec pins the
 * corridor NETWORK for that floor (as whole-cell rectangles) plus the content
 * palette; partition.ts deterministically fills the leftover usable cells with
 * enclosed rooms, walls every walkable/non-walkable boundary, and cuts a door
 * from each room onto its adjacent corridor. So the plan you read here IS the
 * floor: change a corridor and the rooms re-tile around it.
 *
 * Why authored corridors (not a shared shell skeleton): the old bug was one
 * open plate shared across every storey. Here every floor pins its OWN winding
 * corridor set — a spine avenue, ribs, branches and dead-end alcoves — so each
 * floor reads distinct and claustrophobic. verify.ts asserts the network is one
 * connected component that reaches a stair core, that every room is reachable,
 * that no open plate survives, and that all seven signatures differ.
 *
 * FIXED FACTS the plans build around (never moved here — read from the shell):
 *  - grid: 32 × 24 cells (2 m each); wings are 8 cells; see grid.ts.
 *  - stair cores: shafts at x=±10 rasterize to CORE cells ix{9..12}/{19..22} ×
 *    iz{10..13}; ribs at ix13 / ix18 hug their open (building-centre) side, so
 *    they double as the stair lobbies that make the climb reachable.
 *  - upper floors (5,6) shrink to the two inner wing columns (ix 8..23) — the
 *    massing step. Corridors on those floors stay inside that band.
 */

export interface FloorSpec {
  /** Distinct, human-readable id (verify asserts uniqueness + prints it). */
  id: string;
  /** Department theme label (matches the floor's dominant content). */
  theme: string;
  /** The authored corridor network for this floor (whole-cell rects). */
  corridors: CellRect[];
  /** Windowed (exterior-facing) rooms take this content. */
  facade: RoomContent;
  /** Blind (interior) rooms take this content. */
  core: RoomContent;
  /** Max room extent along / away from its access corridor (cells). Lower
   *  floors run denser (smaller rooms, more of them); upper floors sparser. */
  roomMaxW: number;
  roomMaxD: number;
  /** The single kitchen: first facade room carved in this wing becomes it.
   *  Exactly one spec sets this (verify asserts kitchens == 1). */
  kitchenWing?: readonly [number, number];
  /** Targeted content overrides: the first facade/core room carved in a wing
   *  takes this content — the signature extras (nurse station, isolation,
   *  server, waiting) that give each floor a room the others don't. */
  overrides?: readonly { gx: number; gz: number; facade: boolean; content: RoomContent }[];
}

// --- corridor authoring helpers (cell coords) ---------------------------------
// Full usable width depends on the storey (outer columns stop at floor 5).
const wide = (f: number): { x: number; w: number } =>
  f >= 5 ? { x: 8, w: 16 } : { x: 0, w: 32 };
/** Full-height N–S rib corridor at column ix. */
const rib = (ix: number): CellRect => ({ x: ix, z: 0, w: 1, d: 24 });
/** Full-width E–W avenue at row iz. */
const avenue = (iz: number, f: number): CellRect => ({ x: wide(f).x, z: iz, w: wide(f).w, d: 1 });
/** A short E–W dead-end alcove: ix..ix+w at row iz. Authored to ABUT a full
 *  rib on one end so it always joins the network (its far end is the dead end).*/
const alcove = (ix: number, iz: number, w: number): CellRect => ({ x: ix, z: iz, w, d: 1 });

// The two stair-lobby ribs (ix13 east of shaft A, ix18 west of shaft B) appear
// on every floor so the climb is always reachable; per-floor ribs vary around
// them for winding + distinctness.
const STAIR_RIBS = [13, 18];

/**
 * FLOOR_SPECS[f] — authored bottom (dense, public) to top (sparse, quiet).
 * Corridors are assembled per floor from avenue()/rib() so each floor's network
 * is visibly different (rib count/positions, which avenues, branch stubs).
 */
export const FLOOR_SPECS: readonly FloorSpec[] = [
  // f0 — Entrance & Emergency. Twin avenues + an entrance-axis rib (ix16) and
  // ED ribs; front-centre rooms are the waiting concourse, the rest ED bays.
  {
    id: "L0-entrance-emergency",
    theme: "Entrance & Emergency",
    corridors: [
      avenue(9, 0),
      avenue(14, 0),
      ...[3, 6, 16, 26].map(rib),
      ...STAIR_RIBS.map(rib),
    ],
    facade: "patient", // ED treatment / resus bays around the concourse
    core: "store", // records / pharmacy store off the lobby
    roomMaxW: 3,
    roomMaxD: 4,
    overrides: [
      { gx: 1, gz: 2, facade: true, content: "waiting" },
      { gx: 2, gz: 2, facade: true, content: "waiting" },
      { gx: 2, gz: 2, facade: false, content: "nurse_station" },
    ],
  },
  // f1 — Outpatient & Imaging. Long dense spine of consult/scanner rooms; a
  // radiology reading office across the corridor.
  {
    id: "L1-outpatient-imaging",
    theme: "Outpatient & Imaging",
    corridors: [
      avenue(9, 1),
      avenue(14, 1),
      ...[4, 27].map(rib),
      ...STAIR_RIBS.map(rib),
    ],
    facade: "imaging",
    core: "office", // radiology reading rooms
    roomMaxW: 3,
    roomMaxD: 3,
  },
  // f2 — Surgical. Sterile loop: extra ribs (dense) frame the theatres; scrub /
  // sterile-supply stores across the corridor.
  {
    id: "L2-surgical-theatres",
    theme: "Surgical",
    corridors: [
      avenue(9, 2),
      avenue(14, 2),
      ...[3, 5, 15, 26, 28].map(rib),
      ...STAIR_RIBS.map(rib),
    ],
    facade: "surgical",
    core: "store", // sterile supply / scrub stores
    roomMaxW: 3,
    roomMaxD: 4,
    overrides: [{ gx: 1, gz: 0, facade: false, content: "office" }],
  },
  // f3 — Inpatient Wards. Racetrack: both avenues + ribs loop the nurse core;
  // the building's single staff kitchen sits on the west front wing.
  {
    id: "L3-inpatient-wards",
    theme: "Inpatient Wards",
    corridors: [
      avenue(9, 3),
      avenue(14, 3),
      ...[4, 16, 27].map(rib),
      ...STAIR_RIBS.map(rib),
    ],
    facade: "patient",
    core: "office", // ward office / nurse admin
    roomMaxW: 3,
    roomMaxD: 3,
    kitchenWing: [0, 2],
    overrides: [{ gx: 2, gz: 2, facade: false, content: "nurse_station" }],
  },
  // f4 — ICU / Critical Care. Horseshoe: north avenue only + south rib stubs,
  // sparser bays; an isolation room with a nearby anteroom-office.
  {
    id: "L4-intensive-care",
    theme: "ICU / Critical Care",
    corridors: [
      avenue(14, 4),
      ...[3, 15, 28].map(rib),
      ...STAIR_RIBS.map(rib),
      alcove(4, 3, 3), // dead-end alcoves branching off ribs 3 / 28
      alcove(25, 20, 3),
    ],
    facade: "icu",
    core: "office", // family waiting / monitoring office
    roomMaxW: 3,
    roomMaxD: 4,
    overrides: [
      { gx: 0, gz: 0, facade: true, content: "isolation" },
      { gx: 3, gz: 0, facade: false, content: "office" },
    ],
  },
  // f5 — Maternity & Paediatrics. Two short spines split by the core; delivery
  // rooms + nursery, with the milk-kitchen store across the way.
  {
    id: "L5-maternity-paediatrics",
    theme: "Maternity & Paediatrics",
    corridors: [
      avenue(9, 5),
      avenue(14, 5),
      ...[16].map(rib),
      ...STAIR_RIBS.map(rib),
    ],
    facade: "maternity",
    core: "store", // milk kitchen / supply store
    roomMaxW: 3,
    roomMaxD: 4,
    overrides: [{ gx: 1, gz: 0, facade: false, content: "office" }],
  },
  // f6 — Labs & Admin. The sparsest, most claustrophobic floor: a single south
  // avenue perimeter-ring feel, a lab, a records archive, a server room.
  {
    id: "L6-labs-admin",
    theme: "Labs & Admin",
    corridors: [
      avenue(9, 6),
      ...[16].map(rib),
      ...STAIR_RIBS.map(rib),
      alcove(14, 4, 2), // short winding stubs off ribs 13 / 18
      alcove(19, 20, 2),
    ],
    facade: "lab",
    core: "records",
    roomMaxW: 3,
    roomMaxD: 4,
    overrides: [
      { gx: 1, gz: 0, facade: false, content: "server" },
      { gx: 2, gz: 0, facade: true, content: "office" },
    ],
  },
];
