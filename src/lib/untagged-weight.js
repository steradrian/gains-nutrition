/**
 * untagged-weight.js — the diary's manual weight (body_stats.weight) in kg,
 * read the way server/lib/body-weight.js reads it, for the standalone
 * Android app (adaptive-tdee-local.js).
 *
 * A weight carries a weight_unit tag. A row from before the tag existed has
 * none, and is read in the user's weightUnit setting (the app's default,
 * lb, when unset): the unit the diary shows it in. scripts/
 * weight-unit-agreement.test.js holds this to the server's answer.
 */

export const LB_PER_KG = 2.2046226218;

/** The unit an untagged weight is read in, from the weightUnit setting's stored value. */
export function untaggedUnitFromSetting(stored) {
  let value = stored;
  if (typeof stored === 'string') {
    try { value = JSON.parse(stored); } catch { value = stored; }
  }
  return value === 'kg' || value === 'lb' ? value : 'lb';
}

/** body_stats (object or JSON) -> weight in kg, or null when there is none. */
export function bodyStatsWeightKg(bodyStats, untaggedUnit) {
  let bs = bodyStats;
  if (typeof bs === 'string') {
    try { bs = JSON.parse(bs); } catch { return null; }
  }
  const raw = bs?.weight;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = bs.weight_unit || untaggedUnit;
  return unit === 'lb' ? n / LB_PER_KG : n;
}
