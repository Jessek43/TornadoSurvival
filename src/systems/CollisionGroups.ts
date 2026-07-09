/**
 * Rapier collision-group bit layout — the ONLY place groups are assigned.
 *
 * Rapier packs interaction groups as (memberships << 16) | filter, each a 16-bit
 * mask; two colliders interact iff (A.mem & B.filter) && (B.mem & A.filter).
 * Every collider is Rapier's default 0xFFFF/0xFFFF ("world" — a member of every
 * group, colliding with everything) UNLESS listed here.
 *
 * Only two roles need explicit groups, to give the map boundary a one-way effect:
 *   bit 1  PLAYER   — the kinematic character capsule (the one thing the edge
 *                     walls must stop).
 *   bit 2  BOUNDARY — the four static map-edge walls.
 *
 * The boundary FILTERS the PLAYER bit only, so it blocks the character capsule
 * yet is invisible to the solver for everything else. For that to actually hold,
 * one non-boundary collider MUST drop the PLAYER bit: debris (the only dynamic
 * body that reaches the edge). If debris kept the default 0xFFFF membership it
 * would carry the PLAYER bit and the boundary would pile it up — Rapier gives no
 * way around this (the boundary-vs-debris test never reads the player's groups).
 * So debris uses WORLD_NO_PLAYER. Structures/ground keep the default: they never
 * reach the edge, and are fixed bodies (fixed↔fixed pairs generate no contacts
 * regardless of groups). The ragdoll keeps the default too — a flung body simply
 * stops at the wall like the capsule, which is fine.
 */

const ALL = 0xffff;
const PLAYER = 1 << 1;
const BOUNDARY = 1 << 2;
const WORLD_NO_PLAYER = ALL & ~PLAYER;

/** Pack (memberships, filter) into Rapier's u32 interaction-groups word. */
const pack = (memberships: number, filter: number): number =>
  ((memberships << 16) | filter) >>> 0;

/** Kinematic character capsule: member of PLAYER, collides with everything. */
export const PLAYER_GROUPS = pack(PLAYER, ALL);
/** Debris: like the world but WITHOUT the PLAYER bit, so the boundary ignores it
 *  (still collides with ground/structures/player/other debris, all via ALL). */
export const DEBRIS_GROUPS = pack(WORLD_NO_PLAYER, ALL);
/** Boundary walls: member of BOUNDARY, collide ONLY with the PLAYER bit. */
export const BOUNDARY_GROUPS = pack(BOUNDARY, PLAYER);
