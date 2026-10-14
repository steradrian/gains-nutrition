/**
 * GET /api/v1/body-stats — the diary's daily body weight, for a sync
 * service that keeps another app's weigh-ins in step (the openGym bridge).
 * Scope read:body-stats. Federation-style, so not behind PUBLIC_API_ENABLED.
 *
 * One value per date: the diary day's body_stats.weight, the number the
 * diary's Weight card shows and the adaptive TDEE reads, converted to kg
 * from its weight_unit tag. An untagged legacy value is read the way the
 * app shows it, in the user's weightUnit setting (the app's default, lb,
 * when unset; src/lib/body-stats-unit.js).
 *
 * Query (all optional):
 *   from, to        YYYY-MM-DD, inclusive. No default range: dates are the
 *                   user's own calendar days, never derived from the
 *                   server's clock or timezone.
 *   updated_since   ISO 8601 instant with Z or an offset, inclusive: starts
 *                   polling mode (below).
 *   cursor          the next_cursor of an earlier polling response: goes on
 *                   from there. Not with updated_since or offset.
 *   limit           1..1000, default 200
 *   offset          default 0; listing mode only
 *
 * Listing mode (no updated_since, no cursor): days with a weight, in date
 * order, paged by limit/offset.
 * Response: { items: [{ date, weight_kg, updated_at }], total, limit, offset }
 *
 * Polling mode: every day whose diary row changed at or after the start,
 * oldest change first (ties in date order), including days that no longer
 * have a weight (weight_kg null), so a removed weight or an erased day is
 * seen. Response adds next_cursor (always set) and has_more (true when
 * more can be read now, never while the cursor is held still); total counts
 * what is left from this position. The cursor is a keyset position on
 * (updated_at, date), so any number of rows sharing one second (a "Clear
 * all data" stamps every day at once) pages through. It never moves past
 * the current second, which can still be written to: rows from it come
 * again on the next poll, so drop repeats by (date, updated_at).
 *
 * updated_at is the diary row's last change (any change to the day, food
 * included, so an upper bound for the weight), in whole seconds. A
 * full-backup restore replaces the diary with the backup's rows and their
 * own updated_at, so polling cannot see what it removed: after a restore,
 * read the whole range again.
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { isCalendarDate, safeJson } from '../../../lib/mcp/_util.js';

const router = Router();

const LB_PER_KG = 2.2046226218;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const SQL_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const _bad = (res, code, error) => res.status(400).json({ error, code });

// A polling position: rows after (u, d) on (updated_at, date). d '' is
// "before every date", so { u: since, d: '' } starts at since inclusive.
const _encodeCursor = ({ u, d }) => Buffer.from(JSON.stringify({ u, d })).toString('base64url');
function _decodeCursor(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
  let pos;
  try { pos = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return null; }
  if (!pos || typeof pos.u !== 'string' || !SQL_TIME_RE.test(pos.u)) return null;
  if (typeof pos.d !== 'string' || (pos.d !== '' && !isCalendarDate(pos.d))) return null;
  return { u: pos.u, d: pos.d };
}

function _weightUnitSetting(owner) {
  if (owner == null) return null;
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE user_id = ? AND key = 'weightUnit' AND deleted_at IS NULL`
  ).get(owner);
  const value = row?.value == null ? null : safeJson(row.value, row.value);
  return value === 'kg' || value === 'lb' ? value : null;
}

function _weightKg(bodyStats, untaggedUnit) {
  const raw = bodyStats?.weight;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = bodyStats.weight_unit || untaggedUnit;
  return Math.round((unit === 'lb' ? n / LB_PER_KG : n) * 100) / 100;
}

router.get('/', requireScope('read:body-stats'), wrap((req, res) => {
  const { from, to, updated_since: updatedSince } = req.query;
  if (from != null && !isCalendarDate(from)) return _bad(res, 'bad_date', 'from must be YYYY-MM-DD');
  if (to != null && !isCalendarDate(to)) return _bad(res, 'bad_date', 'to must be YYYY-MM-DD');
  if (from != null && to != null && from > to) return _bad(res, 'bad_range', 'from must be on or before to');

  if (updatedSince != null && req.query.cursor != null) {
    return _bad(res, 'bad_cursor', 'send cursor or updated_since, not both');
  }
  let position = null;   // polling mode when set
  if (updatedSince != null) {
    const at = typeof updatedSince === 'string' && INSTANT_RE.test(updatedSince) ? new Date(updatedSince) : null;
    if (!at || Number.isNaN(at.getTime())) {
      return _bad(res, 'bad_updated_since', 'updated_since must be an ISO 8601 instant with Z or an offset');
    }
    // SQLite's datetime('now') form, UTC, whole seconds (rounded down, so
    // the bound stays inclusive).
    position = { u: at.toISOString().slice(0, 19).replace('T', ' '), d: '' };
  } else if (req.query.cursor != null) {
    position = _decodeCursor(req.query.cursor);
    if (!position) return _bad(res, 'bad_cursor', 'cursor must be a next_cursor from this route');
  }

  const limitRaw = req.query.limit ?? DEFAULT_LIMIT;
  const offsetRaw = req.query.offset ?? 0;
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return _bad(res, 'bad_limit', `limit must be 1..${MAX_LIMIT}`);
  if (!Number.isInteger(offset) || offset < 0) return _bad(res, 'bad_offset', 'offset must be 0 or more');
  if (position && offset !== 0) return _bad(res, 'bad_offset', 'polling pages with next_cursor, not offset');

  const id = req.apiUser.id;
  const owner = (id === 0 || id == null) ? null : id;
  const where = [owner == null ? 'user_id IS NULL' : 'user_id = ?'];
  const params = owner == null ? [] : [owner];
  if (from != null) { where.push('date >= ?'); params.push(from); }
  if (to != null) { where.push('date <= ?'); params.push(to); }
  if (position) {
    where.push('(datetime(updated_at) > ? OR (datetime(updated_at) = ? AND date > ?))');
    params.push(position.u, position.u, position.d);
  }
  const order = position ? 'datetime(updated_at) ASC, date ASC' : 'date ASC';

  const rows = db.prepare(
    `SELECT date, body_stats, deleted_at, datetime(updated_at) AS changed,
            strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated_at
       FROM diary WHERE ${where.join(' AND ')} ORDER BY ${order}`
  ).all(...params);

  const untaggedUnit = _weightUnitSetting(owner) ?? 'lb';
  const all = [];
  for (const row of rows) {
    const weightKg = row.deleted_at == null ? _weightKg(safeJson(row.body_stats, {}), untaggedUnit) : null;
    if (weightKg == null && !position) continue;
    all.push({ date: row.date, weight_kg: weightKg, updated_at: row.updated_at, changed: row.changed });
  }
  const page = all.slice(offset, offset + limit);
  const items = page.map(({ changed, ...item }) => item);
  if (!position) return res.json({ items, total: all.length, limit, offset });

  // Move past the rows returned, but never into the current second (or
  // later): a write can still land there, under a date before the cursor.
  const now = db.prepare(`SELECT datetime('now') AS now`).get().now;
  let next = position;
  for (const row of page) {
    if (row.changed >= now) break;
    next = { u: row.changed, d: row.date };
  }
  // has_more only when the cursor moved: calling again within this second
  // would answer the same rows.
  const hasMore = all.length > page.length && next !== position;
  res.json({ items, total: all.length, limit, next_cursor: _encodeCursor(next), has_more: hasMore });
}));

export default router;
