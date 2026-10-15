/**
 * The keyset cursor over diary rows in change order, shared by the two
 * routes that poll the diary: GET /api/v1/body-stats and GET /api/diary/index.
 *
 * A position is (u, d): rows after it on (DIARY_CHANGED_SQL, date). d ''
 * is "before every date", so { u: since, d: '' } starts at since inclusive.
 * The cursor is base64url(JSON{u, d}); it holds no account data, so one
 * account's cursor used by another yields that other account's rows only.
 *
 * The keyset condition and the LIMIT run in SQL on idx_diary_user_changed
 * (user_id, DIARY_CHANGED_SQL, date), so a poll reads one page, not the
 * user's whole diary. The plain lower bound lets SQLite start the index
 * range at the cursor; the row value is the exact position.
 */
import { DIARY_CHANGED_SQL } from './diary-changed.js';
import { isCalendarDate } from './mcp/_util.js';

const SQL_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const encodeCursor = ({ u, d }) => Buffer.from(JSON.stringify({ u, d })).toString('base64url');

/** The position a cursor names, or null when it is not a cursor. */
export function decodeCursor(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
  let pos;
  try { pos = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return null; }
  if (!pos || typeof pos.u !== 'string' || !SQL_TIME_RE.test(pos.u)) return null;
  if (typeof pos.d !== 'string' || (pos.d !== '' && !isCalendarDate(pos.d))) return null;
  return { u: pos.u, d: pos.d };
}

/**
 * The page SQL: [countSql, pageSql, params]. `where` is the caller's
 * conditions (owner, range, ...), joined with AND; `columns` what to
 * select besides `changed` (the row's change time, DIARY_CHANGED_SQL).
 */
export function keysetSql({ where, params, columns, position }) {
  const all = [...where, `${DIARY_CHANGED_SQL} >= ?`, `(${DIARY_CHANGED_SQL}, date) > (?, ?)`];
  const bound = [...params, position.u, position.u, position.d];
  const clause = all.join(' AND ');
  return {
    countSql: `SELECT COUNT(*) AS n FROM diary WHERE ${clause}`,
    pageSql: `SELECT ${columns}, ${DIARY_CHANGED_SQL} AS changed FROM diary WHERE ${clause}
      ORDER BY ${DIARY_CHANGED_SQL} ASC, date ASC LIMIT ?`,
    params: bound,
  };
}

/**
 * Read one page after `position`. Returns
 *   rows     the page, each with `changed`
 *   left     how many rows remain from `position` (this page included)
 *   next     the position to continue from. It moves past the rows
 *            returned but never into the current second (or later): a write
 *            can still land there, under a date before the cursor, so rows
 *            from it come again on the next call and the caller drops
 *            repeats.
 *   hasMore  true only when the cursor moved and rows remain: calling again
 *            within this second would answer the same rows.
 */
export function readKeysetPage(db, { where, params, columns, position, limit }) {
  const { countSql, pageSql, params: bound } = keysetSql({ where, params, columns, position });
  const left = db.prepare(countSql).get(...bound).n;
  const rows = db.prepare(pageSql).all(...bound, limit);
  const now = db.prepare(`SELECT datetime('now') AS now`).get().now;
  let next = position;
  for (const row of rows) {
    if (row.changed >= now) break;
    next = { u: row.changed, d: row.date };
  }
  return { rows, left, next, hasMore: left > rows.length && next !== position };
}
