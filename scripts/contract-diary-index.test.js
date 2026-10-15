/**
 * API contract: GET /api/diary/index (docs/api-contract.md, "Diary").
 *
 * The real server on a scratch database. Days are written through the
 * API where the write path matters (merge, tombstones, soft delete) and
 * straight into the database where the test needs a chosen updated_at
 * (rows sharing one second, rows the clock has not reached, a restore).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { Nutrition } from '../src/lib/nutrition.js';
import { INDEX_DATE_GLOB, keysetSql } from '../server/lib/diary-keyset.js';
import { PARITY_DAY_KCAL, PARITY_ITEMS } from './fixtures/contract/diary-index-items.mjs';
import { PASSWORD, startServer } from './fixtures/contract/server.mjs';
import { DIARY_INDEX_PAGE } from './fixtures/contract/schemas.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';

const JWT_SECRET = 'contract-test-secret-0123456789abcdef';
const srv = await startServer({ file: import.meta.url, env: { JWT_SECRET } });
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const Database = serverRequire('better-sqlite3');
const jwt = serverRequire('jsonwebtoken');
const db = new Database(join(srv.dir, 'server.db'));
db.pragma('busy_timeout = 5000');
test.after(async () => { db.close(); await srv.stop(); });

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const decodeCursor = raw => JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
const dateOf = i => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

// Each test gets its own account, so no test sees another's days. The
// session token is signed here with the server's secret (the contract
// server's JWT_SECRET): the login route throttles an address after 10 tries.
let seq = 0;
async function account() {
  const username = `index-${++seq}`;
  const reg = await srv.api('POST', '/api/auth/register', { username, password: PASSWORD });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const { id, role } = reg.body.user;
  const token = jwt.sign({ id, username, role, csrf: 'contract' }, JWT_SECRET);
  return {
    id, token,
    get: (query = '') => srv.api('GET', `/api/diary/index${query}`, undefined, { token }),
    put: (date, body) => srv.api('PUT', `/api/diary/${date}`, {
      items: [], body_stats: {}, water: [], notes: '', deleted_uuids: { items: [], water: [] }, ...body,
    }, { token }),
  };
}

const logged = (over = {}) => ({
  uuid: 'i-1', meal: 0, name: 'Rolled oats', brand: 'Contract Mills', portion: 40, unit: 'g', quantity: 1,
  nutrition: { calories: 152, proteins: 5.2 }, addedAt: '2026-10-14T07:30:00.000Z', ...over,
});

const seedDay = (userId, date, { items = [], updatedAt = '2025-03-10 12:00:00', deletedAt = null, rawItems } = {}) => db.prepare(
  'INSERT INTO diary (user_id, date, items, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)'
).run(userId, date, rawItems ?? JSON.stringify(items), updatedAt, deletedAt);

// Follow `next` until the cursor stops, like a client's first load.
async function crawl(acct, limit) {
  const days = [];
  const pages = [];
  let query = `?limit=${limit}`;
  for (let i = 0; i < 50; i++) {
    const r = await acct.get(query);
    assert.equal(r.status, 200);
    pages.push(r.body);
    days.push(...r.body.days);
    if (!r.body.has_more) return { days, pages };
    query = `?since=${r.body.next}&limit=${limit}`;
  }
  assert.fail('the crawl did not finish');
}

test('the page, a live day, a deleted day and an empty account have the pinned shape', async () => {
  const a = await account();
  const empty = await a.get();
  assert.equal(empty.status, 200);
  assertShape(empty.body, DIARY_INDEX_PAGE);
  assert.deepEqual({ ...empty.body, next: typeof empty.body.next }, { days: [], total: 0, next: 'string', has_more: false });

  await a.put('2026-10-14', { items: [logged()] });
  await a.put('2026-10-13', { items: [] });
  await a.put('2026-10-12', { items: [logged({ uuid: 'gone' })] });
  assert.equal((await srv.api('DELETE', '/api/diary/2026-10-12', undefined, { token: a.token })).status, 200);

  const r = await a.get();
  assertShape(r.body, DIARY_INDEX_PAGE);
  const byDate = Object.fromEntries(r.body.days.map(d => [d.date, d]));
  assert.deepEqual(Object.keys(byDate['2026-10-14']).sort(), ['date', 'items', 'kcal', 'rev']);
  assert.equal(byDate['2026-10-14'].kcal, 152);
  assert.deepEqual(byDate['2026-10-13'].items, [], 'a live day with no items is still listed');
  assert.equal(byDate['2026-10-13'].kcal, 0);
  assert.deepEqual(Object.keys(byDate['2026-10-12']).sort(), ['date', 'deleted', 'rev']);
  assert.equal(byDate['2026-10-12'].deleted, true);
  assert.equal(r.body.total, 2, 'total counts live days');
  assert.match(byDate['2026-10-14'].rev, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('an item carries its name, brand, meal slot and food id, and nothing else', async () => {
  const a = await account();
  const extras = { imgUrl: '/uploads/x.jpg', notes: 'private note', user_id: 99, updated_at: 'x', portion: 40, unit: 'g', quantity: 1, addedAt: '2026-10-14T07:30:00.000Z' };
  await a.put('2026-10-14', {
    items: [
      logged({ uuid: 'food', id: 812, meal: 1, name: 'Chicken bowl', brand: 'Sweetgreen', ...extras }),
      { uuid: 'quick', meal: 2, name: 'Quick Calories', nutrition: { calories: 300 }, ...extras },
      { uuid: 'recipe', meal: 0, name: 'Stew', is_recipe: true, id: 5, nutrition: { calories: 400 }, ...extras },
      logged({ uuid: 'phone', id: 3, food_server_id: null, name: 'Phone food', brand: '' }),
      logged({ uuid: 'server-id', id: 3, food_server_id: 77, name: 'Renamed food', brand: undefined }),
    ],
  });
  const [day] = (await a.get()).body.days;
  const items = Object.fromEntries(day.items.map(i => [i.uuid, i]));
  assert.deepEqual(items.food, { uuid: 'food', name: 'Chicken bowl', brand: 'Sweetgreen', food_id: 812, meal: 1, kcal: 152 });
  assert.deepEqual(items.quick, { uuid: 'quick', name: 'Quick Calories', food_id: null, meal: 2, kcal: 300 });
  assert.equal(items.recipe.food_id, null, 'a recipe id is a meals id, not a food');
  assert.equal(items.phone.food_id, null, 'a phone-only food names no server food');
  assert.equal(items.phone.brand, undefined, 'an empty brand is left out');
  assert.equal(items['server-id'].food_id, 77);
  const allowed = new Set(['uuid', 'name', 'brand', 'food_id', 'meal', 'kcal', 'parts']);
  for (const item of day.items) {
    for (const key of Object.keys(item)) assert.ok(allowed.has(key), `unexpected item key ${key}`);
  }
  assert.ok(!JSON.stringify(day).includes('private note'));
});

test('a split recipe lists its ingredients as parts, in the index only for splits', async () => {
  const a = await account();
  const stew = PARITY_ITEMS.find(i => i.uuid === 'par-stew');
  await a.put('2026-10-14', {
    items: [
      { ...stew, expectKcal: undefined, _splitItems: [...stew._splitItems, { uuid: 'nested', name: '', _splitItems: [{ uuid: 'deep', name: 'Carrot', nutrition: { calories: 1 } }] }] },
      logged({ uuid: 'plain' }),
      { uuid: 'empty-split', meal: 0, name: 'Empty split', is_recipe: true, nutrition: { calories: 10 }, _splitItems: [] },
    ],
  });
  const [day] = (await a.get()).body.days;
  const items = Object.fromEntries(day.items.map(i => [i.uuid, i]));
  assert.deepEqual(items['par-stew'].parts, ['Beef', 'Stock', 'Carrot']);
  assert.equal('parts' in items.plain, false);
  assert.equal('parts' in items['empty-split'], false);
  assert.equal(items['empty-split'].kcal, 10);
});

test('kcal is Nutrition.calculate for every item, and the day rounds the unrounded sum', async () => {
  const a = await account();
  await a.put('2026-10-14', { items: PARITY_ITEMS.map(({ expectKcal, ...item }) => item) });
  const [day] = (await a.get()).body.days;
  const byUuid = Object.fromEntries(day.items.map(i => [i.uuid, i]));
  for (const item of PARITY_ITEMS) {
    assert.equal(byUuid[item.uuid].kcal, item.expectKcal, `${item.uuid} against the fixture`);
    const { expectKcal, ...stored } = item;
    assert.equal(byUuid[item.uuid].kcal, Math.round(Nutrition.calculate(stored).calories || 0), `${item.uuid} against Nutrition.calculate`);
  }
  assert.equal(day.kcal, PARITY_DAY_KCAL);
  const sum = PARITY_ITEMS.reduce((s, { expectKcal, ...item }) => s + (Nutrition.calculate(item).calories || 0), 0);
  assert.equal(day.kcal, Math.round(sum));
  assert.notEqual(day.kcal, day.items.reduce((s, i) => s + i.kcal, 0), 'not the sum of the rounded items');
});

test('a malformed items column gives an empty day, not a failed page', async () => {
  const a = await account();
  seedDay(a.id, '2025-01-01', { rawItems: '{not json' });
  seedDay(a.id, '2025-01-02', { rawItems: '{"not":"an array"}' });
  seedDay(a.id, '2025-01-03', { rawItems: 'null' });
  const r = await a.get();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.days.map(d => [d.date, d.items, d.kcal]), [
    ['2025-01-01', [], 0], ['2025-01-02', [], 0], ['2025-01-03', [], 0],
  ]);
});

test('GET /api/diary/index is the index, not the day "index"', async () => {
  const a = await account();
  // A row dated "index" is what /:date would answer with if the route were
  // read as a date: its items and tombstones, not a page.
  seedDay(a.id, 'index', { items: [logged({ uuid: 'shadow', name: 'Shadow of the route' })] });
  seedDay(a.id, '2025-02-01');
  const r = await a.get();
  assert.equal(r.status, 200);
  assertShape(r.body, DIARY_INDEX_PAGE);
  for (const key of ['date', 'items', 'tombstones', 'body_stats']) assert.ok(!(key in r.body), `the answer is a page, it has no ${key}`);
  assert.deepEqual(r.body.days.map(d => d.date), ['2025-02-01']);
  assert.ok(!JSON.stringify(r.body).includes('Shadow of the route'));
  assert.equal((await srv.api('GET', '/api/diary/2026-10-01', undefined, { token: a.token })).body.date, '2026-10-01', '/:date still answers');
  const asDate = await srv.api('GET', '/api/diary/index', undefined, { token: a.token });
  assert.ok('days' in asDate.body, 'and /index is still the page after /:date was used');
});

test('a row whose date is not YYYY-MM-DD is neither listed nor counted', async () => {
  const a = await account();
  seedDay(a.id, '2025-03-01');
  for (const [i, date] of ['not-a-date', '2025-3-1', '2025-03-01x', ' 2025-03-02', '20250302', '2025/03/02', ''].entries()) {
    seedDay(a.id, date, { updatedAt: `2025-03-10 12:00:0${i}` });
  }
  seedDay(a.id, 'bad-deleted', { deletedAt: '2025-03-11 00:00:00' });
  seedDay(a.id, '2025-03-05', { updatedAt: '2025-03-10 13:00:00' });
  const { days, pages } = await crawl(a, 2);
  assert.deepEqual(days.map(d => d.date), ['2025-03-01', '2025-03-05']);
  assert.ok(pages.every(p => p.total === 2), 'total leaves them out too');
  assert.equal(pages.at(-1).has_more, false);
});

test('a bad row cannot fail the page: a split nested past the stack gives 0 kcal, and parts stop at a depth', async () => {
  const a = await account();
  const deep = 20_000;
  const nest = n => '{"uuid":"s","name":"split","nutrition":{"calories":7},"_splitItems":['.repeat(n) + '{"uuid":"leaf","name":"leaf"}' + ']}'.repeat(n);
  seedDay(a.id, '2025-04-01', { rawItems: `[${nest(deep)}]` });
  seedDay(a.id, '2025-04-02', { items: [logged({ uuid: 'fine', nutrition: { calories: 90 } })] });
  const named = (n) => {
    let node = { uuid: 'bottom', name: `part-${n}` };
    for (let i = n - 1; i >= 1; i--) node = { uuid: `p${i}`, name: `part-${i}`, _splitItems: [node] };
    return { uuid: 'nest', name: 'Nested', is_recipe: true, nutrition: { calories: 1 }, _splitItems: [node] };
  };
  seedDay(a.id, '2025-04-03', { items: [named(30)] });
  const r = await a.get();
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const byDate = Object.fromEntries(r.body.days.map(d => [d.date, d]));
  assert.equal(byDate['2025-04-01'].kcal, 0);
  assert.equal(byDate['2025-04-01'].items[0].kcal, 0);
  assert.equal(byDate['2025-04-02'].kcal, 90, 'the next day is untouched');
  const parts = byDate['2025-04-03'].items[0].parts;
  assert.deepEqual(parts, Array.from({ length: 6 }, (_, i) => `part-${i + 1}`), 'six levels of parts, no deeper');
});

test('a page stops after about 2 MB of days, says has_more, and the crawl still gets every day', async () => {
  const a = await account();
  // About 250 KB of index per day.
  const heavy = Array.from({ length: 1000 }, (_, i) => ({ uuid: `h-${i}`, name: 'x'.repeat(150), meal: 0, nutrition: { calories: 1 } }));
  const insert = db.transaction(() => { for (let i = 0; i < 24; i++) seedDay(a.id, dateOf(i), { items: heavy }); });
  insert();
  const first = await a.get('?limit=24');
  assert.equal(first.status, 200);
  assert.ok(first.body.days.length >= 1 && first.body.days.length < 24, `cut at ${first.body.days.length} days`);
  assert.equal(first.body.has_more, true);
  const bytes = JSON.stringify(first.body.days).length;
  assert.ok(bytes > 2 * 1024 * 1024 && bytes < 2.5 * 1024 * 1024, `${bytes} bytes: past the cap by at most one day`);
  assert.deepEqual(decodeCursor(first.body.next), { u: '2025-03-10 12:00:00', d: first.body.days.at(-1).date }, 'the cursor sits on the last day sent');
  const { days } = await crawl(a, 24);
  assert.deepEqual(days.map(d => d.date), Array.from({ length: 24 }, (_, i) => dateOf(i)));
});

test('one day over the cap still goes out whole', async () => {
  const a = await account();
  const giant = Array.from({ length: 12_000 }, (_, i) => ({ uuid: `g-${i}`, name: 'y'.repeat(150), meal: 0, nutrition: { calories: 1 } }));
  seedDay(a.id, '2025-06-01', { items: giant });
  seedDay(a.id, '2025-06-02');
  const first = await a.get();
  assert.deepEqual(first.body.days.map(d => d.date), ['2025-06-01']);
  assert.equal(first.body.has_more, true);
  assert.deepEqual((await a.get(`?since=${first.body.next}`)).body.days.map(d => d.date), ['2025-06-02']);
});

test('a removed item, a deleted day and a clear-all reach the next poll', async () => {
  const a = await account();
  await a.put('2026-10-14', { items: [logged({ uuid: 'keep' }), logged({ uuid: 'drop', name: 'Dropped' })] });
  const first = await a.get();
  assert.deepEqual(first.body.days[0].items.map(i => i.uuid), ['keep', 'drop']);

  await a.put('2026-10-14', { items: [], deleted_uuids: { items: ['drop'], water: [] } });
  const afterRemoval = await a.get(`?since=${first.body.next}`);
  const day = afterRemoval.body.days.find(d => d.date === '2026-10-14');
  assert.deepEqual(day.items.map(i => i.uuid), ['keep'], 'the whole day comes again, without the item');
  assert.ok(!JSON.stringify(afterRemoval.body).includes('tombstones'), 'tombstones are not on the wire');

  await a.put('2026-10-15', { items: [logged({ uuid: 'other' })] });
  assert.equal((await srv.api('DELETE', '/api/diary/2026-10-15', undefined, { token: a.token })).status, 200);
  const afterDelete = await a.get(`?since=${afterRemoval.body.next}`);
  const gone = afterDelete.body.days.find(d => d.date === '2026-10-15');
  assert.deepEqual(Object.keys(gone).sort(), ['date', 'deleted', 'rev']);
  assert.equal(gone.deleted, true);

  await a.put('2026-10-15', { items: [logged({ uuid: 'back' })] });
  const afterReturn = await a.get(`?since=${afterDelete.body.next}`);
  const back = afterReturn.body.days.find(d => d.date === '2026-10-15');
  assert.equal(back.deleted, undefined, 'a re-PUT brings the day back as a normal day');
  assert.ok(back.items.some(i => i.uuid === 'back'));

  assert.equal((await srv.api('DELETE', '/api/data', undefined, { token: a.token })).status, 200);
  const cleared = await a.get();
  assert.ok(cleared.body.days.length >= 2 && cleared.body.days.every(d => d.deleted === true), 'every day is deleted');
  assert.equal(cleared.body.total, 0);
});

test('rows sharing one second page through with no gap or duplicate', async () => {
  const a = await account();
  const insert = db.transaction(() => { for (let i = 0; i < 250; i++) seedDay(a.id, dateOf(i)); });
  insert();
  const { days, pages } = await crawl(a, 100);
  assert.deepEqual(days.map(d => d.date), Array.from({ length: 250 }, (_, i) => dateOf(i)));
  assert.deepEqual(pages.map(p => p.has_more), [true, true, false]);
  assert.ok(pages.every(p => p.total === 250));
});

test('the cursor never passes the current second, and rows from it come again', async () => {
  const a = await account();
  seedDay(a.id, '2025-05-01', { updatedAt: '2025-05-02 00:00:00' });
  // A row the clock has not reached: a write can still land in its second
  // under an earlier date.
  seedDay(a.id, '2025-04-30', { updatedAt: '2999-01-01 00:00:00' });
  for (let i = 0; i < 2; i++) {
    const r = await a.get();
    assert.deepEqual(r.body.days.map(d => d.date), ['2025-05-01', '2025-04-30']);
    assert.deepEqual(decodeCursor(r.body.next), { u: '2025-05-02 00:00:00', d: '2025-05-01' });
    const again = await a.get(`?since=${r.body.next}`);
    assert.deepEqual(again.body.days.map(d => d.date), ['2025-04-30'], 'comes again');
  }
  // A write after the poll, in the same second as the row before it, shows up.
  seedDay(a.id, '2025-04-29', { updatedAt: '2999-01-01 00:00:00' });
  const poll = await a.get('?since=' + (await a.get()).body.next);
  assert.deepEqual(poll.body.days.map(d => d.date), ['2025-04-29', '2025-04-30']);

  // More held rows than the limit: has_more stays false, so a poller waits
  // for its next round instead of spinning on one page.
  const held = await a.get(`?since=${Buffer.from(JSON.stringify({ u: '2025-05-02 00:00:01', d: '' })).toString('base64url')}&limit=1`);
  assert.equal(held.body.days.length, 1);
  assert.equal(held.body.has_more, false);
  assert.deepEqual(decodeCursor(held.body.next), { u: '2025-05-02 00:00:01', d: '' });
});

test('a poll with nothing new answers no days, and a write after it is seen by the next poll', async () => {
  const a = await account();
  await a.put('2026-10-14', { items: [logged()] });
  await new Promise(r => setTimeout(r, 1100));   // the write's second is over
  const { pages } = await crawl(a, 200);
  const idle = await a.get(`?since=${pages.at(-1).next}`);
  assert.deepEqual(idle.body.days, []);
  assert.equal(idle.body.has_more, false);
  assert.equal(idle.body.total, 1);
  await a.put('2026-10-15', { items: [logged({ uuid: 'late' })] });
  const seen = await a.get(`?since=${idle.body.next}`);
  assert.ok(seen.body.days.some(d => d.date === '2026-10-15'));
});

test('limit and since are validated with a code', async () => {
  const a = await account();
  const cursor = Buffer.from(JSON.stringify({ u: '2026-01-01 00:00:00', d: '' })).toString('base64url');
  const bad = async (query, code) => {
    const r = await a.get(query);
    assert.equal(r.status, 400, query);
    assert.equal(r.body.code, code, query);
    assert.equal(typeof r.body.error, 'string', query);
  };
  for (const limit of ['0', '501', 'abc', '1.5', '-1', '', '1e2x', '010', '+5', '%205', '0x10', '1000']) await bad(`?limit=${limit}`, 'bad_limit');
  await bad('?limit=1&limit=2', 'bad_limit');
  await bad('?since=garbage', 'bad_cursor');
  await bad('?since=', 'bad_cursor');
  await bad('?since=a%2Bb', 'bad_cursor');
  await bad(`?since=${Buffer.from(JSON.stringify({ u: 'yesterday', d: '' })).toString('base64url')}`, 'bad_cursor');
  await bad(`?since=${Buffer.from(JSON.stringify({ u: '2026-01-01 00:00:00', d: '2026-02-30' })).toString('base64url')}`, 'bad_cursor');
  await bad(`?since=${'a'.repeat(201)}`, 'bad_cursor');
  assert.equal((await a.get(`?since=${cursor}&limit=500`)).status, 200);
  assert.equal((await a.get('?limit=1')).status, 200);
});

test('each account sees only its own days; total is the length of GET /api/diary', async () => {
  const a = await account();
  const b = await account();
  await a.put('2026-10-14', { items: [logged({ uuid: 'a-uuid', name: 'Secret of A' })] });
  await a.put('2026-10-10', { items: [logged({ uuid: 'a-old', name: 'Old of A' })] });
  await a.put('2026-10-09', { items: [] });
  await srv.api('DELETE', '/api/diary/2026-10-09', undefined, { token: a.token });
  await b.put('2026-10-13', { items: [logged({ uuid: 'b-uuid', name: 'Secret of B' })] });

  const forB = await b.get();
  assert.deepEqual(forB.body.days.map(d => d.date), ['2026-10-13']);
  for (const leak of ['Secret of A', 'a-uuid', '2026-10-14']) assert.ok(!JSON.stringify(forB.body).includes(leak), leak);

  const forA = await a.get();
  const aCursor = forA.body.next;
  const crossed = await b.get(`?since=${aCursor}`);
  assert.ok(crossed.body.days.every(d => d.date === '2026-10-13'), 'a cursor from A yields B rows only');
  assert.ok(!JSON.stringify(crossed.body).includes('Secret of A'));

  const spoof = await a.get(`?user=${b.id}&user_id=${b.id}&owner=${b.id}`);
  assert.deepEqual(spoof.body.days.map(d => d.date).sort(), ['2026-10-09', '2026-10-10', '2026-10-14']);

  for (const acct of [a, b]) {
    const list = await srv.api('GET', '/api/diary', undefined, { token: acct.token });
    assert.equal((await acct.get()).body.total, list.body.length);
  }
  assert.equal(forA.body.total, 2);
});

test('without a session: 401', async () => {
  const r = await srv.api('GET', '/api/diary/index', undefined, { token: null });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Not authenticated' });
});

test('a restore that hard-deletes rows is caught by total', async () => {
  const a = await account();
  const insert = db.transaction(() => { for (let i = 0; i < 5; i++) seedDay(a.id, dateOf(i)); });
  insert();
  const before = await crawl(a, 200);
  assert.equal(before.pages.at(-1).total, 5);
  db.prepare('DELETE FROM diary WHERE user_id = ? AND date IN (?, ?)').run(a.id, dateOf(1), dateOf(3));
  const after = await a.get(`?since=${before.pages.at(-1).next}`);
  assert.equal(after.body.total, 3, 'fewer live days than the client holds: it rebuilds');
});

test('the handler reads stored JSON only, and its query runs on idx_diary_user_changed', () => {
  const route = read('../server/routes/diary.js');
  const start = route.indexOf("router.get('/index'");
  const handler = route.slice(start, route.indexOf("router.get('/:date'", start));
  assert.ok(start > 0 && handler.length > 0, 'the index route is mounted before /:date');
  for (const source of [handler, read('../server/lib/diary-index.js')]) {
    assert.doesNotMatch(source, /\b(hydrateItems|freshenItemImages)\(/);
    assert.doesNotMatch(source, /\bJOIN\b/);
  }

  assert.match(handler, /INDEX_DATE_GLOB/, 'the page and total both filter on the date shape');
  const { pageSql, countSql, params } = keysetSql({
    where: [INDEX_DATE_GLOB, 'user_id = ?'], params: [1], columns: 'date, items, deleted_at',
    position: { u: '1970-01-01 00:00:00', d: '' },
  });
  for (const [sql, bound] of [[pageSql, [...params, 200]], [countSql, params]]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bound).map(r => r.detail).join('\n');
    assert.match(plan, /idx_diary_user_changed/);
  }
});

test('1,100 days come in a few pages, quickly', async () => {
  const a = await account();
  const insert = db.transaction(() => { for (let i = 0; i < 1100; i++) seedDay(a.id, dateOf(i), { items: [logged({ uuid: `u-${i}` })] }); });
  insert();
  const started = Date.now();
  const { days, pages } = await crawl(a, 200);
  assert.equal(days.length, 1100);
  assert.equal(pages.length, 6);
  assert.ok(Date.now() - started < 10_000, `a full first load took ${Date.now() - started} ms`);
});

// Last: it removes every account, which puts the server in single-user mode
// (no users table rows, no sign-in) for whatever runs after it.
test('single-user mode: no sign-in, the one owner (user_id NULL) sees every day', async () => {
  db.prepare('DELETE FROM diary').run();
  db.prepare('DELETE FROM users').run();
  db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('single_user_mode', '1')`).run();
  const anon = { token: null };
  const put = (date, body) => srv.api('PUT', `/api/diary/${date}`, {
    items: [], body_stats: {}, water: [], notes: '', deleted_uuids: { items: [], water: [] }, ...body,
  }, anon);

  assert.equal((await put('2026-10-14', { items: [logged({ uuid: 'solo-1', name: 'Solo oats' })] })).status, 200);
  assert.equal((await put('2026-10-13', { items: [logged({ uuid: 'solo-2' })] })).status, 200);
  assert.equal((await put('2026-10-12', { items: [] })).status, 200);
  assert.equal((await srv.api('DELETE', '/api/diary/2026-10-12', undefined, anon)).status, 200);
  assert.equal((await put('not-a-date', {})).status, 400);
  seedDay(null, 'legacy-bad');

  const r = await srv.api('GET', '/api/diary/index', undefined, anon);
  assert.equal(r.status, 200);
  assertShape(r.body, DIARY_INDEX_PAGE);
  const byDate = Object.fromEntries(r.body.days.map(d => [d.date, d]));
  assert.deepEqual(Object.keys(byDate).sort(), ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(byDate['2026-10-14'].items[0].name, 'Solo oats');
  assert.equal(byDate['2026-10-14'].kcal, 152);
  assert.equal(byDate['2026-10-12'].deleted, true);
  assert.equal(r.body.total, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary WHERE user_id IS NOT NULL').get().n, 0);

  const list = await srv.api('GET', '/api/diary', undefined, anon);
  assert.equal(list.body.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date)).length, r.body.total, 'total is the dated days of GET /api/diary');

  assert.equal((await srv.api('GET', `/api/diary/index?since=${r.body.next}&limit=1`, undefined, anon)).status, 200);
  assert.equal((await srv.api('GET', '/api/diary/index?limit=0', undefined, anon)).status, 400);
});
