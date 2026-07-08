import type { BlockDef } from "../Blueprints";
import type { MaterialId } from "../Materials";
import { block } from "./shell";

/**
 * PHASE 2 — the prop kit. Pure factories: each returns the BlockDef[] for one
 * prop at an anchor position + facing, with its block count in the doc
 * comment. Props know nothing about wings or floors — archetypes.ts decides
 * where they stand and owns the per-floor block budgets.
 *
 * Placement discipline every factory obeys (keeps the verify invariants at
 * zero without per-prop exceptions):
 *  - freestanding props sit bottom-flush ON the deck-top plane (support edge
 *    to the deck via exact contact; released with the room by the flood-fill);
 *  - wall-mounted props ABUT the wall's inner face — contact, never intrusion;
 *  - within a prop, sub-blocks stack exactly and are inset ≥ 0.05 m on both
 *    horizontal axes (or abut edge-to-edge), so no two same-facing faces ever
 *    share a plane with real overlap area;
 *  - prop materials are furniture/metal tier (threshold < 550), so a prop can
 *    never stand in for a light fixture's durable enclosure.
 */

export type Facing = "+z" | "-z" | "+x" | "-x";

/**
 * Local frame: `across` runs along the wall the prop backs onto, `depth`
 * grows away from that wall toward `facing`. (x, z) is the anchor — the
 * center of the prop's BACK edge at the wall face. Same axis-swap trick as
 * buildHouse's put() in Neighborhood.ts.
 */
function frame(x: number, z: number, facing: Facing) {
  const alongX = facing === "+x" || facing === "-x";
  const sign = facing === "+z" || facing === "+x" ? 1 : -1;
  return (
    mat: MaterialId,
    across: number,
    bottom: number,
    depth: number,
    wAcross: number,
    h: number,
    wDepth: number,
  ): BlockDef => {
    return alongX
      ? block(mat, x + depth * sign, bottom, z + across, wDepth, h, wAcross)
      : block(mat, x + across, bottom, z + depth * sign, wAcross, h, wDepth);
  };
}

/** Patient bed — 3 blocks: metal frame, inset white mattress, one side rail
 *  (abutting the frame's side face; y-overlap with the frame supports it). */
export function bed(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 1.0, 0.9, 0.35, 2.0),
    put("propWhite", 0, floorY + 0.35, 1.0, 0.8, 0.25, 1.9),
    put("metal", 0.48, floorY + 0.1, 1.0, 0.06, 0.65, 1.6),
  ];
}

/** Bedside cabinet — 1 block. */
export function bedsideCabinet(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  return [frame(x, z, facing)("propWhite", 0, floorY, 0.25, 0.45, 0.85, 0.45)];
}

/** IV stand — 2 blocks: thin pole + bag abutting the pole's upper side. */
export function ivStand(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.2, 0.06, 1.7, 0.06),
    put("propWhite", 0.105, floorY + 1.3, 0.2, 0.15, 0.3, 0.1),
  ];
}

/** Bedhead panel — 1 wall-abutting accent block over the bed (kept to the
 *  bed's own width band so it never reaches a separator wall's plane). */
export function bedheadPanel(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  return [frame(x, z, facing)("accentBlue", 0, floorY + 1.5, 0.03, 1.2, 0.5, 0.06)];
}

/** Visitor chair — 2 blocks: seat + backrest resting on the seat's rear edge
 *  (their shared rear plane abuts vertically — zero overlap area). */
export function chair(
  x: number,
  floorY: number,
  z: number,
  facing: Facing,
  mat: MaterialId = "accentOrange",
): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put(mat, 0, floorY, 0.25, 0.5, 0.45, 0.5),
    put(mat, 0, floorY + 0.45, 0.04, 0.5, 0.5, 0.08),
  ];
}

/** Window drape — 1 floor-length panel flat against the facade wall's inner
 *  face, flanking a window (the image-6 read). Never crosses the room, so it
 *  can't block circulation like the old mid-room privacy curtain did. */
export function windowDrape(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  return [frame(x, z, facing)("propWhite", 0, floorY, 0.04, 0.45, 2.6, 0.08)];
}

/** Potted plant — 3 blocks, reusing tree materials (no new ids). */
export function plant(x: number, floorY: number, z: number): BlockDef[] {
  return [
    block("propWhite", x, floorY, z, 0.4, 0.4, 0.4),
    block("trunk", x, floorY + 0.4, z, 0.12, 0.8, 0.12),
    block("foliage", x, floorY + 1.2, z, 0.7, 0.7, 0.7),
  ];
}

/** Wall-abutting sign (room number / bay sign / wall chart). 1 block. */
export function wallPanel(
  x: number,
  bottomY: number,
  z: number,
  facing: Facing,
  mat: MaterialId,
  w: number,
  h: number,
): BlockDef[] {
  return [frame(x, z, facing)(mat, 0, bottomY, 0.025, w, h, 0.05)];
}

/** Office desk — 2 blocks: white pedestal body + a wood top on its own plane
 *  (overhangs in depth only, so the side faces stay coplanar-clean). */
export function officeDesk(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("propWhite", 0, floorY, 0.75, 0.95, 0.72, 1.25),
    put("wood", 0, floorY + 0.72, 0.78, 0.95, 0.06, 1.4),
  ];
}

/** Filing / storage cabinet — 1 tall block. */
export function cabinet(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  return [frame(x, z, facing)("propWhite", 0, floorY, 0.28, 0.9, 1.25, 0.55)];
}

/** Kitchen counter run — 2 blocks: base cabinets + a steel worktop (stacked,
 *  y-abutting, so the shared side planes carry zero overlap area). `len` runs
 *  ALONG the wall. */
export function counter(
  x: number,
  floorY: number,
  z: number,
  facing: Facing,
  len: number,
): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("propWhite", 0, floorY, 0.3, len, 0.85, 0.6),
    put("metal", 0, floorY + 0.85, 0.31, len, 0.06, 0.62), // worktop: back flush, 2 cm front lip
  ];
}

/** Kitchen appliance box (fridge / oven) — 1 metal block (back flush to the
 *  wall it stands against, so it never intrudes into the wall). */
export function appliance(
  x: number,
  floorY: number,
  z: number,
  facing: Facing,
  h = 1.75,
): BlockDef[] {
  return [frame(x, z, facing)("metal", 0, floorY, 0.35, 0.72, h, 0.66)];
}

/** Small kitchen/dining table — 2 blocks: leg block + top on its own plane. */
export function kitchenTable(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("wood", 0, floorY, 0.55, 0.7, 0.72, 1.0),
    put("wood", 0, floorY + 0.72, 0.55, 0.95, 0.06, 1.3),
  ];
}

/** Gurney — 3 blocks: metal underframe, white mattress, pillow. */
export function gurney(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.9, 0.55, 0.55, 1.6),
    put("propWhite", 0, floorY + 0.55, 0.9, 0.6, 0.15, 1.8),
    put("propWhite", 0, floorY + 0.7, 0.35, 0.5, 0.1, 0.35),
  ];
}

/** Wheelchair — 2 blocks: seat box + backrest (chair pattern, metal). */
export function wheelchair(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.3, 0.55, 0.5, 0.55),
    put("metal", 0, floorY + 0.5, 0.04, 0.55, 0.55, 0.08),
  ];
}

/** Vending machine — 2 blocks: a tall metal body + a lit glass-front panel
 *  standing proud of the front face (its own plane, so no coplanar clash). */
export function vendingMachine(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.35, 0.9, 1.9, 0.7),
    put("accentBlue", 0, floorY + 0.35, 0.705, 0.7, 1.2, 0.05), // glass front (proud of the body)
  ];
}

/** Supply / linen trolley — 2 blocks: a metal cabinet + a white tray top that
 *  overhangs it on both axes (own plane, no shared side face). */
export function supplyCart(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.3, 0.6, 0.85, 0.5),
    put("propWhite", 0, floorY + 0.85, 0.3, 0.68, 0.08, 0.58),
  ];
}

/** Linked waiting bench — 3 blocks: leg beam, seat slab, backrest. */
export function benchRow(
  x: number,
  floorY: number,
  z: number,
  facing: Facing,
  seatMat: MaterialId,
): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.3, 2.2, 0.35, 0.45),
    put(seatMat, 0, floorY + 0.35, 0.3, 2.2, 0.1, 0.5),
    put(seatMat, 0, floorY + 0.45, 0.06, 2.2, 0.5, 0.08),
  ];
}

/** Reception desk with accent stripe (treatment) — 6 blocks: 3-piece white
 *  U-body, 2 stripe strips abutting the front faces, counter top. */
export function receptionDesk(
  x: number,
  floorY: number,
  z: number,
  facing: Facing,
  stripe: MaterialId,
): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("propWhite", 0, floorY, 0.35, 2.6, 0.95, 0.7), // front body
    put("propWhite", -1.5, floorY, 0.95, 0.4, 0.95, 1.9), // left return
    put("propWhite", 1.5, floorY, 0.95, 0.4, 0.95, 1.9), // right return
    put(stripe, 0, floorY + 0.25, 0.725, 2.6, 0.18, 0.05), // stripe on front face
    put(stripe, 0, floorY + 0.55, 0.725, 2.6, 0.1, 0.05),
    put("propWhite", 0, floorY + 0.95, 0.35, 2.7, 0.08, 0.8), // counter top (own plane)
  ];
}

/** Nurse station (lobby) — 5 blocks: faceted axis-aligned arc of white body
 *  segments (corners abutting) + counter top at its own plane. */
export function nurseStation(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("propWhite", 0, floorY, 0.4, 2.4, 0.95, 0.8),
    put("propWhite", -1.7, floorY, 0.8, 1.0, 0.95, 0.8),
    put("propWhite", 1.7, floorY, 0.8, 1.0, 0.95, 0.8),
    put("propWhite", 0, floorY + 0.95, 0.4, 2.5, 0.08, 0.85),
    put("propWhite", 0, floorY + 0.3, 0.85, 1.6, 0.06, 0.1), // writing ledge
  ];
}

/** Lobby feature wall — 3 blocks: wood panel abutting a shell wall, red
 *  cross + white letter bar abutting the panel's front face. */
export function featureWall(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("wood", 0, floorY, 0.075, 5.0, 2.8, 0.15),
    put("signRed", -1.6, floorY + 1.8, 0.175, 0.6, 0.6, 0.05),
    put("propWhite", 0.7, floorY + 1.85, 0.175, 3.0, 0.45, 0.05),
  ];
}

/**
 * Ambulance — 18 blocks: a white Type-III box rig (Ford E-series read from the
 * reference). A tall white box module behind a lower windowed cab, on four
 * wheels with a grey rocker/chassis + bumpers, an emergency light bar (red /
 * amber / blue) on the box roof, and twin blue-over-orange side stripes.
 *
 * Reuses only existing materials — propWhite (body), metal (chassis, wheels,
 * bumpers, cab glazing), signRed/accentOrange/accentBlue (lights + stripes) —
 * so it adds no draw call and stays out of the perimeter-glass registry (no
 * `glass`: verify.ts would flag a windshield off the hospital envelope). Every
 * block chains to a ground-touching wheel and no two same-facing faces are
 * coplanar, so it passes the shell invariants like any other prop.
 */
export function ambulance(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  const y = floorY;
  return [
    // Wheels (ground anchors) — rear + front axle, both sides.
    put("metal", -0.82, y, 0.85, 0.42, 0.55, 0.75),
    put("metal", 0.82, y, 0.85, 0.42, 0.55, 0.75),
    put("metal", -0.82, y, 3.6, 0.42, 0.55, 0.75),
    put("metal", 0.82, y, 3.6, 0.42, 0.55, 0.75),
    // Grey rocker / chassis skirt spanning the wheelbase (rests on the wheels).
    put("metal", 0, y + 0.38, 2.35, 1.78, 0.4, 4.4),
    // White box module (rear) + lower windowed cab (front).
    put("propWhite", 0, y + 0.55, 1.5, 1.86, 2.0, 3.0),
    put("propWhite", 0, y + 0.55, 3.825, 1.7, 0.7, 1.65),
    put("metal", 0, y + 1.25, 3.95, 1.6, 0.62, 1.3), // cab greenhouse (glazing)
    // Bumpers.
    put("metal", 0, y + 0.25, 4.7, 1.6, 0.55, 0.35), // front
    put("metal", 0, y + 0.25, -0.13, 1.6, 0.55, 0.35), // rear
    // Roof light bar: dark base + red / amber / blue lamps across it.
    put("metal", 0, y + 2.55, 2.6, 1.7, 0.08, 0.45),
    put("signRed", -0.52, y + 2.63, 2.6, 0.5, 0.14, 0.4),
    put("accentOrange", 0, y + 2.63, 2.6, 0.5, 0.14, 0.4),
    put("accentBlue", 0.52, y + 2.63, 2.6, 0.5, 0.14, 0.4),
    // Twin side stripes (blue over orange) abutting each box flank.
    put("accentBlue", 0.945, y + 1.7, 1.5, 0.03, 0.18, 3.0),
    put("accentBlue", -0.945, y + 1.7, 1.5, 0.03, 0.18, 3.0),
    put("accentOrange", 0.945, y + 1.48, 1.5, 0.03, 0.16, 3.0),
    put("accentOrange", -0.945, y + 1.48, 1.5, 0.03, 0.16, 3.0),
  ];
}

// ===========================================================================
// §3.4/§3.5 THEMED EQUIPMENT — signature machines that make each floor read as
// its department (imaging / surgical / ICU / maternity / labs). Every one is
// sized to sit inside the proven bed footprint (≤ ~0.9 across × ≤ ~2.2 deep,
// wall-backed) so the room enterability flood-fill still clears, and every
// sub-block is y-stacked or inset ≥ 5 cm so no two same-facing faces overlap.
// ===========================================================================

/** CT / X-ray scanner (imaging floor) — 4 blocks: a gantry housing with a dark
 *  bore ring on its front, and a short patient table on a pedestal. Compact
 *  (≤ ~1.5 m deep) so it fits inside any room and the archetype can set it back
 *  off the facade, keeping the window band walkable. */
export function ctScanner(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("propWhite", 0, floorY, 0.55, 1.0, 1.7, 1.0), // gantry housing (depth 0.05..1.05)
    put("accentBlue", 0, floorY + 0.72, 1.08, 0.72, 0.72, 0.05), // bore ring, proud of the front
    put("metal", 0, floorY, 1.55, 0.24, 0.52, 0.75), // table pedestal (1.175..1.925), clear of gantry
    put("propWhite", 0, floorY + 0.52, 1.55, 0.5, 0.12, 0.9), // patient table (1.1..2.0) on the pedestal
  ];
}

/** Operating table (surgical floor) — 2 blocks: a central pillar + a narrow
 *  padded table top on its own plane. */
export function operatingTable(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 1.0, 0.42, 0.72, 0.5), // pillar
    put("propWhite", 0, floorY + 0.72, 1.0, 0.6, 0.14, 1.85), // padded top
  ];
}

/** Ceiling surgical-light cluster (surgical floor) — 2 blocks: a stem whose top
 *  abuts the ceiling deck (its support) + a wide dish whose top abuts the stem
 *  bottom (chained: dish → stem → deck → walls → ground). `ceilY` is the deck
 *  underside above (= (f+1)·floorHeight − deckT). `block(mat, x, BOTTOM, z, …)`. */
export function surgicalLight(x: number, ceilY: number, z: number): BlockDef[] {
  const stemH = 0.4;
  const dishH = 0.18;
  return [
    block("metal", x, ceilY - stemH, z, 0.14, stemH, 0.14), // stem: top at ceilY (touches deck)
    block("propWhite", x, ceilY - stemH - dishH, z, 0.95, dishH, 0.95), // dish top abuts stem bottom
  ];
}

/** Anaesthesia cart (surgical floor) — 2 blocks: a grey machine body + a gas
 *  cylinder beside it (both floor-standing). */
export function anaesthesiaCart(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.4, 0.55, 1.2, 0.6),
    put("accentTeal", 0, floorY, 0.95, 0.2, 1.0, 0.22), // gas cylinder
  ];
}

/** Ventilator / dialysis tower (ICU floor) — 2 blocks: a tower + a dark screen
 *  proud of its front face. */
export function ventilator(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.35, 0.5, 1.4, 0.55),
    put("accentBlue", 0, floorY + 0.95, 0.64, 0.42, 0.32, 0.05), // screen
  ];
}

/** Crash cart (ICU / ED floor) — 3 blocks: a red multi-drawer trolley, a defib
 *  box on top, and its screen (each on its own plane). */
export function crashCart(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("signRed", 0, floorY, 0.35, 0.55, 0.95, 0.55),
    put("metal", 0, floorY + 0.95, 0.35, 0.5, 0.18, 0.46), // defib body
    put("accentBlue", 0, floorY + 1.13, 0.35, 0.3, 0.12, 0.3), // defib screen
  ];
}

/** Incubator (maternity floor) — 3 blocks: a stand, a translucent hood, and the
 *  mattress inside it. */
export function incubator(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.5, 0.72, 0.78, 1.0), // stand
    put("propWhite", 0, floorY + 0.78, 0.5, 0.7, 0.1, 0.9), // mattress on the stand top
    put("accentBlue", 0, floorY + 0.9, 0.5, 0.82, 0.5, 1.02), // clear hood over it
  ];
}

/** Specimen / blood fridge (labs floor) — 2 blocks: a body + a glazed front
 *  panel (accentBlue, NOT glass — glass is perimeter-only). */
export function specimenFridge(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.35, 0.82, 1.9, 0.62),
    put("accentBlue", 0, floorY + 0.3, 0.67, 0.64, 1.4, 0.05), // glazed door, proud of the body
  ];
}

/** Small wall-abutting box (sharps bin / sanitiser / extinguisher) — 1 block,
 *  no floor footprint, so it never affects room walkability. */
export function wallBox(
  x: number,
  bottomY: number,
  z: number,
  facing: Facing,
  mat: MaterialId,
  size = 0.24,
): BlockDef[] {
  return [frame(x, z, facing)(mat, 0, bottomY, size / 2 + 0.02, size, size, size)];
}

// ===========================================================================
// WARD / OFFICE / KITCHEN DETAIL PROPS — the density that makes a furnished
// room read as a real hospital space. Every factory obeys the same discipline
// as the kit above (freestanding props bottom-flush on the deck; wall props
// abut the inner face; sub-blocks stack or inset ≥ 5 cm so no two same-facing
// faces overlap; small loose items are propWhite/furniture-tier so they fling
// whole in the storm). Counts are kept low — archetypes.ts scales how MANY of
// these a room gets by its size.
// ===========================================================================

/** Over-bed cantilever table — 3 blocks: a foot, a slim upright, a top slab
 *  that overhangs on its own plane. Slides in beside a bed at table height. */
export function overbedTable(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.25, 0.44, 0.04, 0.4), // foot
    put("metal", 0, floorY + 0.04, 0.25, 0.08, 0.78, 0.08), // upright
    put("propWhite", 0, floorY + 0.82, 0.32, 0.5, 0.05, 0.7), // cantilevered top
  ];
}

/** Wall vitals monitor — 2 blocks: a white housing abutting the wall + a dark
 *  screen embedded proud of its face. Hangs above the bedhead (clears the bed). */
export function vitalsMonitor(x: number, bottomY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("propWhite", 0, bottomY, 0.06, 0.46, 0.4, 0.12), // housing
    put("accentBlue", 0, bottomY + 0.05, 0.14, 0.36, 0.3, 0.04), // screen (proud)
  ];
}

/** Desktop PC on a desk/counter top — 3 blocks: monitor screen on a stalk, a
 *  keyboard. `topY` is the surface top; everything stacks above it, inset so no
 *  face aligns with the surface below. */
export function deskPC(x: number, topY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, topY, 0.5, 0.08, 0.12, 0.08), // stalk
    put("accentBlue", 0, topY + 0.12, 0.5, 0.5, 0.34, 0.05), // screen
    put("propWhite", 0, topY, 0.18, 0.42, 0.03, 0.16), // keyboard (front, on the surface)
  ];
}

/** Bookshelf / chart rack — 3 blocks: a tall body + two shelf ledges proud of
 *  the front (their own planes). Freestanding, backs onto a wall. */
export function bookshelf(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("wood", 0, floorY, 0.3, 0.9, 1.6, 0.55),
    put("propWhite", 0, floorY + 0.55, 0.62, 0.82, 0.06, 0.06), // lower shelf lip
    put("propWhite", 0, floorY + 1.05, 0.62, 0.82, 0.06, 0.06), // upper shelf lip
  ];
}

/** Wall cabinet band (over a kitchen counter / lab bench) — 1 block hung high
 *  on the wall, its own y-plane clear of the worktop below (0.5 m tall so a
 *  1.5 m mount top-outs at 2.0 m, clear of the 2.05 m department soffit band). */
export function upperCabinets(
  x: number,
  bottomY: number,
  z: number,
  facing: Facing,
  len: number,
): BlockDef[] {
  return [frame(x, z, facing)("propWhite", 0, bottomY, 0.18, len, 0.5, 0.36)];
}

/** Counter-top appliance (microwave / coffee machine) — 2 blocks: a body + a
 *  dark front panel. Sits on a worktop; `topY` is the worktop top. */
export function counterAppliance(x: number, topY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("propWhite", 0, topY, 0.32, 0.5, 0.3, 0.4),
    put("metal", 0, topY + 0.05, 0.53, 0.4, 0.2, 0.04), // door panel (proud of the front)
  ];
}

/** Small bin — 1 loose metal block, propWhite-tier weight isn't wanted (a bin
 *  is steel), but it must fling: metal at furniture scale is fine as debris. */
export function bin(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  return [frame(x, z, facing)("metal", 0, floorY, 0.22, 0.34, 0.6, 0.34)];
}

/** Flat item resting on a surface (clipboard / tray / folder) — 1 tiny loose
 *  block. `topY` is the surface it lies on. */
export function deskItem(
  x: number,
  topY: number,
  z: number,
  facing: Facing,
  mat: MaterialId = "propWhite",
): BlockDef[] {
  return [frame(x, z, facing)(mat, 0, topY, 0.3, 0.28, 0.04, 0.36)];
}

/** Wet-floor cone — 2 blocks: a base + a tapered body (box approximation).
 *  Loose, floor-standing, hazard orange. */
export function cone(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("accentOrange", 0, floorY, 0.2, 0.36, 0.06, 0.36), // splayed base
    put("accentOrange", 0, floorY + 0.06, 0.2, 0.16, 0.52, 0.16), // body
  ];
}

/** Fire extinguisher — 2 blocks: a red bottle + a metal valve head. Small,
 *  floor-standing (a corridor stand rather than a wall bracket, so support
 *  flows through the deck, not a maybe-cross-section wall). */
export function extinguisher(x: number, floorY: number, z: number, facing: Facing): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("signRed", 0, floorY, 0.16, 0.26, 0.7, 0.26),
    put("metal", 0, floorY + 0.7, 0.16, 0.1, 0.13, 0.1),
  ];
}

/** Wayfinding sign pylon — 3 blocks: a slim post + two direction blades on
 *  their own planes (upper blade in the floor's department colour). A
 *  freestanding totem, so it reads as corridor signage without a wall mount. */
export function signPylon(
  x: number,
  floorY: number,
  z: number,
  facing: Facing,
  blade: MaterialId,
): BlockDef[] {
  const put = frame(x, z, facing);
  return [
    put("metal", 0, floorY, 0.16, 0.12, 1.7, 0.12), // post
    put(blade, 0, floorY + 1.18, 0.22, 0.5, 0.3, 0.06), // department blade (proud)
    put("propWhite", 0, floorY + 0.82, 0.22, 0.5, 0.28, 0.06), // lower blade
  ];
}

/** Rooftop cross — 3 signRed blocks: post standing on the roof deck + two
 *  arms ABUTTING the post's sides (never an overlapping plus — intersecting
 *  same-size bars would put coplanar same-facing faces with real area). */
export function roofCross(x: number, roofTop: number, z: number): BlockDef[] {
  return [
    block("signRed", x, roofTop, z, 0.5, 2.4, 0.5),
    block("signRed", x - 0.7, roofTop + 1.0, z, 0.9, 0.7, 0.5),
    block("signRed", x + 0.7, roofTop + 1.0, z, 0.9, 0.7, 0.5),
  ];
}

/** Entrance "HOSPITAL" bar — 2 blocks resting on the portico canopy top. */
export function hospitalBar(x: number, canopyTop: number, z: number): BlockDef[] {
  return [
    block("propWhite", x, canopyTop, z, 8.0, 0.7, 0.35),
    block("signRed", x, canopyTop + 0.7, z, 8.0, 0.15, 0.35),
  ];
}
