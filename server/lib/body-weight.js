/**
 * server/lib/body-weight.js — the diary's manual weight (body_stats.weight)
 * in kg, read the same way everywhere on the server.
 *
 * A weight is stored in the unit it was typed in, tagged with weight_unit
 * ('kg' or 'lb'; src/lib/body-stats-unit.js tagBodyStats, and every server
 * writer tags too). Rows from before the tag existed carry none. The app
 * shows such a value in the user's weightUnit setting (readBodyStat; the
 * app's default, lb, when unset), so that is what the person has seen and
 * corrected all along: an untagged value is read in that unit here too.
 * Reading it as kg instead (as the adaptive TDEE and the weekly email used
 * to) made a 200 lb history a 200 kg one there while the diary showed lb.
 *
 * The unit an untagged value was really typed in is not recorded anywhere:
 * if the person switched weightUnit since, the app shows it wrongly, and so
 * does every reader here, in the same way.
 */
import db from '../db.js';
import { safeJson } from './mcp/_util.js';

export const LB_PER_KG = 2.2046226218;

/** The unit an untagged weight is read in for this owner (null: user management off). */
export function untaggedWeightUnit(owner) {
  if (owner == null) return 'lb';
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE user_id = ? AND key = 'weightUnit' AND deleted_at IS NULL`
  ).get(owner);
  const value = row?.value == null ? null : safeJson(row.value, row.value);
  return value === 'kg' || value === 'lb' ? value : 'lb';
}

/** body_stats (object or JSON) -> weight in kg, or null when there is none. */
export function bodyStatsWeightKg(bodyStats, untaggedUnit) {
  const bs = typeof bodyStats === 'string' ? safeJson(bodyStats, null) : bodyStats;
  const raw = bs?.weight;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = bs.weight_unit || untaggedUnit;
  return unit === 'lb' ? n / LB_PER_KG : n;
}
