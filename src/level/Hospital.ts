import type { SectionSpec } from "./Blueprints";
import { buildShell } from "./hospital/shell";
import { partitionHospital } from "./hospital/partition";
import { furnish, DECK_PALETTE } from "./hospital/furnish";
import { verifyHospital } from "./hospital/verify";
import type { Fixture, StairLight } from "./hospital/params";

/**
 * The hospital level — a thin facade over the parametric builder in
 * ./hospital/ (params.ts is the size dial + grid, shell.ts the structural
 * generator, furnish.ts/archetypes.ts/props.ts the Phase-2 detailing pass,
 * verify.ts the build-time invariants). Everything it returns is plain data
 * for the existing machinery:
 *
 *  - sections: SectionSpec[] for StructureSystem — instancing, wake/re-sleep,
 *    progressive fracture, support flood-fill all plug in unchanged. Furnish
 *    props are ordinary blocks appended into their wing's section, so the
 *    per-section flood-fill releases them with their room (no floating props).
 *  - lightFixtures: ceiling positions for InteriorLights. A fixture's life is
 *    governed at runtime by LOCAL ENCLOSURE (dark once no intact block
 *    remains within strandRange), so a position is all it carries.
 *
 * `detail: false` (the `?bare` URL switch) builds the Phase-1 structural
 * shell only — the perf-gate A/B measurement mode. With `detail`, decks take
 * the per-floor palette, the partition layer erects the per-floor enclosed
 * rooms + corridors, and the furnish pass dresses them.
 */
export function buildHospital(opts: { detail?: boolean } = {}): {
  sections: SectionSpec[];
  lightFixtures: Fixture[];
  stairLights: StairLight[];
} {
  const shell = buildShell(opts.detail ? { deckMaterial: DECK_PALETTE, interiorColumns: false } : {});

  let shellCounts: number[] | undefined;
  let partition: ReturnType<typeof partitionHospital> | undefined;
  if (opts.detail) {
    // Baseline BEFORE the interior goes in, so verify can prove the partition +
    // furnish passes only ever APPENDED to the shell's envelope sections.
    shellCounts = shell.sections.map((s) => s.blocks.length);
    partition = partitionHospital(shell); // per-floor rooms/corridors/doors + fixtures
    furnish(shell, partition.rooms, partition.floorMaps); // dept equipment + corridor dressing
  }

  // Dev-time invariant check (the CLI equivalent is `npm run verify:hospital`,
  // which fails the build on any violation — this is just the loud console
  // mirror while iterating). The cast keeps this file loadable outside Vite.
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (env?.DEV) {
    const result = verifyHospital(shell.sections, shell.lightFixtures, shell.exteriorFaces, {
      shellCounts,
      rooms: partition?.rooms,
      floorMaps: partition?.floorMaps,
    });
    for (const line of result.info) console.info(`[hospital] ${line}`);
    for (const failure of result.failures) {
      console.error(`[hospital] INVARIANT FAILED: ${failure}`);
    }
  }

  return {
    sections: shell.sections,
    lightFixtures: shell.lightFixtures,
    stairLights: shell.stairLights,
  };
}
