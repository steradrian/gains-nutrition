/**
 * When a diary row last changed, as an index can hold it.
 *
 * GET /api/v1/body-stats polls on idx_diary_user_changed, an index on
 * datetime(updated_at), which reads 'YYYY-MM-DD HH:MM:SS', the ISO 'T' form
 * and the offset forms alike. SQLite refuses to evaluate datetime() inside
 * an index when its argument is 'now' (and 'NOW', and 'now' followed by a
 * NUL): "non-deterministic use of datetime() in an index". On a stored
 * 'now' that error stops CREATE INDEX at boot and fails every later write to
 * the row, so the index expression only hands datetime() a value that starts
 * like a date. Anything else is NULL: it cannot throw, and the boot
 * migration (db.js) rewrites such rows to a real time anyway.
 *
 * The polling query must spell the expression exactly like the index, or
 * SQLite will not use the index.
 */
export const DIARY_CHANGED_SQL =
  `datetime(CASE WHEN updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN updated_at END)`;

const SQL_TIME_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * A backup's updated_at, or null when it is not a time SQLite reads
 * ('now', '', a number, free text...). The restore COALESCEs null to the
 * restore's own time, as it does for a missing value.
 */
export function restorableUpdatedAt(value) {
  if (typeof value !== 'string' || !SQL_TIME_RE.test(value)) return null;
  return Number.isNaN(Date.parse(value.replace(' ', 'T'))) ? null : value;
}
