import type { BlockDef } from "../Blueprints";
import type { MaterialId } from "../Materials";
import { HOSPITAL_PARAMS as P } from "./params";
import { CELLS_PER_COL, CELLS_PER_ROW } from "./grid";
import * as props from "./props";
import { isClinical, type RoomContent } from "./layouts";
import type { BuiltRoom } from "./partition";

/**
 * PHASE 2 — floor archetypes, now keyed off the ENCLOSED rooms the partition
 * layer built (partition.ts) rather than a shared open plate. Each furnish call
 * dresses ONE authored room by its content type, appending blocks into the
 * room's wing SECTION (props ride their wing's support flood-fill, so a bed is
 * released exactly when its room is torn out — no floating props).
 *
 * Placement discipline that keeps enterability an invariant (verify.ts asserts
 * it): the primary equipment cluster anchors to the wall OPPOSITE the door and
 * faces back toward it, so the door→room walkway is always clear; wall details
 * hug a side wall; nothing enters the 1-cell door opening. Small rooms fall back
 * to a compact wall cabinet so a shallow bay can't be over-furnished.
 */

/** Phase-2 palette: interior deck colour per floor (roofs stay cladding).
 *  All ids are physics clones of concrete — colour only. */
export function DECK_PALETTE(f: number): MaterialId {
  return f === 0 ? "floorBeige" : f === 1 ? "floorTeal" : f % 2 === 0 ? "floorMustard" : "floorTeal";
}

/** Department accent — the trim/soffit hue that gives each department a
 *  recognisable identity on top of the per-floor deck colour. Keyed off room
 *  CONTENT (a floor is dominated by one facade + one core content, so the
 *  accent clusters per floor), and reuses only existing accent ids so it adds
 *  no draw call: cool blue for imaging/critical/lab/tech, sterile teal for
 *  ward/surgical/desk, warm orange for maternity/office/support. */
export function deptAccent(c: RoomContent): MaterialId {
  switch (c) {
    case "icu":
    case "isolation":
    case "imaging":
    case "lab":
    case "server":
    case "waiting":
      return "accentBlue";
    case "patient":
    case "surgical":
    case "nurse_station":
      return "accentTeal";
    default: // maternity, office, records, store, kitchen
      return "accentOrange";
  }
}

/** Where the primary cluster stands: back-wall centre, facing the door. */
interface Anchor {
  bx: number;
  bz: number;
  facing: props.Facing;
  depth: number; // door-normal room extent (clearance the cluster grows into)
  cross: number; // along-back-wall room extent
  ceilY: number;
}

function anchorOf(room: BuiltRoom): Anchor | null {
  if (!room.door) return null;
  const cxr = (room.x0 + room.x1) / 2;
  const czr = (room.z0 + room.z1) / 2;
  const d = room.door;
  const ceilY = (room.floor + 1) * P.floorHeight - P.deckT;
  if (d.axis === "z") {
    return {
      bx: cxr,
      bz: d.inward > 0 ? room.z1 : room.z0,
      facing: d.inward > 0 ? "-z" : "+z",
      depth: room.z1 - room.z0,
      cross: room.x1 - room.x0,
      ceilY,
    };
  }
  return {
    bx: d.inward > 0 ? room.x1 : room.x0,
    bz: czr,
    facing: d.inward > 0 ? "-x" : "+x",
    depth: room.x1 - room.x0,
    cross: room.z1 - room.z0,
    ceilY,
  };
}

/** A point `across` metres along the back wall from the anchor centre. */
function acrossPoint(a: Anchor, across: number): [number, number] {
  return a.facing === "+z" || a.facing === "-z" ? [a.bx + across, a.bz] : [a.bx, a.bz + across];
}

export function furnishRoom(room: BuiltRoom, blocks: BlockDef[]): void {
  const a = anchorOf(room);
  if (!a) return; // unreachable room — leave bare (verify's reachability flags it)
  const base = room.base;
  const c = room.content;
  const deep = a.depth >= 3.0 && a.cross >= 2.2;
  const wide = a.depth >= 4.2 && a.cross >= 3.4;

  // The back wall (where wall-mounted props hang) is a cross-section WING
  // BOUNDARY when the room's low edge sits on an internal grid line — the wall
  // is bucketed to the neighbour wing there, so a prop hung on it would float
  // out of this section's support flood-fill. `wall()` no-ops in that case;
  // the floor-standing furniture (always deck-supported) still lands.
  const backSafe = !(
    (a.facing === "+z" && room.ciz % CELLS_PER_ROW === 0 && room.ciz !== 0) ||
    (a.facing === "+x" && room.cix % CELLS_PER_COL === 0 && room.cix !== 0)
  );
  const wall = (b: BlockDef[]): void => {
    if (backSafe) for (const blk of b) blocks.push(blk);
  };

  // DEPARTMENT SOFFIT BAND — a wide accent stripe high on the back wall in the
  // department's colour, breaking up the flat white cladding and giving each
  // floor an identity read. Deliberately at 2.05 m: clears the tallest
  // wall-backed item (the 1.9 m specimen fridge) so it never sits coplanar with
  // an item's back face; hugs the back wall via wall() so it can't float out of
  // section support. Applied to every room (shallow bays too).
  const accent = deptAccent(c);
  wall(props.wallPanel(a.bx, base + 2.05, a.bz, a.facing, accent, Math.max(0.8, a.cross - 0.5), 0.35));

  // Shallow bays get only a compact wall run, so they can't be over-furnished
  // into an un-walkable room.
  if (!deep) {
    blocks.push(...props.cabinet(a.bx, base, a.bz, a.facing));
    return;
  }

  // `b2` = a slot along the back wall next to the primary item; `b3` = the far
  // slot; both keep the door approach clear.
  const [b2x, b2z] = acrossPoint(a, wide ? 1.4 : 1.1);
  const [b3x, b3z] = acrossPoint(a, wide ? -1.5 : -1.2);

  if (c === "patient" || c === "isolation") {
    blocks.push(...props.bed(a.bx, base, a.bz, a.facing));
    wall(props.bedheadPanel(a.bx, base, a.bz, a.facing));
    blocks.push(...props.bedsideCabinet(b2x, base, b2z, a.facing));
    if (wide) blocks.push(...props.ivStand(b3x, base, b3z, a.facing));
  } else if (c === "icu") {
    blocks.push(...props.bed(a.bx, base, a.bz, a.facing));
    wall(props.bedheadPanel(a.bx, base, a.bz, a.facing));
    blocks.push(...props.ventilator(b2x, base, b2z, a.facing));
    if (wide) blocks.push(...props.crashCart(b3x, base, b3z, a.facing));
  } else if (c === "maternity") {
    blocks.push(...props.incubator(a.bx, base, a.bz, a.facing));
    blocks.push(...props.bedsideCabinet(b2x, base, b2z, a.facing));
    wall(props.wallPanel(a.bx, base + 1.4, a.bz, a.facing, "accentTeal", 0.44, 0.32));
  } else if (c === "surgical") {
    // Table set 1 m into the room under a ceiling light; anaesthesia cart back.
    const [lx, lz] = offsetInto(a, 1.0);
    blocks.push(...props.operatingTable(a.bx, base, a.bz, a.facing));
    blocks.push(...props.surgicalLight(lx, a.ceilY, lz));
    blocks.push(...props.anaesthesiaCart(b2x, base, b2z, a.facing));
  } else if (c === "imaging") {
    blocks.push(...props.ctScanner(a.bx, base, a.bz, a.facing));
    wall(props.wallPanel(b3x, base + 1.35, b3z, a.facing, "accentBlue", 0.55, 0.5));
  } else if (c === "lab") {
    const clen = Math.min(a.cross - 1.0, 1.4);
    blocks.push(...props.counter(a.bx, base, a.bz, a.facing, clen));
    wall(props.wallPanel(a.bx, base + 1.15, a.bz, a.facing, "accentBlue", 0.42, 0.34));
    if (wide) {
      const [fx, fz] = acrossPoint(a, clen / 2 + 0.55); // fridge past the bench end
      blocks.push(...props.specimenFridge(fx, base, fz, a.facing));
      const [stx, stz] = offsetInto(a, 1.3);
      blocks.push(...props.chair(stx, base, stz, invert(a.facing), "metal")); // stool at the bench
    }
  } else if (c === "records" || c === "store" || c === "server") {
    const mat: MaterialId = c === "server" ? "metal" : "propWhite";
    blocks.push(...props.cabinet(a.bx, base, a.bz, a.facing));
    blocks.push(...props.cabinet(b2x, base, b2z, a.facing));
    if (wide) blocks.push(...props.cabinet(b3x, base, b3z, a.facing));
    wall(props.wallPanel(a.bx, base + 1.5, a.bz, a.facing, mat, 0.7, 0.5));
  } else if (c === "office") {
    const [chx, chz] = offsetInto(a, 1.9);
    blocks.push(...props.officeDesk(a.bx, base, a.bz, a.facing));
    blocks.push(...props.chair(chx, base, chz, invert(a.facing)));
    blocks.push(...props.cabinet(b2x, base, b2z, a.facing));
  } else if (c === "kitchen") {
    const clen = Math.min(a.cross - 1.0, 1.4);
    blocks.push(...props.counter(a.bx, base, a.bz, a.facing, clen));
    if (wide) {
      const [apx, apz] = acrossPoint(a, clen / 2 + 0.6); // fridge/oven past the run
      blocks.push(...props.appliance(apx, base, apz, a.facing));
      const [tx, tz] = offsetInto(a, 1.9);
      blocks.push(...props.kitchenTable(tx, base, tz, a.facing));
    }
  } else if (c === "waiting") {
    blocks.push(...props.benchRow(a.bx, base, a.bz, a.facing, "accentBlue"));
    if (wide) {
      const [b2ax, b2az] = offsetInto(a, 1.9);
      blocks.push(...props.benchRow(b2ax, base, b2az, a.facing, "accentOrange"));
    }
  } else {
    // nurse_station (and any future public desk) — faces the door.
    blocks.push(...props.receptionDesk(a.bx, base, a.bz, a.facing, "accentTeal"));
  }

  // Clinical rooms get a wall sharps bin + sanitiser hugging a side wall corner.
  if (isClinical(c)) {
    const [dx, dz] = acrossPoint(a, a.cross / 2 - 0.3);
    wall(props.wallBox(dx, base + 1.05, dz, a.facing, "propWhite", 0.22));
    wall(props.wallBox(dx, base + 0.7, dz, a.facing, "accentOrange", 0.26));
  }
}

// Small geometry helpers ------------------------------------------------------
function invert(f: props.Facing): props.Facing {
  return f === "+z" ? "-z" : f === "-z" ? "+z" : f === "+x" ? "-x" : "+x";
}
/** A point `into` metres from the anchor toward the door (down the facing). */
function offsetInto(a: Anchor, into: number): [number, number] {
  if (a.facing === "+z") return [a.bx, a.bz + into];
  if (a.facing === "-z") return [a.bx, a.bz - into];
  if (a.facing === "+x") return [a.bx + into, a.bz];
  return [a.bx - into, a.bz];
}
