/**
 * /api/v1/activity — log manual activity entries into the diary from an
 * external integration (self-hosted trackers, Dropbox → TCX pipelines,
 * Node-RED, Gadgetbridge, the openGym bridge, etc.).
 *
 * Storage: activity_log table (same table the in-app "Add Activity"
 * sheet writes to). Renders in the diary's Activity section and
 * contributes to the day's kcal-burned tally the same way a manually
 * added activity does.
 *
 * Not to be confused with `POST /api/v1/workouts`, which is a
 * federation endpoint for LiftTrace strength workouts. That path
 * writes to the `workouts` table + rolls into `wellness_data`
 * calories_out for the dynamic-TDEE lookup, and renders under
 * Settings → Wellness → Workout History — NOT the diary. See issue
 * #154 for the difference. Use `/api/v1/workouts` for anything that
 * should feed the dynamic-TDEE calorie goal; use `/api/v1/activity`
 * for anything that should appear as a diary Activity row.
 *
 * Routes (all scope write:activity):
 *   POST   /                        one entry, upserted on external_id
 *   POST   /batch                   up to 100 upserts and deletes
 *   DELETE /external/:external_id   soft-delete the entry with that key
 *
 * Entry:
 *   {
 *     date:          "YYYY-MM-DD",        // required, the owner's local day
 *     name:          "Bicycle",           // required, a string, <=80 chars kept
 *     kcal:          270,                 // required, a number (or numeric string)
 *     duration_min:  40,                  // optional, a number (or numeric string)
 *     distance:      "12.4 km",           // optional, free text, <=40 chars
 *     external_id:   "og:w:lq2k9x7a1b",   // optional idempotency key, <=128 chars
 *     source:        "opengym"            // optional; only "opengym" means anything.
 *                                         // Omitted on an update: the row keeps its own.
 *   }
 *
 * A batch spends one unit of the token's rate limit per item.
 *
 * external_id names one row per user for good (a unique index, deleted
 * rows included): re-posting it updates that row in place, a post after a
 * delete brings the row back, and nothing ever makes a second row for it.
 * source "opengym" marks the openGym bridge's rows: on a day a wearable
 * reports active calories they are shown but not counted
 * (lib/active-calories.js).
 *
 * The person's edit wins, for every integration: once they change or
 * delete a keyed row in the app (web, phone, "Clear all data"), upserts
 * leave it as they made it and answer status "user_edited". A delete from
 * the integration (the workout no longer exists) still removes the row,
 * edited or not.
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { BATCH_MAX_ITEMS, chargeRateLimit, requireScope } from '../../../middleware/bearer-auth.js';
import { BRIDGE_SOURCE } from '../../../lib/active-calories.js';
import { cleanText } from '../../../lib/clean-text.js';
import { isCalendarDate } from '../../../lib/mcp/_util.js';

const router = Router();

const EXTERNAL_ID_MAX = 128;

const _invalid = (code, error) => ({ invalid: { code, error } });

// Before this route had a key column, a longer key was cut to 128
// characters (so were the keys the migration moved out of source). Cutting
// can make two long keys one, so a key over 128 characters is accepted only
// when its cut form already names a row (that integration's own legacy
// rows keep working); a new one is refused (external_id_too_long).
function _externalId(raw) {
  if (!raw) return { value: null };
  if (typeof raw !== 'string' && !(typeof raw === 'number' && Number.isFinite(raw))) {
    return _invalid('bad_external_id', 'external_id must be a string');
  }
  const full = String(raw);
  return { value: full.slice(0, EXTERNAL_ID_MAX), overLength: full.length > EXTERNAL_ID_MAX };
}

const TOO_LONG = {
  code: 'external_id_too_long',
  error: `external_id is longer than ${EXTERNAL_ID_MAX} characters; use a shorter key (a hash of the long one, say)`,
};

// A finite number, or a string that spells one (the documented type is a
// number; integrations have long sent "270" and keep working). null, true,
// '', arrays and objects used to pass through Number() as 0, 1 or 270.
function _number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/.test(value)) return Number(value);
  return null;
}

/** Validate one entry: { value } or { invalid: { code, error } }. */
function _parseEntry(body) {
  const { date, name, kcal, duration_min, distance, external_id, source } = body || {};
  if (typeof date !== 'string' || !isCalendarDate(date)) return _invalid('bad_date', 'date must be YYYY-MM-DD');
  if (typeof name !== 'string') return _invalid('bad_name', 'name must be a string');
  const cleanName = cleanText(name).trim().slice(0, 80);
  if (!cleanName) return _invalid('bad_name', 'name required');
  const kcalNum = _number(kcal);
  if (kcalNum == null || kcalNum < 0 || kcalNum > 10000) {
    return _invalid('bad_kcal', 'kcal must be a number 0..10000');
  }
  let dur = null;
  if (duration_min != null) {
    const d = _number(duration_min);
    if (d == null || d < 0 || d > 1440) return _invalid('bad_duration', 'duration_min must be a number 0..1440');
    dur = Math.round(d);
  }
  const ext = _externalId(external_id);
  if (ext.invalid) return ext;
  return {
    value: {
      date,
      name: cleanName,
      kcal: Math.round(kcalNum),
      duration_min: dur,
      distance: distance != null ? String(distance).trim().slice(0, 40) || null : null,
      external_id: ext.value,
      // Omitted: null, and an update keeps the row's stored source.
      source: source == null ? null : source === BRIDGE_SOURCE ? BRIDGE_SOURCE : 'external',
    },
    overLength: ext.overLength,
  };
}

// Single-user mode stores rows under user_id NULL; the unique index counts
// that owner as 0.
const _owner = req => {
  const id = req.apiUser.id;
  return (id === 0 || id == null) ? null : id;
};

const _byKey = db.prepare(`SELECT * FROM activity_log WHERE IFNULL(user_id, 0) = ? AND external_id = ?`);
const _byId = db.prepare(`SELECT * FROM activity_log WHERE id = ?`);
const _insert = db.prepare(`
  INSERT INTO activity_log (
    user_id, date, name, kcal, duration_min, distance,
    source, external_id, met, is_template, created_at, updated_at
  )
  VALUES (@user_id, @date, @name, @kcal, @duration_min, @distance, @source, @external_id, NULL, 0, datetime('now'), datetime('now'))
`);
const _update = db.prepare(`
  UPDATE activity_log
     SET date = @date, name = @name, kcal = @kcal, duration_min = @duration_min, distance = @distance,
         source = @source, deleted_at = NULL, updated_at = datetime('now')
   WHERE id = @id
`);
const _softDelete = db.prepare(`UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`);

const CONTENT = ['date', 'name', 'kcal', 'duration_min', 'distance', 'source'];

/**
 * Write one validated entry ({ value, overLength } from _parseEntry).
 * Returns { status, row } where status is created | updated | unchanged |
 * user_edited, or { invalid } for a new over-length key. Callers run it
 * inside a transaction, so the lookup and the write cannot interleave.
 */
function _upsert(owner, { value: entry, overLength }) {
  const current = entry.external_id == null ? null : _byKey.get(owner ?? 0, entry.external_id);
  if (!current) {
    if (overLength) return { invalid: TOO_LONG };
    const r = _insert.run({ user_id: owner, ...entry, source: entry.source ?? 'external' });
    return { status: 'created', row: _byId.get(r.lastInsertRowid) };
  }
  if (current.user_edited_at != null) return { status: 'user_edited', row: current };
  // A post that leaves source out keeps the row's (an openGym row stays one).
  const next = { ...entry, source: entry.source ?? current.source };
  if (current.deleted_at == null && CONTENT.every(k => current[k] === next[k])) {
    return { status: 'unchanged', row: current };
  }
  _update.run({ id: current.id, ...next });
  return { status: current.deleted_at == null ? 'updated' : 'created', row: _byId.get(current.id) };
}

/** Soft-delete the row with this key. { status: deleted | not_found, row }. */
function _remove(owner, externalId) {
  const current = _byKey.get(owner ?? 0, externalId);
  if (!current || current.deleted_at != null) return { status: 'not_found', row: null };
  _softDelete.run(current.id);
  return { status: 'deleted', row: _byId.get(current.id) };
}

/** The day's cumulative activity kcal, so callers can sanity-check their
 *  pipeline (matches daily_total_calories_burned on /workouts). */
function _dailyTotal(owner, date) {
  const row = owner == null
    ? db.prepare(`SELECT COALESCE(SUM(kcal), 0) AS total FROM activity_log WHERE user_id IS NULL AND date = ? AND deleted_at IS NULL`).get(date)
    : db.prepare(`SELECT COALESCE(SUM(kcal), 0) AS total FROM activity_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL`).get(owner, date);
  return Math.round(row?.total ?? 0);
}

router.post('/', requireScope('write:activity'), wrap((req, res) => {
  const parsed = _parseEntry(req.body);
  if (parsed.invalid) return res.status(400).json(parsed.invalid);
  const owner = _owner(req);
  const { status, row, invalid } = db.transaction(() => _upsert(owner, parsed))();
  if (invalid) return res.status(400).json(invalid);
  res.status(status === 'created' ? 201 : 200).json({
    ok: true,
    status,
    activity_id: row.id,
    date: row.date,
    kcal: row.kcal,
    daily_total_kcal: _dailyTotal(owner, row.date),
    updated: status === 'updated' || status === 'unchanged',
  });
}));

router.post('/batch', requireScope('write:activity'), wrap((req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array', code: 'bad_body' });
  if (items.length > BATCH_MAX_ITEMS) {
    return res.status(400).json({ error: `at most ${BATCH_MAX_ITEMS} items per batch`, code: 'too_many_items' });
  }
  // One unit of the rate limit per item, before anything is written.
  if (!chargeRateLimit(req, res, items.length)) return;
  const owner = _owner(req);
  const results = db.transaction(() => items.map((item) => {
    const ext = _externalId(item?.external_id);
    const externalId = ext.value ?? null;
    if (ext.invalid || externalId == null) {
      return { external_id: externalId, status: 'error', code: 'bad_external_id', error: 'external_id required' };
    }
    const op = item.op ?? 'upsert';
    if (op === 'delete') {
      const { status, row } = _remove(owner, externalId);
      return { external_id: externalId, status, activity_id: row?.id ?? null };
    }
    if (op !== 'upsert') return { external_id: externalId, status: 'error', code: 'bad_op', error: 'op must be upsert or delete' };
    const parsed = _parseEntry(item);
    if (parsed.invalid) return { external_id: externalId, status: 'error', ...parsed.invalid };
    const { status, row, invalid } = _upsert(owner, parsed);
    if (invalid) return { external_id: externalId, status: 'error', ...invalid };
    return { external_id: externalId, status, activity_id: row.id };
  }))();
  res.json({ ok: true, results });
}));

router.delete('/external/:external_id', requireScope('write:activity'), wrap((req, res) => {
  const ext = _externalId(req.params.external_id);
  if (ext.invalid) return res.status(400).json(ext.invalid);
  const owner = _owner(req);
  const { status, row } = db.transaction(() => _remove(owner, ext.value))();
  if (status === 'not_found') {
    return res.json({ ok: true, deleted: false, activity_id: null, date: null, daily_total_kcal: null });
  }
  res.json({
    ok: true,
    deleted: true,
    activity_id: row.id,
    date: row.date,
    daily_total_kcal: _dailyTotal(owner, row.date),
  });
}));

export default router;
