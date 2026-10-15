/**
 * Home services on the server's own network (lib/outbound-policy.js
 * homeServiceAllowed, lib/service-origins.js).
 *
 * Mealie, CookTrace and push services usually live next to the server, so
 * they may reach private addresses — but only for an admin, a single-user
 * install, or everyone when the owner sets ALLOW_PRIVATE_SERVICE_URLS.
 * Otherwise any signed-in account (a friend behind a hub, say) could save a
 * "Mealie" address of 127.0.0.1 or the router and have the server fetch it.
 *
 * Every case runs the real routes against a server on 127.0.0.1 and counts
 * what reached it.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const OPT_IN = 'ALLOW_PRIVATE_SERVICE_URLS';
const req = createRequire(new URL('../server/package.json', import.meta.url));
let sqlite = true;
try { req('better-sqlite3'); } catch { sqlite = false; /* not built for this Node: the cases skip */ }

// A 1x1 PNG, so an image import that does reach the target gets a real image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let db = null, dir = null, server = null, target = null, base = null, home = null, mods = null;
const hits = [];
if (sqlite) {
  dir = mkdtempSync(join(tmpdir(), 'nt-home-svc-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.UPLOADS_PATH = join(dir, 'uploads');
  delete process.env[OPT_IN];
  delete process.env.ALLOW_PRIVATE_IMAGE_URLS;
  db = (await import('../server/db.js')).default;
  const policy = await import('../server/lib/outbound-policy.js');
  const origins = await import('../server/lib/service-origins.js');
  const push = await import('../server/lib/push-notify.js');
  mods = { policy, origins, push };

  const express = req('express');
  const app = express();
  app.use(express.json());
  // Stand-in for the session: the account named by a header. x-test-role
  // plays a session token signed before a demotion (the JWT keeps the old role).
  app.use((r, _res, next) => {
    const id = r.get('x-test-user');
    const row = id ? db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(Number(id)) : null;
    r.user = row ? { ...row, role: r.get('x-test-role') || row.role } : null;
    next();
  });
  app.use('/api/mealie', (await import('../server/routes/mealie.js')).default);
  app.use('/api/cooktrace', (await import('../server/routes/cooktrace.js')).default);
  app.use('/api/settings', (await import('../server/routes/settings.js')).default);
  app.use('/api/foods', (await import('../server/routes/foods.js')).default);
  app.use('/api/meals', (await import('../server/routes/meals.js')).default);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  target = http.createServer((r, res) => {
    hits.push(r.url);
    if (r.url.endsWith('.png')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  home = `http://127.0.0.1:${target.address().port}`;
}
test.after(() => {
  server?.close(); target?.close();
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const skip = t => { if (!db) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };

const post = async (path, user, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user.id) } : {}), ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const reached = path => hits.filter(h => h === path || h.startsWith(path + '?')).length;
const withOptIn = async fn => {
  process.env[OPT_IN] = '1';
  try { return await fn(); } finally { delete process.env[OPT_IN]; }
};

const SETTINGS = () => ({
  mealieBaseUrl: home, cooktraceBaseUrl: home,
  notifPushService: 'gotify', gotifyUrl: home, gotifyToken: 'tok', notifTest: true,
});
function account(username, role) {
  const id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'x', role).lastInsertRowid);
  const put = db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(SETTINGS())) put.run(id, k, JSON.stringify(v));
  return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
}

// Runs first, while there are no accounts.
test('a single-user install is the owner: home services are allowed', (t) => {
  if (skip(t)) return;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(mods.policy.homeServiceAllowed(null), true);
  assert.equal(mods.policy.homeServiceAllowed(0), true, 'the pollers\' single-user owner');
});

let admin = null, friend = null;
test('with accounts: an admin may, anyone else only with the opt-in', async (t) => {
  if (skip(t)) return;
  admin = account('owner', 'admin');
  friend = account('friend', 'user');
  assert.equal(mods.policy.homeServiceAllowed(admin.id), true);
  assert.equal(mods.policy.homeServiceAllowed(friend.id), false);
  assert.equal(mods.policy.homeServiceAllowed(null), false);
  assert.equal(mods.policy.homeServiceAllowed(999999), false, 'an account that no longer exists');
  await withOptIn(() => assert.equal(mods.policy.homeServiceAllowed(friend.id), true));
});

test('the role is the database\'s, not a session signed before a demotion', async (t) => {
  if (skip(t)) return;
  const before = reached('/api/recipes');
  const stale = await post('/api/mealie/proxy', friend, { baseUrl: home, token: 't', path: '/api/recipes' }, { 'x-test-role': 'admin' });
  assert.equal(stale.status, 503);
  assert.equal(reached('/api/recipes'), before);
});

for (const [name, path, apiPath] of [['Mealie', '/api/mealie/proxy', '/api/recipes'], ['CookTrace', '/api/cooktrace/proxy', '/api/v1/me']]) {
  test(`${name} proxy: a friend's saved private address is refused, an admin's is fetched`, async (t) => {
    if (skip(t)) return;
    const body = { baseUrl: home, token: 't', path: apiPath };
    const before = reached(apiPath);
    const refused = await post(path, friend, body);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error, `Could not reach ${name}`, 'the same words as an unreachable service');
    assert.doesNotMatch(refused.body.error, new RegExp(`${OPT_IN}|[Pp]rivate|loopback`), 'nothing about why');
    assert.equal(reached(apiPath), before, 'nothing reached the private address');

    assert.equal((await post(path, admin, body)).status, 200);
    assert.equal(reached(apiPath), before + 1);
    await withOptIn(async () => assert.equal((await post(path, friend, body)).status, 200));
    assert.equal(reached(apiPath), before + 2);
  });
}

test('push test: a friend cannot reach a private push server, an admin can', async (t) => {
  if (skip(t)) return;
  const before = reached('/message');
  const refused = await post('/api/settings/push-test', friend, { service: 'gotify' });
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error, 'gotify: could not reach the service');
  assert.equal(reached('/message'), before);
  assert.equal((await post('/api/settings/push-test', admin, { service: 'gotify' })).status, 200);
  assert.equal(reached('/message'), before + 1);
});

// A refusal a non-admin could tell apart from a failed lookup would map the
// server's network for them: which names exist, which resolve privately.
test('push test: a non-admin cannot tell a private address from a name that does not resolve', async (t) => {
  if (skip(t)) return;
  const setUrl = (user, url) => db.prepare(
    'INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
  ).run(user.id, 'gotifyUrl', JSON.stringify(url));
  const errorFor = async (user, url) => {
    setUrl(user, url);
    return (await post('/api/settings/push-test', user, { service: 'gotify' })).body.error;
  };
  const logged = [];
  const { logger } = await import('../server/logger.js');
  const warn = logger.warn;
  logger.warn = (...a) => logged.push(a.join(' '));
  try {
    const answers = new Set([
      await errorFor(friend, home),                          // resolves to loopback
      await errorFor(friend, 'http://localhost:9/'),         // resolves to loopback by name
      await errorFor(friend, 'http://nothing-here.invalid/'), // does not resolve
      await errorFor(friend, 'http://169.254.169.254/'),     // cloud metadata
    ]);
    assert.deepEqual([...answers], ['gotify: could not reach the service']);
    assert.ok(logged.some(l => /Private \/ loopback/.test(l) && l.includes(`user ${friend.id}`)), 'the detail is in the log');
    assert.ok(logged.some(l => /Could not resolve host/.test(l)));

    // An admin can act on the detail (which variable to set), so gets it.
    assert.match(await errorFor(admin, 'http://169.254.169.254/'), /^gotify: Link-local \/ cloud-metadata/);
    assert.match(await errorFor(admin, 'http://nothing-here.invalid/'), /^gotify: Could not resolve host$/, 'as before');
  } finally {
    logger.warn = warn;
    setUrl(friend, home);
    setUrl(admin, home);
  }
});

test('the SSRF refusal follows the database role, not a session signed before a promotion or demotion', async (t) => {
  if (skip(t)) return;
  db.prepare(`INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'gotifyUrl', ?)`)
    .run(friend.id, JSON.stringify('http://169.254.169.254/'));
  try {
    const stale = await post('/api/settings/push-test', friend, { service: 'gotify' }, { 'x-test-role': 'admin' });
    assert.equal(stale.body.error, 'gotify: could not reach the service', 'a token that says admin is not enough');
  } finally {
    db.prepare(`INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'gotifyUrl', ?)`).run(friend.id, JSON.stringify(home));
  }
});

test('background push follows the account\'s own role', async (t) => {
  if (skip(t)) return;
  const before = reached('/message');
  await mods.push.pushNotify(friend.id, 'notifTest', 'Title', 'Body');
  assert.equal(reached('/message'), before, 'a friend\'s push to a private address is dropped');
  await mods.push.pushNotify(admin.id, 'notifTest', 'Title', 'Body');
  assert.equal(reached('/message'), before + 1);
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(friend.id);
  try {
    await mods.push.pushNotify(friend.id, 'notifTest', 'Title', 'Body');
    assert.equal(reached('/message'), before + 2, 'read when the push goes out, not cached');
  } finally {
    db.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(friend.id);
  }
});

test('trustedServiceOrigins: the saved address only for accounts that may reach home services', async (t) => {
  if (skip(t)) return;
  const { trustedServiceOrigins } = mods.origins;
  assert.deepEqual(trustedServiceOrigins(admin.id, 'cooktrace'), [home]);
  assert.deepEqual(trustedServiceOrigins(admin.id, 'mealie'), [home]);
  assert.deepEqual(trustedServiceOrigins(admin.id, 'elsewhere'), []);
  assert.deepEqual(trustedServiceOrigins(admin.id, null), []);
  assert.deepEqual(trustedServiceOrigins(friend.id, 'cooktrace'), []);
  await withOptIn(() => assert.deepEqual(trustedServiceOrigins(friend.id, 'cooktrace'), [home]));
});

for (const kind of ['foods', 'meals']) {
  test(`importing ${kind} from CookTrace: a friend's image on a private address is not fetched`, async (t) => {
    if (skip(t)) return;
    const img = n => `/uploads/${kind}-${n}.png`;
    const make = (user, n) => post(`/api/${kind}`, user, {
      name: `${kind} ${n}`, source_app: 'cooktrace', source_external_id: `${kind}-${n}`, img_url: home + img(n),
    });
    assert.ok((await make(friend, 'friend')).status < 300);
    assert.equal(reached(img('friend')), 0, 'the saved CookTrace address does not open the server\'s network');
    await withOptIn(async () => assert.ok((await make(friend, 'opted-in')).status < 300));
    assert.equal(reached(img('opted-in')), 1, 'the opt-in lets the import pull its picture');
    assert.ok((await make(admin, 'admin')).status < 300);
    assert.equal(reached(img('admin')), 1);
  });
}
