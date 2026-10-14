import db from '../db.js';

// Rows the openGym bridge writes through POST /api/v1/activity. A wearable
// already measures the training they estimate, so on a day it reports
// active calories they are kept and shown but never counted, whatever the
// manualActivityPolicy (there is no 'additive' for them).
export const BRIDGE_SOURCE = 'opengym';

/** A row POST /api/v1/activity made. An edit in the app (web or phone)
 *  keeps its source: the bridge and the wearable rule key on it. */
export const isIntegrationRow = row =>
  row.external_id != null || row.source === BRIDGE_SOURCE || row.source === 'external';

function _sumActivity(userId, date, where) {
  const sql = userId == null
    ? `SELECT COALESCE(SUM(kcal), 0) AS s FROM activity_log
        WHERE user_id IS NULL AND date = ? AND deleted_at IS NULL ${where}`
    : `SELECT COALESCE(SUM(kcal), 0) AS s FROM activity_log
        WHERE user_id = ? AND date = ? AND deleted_at IS NULL ${where}`;
  const row = userId == null
    ? db.prepare(sql).get(date)
    : db.prepare(sql).get(userId, date);
  return Math.max(0, Math.round(row?.s || 0));
}

// Sum manually-logged activity calories for a user on a given date, bridge
// rows included. Returns an integer; 0 if no entries.
export function sumManualActivity(userId, date) {
  return _sumActivity(userId, date, '');
}

/** The wearable source reporting the most active calories for a date:
 *  { source, kcal }, or null when none reports any. */
export function wearableActivity(userId, date) {
  const sql = userId == null
    ? `SELECT source, value FROM wellness_data
        WHERE user_id IS NULL AND date = ? AND metric_type = 'active_calories' AND value > 0
        ORDER BY value DESC LIMIT 1`
    : `SELECT source, value FROM wellness_data
        WHERE user_id = ? AND date = ? AND metric_type = 'active_calories' AND value > 0
        ORDER BY value DESC LIMIT 1`;
  const row = userId == null
    ? db.prepare(sql).get(date)
    : db.prepare(sql).get(userId, date);
  return row ? { source: row.source, kcal: Math.round(row.value) } : null;
}

// Sum wearable active_calories for a date across all sources.
// Picks the highest single-source value to avoid double-counting when
// multiple integrations are connected (Fitbit + Garmin etc).
export function wearableActiveCalories(userId, date) {
  return wearableActivity(userId, date)?.kcal ?? 0;
}

// Combine wearable + manual per the user's manualActivityPolicy.
// policy: 'wearable_wins' (default) | 'manual_wins' | 'additive'
// Bridge rows count only on a day without wearable active calories.
export function effectiveActiveCalories(userId, date, policy = 'wearable_wins') {
  const wearable = wearableActiveCalories(userId, date);
  if (!wearable) return sumManualActivity(userId, date);
  const manual = _sumActivity(userId, date, `AND source != '${BRIDGE_SOURCE}'`);
  if (!manual) return wearable;
  switch (policy) {
    case 'manual_wins': return manual;
    case 'additive':    return wearable + manual;
    case 'wearable_wins':
    default:            return wearable;
  }
}

/**
 * Add `covered_by` to activity rows: on a bridge row, the wearable source
 * whose active calories stand in for it that day (the client shows
 * "Covered by <device>"); null on every other row and on days no wearable
 * reports. Mutates and returns `rows`.
 */
export function withCoverage(userId, rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (row.source !== BRIDGE_SOURCE) { row.covered_by = null; continue; }
    if (!byDate.has(row.date)) byDate.set(row.date, wearableActivity(userId, row.date)?.source ?? null);
    row.covered_by = byDate.get(row.date);
  }
  return rows;
}
