/**
 * A diary day is keyed by a real YYYY-MM-DD, whichever way it is written.
 * One row with another date ("not-a-date", "2026-02-30") used to reach the
 * search index, and the hub's filter then refused the whole page, so search
 * stayed broken for that person for good. A day under such a date is kept
 * whole in diary_quarantine (never stored in the diary, never dropped), the
 * rest of its batch lands, and the answer names it in `quarantined_diary`.
 *
 * Every writer: the Android push, the wellness weight mirror it triggers, the
 * JSON import, the CSV import and the backup restore quarantine; the day
 * routes (PUT /api/diary/:date and its two completion routes) answer 400 and
 * keep nothing, since their caller can correct the date and retry. The cap on
 * the quarantine is in diary-quarantine-cap.test.js.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { parseDate } from '../server/lib/nutrition-import/common.js';
import { startServer } from './fixtures/contract/server.mjs';

const srv = await startServer({ file: import.meta.url });
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const Database = serverRequire('better-sqlite3');
const AdmZip = serverRequire('adm-zip');
const db = new Database(join(srv.dir, 'server.db'));
db.pragma('busy_timeout = 5000');
test.after(async () => { db.close(); await srv.stop(); });

const owner = db.prepare(`SELECT id FROM users WHERE username = 'contract'`).get().id;
const dates = () => db.prepare('SELECT date FROM diary ORDER BY date').all().map(r => r.date);
const quarantine = source => db.prepare('SELECT user_id, date, payload, source FROM diary_quarantine WHERE source = ? ORDER BY id').all(source)
  .map(r => ({ ...r, payload: JSON.parse(r.payload) }));
const item = uuid => ({ uuid, meal: 0, name: `Item ${uuid}`, nutrition: { calories: 100 }, addedAt: '2026-10-14T07:30:00.000Z' });
const BAD = ['not-a-date', '2026-02-30', '2026-13-01', '2026-1-5', '20261005', '2026-10-05x', '2026-04-31', '2025-02-29'];

test('Android push: a day under a date that does not exist is quarantined whole, named, and the rest of the batch lands', async () => {
  const diary = [
    ...BAD.map((date, i) => ({ client_id: `bad-${i}`, date, items: [item(`bad-${i}`)], body_stats: { weight: 80 }, water: [] })),
    { client_id: 'bad-deleted', date: '2026-02-31', deleted_at: '2026-10-14 00:00:00' },
    { client_id: 'good-1', date: '2026-10-14', items: [item('good-1')], body_stats: {}, water: [] },
    { client_id: 'good-2', date: '2024-02-29', items: [item('good-2')], body_stats: {}, water: [] },
  ];
  const r = await srv.api('POST', '/api/sync/push', { diary });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.diary.map(d => [d.client_id, d.date]), [['good-1', '2026-10-14'], ['good-2', '2024-02-29']]);
  assert.deepEqual(r.body.quarantined_diary.map(d => [d.client_id, d.date]), [...BAD.map((date, i) => [`bad-${i}`, date]), ['bad-deleted', '2026-02-31']]);
  assert.equal('skipped_diary' in r.body, false, 'replaced by quarantined_diary');
  assert.deepEqual(dates(), ['2024-02-29', '2026-10-14']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_tombstones').get().n, 0);

  const kept = quarantine('sync-push');
  assert.deepEqual(kept.map(k => k.date), [...BAD, '2026-02-31']);
  assert.ok(kept.every(k => k.user_id === owner));
  assert.deepEqual(kept[1].payload, diary[1], 'the payload is the day as it was sent');
  assert.equal(kept.at(-1).payload.deleted_at, '2026-10-14 00:00:00');
});

test('Android push: a batch with only good days names nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n;
  const r = await srv.api('POST', '/api/sync/push', { diary: [{ client_id: 'g', date: '2026-10-15', items: [item('g')], body_stats: {}, water: [] }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.quarantined_diary, []);
  assert.ok(dates().includes('2026-10-15'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n, before);
});

test('Android push: a weight reading under a date that does not exist is not mirrored into a new diary day, it is quarantined', async () => {
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'mirrorWellnessWeight', 'true')`).run(owner);
  const wellness = [
    { date: '2026-02-30', source: 'health_connect', metric_type: 'weight_kg', value: 80.46 },
    { date: 'garbage', source: 'health_connect', metric_type: 'weight_kg', value: 81 },
    { date: '2026-10-16', source: 'health_connect', metric_type: 'weight_kg', value: 79.04 },
    { date: '2026-02-30', source: 'health_connect', metric_type: 'steps', value: 4000 },
  ];
  const r = await srv.api('POST', '/api/sync/push', { wellness });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.quarantined_diary, [{ date: '2026-02-30' }, { date: 'garbage' }]);
  assert.equal(r.body.wellness.length, 4, 'the wellness rows themselves are saved as before');
  assert.ok(dates().includes('2026-10-16'), 'a real date still mirrors');
  assert.equal(JSON.parse(db.prepare(`SELECT body_stats FROM diary WHERE date = '2026-10-16'`).get().body_stats).weight, 79);
  assert.equal(dates().includes('2026-02-30') || dates().includes('garbage'), false);
  const kept = quarantine('wellness-mirror');
  assert.deepEqual(kept.map(k => [k.user_id, k.date, k.payload]), [
    [owner, '2026-02-30', { date: '2026-02-30', weight_kg: 80.46 }],
    [owner, 'garbage', { date: 'garbage', weight_kg: 81 }],
  ]);
});

test('JSON import: days under a date that does not exist are quarantined and named', async () => {
  const before = dates().length;
  const diary = [
    ...BAD.map((date, i) => ({ date, items: [item(`imp-bad-${i}`)] })),
    { date: 42, items: [item('imp-num')] },
    { date: '2026-09-01', items: [item('imp-1')] },
    { date: '2026-09-02', items: [item('imp-2')] },
    { items: [item('no-date')] },
  ];
  const r = await srv.api('POST', '/api/data/import', { diary });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, quarantined_diary: [...BAD, '42'].map(date => ({ date })), quarantine_full: [] });
  assert.equal(dates().length, before + 2);
  assert.ok(dates().includes('2026-09-01') && dates().includes('2026-09-02'));
  const kept = quarantine('data-import');
  assert.deepEqual(kept.map(k => k.date), [...BAD, '42']);
  assert.deepEqual(kept[1].payload, diary[1]);
});

test('JSON import: a clean file names nothing', async () => {
  const r = await srv.api('POST', '/api/data/import', { diary: [{ date: '2026-09-03', items: [] }] });
  assert.deepEqual(r.body, { ok: true, quarantined_diary: [], quarantine_full: [] });
});

test('CSV import: a day that exists in no month is not read as a date, so it never becomes a diary day', async () => {
  for (const [text, locale] of [
    ['2026-04-31', 'auto'], ['2026-02-29', 'auto'], ['2026-02-30', 'auto'], ['2026-06-31', 'auto'], ['2026/09/31', 'auto'],
    ['4/31/2026', 'us'], ['31/04/2026', 'eu'], ['2/29/2025', 'us'], ['30-02-2026', 'eu'], ['4/31/26', 'us'],
  ]) assert.equal(parseDate(text, locale), null, `${text} (${locale})`);
  for (const [text, locale, want] of [
    ['2026-04-30', 'auto', '2026-04-30'], ['2024-02-29', 'auto', '2024-02-29'], ['2026-1-5', 'auto', '2026-01-05'],
    ['4/30/2026', 'us', '2026-04-30'], ['30/4/2026', 'eu', '2026-04-30'], ['12/31/2026', 'auto', '2026-12-31'],
  ]) assert.equal(parseDate(text, locale), want, `${text} (${locale})`);

  const csv = ['Date,Meal,Name,Calories', '2026-04-30,Breakfast,Oats,300', '2026-04-31,Breakfast,Ghost,999', '2026-05-01,Lunch,Rice,400'].join('\n');
  const form = new FormData();
  form.set('source', 'spreadsheet');
  form.set('file', new Blob([csv], { type: 'text/csv' }), 'diary.csv');
  const res = await fetch(`${srv.base}/api/nutrition-import/commit`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}` }, body: form });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.imported, 2);
  assert.deepEqual(body.quarantined_diary, []);
  assert.ok(dates().includes('2026-04-30') && dates().includes('2026-05-01'));
  assert.equal(dates().includes('2026-04-31'), false);
});

test('day routes: 400 bad_date and nothing written anywhere, the caller can correct and retry', async () => {
  const held = db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n;
  const put = await srv.api('PUT', '/api/diary/2026-02-30', { items: [item('put-1')], body_stats: { weight: 80 }, water: [], notes: 'kept' });
  assert.deepEqual([put.status, put.body], [400, { error: 'invalid date', code: 'bad_date' }]);
  const done = await srv.api('PUT', '/api/diary/2026-02-30/completion', { completed: true });
  const meal = await srv.api('PUT', '/api/diary/garbage/meal-completion', { slot: 1, completed: true });
  assert.deepEqual([done.status, meal.status], [400, 400]);
  assert.equal(dates().includes('2026-02-30') || dates().includes('garbage'), false);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n, held, 'an interactive write is refused, not quarantined');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM diary_tombstones WHERE date IN ('2026-02-30', 'garbage')`).get().n, 0);

  const fixed = await srv.api('PUT', '/api/diary/2026-02-28', { items: [item('put-2')], body_stats: {}, water: [], notes: '' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.ok(dates().includes('2026-02-28'), 'the corrected date saves');
});

test('backup restore: days under a date that does not exist go to the quarantine, the rest of the backup is restored', async () => {
  const made = await srv.api('POST', '/api/full-backup');
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const zipPath = join(srv.dir, 'uploads', 'backups', made.body.filename);
  const zip = new AdmZip(zipPath);
  const data = JSON.parse(zip.readAsText('database.json'));
  assert.ok(data.diary_quarantine.length > 0, 'the backup carries the quarantine');

  const row = (date, over = {}) => ({ id: null, user_id: owner, date, items: JSON.stringify([item(`r-${date}`)]), body_stats: '{}', water: '[]', notes: null, completed_at: null, completed_meals: null, updated_at: '2026-10-01 10:00:00', deleted_at: null, ...over });
  data.diary.push(row('2026-02-30'), row('garbage'), row('2026-04-31', { deleted_at: '2026-10-02 00:00:00' }), row('2026-08-01'));
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  zip.writeZip(zipPath);

  const held = db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n;
  const restored = await srv.api('POST', `/api/full-backup/${made.body.filename}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(restored.body, { ok: true, quarantined_diary: [{ date: '2026-02-30' }, { date: 'garbage' }, { date: '2026-04-31' }], quarantine_full: [] });
  assert.ok(dates().includes('2026-08-01'), 'a real day in the same backup is restored');
  assert.ok(['2026-02-30', 'garbage', '2026-04-31'].every(d => !dates().includes(d)));
  const kept = quarantine('full-backup-restore');
  assert.deepEqual(kept.map(k => k.date), ['2026-02-30', 'garbage', '2026-04-31']);
  assert.equal(kept[0].payload.items, data.diary.at(-4).items, 'the row is kept whole');
  assert.equal(kept[2].payload.deleted_at, '2026-10-02 00:00:00');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n, held + 3,
    'the restore added the three, kept every row it held, and did not duplicate the backup\'s own quarantine rows');

  const again = await srv.api('POST', `/api/full-backup/${made.body.filename}/restore`);
  assert.equal(again.status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM diary_quarantine WHERE source != 'full-backup-restore'`).get().n, held,
    'restoring the same backup again adds none of its quarantine rows twice');
});

test('a writer that forgot the check is stopped by the table, not stored', () => {
  assert.throws(() => db.prepare(`INSERT INTO diary (user_id, date, items) VALUES (?, '2026-02-30', '[]')`).run(owner), /real YYYY-MM-DD/);
  assert.equal(dates().includes('2026-02-30'), false);
});
