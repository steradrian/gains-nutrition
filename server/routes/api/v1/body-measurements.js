/**
 * POST /api/v1/body-measurements — record body composition from an
 * external smart-scale integration (Home Assistant, Node-RED,
 * Gadgetbridge-on-server, ESPHome BLE bridges, etc.).
 *
 * Fills the "headless server" gap that Health Connect can't cover:
 * BLE scale → HA (running on your NAS/Pi) → JSON → this endpoint.
 * Same day, Withings/Fitbit users can keep syncing via their existing
 * OAuth flows; this is the wire for scales that never touch a phone.
 *
 * Storage: writes to `diary.body_stats` for the day in `date`, or when
 * that is absent the day measured_at falls on in the user's timezone
 * setting (else the date written in measured_at itself). Never the
 * server's timezone. Uses "overwrite only what's sent" semantics: fields
 * present in the payload replace whatever was there, but any keys
 * already in body_stats that the payload doesn't mention are
 * preserved untouched. So manual `notes` don't get clobbered when HA
 * pushes a scale reading, and multiple readings the same day update
 * to the newest value (opposite tradeoff from Withings' passive
 * "fill-if-empty" sync, and matches the user intent behind
 * deliberately setting up the federation integration).
 *
 * Wire contract:
 *   {
 *     date:          "2026-07-25",             // the user's day; wins over measured_at
 *     measured_at:   "2026-07-25T16:10:51Z",   // ISO 8601; required without date
 *     source:        "home-assistant",         // optional, free text, ≤64 chars
 *
 *     // Standard body-composition fields — mapped to NT's native keys:
 *     weight:        76.9,   // kg   → body_stats.weight (+ weight_unit 'kg',
 *                            //        what the Weight card and adaptive
 *                            //        TDEE read) and body_stats.weight_kg
 *     body_fat:      21.2,   // %    → body_stats.body_fat_pct
 *     muscle_mass:   56.14,  // kg   → body_stats.muscle_mass_kg
 *     bone_mass:     3.01,   // kg   → body_stats.bone_mass_kg
 *     body_water:    54,     // %    → body_stats.body_water_pct
 *     lean_body_mass:60,     // kg   → body_stats.lean_mass_kg
 *
 *     // Extra metrics NT doesn't render (yet). Preserved in body_stats
 *     // JSON under the same key names so nothing is lost:
 *     bmi:           24.3,
 *     visceral_fat:  11,
 *     protein:       20.7,
 *     bmr:           1590,
 *     metabolic_age: 28,
 *     impedance:     465,
 *     body_score:    73
 *   }
 *
 * Both camelCase (measuredAt, bodyFat) and snake_case (measured_at,
 * body_fat) are accepted on input for convenience — snake_case wins
 * on collision. Everything is stored snake_case internally.
 *
 * Every write also goes to wellness_data (source 'federation') and fires
 * the body_stat.logged webhook, as a weight saved in the app does. A day
 * erased in the app is refused (409 diary_tombstoned), as the
 * PUT /api/v1/diary/:date/body-stat route does.
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { isCalendarDate, safeJson } from '../../../lib/mcp/_util.js';
import { dispatchWebhookEvent } from '../../../lib/webhooks.js';

const router = Router();

// Map wire field → body_stats key. Anything not in this table but
// present in the payload gets stored under its snake_case wire name
// verbatim (so extras like `bmi`, `visceral_fat`, `body_score` land
// safely without needing a schema change every time a new scale
// vendor invents a metric).
//
// Key names match what the Wellness → Body UI reads and what the
// Withings sync writes (server/routes/withings.js BODY_STAT_TYPES +
// WELLNESS_TYPES) so the same metric from either integration ends up
// under the same key.
const FIELD_MAP = {
  weight:         'weight_kg',
  body_fat:       'body_fat_pct',
  muscle_mass:    'muscle_mass_kg',
  bone_mass:      'bone_mass_kg',
  body_water:     'body_water_pct',
  lean_body_mass: 'lean_mass_kg',      // matches Wellness UI + Withings
};

// Rough sanity ranges so a mis-configured integration posting garbage
// (e.g. weight in grams instead of kg → 76900) doesn't corrupt the
// diary. Reject the whole request on any out-of-range value rather
// than silently dropping fields.
const RANGES = {
  weight:         [10, 500],     // kg
  body_fat:       [1, 80],       // %
  muscle_mass:    [5, 200],      // kg
  bone_mass:      [0.5, 20],     // kg
  body_water:     [1, 90],       // %
  lean_body_mass: [10, 300],     // kg
  bmi:            [5, 100],
  visceral_fat:   [0, 100],
  protein:        [1, 60],       // %
  bmr:            [400, 5000],   // kcal/day
  metabolic_age:  [5, 120],      // years
  impedance:      [50, 2000],    // ohms
  body_score:     [0, 100],
};

/** Read a numeric field from the payload, accepting camelCase and
 *  snake_case names. Returns null when absent; throws when present
 *  but non-numeric or out of range. */
function _readField(body, snakeKey) {
  const camelKey = snakeKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const raw = body[snakeKey] ?? body[camelKey];
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    const err = new Error(`${snakeKey} must be a number`);
    err.code = 'bad_field';
    err.field = snakeKey;
    throw err;
  }
  const [lo, hi] = RANGES[snakeKey] || [-Infinity, Infinity];
  if (n < lo || n > hi) {
    const err = new Error(`${snakeKey} out of range (${lo}..${hi})`);
    err.code = 'out_of_range';
    err.field = snakeKey;
    throw err;
  }
  return n;
}

function _userTimezone(owner) {
  if (owner == null) return null;
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE user_id = ? AND key = 'timezone' AND deleted_at IS NULL`
  ).get(owner);
  const tz = row?.value == null ? null : safeJson(row.value, row.value);
  return typeof tz === 'string' && tz ? tz : null;
}

/** The calendar day an instant falls on in an IANA timezone, or null when
 *  the zone is unknown. */
function _dayIn(timeZone, instant) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant);
    const get = type => parts.find(p => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return null;
  }
}

/** The diary day a measured_at belongs to when no date was sent. A time
 *  with no zone is the device's wall clock, so its written date. Otherwise
 *  the day in the user's timezone setting, else the date written in the
 *  string (the device's own day), else its UTC day. Never the server's
 *  timezone. */
function _measurementDate(raw, instant, owner) {
  const text = String(raw).trim();
  const written = isCalendarDate(text.slice(0, 10)) ? text.slice(0, 10) : null;
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  if (written && !zoned) return written;
  const tz = _userTimezone(owner);
  const inZone = tz ? _dayIn(tz, instant) : null;
  return inZone ?? written ?? instant.toISOString().slice(0, 10);
}

class DiaryTombstoned extends Error {}

router.post('/', requireScope('write:body-measurements'), wrap((req, res) => {
  const body = req.body || {};
  const userId = req.apiUser.id;
  const u = (userId === 0 || userId == null) ? null : userId;

  const measuredAtRaw = body.measured_at ?? body.measuredAt;
  const dateRaw = body.date;
  if (dateRaw != null && (typeof dateRaw !== 'string' || !isCalendarDate(dateRaw))) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD', code: 'bad_date' });
  }
  if (dateRaw == null && !measuredAtRaw) {
    return res.status(400).json({ error: 'date or measured_at required', code: 'bad_measured_at' });
  }
  let measuredAt = null;
  if (measuredAtRaw) {
    measuredAt = new Date(measuredAtRaw);
    if (Number.isNaN(measuredAt.getTime())) {
      return res.status(400).json({ error: 'measured_at must be ISO 8601', code: 'bad_measured_at' });
    }
  }
  const date = dateRaw ?? _measurementDate(measuredAtRaw, measuredAt, u);

  // Assemble the update: mapped fields under their body_stats keys,
  // plus extras under their wire names. Only include what was
  // actually provided so absent fields stay unchanged in the DB.
  const updates = {};
  try {
    for (const [wireKey, storageKey] of Object.entries(FIELD_MAP)) {
      const v = _readField(body, wireKey);
      if (v !== null) updates[storageKey] = v;
    }
    for (const extra of ['bmi', 'visceral_fat', 'protein', 'bmr', 'metabolic_age', 'impedance', 'body_score']) {
      const v = _readField(body, extra);
      if (v !== null) updates[extra] = v;
    }
  } catch (e) {
    return res.status(400).json({ error: e.message, code: e.code || 'bad_field', field: e.field });
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      error: 'no measurement fields provided',
      code: 'no_fields',
    });
  }

  // Optional bookkeeping — record which integration pushed this so
  // multi-source setups (Xiaomi at home, Renpho at the gym) can be
  // told apart later. Stored under a namespaced key to avoid
  // colliding with any future first-class field.
  const source = String(body.source || '').trim().slice(0, 64);
  if (source) updates._last_source = source;
  if (measuredAt) updates._last_measured_at = measuredAt.toISOString();

  // The diary's own weight: what the Weight card shows and the adaptive
  // TDEE reads (weight + its unit tag). weight_kg stays for older readers.
  const diaryWeight = updates.weight_kg != null
    ? { weight: Math.round(updates.weight_kg * 100) / 100, weight_unit: 'kg' }
    : {};

  const owner = u == null ? 'user_id IS NULL' : 'user_id = ?';
  const ownerParams = u == null ? [] : [u];
  let merged;
  try {
    merged = db.transaction(() => {
      const row = db.prepare(`SELECT id, body_stats, deleted_at FROM diary WHERE date = ? AND ${owner}`).get(date, ...ownerParams);
      if (row?.deleted_at) throw new DiaryTombstoned();
      const next = { ...safeJson(row?.body_stats || '{}', {}), ...updates, ...diaryWeight };
      if (row) {
        db.prepare(`UPDATE diary SET body_stats = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(next), row.id);
      } else {
        db.prepare(`INSERT INTO diary (user_id, date, items, body_stats, water, updated_at) VALUES (?, ?, '[]', ?, '[]', datetime('now'))`)
          .run(u, date, JSON.stringify(next));
      }
      return next;
    })();
  } catch (e) {
    if (e instanceof DiaryTombstoned) {
      return res.status(409).json({ error: `Diary day ${date} was erased in the app`, code: 'diary_tombstoned' });
    }
    throw e;
  }

  // Also mirror every numeric metric to wellness_data with
  // source='federation'. Wellness → Body reads from wellness_data
  // (not from diary.body_stats), so without this the fields would
  // land in the diary card but stay invisible in Wellness. Matches
  // the Withings sync pattern: it writes to BOTH tables so the
  // per-source Wellness views can render the data. Uses the same
  // (user_id, date, source, metric_type) uniqueness so re-posting
  // the same day upserts in place.
  const insertWellness = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, metadata, synced_at)
    VALUES (?, ?, 'federation', ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type)
    DO UPDATE SET value = excluded.value, metadata = excluded.metadata, synced_at = excluded.synced_at
  `);
  const wellnessUid = u == null ? 0 : u;
  const wellnessMeta = source ? JSON.stringify({ source }) : '{}';
  for (const [key, value] of Object.entries(updates)) {
    if (key.startsWith('_')) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    insertWellness.run(wellnessUid, date, key, value, wellnessMeta);
  }

  try {
    dispatchWebhookEvent(u, 'body_stat.logged', { date, stats: merged });
  } catch { /* a webhook never fails the save */ }

  res.status(201).json({
    ok: true,
    date,
    stored: [...(diaryWeight.weight != null ? ['weight'] : []), ...Object.keys(updates).filter(k => !k.startsWith('_'))],
  });
}));

export default router;
