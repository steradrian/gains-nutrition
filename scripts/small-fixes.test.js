/**
 * Small fixes (docs/tickets/cloud-11-nutrition-small-fixes.md), behaviour:
 *
 *   - a create key that sits on a deleted row makes a new row (POST /api/foods,
 *     POST /api/meals), while the sync push still answers with the row it
 *     made, deleted or not, so a retried push cannot bring a deleted row back;
 *   - POST /api/meals/:id/used is the owner's alone: another account gets a 404
 *     for a shared meal, a private one and one that is not there alike, and the
 *     meal does not change;
 *   - the names and labels in the settings lose C0 control characters on write
 *     (PUT /api/settings and /bulk; a tab becomes a space), emoji and other
 *     Unicode stay, and a name made only of control characters is refused.
 *
 * In-process, on a scratch database (fixtures/in-process-server.mjs). The
 * User-Agent is in off-user-agent.test.js and off-user-agent-proxy.test.js;
 * the owner scope of the other routes is in owner-scope.test.js and
 * owner-scope-single-user.test.js, the cleaning of every other write path
 * in clean-names.test.js and clean-names-restore.test.js.
 * Skipped where better-sqlite3 is not built for this Node (it needs Node 20).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootInProcess } from './fixtures/in-process-server.mjs';

const env = await bootInProcess({
  prefix: 'nt-small-fixes',
  routes: { '/api/foods': 'foods.js', '/api/meals': 'meals.js', '/api/settings': 'settings.js', '/api/sync': 'sync.js' },
});
const db = env?.db;
const keys = env ? await import('../server/lib/create-keys.js') : null;
const skip = t => { if (!env) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };
const { newUser, call } = env ?? {};

// ── 2. A create key on a deleted row ──────────────────────────────────────
test('findByCreateKey skips a deleted row, prefers the live one, and the sync push can ask for the deleted too', t => {
  if (skip(t)) return;
  const u = newUser(), other = newUser();
  const row = (user, key, deleted) => Number(db.prepare(`INSERT INTO foods (user_id, name, client_key, deleted_at) VALUES (?, 'F', ?, ${deleted ? "datetime('now')" : 'NULL'})`).run(user.id, key).lastInsertRowid);
  const gone = row(u, 'k-gone', true);
  assert.equal(keys.findByCreateKey('foods', u.id, 'k-gone'), null, 'a deleted row is not the one made before');
  assert.equal(keys.findByCreateKey('foods', u.id, 'k-gone', { includeDeleted: true }).id, gone, 'unless the caller asks for it');
  const live = row(u, 'k-gone', false);
  assert.equal(keys.findByCreateKey('foods', u.id, 'k-gone').id, live, 'the live row that replaced it');
  assert.equal(keys.findByCreateKey('foods', u.id, 'k-gone', { includeDeleted: true }).id, live, 'and it wins over the deleted one even when both count');
  row(u, 'k-live', false);
  assert.ok(keys.findByCreateKey('foods', u.id, 'k-live'), 'a live row is found as before');
  assert.equal(keys.findByCreateKey('foods', other.id, 'k-live'), null, 'another account never matches');
  assert.equal(keys.findByCreateKey('foods', u.id, null), null);
  assert.equal(keys.findByCreateKey('foods', u.id, ''), null);
  assert.throws(() => keys.findByCreateKey('diary; DROP TABLE foods', u.id, 'k'), /no create keys/, 'the table is one of the four, never interpolated blind');
  for (const table of ['meals', 'activity_log', 'fasts']) assert.equal(keys.findByCreateKey(table, u.id, 'none'), null, `${table} has the column and the filter`);
});

for (const [route, table, body] of [
  ['/api/foods', 'foods', { name: 'Oats', nutrition: { calories: 380 } }],
  ['/api/meals', 'meals', { name: 'Bowl', items: [], nutrition: { calories: 300 } }],
]) {
  test(`${route}: saving again with the same key is the same ${table.slice(0, -1)}, until it is deleted, then it is a new one`, async t => {
    if (skip(t)) return;
    const u = newUser();
    const send = () => call(u, 'POST', route, { ...body, client_key: 'save-1' });
    const first = await send();
    assert.equal(first.status, 201);
    const again = await send();
    assert.equal(again.status, 200, 'a retry gets the row made the first time');
    assert.equal(again.body.id, first.body.id);

    assert.equal((await call(u, 'DELETE', `${route}/${first.body.id}`)).status, 200);
    const fresh = await send();
    assert.equal(fresh.status, 201, 'a save after the delete is a new row');
    assert.notEqual(fresh.body.id, first.body.id);
    assert.equal(db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(fresh.body.id).deleted_at, null, 'and it is live');
    assert.notEqual(db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(first.body.id).deleted_at, null, 'the deleted one stays deleted');

    const retry = await send();
    assert.equal(retry.status, 200, 'the new row is the one a retry finds now');
    assert.equal(retry.body.id, fresh.body.id);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id = ? AND deleted_at IS NULL`).get(u.id).n, 1);
  });
}

test('the sync push answers a retried key with the row made, deleted or not, and never makes a second', async t => {
  if (skip(t)) return;
  const u = newUser();
  const push = foods => call(u, 'POST', '/api/sync/push', { foods });
  const food = { client_id: 11, server_id: null, client_key: 'inst:foods:11', name: 'Pushed' };
  const first = await push([food]);
  assert.equal(first.status, 200);
  const id = first.body.foods[0].server_id;
  assert.ok(id > 0);
  // Deleted on the web, and the phone, which never saw the answer, pushes it again.
  assert.equal((await call(u, 'DELETE', `/api/foods/${id}`)).status, 200);
  const retry = await push([food]);
  assert.equal(retry.body.foods[0].server_id, id, 'the row made the first time, though it is deleted now');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM foods WHERE user_id = ?').get(u.id).n, 1, 'no second row: the delete holds');
  assert.equal(db.prepare('SELECT deleted_at FROM foods WHERE id = ?').get(id).deleted_at !== null, true);
});

// ── 3. /api/meals/:id/used is the owner's ─────────────────────────────────
test('POST /api/meals/:id/used: the owner bumps it, nobody else does, and every other meal is a plain 404', async t => {
  if (skip(t)) return;
  const owner = newUser(), other = newUser();
  const made = async (vis) => {
    const r = await call(owner, 'POST', '/api/meals', { name: `M-${vis}`, items: [], nutrition: {}, visibility: vis });
    assert.equal(r.status, 201);
    return r.body.id;
  };
  // 'group' is the visibility other accounts can read (lib/sharing.js); the old route let them bump it.
  const shared = await made('group'), priv = await made('private');
  const row = id => db.prepare('SELECT usage_count, last_used_at, updated_at FROM meals WHERE id = ?').get(id);
  db.prepare("UPDATE meals SET updated_at = '2020-01-01 00:00:00'").run();

  const ok = await call(owner, 'POST', `/api/meals/${shared}/used`, { date: '2026-10-01' });
  assert.deepEqual(ok, { status: 200, body: { ok: true } });
  assert.equal(row(shared).usage_count, 1);
  assert.equal(row(shared).last_used_at, '2026-10-01');

  const before = { shared: row(shared), priv: row(priv) };
  const answers = [];
  for (const id of [shared, priv, 999999]) answers.push(await call(other, 'POST', `/api/meals/${id}/used`, { date: '2026-10-02' }));
  for (const a of answers) assert.deepEqual(a, { status: 404, body: { error: 'Not found' } }, 'shared, private and missing look the same');
  assert.deepEqual(row(shared), before.shared, "another account's call changed nothing, shared or not");
  assert.deepEqual(row(priv), before.priv);

  // The owner's own private meal still works, and an invalid date still falls back to today.
  assert.equal((await call(owner, 'POST', `/api/meals/${priv}/used`, { date: 'not-a-date' })).status, 200);
  assert.equal(row(priv).usage_count, 1);
  assert.equal(row(priv).last_used_at, new Date().toISOString().slice(0, 10));
});

// ── 4. Control characters in names and labels ─────────────────────────────
const stored = (u, key) => JSON.parse(db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(u.id, key).value);

test('PUT /api/settings strips C0 control characters from names and labels and keeps everything else', async t => {
  if (skip(t)) return;
  const u = newUser();
  const put = (key, value) => call(u, 'PUT', '/api/settings', { key, value });

  assert.equal((await put('mealNames', ['Break\u0000fast', 'Lun\tch\n', '\u0001Dinner\u001f', 'Snacks \u{1F36A}', 'Frühstück', '朝ごはん'])).status, 200);
  assert.deepEqual(stored(u, 'mealNames'), ['Breakfast', 'Lun ch', 'Dinner', 'Snacks \u{1F36A}', 'Frühstück', '朝ごはん']);

  assert.equal((await put('foodCategories', ['Dai\u0000ry', { name: 'Fr\u0007uit', label: '\u{1F34E}\u0000' }, { name: 'Veg', label: '🥦' }])).status, 200);
  assert.deepEqual(stored(u, 'foodCategories'), ['Dairy', { name: 'Fruit', label: '\u{1F34E}' }, { name: 'Veg', label: '🥦' }]);

  assert.equal((await put('customUnits', [{ abbr: 'sc\u0000p', full: 'sco\nop' }, { abbr: 'tbsp', full: 'tablespoon' }])).status, 200);
  assert.deepEqual(stored(u, 'customUnits'), [{ abbr: 'scp', full: 'scoop' }, { abbr: 'tbsp', full: 'tablespoon' }]);

  assert.equal((await put('customNutriments', [{ id: 'custom_om\u0000ega', label: 'Om\u0000ega', unit: 'g' }])).status, 200);
  assert.deepEqual(stored(u, 'customNutriments'), [{ id: 'custom_omega', label: 'Omega', unit: 'g' }]);
});

test('a clean value is stored exactly as sent, and settings that are not names keep their newlines', async t => {
  if (skip(t)) return;
  const u = newUser();
  const names = ['Breakfast', 'Lunch', 'Dinner', 'Snacks \u{1F36A}'];
  await call(u, 'PUT', '/api/settings', { key: 'mealNames', value: names });
  assert.deepEqual(stored(u, 'mealNames'), names);
  const prompt = 'Line one\nLine\ttwo\u0000';
  assert.equal((await call(u, 'PUT', '/api/settings', { key: 'aiSystemPrompt', value: prompt })).status, 200);
  assert.equal(stored(u, 'aiSystemPrompt'), prompt, 'only the four name settings are cleaned');
  assert.equal((await call(u, 'PUT', '/api/settings', { key: 'mealNames', value: 'not a list' })).status, 200, 'a value of another shape is left to the client, as before');
  assert.equal(stored(u, 'mealNames'), 'not a list');
});

test('a name that is nothing but control characters is refused, and nothing of the request is stored', async t => {
  if (skip(t)) return;
  const u = newUser();
  await call(u, 'PUT', '/api/settings', { key: 'mealNames', value: ['Keep'] });
  const refused = await call(u, 'PUT', '/api/settings', { key: 'mealNames', value: ['Fine', '\u0000\u0001'] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /mealNames/);
  assert.deepEqual(stored(u, 'mealNames'), ['Keep'], 'the earlier value stands');
});

test('PUT /api/settings/bulk cleans the same way, and a refused name refuses the whole request', async t => {
  if (skip(t)) return;
  const u = newUser();
  const ok = await call(u, 'PUT', '/api/settings/bulk', { settings: { mealNames: ['A\u0000', 'B'], language: 'de', energyUnit: 'kcal' } });
  assert.deepEqual(ok, { status: 200, body: { ok: true, written: 3, skipped: 0 } });
  assert.deepEqual(stored(u, 'mealNames'), ['A', 'B']);
  assert.equal(stored(u, 'language'), 'de');

  const refused = await call(u, 'PUT', '/api/settings/bulk', { settings: { language: 'fr', customUnits: [{ abbr: '\u0000', full: 'x' }] } });
  assert.equal(refused.status, 400);
  assert.equal(stored(u, 'language'), 'de', 'nothing before the bad entry was written either');
});
