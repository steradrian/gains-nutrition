/**
 * API contract: the diary (docs/api-contract.md, "Diary").
 *
 * The real server on a scratch database; every response's shape is pinned
 * (fixtures/contract/schemas.mjs), so a renamed, removed or retyped field
 * fails here before a client built on it breaks.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { DIARY_DAY, EMPTY_DAY, ERROR, TOMBSTONE } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

const DAY = { ...DIARY_DAY, tombstones: [TOMBSTONE] };
const item = (over = {}) => ({
  uuid: 'item-oats', meal: 0, name: 'Rolled oats', brand: 'Contract Mills', portion: 40, unit: 'g', quantity: 1,
  nutrition: { calories: 152, proteins: 5.2, carbohydrates: 27.2, fat: 2.6 }, addedAt: '2026-10-14T07:30:00.000Z', ...over,
});
const put = (date, body, opts) => srv.api('PUT', `/api/diary/${date}`, {
  items: [], body_stats: {}, water: [], notes: '', deleted_uuids: { items: [], water: [] }, ...body,
}, opts);

test('GET /api/diary/:date for a day never written: an empty day, no row', async () => {
  const r = await srv.api('GET', '/api/diary/2026-10-01', undefined, { example: 'diary.get.empty' });
  assert.equal(r.status, 200);
  assertShape(r.body, EMPTY_DAY);
  assert.deepEqual(r.body, { date: '2026-10-01', items: [], body_stats: {}, water: [], notes: '', completed_at: null, completed_meals: [], tombstones: [] });
});

test('PUT /api/diary/:date writes the whole day and answers it as stored', async () => {
  const body = {
    items: [item()],
    body_stats: { weight: 80.4, weight_unit: 'kg' },
    water: [{ uuid: 'water-1', amount: 250, time: '8:05 AM' }],
    notes: 'Slept well',
  };
  const r = await put('2026-10-14', body, { example: 'diary.put' });
  assert.equal(r.status, 200);
  assertShape(r.body, DAY);
  assert.equal(r.body.date, '2026-10-14');
  const [got] = r.body.items;
  for (const k of ['uuid', 'meal', 'name', 'brand', 'portion', 'unit', 'quantity', 'addedAt']) assert.equal(got[k], body.items[0][k], k);
  assert.deepEqual(got.nutrition, body.items[0].nutrition, 'nutrition is per the logged portion, as sent');
  assert.equal(got.imgUrl, '', 'imgUrl is the live picture of the source food; none here');
  assert.deepEqual(r.body.body_stats, body.body_stats);
  assert.deepEqual(r.body.water, body.water);
  assert.equal(r.body.notes, 'Slept well');

  const again = await srv.api('GET', '/api/diary/2026-10-14', undefined, { example: 'diary.get' });
  assertShape(again.body, DAY);
  assert.deepEqual(again.body.items, r.body.items);
});

test('items merge by uuid: an omitted item is kept, only deleted_uuids removes one (and leaves a tombstone)', async () => {
  const a = item({ uuid: 'merge-a', name: 'Egg' }), b = item({ uuid: 'merge-b', name: 'Toast' });
  await put('2026-10-13', { items: [a, b] });
  const kept = await put('2026-10-13', { items: [a] });
  assert.deepEqual(kept.body.items.map(i => i.uuid).sort(), ['merge-a', 'merge-b'], 'a client that never saw b does not delete it');
  const removed = await put('2026-10-13', { items: [a], deleted_uuids: { items: ['merge-b'], water: [] } }, { example: 'diary.put.delete' });
  assert.deepEqual(removed.body.items.map(i => i.uuid), ['merge-a']);
  assert.ok(removed.body.tombstones.some(t => t.kind === 'item' && t.uuid === 'merge-b'));
  // A stale client re-sending b does not bring it back.
  const stale = await put('2026-10-13', { items: [a, b] });
  assert.deepEqual(stale.body.items.map(i => i.uuid), ['merge-a']);
});

test('the same uuid sent twice: the later updatedAt wins', async () => {
  await put('2026-10-12', { items: [item({ uuid: 'lww', quantity: 1, updatedAt: '2026-10-12T08:00:00.000Z' })] });
  const newer = await put('2026-10-12', { items: [item({ uuid: 'lww', quantity: 2, updatedAt: '2026-10-12T09:00:00.000Z' })] });
  assert.equal(newer.body.items[0].quantity, 2);
  const older = await put('2026-10-12', { items: [item({ uuid: 'lww', quantity: 3, updatedAt: '2026-10-12T07:00:00.000Z' })] });
  assert.equal(older.body.items[0].quantity, 2);
});

test('a past and a future date are written as sent: the date is the path, as a local YYYY-MM-DD', async () => {
  for (const date of ['2020-02-29', '2099-12-31']) {
    const r = await put(date, { items: [item({ uuid: `d-${date}` })] });
    assert.equal(r.status, 200, date);
    assert.equal(r.body.date, date);
    assert.equal((await srv.api('GET', `/api/diary/${date}`)).body.items.length, 1);
  }
});

test('GET /api/diary: every day with a row, oldest first, no paging (the stats screen reads it all)', async () => {
  const r = await srv.api('GET', '/api/diary');
  assert.equal(r.status, 200);
  assertShape(r.body, [DIARY_DAY]);
  const dates = r.body.map(d => d.date);
  assert.deepEqual(dates, [...dates].sort());
  assert.ok(dates.includes('2020-02-29') && dates.includes('2099-12-31'));
});

test('PUT /api/diary/:date/completion marks and unmarks the day', async () => {
  const on = await srv.api('PUT', '/api/diary/2026-10-14/completion', { completed: true }, { example: 'diary.completion' });
  assert.equal(on.status, 200);
  assertShape(on.body, { ok: 'boolean', date: 'date', completed_at: 'sqltime' });
  const off = await srv.api('PUT', '/api/diary/2026-10-14/completion', { completed: false });
  assertShape(off.body, { ok: 'boolean', date: 'date', completed_at: 'null' });
  const bad = await srv.api('PUT', '/api/diary/14-10-2026/completion', { completed: true });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'invalid date' });
});

test('PUT /api/diary/:date/meal-completion marks one meal slot (0..31)', async () => {
  const r = await srv.api('PUT', '/api/diary/2026-10-14/meal-completion', { slot: 2, completed: true }, { example: 'diary.meal-completion' });
  assert.equal(r.status, 200);
  assertShape(r.body, { ok: 'boolean', date: 'date', completed_meals: ['integer'] });
  assert.deepEqual(r.body.completed_meals, [2]);
  const day = await srv.api('GET', '/api/diary/2026-10-14');
  assert.deepEqual(day.body.completed_meals, [2]);
  assert.equal(typeof day.body.meal_marks_at, 'string', 'meal_marks_at stays a JSON string');
  const bad = await srv.api('PUT', '/api/diary/2026-10-14/meal-completion', { slot: 32 });
  assert.equal(bad.status, 400);
  assertShape(bad.body, ERROR);
});

test('without a session: 401', async () => {
  const r = await srv.api('GET', '/api/diary/2026-10-14', undefined, { token: null });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Not authenticated' });
});

// Found while writing the contract: PUT /api/diary/:date takes any path
// segment as the date (only /completion and /meal-completion check it), so
// a client bug can write a day no screen will ever show.
test('PUT /api/diary/:date refuses a date that is not YYYY-MM-DD', { todo: 'server does not validate the diary date (routes/diary.js PUT /:date)' }, async () => {
  const r = await put('not-a-date', { items: [item({ uuid: 'bad-date' })] });
  assert.equal(r.status, 400);
});
