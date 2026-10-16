/**
 * The owner scope of owner-scope.test.js in single-user mode, where no account
 * exists and the owner is "no user": the rows with user_id IS NULL.
 *
 * POST /api/foods/:id/used and POST /api/meals/:id/used touch only those rows.
 * A row that belongs to an account (left from when user management was on) or
 * is not there is a 404, the same answer. GET /api/meals/:id, the edits and the
 * fasts read and change the instance's rows as they always did.
 *
 * Its own file: a database is in single-user mode only while it has no user.
 */
import assert from 'node:assert/strict';
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

test('single-user mode: a source stamp saved again after a delete makes a new row', async t => {
  if (skip(t)) return;
  for (const [route, body] of [['/api/foods', { name: 'Pantry', nutrition: { calories: 1 } }], ['/api/meals', { name: 'Recipe', items: [], nutrition: {} }]]) {
    const send = () => call(null, 'POST', route, { ...body, client_key: 'k', source_app: 'cooktrace', source_external_id: 'e1' });
    const first = await send();
    assert.equal(first.status, 201);
    assert.equal((await call(null, 'DELETE', `${route}/${first.body.id}`)).status, 200);
    const fresh = await send();
    assert.equal(fresh.status, 201, route);
    assert.notEqual(fresh.body.id, first.body.id);
  }
});
