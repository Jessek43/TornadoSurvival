/**
 * The single, pure predicate that gates every developer-only widget behind
 * `?debug`. THREE-free / DOM-free on purpose so a terminating verify script can
 * import it and prove the gate WITHOUT parsing the renderer bundle — the debug
 * overlay + lil-gui tuning panel are only ever CONSTRUCTED when this is true
 * (see Game's `DebugTools.enabled() ? new DebugTools(...) : null`), never built
 * and hidden.
 */
export function isDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).has("debug");
}
