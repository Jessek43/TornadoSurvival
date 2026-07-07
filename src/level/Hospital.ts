import type { SectionSpec } from "./Blueprints";
import { buildShell } from "./hospital/shell";
import { furnish, DECK_PALETTE } from "./hospital/furnish";
import { verifyHospital } from "./hospital/verify";
import type { Fixture } from "./hospital/params";

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
 * the per-floor palette and the furnish pass decorates the floors (ward
 * slice implemented; treatment/lobby/exterior land after the ward gate).
 */
export function buildHospital(opts: { detail?: boolean } = {}): {
  sections: SectionSpec[];
  lightFixtures: Fixture[];
} {
  const shell = buildShell(opts.detail ? { deckMaterial: DECK_PALETTE } : {});
  const furnished = opts.detail ? furnish(shell) : undefined;

  // Dev-time invariant check (the CLI equivalent is `npm run verify:hospital`,
  // which fails the build on any violation — this is just the loud console
  // mirror while iterating). The cast keeps this file loadable outside Vite.
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (env?.DEV) {
    const result = verifyHospital(shell.sections, shell.lightFixtures, shell.exteriorFaces, {
      shellCounts: furnished?.shellCounts,
      rooms: furnished?.rooms,
    });
    for (const line of result.info) console.info(`[hospital] ${line}`);
    for (const failure of result.failures) {
      console.error(`[hospital] INVARIANT FAILED: ${failure}`);
    }
  }

  return { sections: shell.sections, lightFixtures: shell.lightFixtures };
}
