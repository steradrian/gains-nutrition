/**
 * The routes the hub lets the browser reach answer for the caller's own rows
 * alone, and a row that is not the caller's is a 404 exactly like one that is
 * not there. A 403 for another account's row (or a 200 for a shared one) told
 * anyone which ids exist and which are private.
 *
 *   GET    /api/meals/:id            POST /api/foods/:id/used   POST /api/meals/:id/used
 *   PUT    /api/foods/:id            DELETE /api/foods/:id
 *   PUT    /api/meals/:id            DELETE /api/meals/:id
 *   POST   /api/fasts/:id/end        PATCH  /api/fasts/:id      DELETE /api/fasts/:id
 *
 * Also here: a food or meal saved again with the source stamp of one that was
 * deleted is a new row, not a UNIQUE error (idx_foods_source_ext and
 * idx_meals_source_ext leave deleted rows out). Single-user mode, where the
 * owner is "no user", is in owner-scope-single-user.test.js.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { bootInProcess } from './fixtures/in-process-server.mjs';

const env = await bootInProcess({
  prefix: 'nt-owner-scope',
  routes: { '/api/foods': 'foods.js', '/api/meals': 'meals.js', '/api/fasts': 'fasts.js' },
});
const db = env?.db;
const skip = t => { if (!env) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };
const { newUser, call } = env ?? {};

const NOT_FOUND = { status: 404, body: { error: 'Not found' } };

// 'group' is the visibility other accounts can read (lib/sharing.js).
async function make(owner, route, name, visibility) {
  const body = route === '/api/foods' ? { name, nutrition: { calories: 100 }, visibility } : { name, items: [], nutrition: {}, visibility };
  const r = await call(owner, 'POST', route, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

test('GET /api/meals/:id: the owner reads it; another account gets the same 404 for a shared meal, a private one and one that is not there', async t => {
  if (skip(t)) return;
  const owner = newUser(), other = newUser();
  const shared = await make(owner, '/api/meals', 'Shared bowl', 'group');
  const priv = await make(owner, '/api/meals', 'Private bowl', 'private');

  const mine = await call(owner, 'GET', `/api/meals/${priv}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.name, 'Private bowl');

  for (const id of [shared, priv, 999999]) {
    assert.deepEqual(await call(other, 'GET', `/api/meals/${id}`), NOT_FOUND, `meal ${id}`);
  }
});

test('POST /api/foods/:id/used: the owner bumps it, nobody else does, and every other food is the same 404', async t => {
  if (skip(t)) return;
  const owner = newUser(), other = newUser();
  const shared = await make(owner, '/api/foods', 'Shared oats', 'group');
  const priv = await make(owner, '/api/foods', 'Private oats', 'private');
  const row = id => db.prepare('SELECT usage_count, last_used_at, updated_at FROM foods WHERE id = ?').get(id);
  db.prepare("UPDATE foods SET updated_at = '2020-01-01 00:00:00'").run();

  assert.deepEqual(await call(owner, 'POST', `/api/foods/${shared}/used`, { date: '2026-10-01' }), { status: 200, body: { ok: true } });
  assert.equal(row(shared).usage_count, 1);
  assert.equal(row(shared).last_used_at, '2026-10-01');

  const before = { shared: row(shared), priv: row(priv) };
  for (const id of [shared, priv, 999999]) {
    assert.deepEqual(await call(other, 'POST', `/api/foods/${id}/used`, { date: '2026-10-02' }), NOT_FOUND, `food ${id}`);
  }
  assert.deepEqual(row(shared), before.shared, "another account's call changed nothing, shared or not");
  assert.deepEqual(row(priv), before.priv);

  assert.equal((await call(owner, 'POST', `/api/foods/${priv}/used`, { date: 'not-a-date' })).status, 200);
  assert.equal(row(priv).usage_count, 1);
  assert.equal(row(priv).last_used_at, new Date().toISOString().slice(0, 10), 'an invalid date still falls back to today');
});

for (const [route, table, edit] of [['/api/foods', 'foods', { name: 'Hijacked' }], ['/api/meals', 'meals', { name: 'Hijacked' }]]) {
  test(`PUT and DELETE ${route}/:id: another account's row is a 404, like a missing one, and is left alone`, async t => {
    if (skip(t)) return;
    const owner = newUser(), other = newUser();
    const shared = await make(owner, route, 'Mine', 'group');
    const priv = await make(owner, route, 'Mine too', 'private');
    const row = id => db.prepare(`SELECT name, deleted_at, updated_at FROM ${table} WHERE id = ?`).get(id);
    db.prepare(`UPDATE ${table} SET updated_at = '2020-01-01 00:00:00'`).run();
    const before = { shared: row(shared), priv: row(priv) };

    for (const id of [shared, priv, 999999]) {
      assert.deepEqual(await call(other, 'PUT', `${route}/${id}`, edit), NOT_FOUND, `PUT ${id}`);
      assert.deepEqual(await call(other, 'DELETE', `${route}/${id}`), NOT_FOUND, `DELETE ${id}`);
    }
    assert.deepEqual(row(shared), before.shared);
    assert.deepEqual(row(priv), before.priv);

    assert.equal((await call(owner, 'PUT', `${route}/${priv}`, { name: 'Renamed' })).status, 200);
    assert.equal(row(priv).name, 'Renamed');
    assert.equal((await call(owner, 'DELETE', `${route}/${priv}`)).status, 200);
    assert.notEqual(row(priv).deleted_at, null);
  });
}

test('fasts: end, edit and delete of another account\'s fast are a 404, like a missing one, and leave it alone', async t => {
  if (skip(t)) return;
  const owner = newUser(), other = newUser();
  const started = await call(owner, 'POST', '/api/fasts/start', { goal_hours: 16 });
  assert.equal(started.status, 201);
  const id = started.body.id;
  const fast = () => db.prepare('SELECT end_at, notes, deleted_at FROM fasts WHERE id = ?').get(id);
  const before = fast();

  const missing = { status: 404, body: { error: 'Fast not found' } };
  for (const target of [id, 999999]) {
    assert.deepEqual(await call(other, 'POST', `/api/fasts/${target}/end`, {}), missing, `end ${target}`);
    assert.deepEqual(await call(other, 'PATCH', `/api/fasts/${target}`, { notes: 'mine now' }), missing, `patch ${target}`);
    assert.deepEqual(await call(other, 'DELETE', `/api/fasts/${target}`), missing, `delete ${target}`);
  }
  assert.deepEqual(fast(), before);

  assert.equal((await call(owner, 'PATCH', `/api/fasts/${id}`, { notes: 'felt fine' })).status, 200);
  assert.equal((await call(owner, 'POST', `/api/fasts/${id}/end`, {})).status, 200);
  assert.notEqual(fast().end_at, null);
  assert.equal((await call(owner, 'DELETE', `/api/fasts/${id}`)).status, 200);
  assert.notEqual(fast().deleted_at, null);
});

// ── A source stamp on a deleted row ───────────────────────────────────────
for (const [route, table, body] of [
  ['/api/foods', 'foods', { name: 'Pantry oats', nutrition: { calories: 380 } }],
  ['/api/meals', 'meals', { name: 'Pulled recipe', items: [], nutrition: { calories: 300 } }],
]) {
  test(`${route}: saving again with the source stamp of a deleted ${table.slice(0, -1)} makes a new one, not a UNIQUE error`, async t => {
    if (skip(t)) return;
    const u = newUser();
    const send = () => call(u, 'POST', route, { ...body, client_key: 'stamp-1', source_app: 'cooktrace', source_external_id: 'pantry:42' });
    const first = await send();
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const again = await send();
    assert.equal(again.status, 200, 'a live row with the stamp is updated, not duplicated');
    assert.equal(again.body.id, first.body.id);

    assert.equal((await call(u, 'DELETE', `${route}/${first.body.id}`)).status, 200);
    const fresh = await send();
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    assert.notEqual(fresh.body.id, first.body.id);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id = ? AND source_external_id = 'pantry:42'`).get(u.id).n, 2, 'the deleted row stays, soft-deleted');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id = ? AND source_external_id = 'pantry:42' AND deleted_at IS NULL`).get(u.id).n, 1);

    const upsert = await send();
    assert.equal(upsert.status, 200);
    assert.equal(upsert.body.id, fresh.body.id, 'and the live one is the row the stamp finds now');
  });
}

test('the stamp stays unique among live rows, per account, and the index leaves deleted rows out', t => {
  if (skip(t)) return;
  const a = newUser(), b = newUser();
  for (const table of ['foods', 'meals']) {
    const add = (user, ext, deleted) => db.prepare(
      `INSERT INTO ${table} (user_id, name, source_app, source_external_id, deleted_at) VALUES (?, 'x', 'cooktrace', ?, ${deleted ? "datetime('now')" : 'NULL'})`
    ).run(user.id, ext);
    add(a, 'e1', false);
    assert.throws(() => add(a, 'e1', false), /UNIQUE/, `${table}: two live rows with one stamp`);
    assert.doesNotThrow(() => add(b, 'e1', false), `${table}: another account's stamp is its own`);
    assert.doesNotThrow(() => add(a, 'e1', true), `${table}: a deleted row does not hold the stamp`);
    assert.doesNotThrow(() => add(a, 'e1', true), `${table}: nor do two`);
    assert.match(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_${table}_source_ext'`).get().sql, /deleted_at IS NULL/);
  }
});

test('a database made with the old indexes gets the new ones on start, and keeps its rows', t => {
  if (skip(t)) return;
  const dbPath = db.name.replace(/test\.db$/, 'migrate.db');
  const script = `
    import { createRequire } from 'node:module';
    const Database = createRequire(${JSON.stringify(new URL('../server/package.json', import.meta.url).href)})('better-sqlite3');
    const phase = process.argv[1];
    if (phase === 'old') {
      await import(${JSON.stringify(new URL('../server/db.js', import.meta.url).href)});
      const raw = new Database(process.env.DB_PATH);
      raw.exec("INSERT INTO users (id, username, password_hash, role) VALUES (7, 'old', 'x', 'user')");
      for (const [t, i] of [['foods', 'idx_foods_source_ext'], ['meals', 'idx_meals_source_ext']]) {
        raw.exec('DROP INDEX ' + i);
        raw.exec('CREATE UNIQUE INDEX ' + i + ' ON ' + t + '(user_id, source_app, source_external_id) WHERE source_app IS NOT NULL AND source_external_id IS NOT NULL');
        raw.exec("INSERT INTO " + t + " (user_id, name, source_app, source_external_id) VALUES (7, 'kept', 'cooktrace', 'e1')");
      }
      raw.close();
    } else {
      const db = (await import(${JSON.stringify(new URL('../server/db.js', import.meta.url).href)})).default;
      console.log(JSON.stringify({
        sql: db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'idx_%_source_ext' ORDER BY name").all(),
        kept: db.prepare("SELECT (SELECT COUNT(*) FROM foods WHERE name = 'kept') f, (SELECT COUNT(*) FROM meals WHERE name = 'kept') m").get(),
      }));
    }`;
  const run = phase => spawnSync(process.execPath, ['--input-type=module', '-e', script, phase], {
    env: { ...process.env, DB_PATH: dbPath, UPLOADS_PATH: dbPath + '-uploads', JWT_SECRET: 'migrate-test-secret-0123456789abcdef' },
    encoding: 'utf8',
  });
  const old = run('old');
  assert.equal(old.status, 0, old.stderr);
  const after = run('new');
  assert.equal(after.status, 0, after.stderr);
  const { sql, kept } = JSON.parse(after.stdout.trim().split('\n').at(-1));
  assert.deepEqual(sql.map(s => s.name), ['idx_foods_source_ext', 'idx_meals_source_ext']);
  for (const s of sql) assert.match(s.sql, /deleted_at IS NULL/, `${s.name} is the new definition`);
  assert.deepEqual(kept, { f: 1, m: 1 }, 'no row was touched');
});
