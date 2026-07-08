/**
 * ROOM CONTENT VOCABULARY — the enumerated department a room is furnished as.
 *
 * This used to also hold a per-wing "furnishing table" (room counts by wing),
 * which is exactly what could NOT express a real floor plan: it named how many
 * rooms and of what type, but never WHERE the walls are. Per-floor enclosure
 * now lives in the authored cell-grid plans (floorplans.ts) + the partition
 * builder (partition.ts); this file is reduced to the content union those
 * plans tag each room with, plus the small helpers furnish/verify share.
 */

export type RoomContent =
  // core clinical / ward
  | "patient" // ward / ED bed bay
  | "icu" // critical-care bay: bed + ventilator + crash cart
  | "isolation" // isolation room (bed, sealed) — with an anteroom nearby
  | "maternity" // delivery / nursery: incubator + bassinet
  | "surgical" // operating theatre: table + ceiling light + anaesthesia cart
  | "imaging" // X-ray / CT scanner room
  // support / diagnostic
  | "lab" // pathology lab: benches + specimen fridges
  | "records" // filing cabinets + archive shelving
  | "office" // desk + PC + cabinet
  | "server" // comms / server room: racks
  | "store" // supply / pharmacy store: shelving
  | "kitchen" // the building's single staff kitchen
  // circulation-adjacent public
  | "waiting" // waiting seating / family room
  | "nurse_station"; // nurse / reception desk on the corridor

/** Clinical rooms take the extra sharps-bin + sanitiser wall detailing and read
 *  as patient-facing spaces (drives the §clinical wall-detail pass in furnish). */
export function isClinical(c: RoomContent): boolean {
  return (
    c === "patient" ||
    c === "icu" ||
    c === "isolation" ||
    c === "maternity" ||
    c === "surgical" ||
    c === "imaging"
  );
}
