/**
 * Persisted USER preferences — distinct from GameConfig.
 *
 * GameConfig holds developer tuning constants (mutated live by the ?debug
 * panel, reset every reload). This is a user preference with a different
 * lifetime: it outlives the session, backed by localStorage. Keep the two
 * separate — do not fold preferences into GameConfig.
 *
 * The one preference today is mouse sensitivity, stored as a unitless
 * MULTIPLIER; the effective radians/pixel is `GameConfig.player.mouseSensitivity
 * × sensitivity`, computed at the look-system's init (see PlayerController /
 * Game entry-to-playing) — this file stays free of THREE, DOM, and GameConfig.
 *
 * `loadSettings` is TOTAL: a missing key, malformed JSON, a wrong-typed or
 * out-of-range value all fall back to the default without throwing — corrupt
 * storage must never crash boot. That totality is what scripts/verify-flow.ts
 * asserts, driving an in-memory storage stub.
 */

/** Sensitivity is a multiplier on the base look speed. */
export const SENSITIVITY_MIN = 0.25;
export const SENSITIVITY_MAX = 4;
export const SENSITIVITY_DEFAULT = 1;

export interface Settings {
  sensitivity: number;
}

/** The subset of the Web Storage API this module uses. Injectable so the verify
 *  script (which runs in Node, where `localStorage` doesn't exist) can pass an
 *  in-memory stub. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "tornado-survival/settings/v1";

/** Pure clamp for the slider / save path: below→min, above→max, identity in
 *  range; any non-finite input collapses to the default. */
export function clampSensitivity(n: number): number {
  if (!Number.isFinite(n)) return SENSITIVITY_DEFAULT;
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, n));
}

function defaults(): Settings {
  return { sensitivity: SENSITIVITY_DEFAULT };
}

/** localStorage if available and accessible, else null (privacy mode can throw
 *  on mere access). Never throws. */
function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read settings, falling back to the default for ANY problem (absent, malformed,
 * wrong type, non-finite, out of range). Stricter than `clampSensitivity`: an
 * out-of-range stored value is treated as corrupt and rejected wholesale rather
 * than clamped, so a tampered/legacy value can't silently pin to a bound.
 */
export function loadSettings(storage: StorageLike | null = browserStorage()): Settings {
  if (!storage) return defaults();

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return defaults();
  }
  if (raw === null) return defaults();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults();
  }
  if (typeof parsed !== "object" || parsed === null) return defaults();

  const s = (parsed as Record<string, unknown>).sensitivity;
  if (
    typeof s !== "number" ||
    !Number.isFinite(s) ||
    s < SENSITIVITY_MIN ||
    s > SENSITIVITY_MAX
  ) {
    return defaults();
  }
  return { sensitivity: s };
}

/** Persist settings (best-effort; storage can throw on quota / privacy mode).
 *  The value is clamped so a bad in-memory setting can't be written out of range. */
export function saveSettings(
  settings: Settings,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  const safe: Settings = { sensitivity: clampSensitivity(settings.sensitivity) };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // best-effort — losing a preference write is preferable to crashing.
  }
}
