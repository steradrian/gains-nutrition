/**
 * A diary day is keyed by a real calendar date. A day that arrives under any
 * other ("2026-02-30", "garbage") is never written to `diary`. From an
 * interactive route it is refused with 400 bad_date and nothing is kept. From
 * a batch writer it is never lost: it goes to `diary_quarantine` whole, and
 * the rest of its batch carries on (up to QUARANTINE_MAX_PER_USER rows).
 *
 * Two layers, so no writer can get one past:
 *   admitDiaryDay        what every batch writer calls before it inserts a day.
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
 * Most rows one person's quarantine takes from batch writers. A batch carries
 * a handful of bad days when something upstream went wrong once; 500 is the
 * history of a bad export many times over (a year and a half of daily days)
 * and, as every row holds a whole day, keeps the table's size bounded.
 * Past it a batch writer skips the day (ADMIT.FULL) instead of growing it
 * further. The boot migration is not a batch writer: it calls quarantineDay
 * directly, because it deletes the row it copies.
 */
export const QUARANTINE_MAX_PER_USER = 500;

/** What admitDiaryDay decided about a day. */
export const ADMIT = { WRITE: 'write', QUARANTINED: 'quarantined', FULL: 'full' };

/**
 * For the batch writers (Android push, wellness mirror, JSON and CSV import,
 * backup restore): a batch must not silently lose a day.
 *   ADMIT.WRITE        the date is real, write the day.
 *   ADMIT.QUARANTINED  it is not; kept whole in diary_quarantine, skip it.
 *   ADMIT.FULL         it is not, and this person's quarantine is at
 *                      QUARANTINE_MAX_PER_USER; skip it, nothing is kept.
 *                      The caller reports it as `quarantine_full`.
 * Inside the caller's transaction, if there is one, so a rolled-back batch
 * does not leave a quarantine row behind.
 *
 * The interactive routes do not come through here: they answer 400 bad_date
 * and write nothing anywhere, since the caller can fix the date and retry.
 */
export function admitDiaryDay(db, { userId, date, payload, source }) {
  if (isCalendarDate(date)) return ADMIT.WRITE;
  const held = db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine WHERE user_id IS ?').get(userId ?? null).n;
  if (held >= QUARANTINE_MAX_PER_USER) {
    console.warn(`[diary-quarantine] user ${userId ?? 'none'} holds ${held} quarantined day(s), the limit; skipped a day from ${source}`);
    return ADMIT.FULL;
  }
  quarantineDay(db, { userId, date, payload, source });
  return ADMIT.QUARANTINED;
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
