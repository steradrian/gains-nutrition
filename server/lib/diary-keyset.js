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

// A `where` condition for the search index: only rows whose date is a real
// calendar date, the shape (GLOB) and the day (date() rolls 2026-02-30 over
// to 2026-03-02, so only a date it gives back unchanged exists). The hub
// drops any other from a page and a client can do nothing with it, so it is
// left out of the page and of `total`. No row should hold one any more
// (lib/diary-quarantine.js keeps them out); this is the second line.
export const INDEX_DATE_VALID = "date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date) IS date";

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
 *
 * `build` and `maxBytes` cap a page by size: `build(row)` makes what the
 * caller sends for a row, and the page stops before the row that would take
 * the built values, as a JSON array, past `maxBytes` UTF-8 bytes. Every page
 * holds at least one row, so `build` must keep one value within `maxBytes`
 * on its own (diary-index.js trims a day to fit), or a page is that one
 * value's size. `built` is parallel to `rows`.
 */
export function readKeysetPage(db, { where, params, columns, position, limit, build = null, maxBytes = Infinity }) {
  const { countSql, pageSql, params: bound } = keysetSql({ where, params, columns, position });
  const left = db.prepare(countSql).get(...bound).n;
  let rows = db.prepare(pageSql).all(...bound, limit);
  const built = [];
  if (build) {
    let bytes = 2; // the [ and ]
    for (let i = 0; i < rows.length; i++) {
      const value = build(rows[i]);
      bytes += Buffer.byteLength(JSON.stringify(value)) + (i > 0 ? 1 : 0);
      if (i > 0 && bytes > maxBytes) { rows = rows.slice(0, i); break; }
      built.push(value);
    }
  }
  const now = db.prepare(`SELECT datetime('now') AS now`).get().now;
  let next = position;
  for (const row of rows) {
    if (row.changed >= now) break;
    next = { u: row.changed, d: row.date };
  }
  return { rows, built, left, next, hasMore: left > rows.length && next !== position };
}
