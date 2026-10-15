/**
 * A diary day is keyed by a real calendar date. A day that arrives under any
 * other ("2026-02-30", "garbage") is never written to `diary` and never lost:
 * it goes to `diary_quarantine` whole, and the rest of its batch carries on.
 *
 * Two layers, so no writer can get one past:
 *   admitDiaryDay        what every writer calls before it inserts a day.
 *   ensureDiaryDateGuard a trigger on `diary` itself, for a writer added later
 *                        that forgets to call it: the insert fails loudly
 *                        instead of poisoning the search index.
 * quarantineBadDiaryRows moves the rows an earlier version stored (db.js).
 */
import { isCalendarDate } from './mcp/_util.js';

const DATE_TEXT_MAX = 40;

/** The raw date as it is shown back to a client: text, and short. */
export const quarantinedDate = date =>
  (typeof date === 'string' ? date : (JSON.stringify(date) ?? String(date))).slice(0, DATE_TEXT_MAX);

function toJson(payload) {
  try {
    return JSON.stringify(payload) ?? 'null';
  } catch {
    return JSON.stringify({ unserializable: String(payload) });
  }
}

/** Keep a day the diary cannot hold. `payload` is everything that was sent for it. */
export function quarantineDay(db, { userId, date, payload, source }) {
  const raw = typeof date === 'string' ? date : (JSON.stringify(date) ?? String(date));
  db.prepare(`INSERT INTO diary_quarantine (user_id, date, payload, source) VALUES (?, ?, ?, ?)`)
    .run(userId ?? null, raw, toJson(payload), source);
}

/**
 * true: the day's date is real, write it. false: it was quarantined, skip it.
 * Inside the caller's transaction, if there is one, so a rolled-back batch
 * does not leave a quarantine row behind.
 */
export function admitDiaryDay(db, { userId, date, payload, source }) {
  if (isCalendarDate(date)) return true;
  quarantineDay(db, { userId, date, payload, source });
  return false;
}

/**
 * Refuse a diary row whose date is not a real calendar date, in SQLite
 * itself: date() gives NULL for a shape it cannot read and rolls an
 * impossible day over (2026-02-30 -> 2026-03-02), so only a date that
 * comes back unchanged is real. Same rule as isCalendarDate.
 */
export function ensureDiaryDateGuard(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS diary_date_is_real_insert BEFORE INSERT ON diary
    WHEN date(NEW.date) IS NOT NEW.date
    BEGIN
      SELECT RAISE(ABORT, 'diary.date must be a real YYYY-MM-DD date');
    END;
    CREATE TRIGGER IF NOT EXISTS diary_date_is_real_update BEFORE UPDATE OF date ON diary
    WHEN date(NEW.date) IS NOT NEW.date
    BEGIN
      SELECT RAISE(ABORT, 'diary.date must be a real YYYY-MM-DD date');
    END;
  `);
}

/**
 * Move every diary row whose date is not a real calendar date into
 * diary_quarantine, copy first, in one transaction: a row is deleted only
 * together with its copy. Returns how many moved.
 */
export function quarantineBadDiaryRows(db) {
  const bad = db.prepare('SELECT id, date FROM diary ORDER BY id').all().filter(r => !isCalendarDate(r.date));
  if (bad.length === 0) return 0;
  const read = db.prepare('SELECT * FROM diary WHERE id = ?');
  const remove = db.prepare('DELETE FROM diary WHERE id = ?');
  db.transaction(() => {
    for (const { id } of bad) {
      const row = read.get(id);
      quarantineDay(db, { userId: row.user_id, date: row.date, payload: row, source: 'migration' });
      remove.run(id);
    }
  })();
  return bad.length;
}
