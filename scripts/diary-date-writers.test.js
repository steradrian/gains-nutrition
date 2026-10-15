/**
 * A diary day is keyed by a real YYYY-MM-DD, whichever way it is written.
 * One row with another date ("not-a-date", "2026-02-30") used to reach the
 * search index, and the hub's filter then refused the whole page, so search
 * stayed broken for that person for good. PUT /api/diary/:date is pinned in
 * contract-diary.test.js; this is the Android push and the JSON import.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';

const srv = await startServer({ file: import.meta.url });
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const Database = serverRequire('better-sqlite3');
const db = new Database(join(srv.dir, 'server.db'));
test.after(async () => { db.close(); await srv.stop(); });

const dates = () => db.prepare('SELECT date FROM diary ORDER BY date').all().map(r => r.date);
const item = uuid => ({ uuid, meal: 0, name: `Item ${uuid}`, nutrition: { calories: 100 }, addedAt: '2026-10-14T07:30:00.000Z' });
const BAD = ['not-a-date', '2026-02-30', '2026-13-01', '2026-1-5', '20261005', '2026-10-05x'];

test('Android push: a day with a date that does not exist is skipped, named, and the rest of the batch lands', async () => {
  const diary = [
    ...BAD.map((date, i) => ({ client_id: `bad-${i}`, date, items: [item(`bad-${i}`)], body_stats: {}, water: [] })),
    { client_id: 'bad-deleted', date: '2026-02-31', deleted_at: '2026-10-14 00:00:00' },
    { client_id: 'good-1', date: '2026-10-14', items: [item('good-1')], body_stats: {}, water: [] },
    { client_id: 'good-2', date: '2024-02-29', items: [item('good-2')], body_stats: {}, water: [] },
  ];
  const r = await srv.api('POST', '/api/sync/push', { diary });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.diary.map(d => [d.client_id, d.date]), [['good-1', '2026-10-14'], ['good-2', '2024-02-29']]);
  assert.deepEqual(r.body.skipped_diary.map(d => d.client_id), [...BAD.map((_, i) => `bad-${i}`), 'bad-deleted']);
  assert.deepEqual(dates(), ['2024-02-29', '2026-10-14']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_tombstones').get().n, 0);
});

test('Android push: a batch with only good days names nothing skipped', async () => {
  const r = await srv.api('POST', '/api/sync/push', { diary: [{ client_id: 'g', date: '2026-10-15', items: [item('g')], body_stats: {}, water: [] }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.skipped_diary, []);
  assert.ok(dates().includes('2026-10-15'));
});

test('import: days with a date that does not exist are skipped and counted', async () => {
  const before = dates().length;
  const diary = [
    ...BAD.map((date, i) => ({ date, items: [item(`imp-bad-${i}`)] })),
    { date: 42, items: [] },
    { date: '2026-09-01', items: [item('imp-1')] },
    { date: '2026-09-02', items: [item('imp-2')] },
    { items: [item('no-date')] },
  ];
  const r = await srv.api('POST', '/api/data/import', { diary });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, skipped_diary: BAD.length + 1 }, 'a day with no date at all was never counted');
  assert.equal(dates().length, before + 2);
  assert.ok(dates().includes('2026-09-01') && dates().includes('2026-09-02'));
});

test('import: a clean file reports none skipped', async () => {
  const r = await srv.api('POST', '/api/data/import', { diary: [{ date: '2026-09-03', items: [] }] });
  assert.deepEqual(r.body, { ok: true, skipped_diary: 0 });
});
