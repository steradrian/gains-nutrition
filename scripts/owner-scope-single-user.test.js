/**
 * The owner scope of owner-scope.test.js in single-user mode, where no account
 * exists and the owner is "no user": the rows with user_id IS NULL.
 *
 * POST /api/foods/:id/used and POST /api/meals/:id/used touch only those rows.
 * A row that belongs to an account (left from when user management was on) or
 * is not there is a 404, the same answer. GET /api/meals/:id, the edits and the
 * fasts read and change the instance's rows as they always did.
 *
 * The unique index on the source stamp does not apply to rows with no user
 * (SQLite counts NULLs as different), so the route's lookup alone keeps a stamp
 * to one row there, also when the same create is sent several times at once
 * (create-race.test.js has the account case).
 *
 * Its own file: a database is in single-user mode only while it has no user.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { bootInProcess } from './fixtures/in-process-server.mjs';

const env = await bootInProcess({
  prefix: 'nt-owner-scope-single',
  routes: { '/api/foods': 'foods.js', '/api/meals': 'meals.js', '/api/fasts': 'fasts.js' },
});
const db = env?.db;
const skip = t => { if (!env) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };
const { call } = env ?? {};

const NOT_FOUND = { status: 404, body: { error: 'Not found' } };

// A row that belongs to an account, as one left from before user management was turned off.
// Foreign keys are off for the insert only: the account itself is not part of the case.
function accountRow(table) {
  db.pragma('foreign_keys = OFF');
  try {
    const cols = table === 'foods' ? 'user_id, name, nutrition' : 'user_id, name, nutrition, items';
    const vals = table === 'foods' ? "42, 'Theirs', '{}'" : "42, 'Theirs', '{}', '[]'";
    return Number(db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${vals})`).run().lastInsertRowid);
  } finally { db.pragma('foreign_keys = ON'); }
}

test('single-user mode has no account', t => {
  if (skip(t)) return;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
});

for (const [route, table, body] of [
  ['/api/foods', 'foods', { name: 'Oats', nutrition: { calories: 380 } }],
  ['/api/meals', 'meals', { name: 'Bowl', items: [], nutrition: {} }],
]) {
  test(`POST ${route}/:id/used bumps a row with no user, and the same 404 answers a row of an account and one that is not there`, async t => {
    if (skip(t)) return;
    const made = await call(null, 'POST', route, body);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const mine = made.body.id;
    assert.equal(db.prepare(`SELECT user_id FROM ${table} WHERE id = ?`).get(mine).user_id, null, 'single-user rows have no user');
    const theirs = accountRow(table);
    const row = id => db.prepare(`SELECT usage_count, last_used_at, updated_at FROM ${table} WHERE id = ?`).get(id);
    db.prepare(`UPDATE ${table} SET updated_at = '2020-01-01 00:00:00'`).run();

    assert.deepEqual(await call(null, 'POST', `${route}/${mine}/used`, { date: '2026-10-01' }), { status: 200, body: { ok: true } });
    assert.equal(row(mine).usage_count, 1);
    assert.equal(row(mine).last_used_at, '2026-10-01');

    const before = row(theirs);
    assert.deepEqual(await call(null, 'POST', `${route}/${theirs}/used`, { date: '2026-10-02' }), NOT_FOUND, "an account's row");
    assert.deepEqual(await call(null, 'POST', `${route}/999999/used`, { date: '2026-10-02' }), NOT_FOUND, 'a row that is not there');
    assert.deepEqual(row(theirs), before, 'and the row is not changed');
  });
}

test('single-user mode: GET /api/meals/:id, the edits and the deletes work on the instance\'s rows, a missing id is a 404', async t => {
  if (skip(t)) return;
  const meal = (await call(null, 'POST', '/api/meals', { name: 'Soup', items: [], nutrition: {} })).body.id;
  const food = (await call(null, 'POST', '/api/foods', { name: 'Rice', nutrition: { calories: 130 } })).body.id;

  assert.equal((await call(null, 'GET', `/api/meals/${meal}`)).body.name, 'Soup');
  assert.deepEqual(await call(null, 'GET', '/api/meals/999999'), NOT_FOUND);
  assert.equal((await call(null, 'PUT', `/api/meals/${meal}`, { name: 'Stew' })).status, 200);
  assert.equal((await call(null, 'PUT', `/api/foods/${food}`, { name: 'Brown rice' })).status, 200);
  assert.deepEqual(await call(null, 'PUT', '/api/foods/999999', { name: 'x' }), NOT_FOUND);
  assert.deepEqual(await call(null, 'DELETE', '/api/meals/999999'), NOT_FOUND);
  assert.equal((await call(null, 'DELETE', `/api/meals/${meal}`)).status, 200);
  assert.equal((await call(null, 'DELETE', `/api/foods/${food}`)).status, 200);
});

test('single-user mode: a fast is ended, edited and deleted, and a missing one is a 404', async t => {
  if (skip(t)) return;
  const started = await call(null, 'POST', '/api/fasts/start', { goal_hours: 16 });
  assert.equal(started.status, 201);
  const id = started.body.id;
  assert.equal((await call(null, 'PATCH', `/api/fasts/${id}`, { notes: 'ok' })).status, 200);
  assert.equal((await call(null, 'POST', `/api/fasts/${id}/end`, {})).status, 200);
  assert.equal((await call(null, 'DELETE', `/api/fasts/${id}`)).status, 200);
  assert.deepEqual(await call(null, 'DELETE', '/api/fasts/999999'), { status: 404, body: { error: 'Fast not found' } });
});

// The unique index on the source stamp counts NULL owners as all different, so for the rows of
// single-user mode it guards nothing: the route's own lookup (which leaves deleted rows out) is
// what makes a stamp saved twice one row, and a delete free it. The tests below hold the lookup.
test('single-user mode: the stamp index does not apply to rows with no user', t => {
  if (skip(t)) return;
  for (const table of ['foods', 'meals']) {
    const add = () => db.prepare(`INSERT INTO ${table} (user_id, name, source_app, source_external_id) VALUES (NULL, 'x', 'cooktrace', 'raw')`).run();
    add();
    assert.doesNotThrow(add, `${table}: two live rows with no user and one stamp are both accepted`);
  }
});

for (const [route, body] of [['/api/foods', { name: 'Pantry', nutrition: { calories: 1 } }], ['/api/meals', { name: 'Recipe', items: [], nutrition: {} }]]) {
  test(`single-user mode: ${route} with one source stamp is updated in place, and saved again after a delete makes a new row`, async t => {
    if (skip(t)) return;
    const send = () => call(null, 'POST', route, { ...body, source_app: 'cooktrace', source_external_id: 'e1' });
    const first = await send();
    assert.equal(first.status, 201);
    const again = await send();
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id, 'a live row with the stamp is found, not duplicated');

    assert.equal((await call(null, 'DELETE', `${route}/${first.body.id}`)).status, 200);
    const fresh = await send();
    assert.equal(fresh.status, 201, 'the deleted row does not answer for the stamp');
    assert.notEqual(fresh.body.id, first.body.id);
    assert.equal((await send()).body.id, fresh.body.id, 'and the live one is what the stamp finds now');
  });
}

test('single-user mode: the same food with a source stamp, sent at once, is one food', async t => {
  if (skip(t)) return;
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]);
  const images = createServer((req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); }, 200));
  images.listen(0, '127.0.0.1');
  await once(images, 'listening');
  // The image is on the loopback, which the SSRF guard refuses unless the variable allows it (single-user mode has no admin).
  process.env.ALLOW_PRIVATE_IMAGE_URLS = '1';
  try {
    const body = { name: 'Raced pantry', nutrition: { calories: 1 }, img_url: `http://127.0.0.1:${images.address().port}/p.png`, source_app: 'cooktrace', source_external_id: 'raced' };
    const replies = await Promise.all(Array.from({ length: 4 }, () => call(null, 'POST', '/api/foods', body)));
    assert.deepEqual(replies.map(r => r.status).sort(), [200, 200, 200, 201]);
    assert.equal(new Set(replies.map(r => r.body.id)).size, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM foods WHERE source_external_id = 'raced'").get().n, 1);
  } finally {
    delete process.env.ALLOW_PRIVATE_IMAGE_URLS;
    images.close();
  }
});
