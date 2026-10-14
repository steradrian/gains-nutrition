/**
 * Hub tokens (server/lib/hub-auth.js, HUB_JWKS + HUB_ISSUER).
 *
 * A hub in front of NutriTrace signs every forwarded request with a 60 s
 * ES256 token. These cases run the real middleware and routes on a scratch
 * database:
 *   - a valid token makes the account once and reuses it; the role is the
 *     database's, never the token's;
 *   - every kind of bad hub token is a 401 even with a good cookie on the
 *     same request (no fall-through), whatever the Bearer scheme's case;
 *   - an empty users table behind a hub refuses requireAuth, requireAdmin
 *     and /register instead of turning into single-user mode; neither the
 *     first OIDC sign-in nor the startup repair makes anyone the owner;
 *   - a hub account never gets a local password from a request;
 *   - scope=sync reaches /api/v1 with exactly three scopes and its own rate
 *     limit, scope=user not at all;
 *   - a full backup round-trips the hub links;
 *   - with HUB_JWKS unset, everything is as upstream.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ISSUER = 'https://hub.test/hub';
const keyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const k1 = keyPair(), k2 = keyPair(), stranger = keyPair();
const jwk = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' });
const JWKS = JSON.stringify({ keys: [jwk(k1, 'k1'), jwk(k2, 'k2')] });

const hubOn = () => { process.env.HUB_JWKS = JWKS; process.env.HUB_ISSUER = ISSUER; };
const hubOff = () => { delete process.env.HUB_JWKS; delete process.env.HUB_ISSUER; };

let db = null, dir = null, server = null, base = null, mods = null;
const req = createRequire(new URL('../server/package.json', import.meta.url));
let sqlite = true;
try { req('better-sqlite3'); } catch { sqlite = false; /* not built for this Node: the cases skip */ }
if (sqlite) {
  dir = mkdtempSync(join(tmpdir(), 'nt-hub-auth-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.UPLOADS_PATH = join(dir, 'uploads');
  hubOn();
  db = (await import('../server/db.js')).default;
  const auth = await import('../server/middleware/auth.js');
  const { csrfProtect } = await import('../server/middleware/csrf.js');
  const bearer = await import('../server/middleware/bearer-auth.js');
  const hub = await import('../server/lib/hub-auth.js');
  const claim = await import('../server/lib/claim-anonymous-data.js');
  const oidc = await import('../server/routes/oidc.js');
  const oidcLib = await import('../server/lib/oidc.js');
  const { KNOWN_SCOPES } = await import('../server/lib/api-tokens.js');
  const { default: authRoutes } = await import('../server/routes/auth.js');
  const { default: apiV1Routes } = await import('../server/routes/api/v1/index.js');
  const { default: backupRoutes } = await import('../server/routes/full-backup.js');
  mods = { auth, bearer, hub, claim, oidc, oidcLib, csrfProtect, KNOWN_SCOPES };

  const express = req('express');
  const cookieParser = req('cookie-parser');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(auth.authenticate);
  app.use(csrfProtect);
  app.get('/api/whoami', auth.requireAuth, (r, res) => res.json({ user: r.user, via: r.authVia }));
  app.post('/api/whoami', auth.requireAuth, (r, res) => res.json({ user: r.user, via: r.authVia }));
  app.get('/api/admin-only', auth.requireAdmin, (r, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/v1', apiV1Routes);
  app.use('/api/full-backup', backupRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}
test.after(() => { server?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });
const skip = t => { if (!db) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };

// ── Tokens ────────────────────────────────────────────────────────────────
const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const claimsFor = (sub, extra = {}) => ({
  iss: ISSUER, aud: 'nutritrace', sub, name: 'Friend Name', scope: 'user', act: 'browser',
  iat: now(), exp: now() + 60, jti: crypto.randomBytes(16).toString('base64url'), ...extra,
});
function sign(claims, { kid = 'k1', key = k1.privateKey, header = {} } = {}) {
  const input = `${b64({ alg: 'ES256', kid, typ: 'JWT', ...header })}.${b64(claims)}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}
const tokenFor = (sub, extra) => sign(claimsFor(sub, extra));

const call = async (path, { token, cookie, method = 'GET', body, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = `nt_token=${cookie}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const linkCount = sub => db.prepare('SELECT COUNT(*) n FROM user_hub_links WHERE issuer = ? AND sub = ?').get(ISSUER, sub).n;
const localUser = (name, role = 'user') => {
  const id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(name, 'x', role).lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};

// ── Empty database behind a hub: fail closed ──────────────────────────────
// Runs first, while the users table is still empty.
test('hub mode, no users: requireAuth, requireAdmin and /register refuse', async (t) => {
  if (skip(t)) return;
  hubOn();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(mods.auth.userMgmtActive(), true, 'no single-user mode behind a hub');
  assert.equal((await call('/api/whoami')).status, 401);
  assert.equal((await call('/api/admin-only')).status, 403);
  const reg = await call('/api/auth/register', { method: 'POST', body: { username: 'first', password: 'Str0ng!Passw0rd#' } });
  assert.equal(reg.status, 403, 'the first /register no longer becomes admin');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0, 'nobody was created');
  const status = await call('/api/auth/status');
  assert.equal(status.body.setup_required, false);
});

test('hub mode: the first OIDC sign-in does not become admin', (t) => {
  if (skip(t)) return;
  const first = localUser('oidc-first');
  const result = () => ({ created: true, user: { id: first.id, username: first.username, role: 'user' } });
  const role = () => db.prepare('SELECT role FROM users WHERE id = ?').get(first.id).role;
  try {
    hubOn();
    const r = result();
    assert.equal(mods.oidc.bootstrapFirstOidcUser(r), false);
    assert.equal(r.user.role, 'user');
    assert.equal(role(), 'user');
    // The guard is what decides: the same sign-in without a hub is the admin.
    hubOff();
    assert.equal(mods.oidc.bootstrapFirstOidcUser(result()), true);
    assert.equal(role(), 'admin');
  } finally {
    hubOn();
    db.prepare('DELETE FROM users WHERE id = ?').run(first.id);
  }
});

// The row stays unowned until the link test claims it with --claim-anonymous.
const orphanFast = () => db.prepare(`SELECT user_id FROM fasts WHERE notes = 'single-user fast'`).get();
test('hub mode: startup does not hand single-user data to the only account', (t) => {
  if (skip(t)) return;
  hubOn();
  const only = localUser('first-friend');
  db.prepare(`INSERT INTO fasts (user_id, start_at, notes) VALUES (NULL, '2026-10-01T20:00', 'single-user fast')`).run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  const r = mods.claim.repairOrphanedData();
  assert.equal(r.hub, true);
  assert.equal(r.repaired, 0);
  assert.equal(orphanFast().user_id, null, 'still unowned');
  assert.notEqual(orphanFast().user_id, only.id);
});

test('hub mode: /register works for an admin and refuses everyone else', async (t) => {
  if (skip(t)) return;
  hubOn();
  const sub = 'og-registrar';
  assert.equal((await call('/api/whoami', { token: tokenFor(sub) })).status, 200);
  const body = { username: 'invited', password: 'Str0ng!Passw0rd#' };
  assert.equal((await call('/api/auth/register', { method: 'POST', token: tokenFor(sub), body })).status, 403, 'a plain hub user');
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = (SELECT user_id FROM user_hub_links WHERE sub = ?)`).run(sub);
  const ok = await call('/api/auth/register', { method: 'POST', token: tokenFor(sub), body });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'user');
});

// ── A valid token ─────────────────────────────────────────────────────────
test('a valid token makes the account once and reuses it', async (t) => {
  if (skip(t)) return;
  hubOn();
  const sub = 'og-friend-1';
  const first = await call('/api/whoami', { token: tokenFor(sub) });
  assert.equal(first.status, 200);
  assert.equal(first.body.via, 'hub');
  const again = await call('/api/whoami', { token: tokenFor(sub, { name: 'Renamed' }) });
  assert.equal(again.body.user.id, first.body.user.id);
  assert.equal(linkCount(sub), 1);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(first.body.user.id);
  assert.equal(row.role, 'user');
  assert.equal(row.password_hash, null, 'no usable password');
  assert.match(row.username, /^hub-[0-9a-f]{16}$/);
  assert.equal(row.full_name, 'Friend Name');
});

test('a key further down HUB_JWKS (rotation) is accepted', async (t) => {
  if (skip(t)) return;
  hubOn();
  const res = await call('/api/whoami', { token: sign(claimsFor('og-friend-1'), { kid: 'k2', key: k2.privateKey }) });
  assert.equal(res.status, 200);
});

test('the role comes from the database, never from the token', async (t) => {
  if (skip(t)) return;
  hubOn();
  const sub = 'og-role';
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub, { role: 'admin', admin: true }) })).status, 403);
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = (SELECT user_id FROM user_hub_links WHERE sub = ?)`).run(sub);
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub) })).status, 200);
  db.prepare(`UPDATE users SET role = 'user' WHERE id = (SELECT user_id FROM user_hub_links WHERE sub = ?)`).run(sub);
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub) })).status, 403, 'a demotion applies on the next request');
});

test('a hub user posts without a CSRF token, and a cookie beside it is not the session', async (t) => {
  if (skip(t)) return;
  hubOn();
  const cookieUser = localUser(`cookie-${crypto.randomUUID()}`);
  const cookie = mods.auth.signToken(cookieUser);
  // The cookie carries a CSRF value, so on its own a POST without the header is refused.
  assert.equal((await call('/api/whoami', { method: 'POST', cookie, body: {} })).status, 403);
  // A bearer that isn't the hub's leaves the cookie as the session: still checked.
  const foreign = sign({ ...claimsFor('x'), iss: 'https://proxy.test' }, { kid: 'proxy', key: stranger.privateKey });
  assert.equal((await call('/api/whoami', { method: 'POST', token: foreign, cookie, body: {} })).status, 403);
  // The hub token is the session (a header a page cannot set), not the cookie.
  const res = await call('/api/whoami', { method: 'POST', token: tokenFor('og-friend-1'), cookie, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.via, 'hub');
  assert.notEqual(res.body.user.id, cookieUser.id);
});

test('the Bearer scheme is case-insensitive: a bad hub token is refused however it is spelled', async (t) => {
  if (skip(t)) return;
  hubOn();
  const cookie = mods.auth.signToken(localUser(`cookie-${crypto.randomUUID()}`, 'admin'));
  for (const scheme of ['bearer', 'BEARER', 'bEaReR']) {
    const bad = await call('/api/whoami', { cookie, headers: { authorization: `${scheme} ${BAD['bad signature']()}` } });
    assert.equal(bad.status, 401, scheme);
    assert.equal(bad.body.code, 'hub_token_invalid', scheme);
    const good = await call('/api/whoami', { headers: { authorization: `${scheme}\t${tokenFor('og-friend-1')}` } });
    assert.equal(good.status, 200, scheme);
    assert.equal(good.body.via, 'hub', scheme);
  }
});

test('a hub account gets no local password: change, reset and forgot are refused', async (t) => {
  if (skip(t)) return;
  hubOn();
  const sub = 'og-password';
  const me = await call('/api/whoami', { token: tokenFor(sub) });
  const id = me.body.user.id;
  const hash = () => db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash;

  const change = await call('/api/auth/password', { method: 'PUT', token: tokenFor(sub), body: { new_password: 'Str0ng!Passw0rd#' } });
  assert.equal(change.status, 403);
  assert.equal(change.body.code, 'hub_managed');
  assert.equal(hash(), null);

  // A reset link issued before the account was linked.
  db.prepare(`INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ('pre-link', ?, ?)`)
    .run(id, new Date(Date.now() + 3600_000).toISOString());
  const reset = await call('/api/auth/reset-password', { method: 'POST', body: { token: 'pre-link', password: 'Str0ng!Passw0rd#' } });
  assert.equal(reset.status, 403);
  assert.equal(hash(), null);

  // The profile email is whatever the person typed; no reset link goes there.
  db.prepare(`UPDATE users SET email = 'friend@example.test' WHERE id = ?`).run(id);
  db.prepare(`INSERT INTO app_config (key, value) VALUES ('smtp_host', '127.0.0.1'), ('smtp_port', '1')`).run();
  try {
    const forgot = await call('/api/auth/forgot-password', { method: 'POST', body: { email: 'friend@example.test' } });
    assert.equal(forgot.status, 200, 'the same answer as an unknown address');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM password_reset_tokens WHERE user_id = ? AND used = 0 AND token != 'pre-link'`).get(id).n, 0);
  } finally {
    db.prepare(`DELETE FROM app_config WHERE key IN ('smtp_host', 'smtp_port')`).run();
  }

  // Nor from an admin, who behind a hub is a hub session too.
  const adminSub = 'og-password-admin';
  assert.equal((await call('/api/whoami', { token: tokenFor(adminSub) })).status, 200);
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = (SELECT user_id FROM user_hub_links WHERE sub = ?)`).run(adminSub);
  const byAdmin = await call(`/api/auth/users/${id}/password`, { method: 'PUT', token: tokenFor(adminSub), body: { new_password: 'Str0ng!Passw0rd#' } });
  assert.equal(byAdmin.status, 403);
  assert.equal(byAdmin.body.code, 'hub_managed');
  assert.equal(hash(), null);
});

test('a linked account that already had a password may rotate it (with the current one)', async (t) => {
  if (skip(t)) return;
  hubOn();
  const bcrypt = req('bcryptjs');
  const sub = 'og-rotate';
  const id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run('rotating-owner', bcrypt.hashSync('Old!Passw0rd#1', 4), 'user').lastInsertRowid);
  mods.hub.linkHubUser({ userId: id, issuer: ISSUER, sub });
  const wrong = await call('/api/auth/password', { method: 'PUT', token: tokenFor(sub), body: { current_password: 'nope', new_password: 'New!Passw0rd#2' } });
  assert.equal(wrong.status, 401);
  const ok = await call('/api/auth/password', { method: 'PUT', token: tokenFor(sub), body: { current_password: 'Old!Passw0rd#1', new_password: 'New!Passw0rd#2' } });
  assert.equal(ok.status, 200);
});

test('a hub account cannot be linked to an OIDC identity, by hand or by a typed email', (t) => {
  if (skip(t)) return;
  hubOn();
  const id = db.prepare('SELECT user_id FROM user_hub_links WHERE sub = ?').get('og-friend-1').user_id;
  const { linkUser, resolveUser } = mods.oidcLib;
  assert.throws(() => linkUser(id, 1, 'idp-sub-1', true), /signs in through the hub/);
  db.prepare(`UPDATE users SET email = 'typed@example.test' WHERE id = ?`).run(id);
  const provider = { id: 1, auto_link_verified_email: 1, auto_register_new_users: 0 };
  assert.throws(() => resolveUser(provider, { sub: 'idp-sub-2', email: 'typed@example.test', email_verified: true }), /signs in through the hub/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_oidc_links WHERE user_id = ?').get(id).n, 0);
});

test('a hub token inside a malformed Authorization header is refused, not left to the cookie', async (t) => {
  if (skip(t)) return;
  hubOn();
  const cookie = mods.auth.signToken(localUser(`cookie-${crypto.randomUUID()}`, 'admin'));
  const tok = tokenFor('og-friend-1');
  for (const authorization of [`Bearer ${tok},`, `Bearer ${tok} x`, `Token ${tok}`, `Bearer, ${tok}`]) {
    const res = await call('/api/whoami', { cookie, headers: { authorization } });
    assert.equal(res.status, 401, authorization.replace(tok, '<hub>'));
    assert.equal(res.body.code, 'hub_token_invalid');
  }
});

test('looking for a hub token in a 16 KB header is linear (it runs before sign-in)', async (t) => {
  if (skip(t)) return;
  hubOn();
  for (const header of [`Bearer ${'A'.repeat(16300)}`, `Bearer ${'A.'.repeat(8150)}`, `x ${'A-'.repeat(8150)}.`]) {
    const started = performance.now();
    assert.equal(mods.hub.headerCarriesHubToken(header), false);
    assert.ok(performance.now() - started < 50, `${Math.round(performance.now() - started)} ms`);
  }
  const res = await call('/api/whoami', { headers: { authorization: `Bearer ${'A'.repeat(16000)}` } });
  assert.equal(res.status, 401);
});

test('csrfProtect lets a hub session through even when its user carries a csrf value', (t) => {
  if (skip(t)) return;
  hubOn();
  let passed = false;
  const res = { status() { return this; }, json() { return this; } };
  mods.csrfProtect({ method: 'POST', path: '/api/whoami', authVia: 'hub', user: { id: 1, csrf: 'x' }, headers: {} }, res, () => { passed = true; });
  assert.ok(passed);
});

// ── Bad tokens: 401, never the cookie ─────────────────────────────────────
const hmac = (claims) => {
  const input = `${b64({ alg: 'HS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
  const secret = JSON.stringify(jwk(k1, 'k1'));
  return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
};
const BAD = {
  'expired':                  () => tokenFor('og-bad', { iat: now() - 90, exp: now() - 30 }),
  'expiring this second':     () => tokenFor('og-bad', { iat: now() - 60, exp: now() }),
  'wrong aud':                () => tokenFor('og-bad', { aud: 'opengym-sync' }),
  'aud as an array':          () => tokenFor('og-bad', { aud: ['nutritrace'] }),
  'wrong iss':                () => tokenFor('og-bad', { iss: 'https://evil.test/hub' }),
  'alg HS256':                () => hmac(claimsFor('og-bad')),
  'alg none':                 () => `${b64({ alg: 'none', kid: 'k1' })}.${b64(claimsFor('og-bad'))}.`,
  'alg ES384 header':         () => sign(claimsFor('og-bad'), { header: { alg: 'ES384' } }),
  'unknown kid':              () => sign(claimsFor('og-bad'), { kid: 'retired', key: stranger.privateKey }),
  'no kid':                   () => sign(claimsFor('og-bad'), { header: { kid: undefined } }),
  'bad signature':            () => sign(claimsFor('og-bad'), { kid: 'k1', key: stranger.privateKey }),
  'tampered payload':         () => { const [h, , s] = tokenFor('og-bad').split('.'); return `${h}.${b64(claimsFor('og-other'))}.${s}`; },
  'lifetime over 60 s':       () => tokenFor('og-bad', { iat: now(), exp: now() + 61 }),
  'iat 40 s in the future':   () => tokenFor('og-bad', { iat: now() + 40, exp: now() + 80 }),
  'no sub':                   () => tokenFor(''),
  'unknown scope':            () => tokenFor('og-bad', { scope: 'admin' }),
  'crit header':              () => sign(claimsFor('og-bad'), { header: { crit: ['exp'] } }),
};

for (const [name, make] of Object.entries(BAD)) {
  test(`hub token, ${name}: 401 and the cookie is not used`, async (t) => {
    if (skip(t)) return;
    hubOn();
    const cookieUser = localUser(`cookie-${crypto.randomUUID()}`, 'admin');
    const cookie = mods.auth.signToken(cookieUser);
    assert.equal((await call('/api/whoami', { cookie })).status, 200, 'the cookie alone signs in');
    const res = await call('/api/whoami', { token: make(), cookie });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'hub_token_invalid');
    // Even on routes that do not require a session.
    assert.equal((await call('/api/auth/me', { token: make(), cookie })).status, 401);
    assert.equal(linkCount('og-bad'), 0, 'no account is made');
  });
}

test('iat up to 30 s ahead (clock skew) is accepted', async (t) => {
  if (skip(t)) return;
  hubOn();
  assert.equal((await call('/api/whoami', { token: tokenFor('og-skew', { iat: now() + 25, exp: now() + 60 }) })).status, 200);
});

test("a bearer that isn't the hub's is still left to the cookie (upstream)", async (t) => {
  if (skip(t)) return;
  hubOn();
  const cookieUser = localUser(`cookie-${crypto.randomUUID()}`);
  const foreign = sign({ ...claimsFor('x'), iss: 'https://proxy.test' }, { kid: 'proxy', key: stranger.privateKey });
  const res = await call('/api/whoami', { token: foreign, cookie: mods.auth.signToken(cookieUser) });
  assert.equal(res.status, 200);
  assert.equal(res.body.via, 'cookie');
  assert.equal(res.body.user.id, cookieUser.id);
});

// ── /api/v1 ───────────────────────────────────────────────────────────────
test('scope=sync reaches /api/v1 with exactly the three sync scopes', async (t) => {
  if (skip(t)) return;
  hubOn();
  const sync = () => tokenFor('og-sync', { scope: 'sync', act: 'bridge' });
  const posted = await call('/api/v1/activity', { method: 'POST', token: sync(), body: { date: '2026-10-14', name: 'Run', kcal: 300, external_id: 'og:1' } });
  assert.ok(posted.status >= 200 && posted.status < 300, `activity: ${posted.status}`);
  const userId = db.prepare('SELECT user_id FROM user_hub_links WHERE sub = ?').get('og-sync').user_id;
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM activity_log WHERE user_id = ? AND source = 'external:og:1'`).get(userId).n, 1);

  const measured = await call('/api/v1/body-measurements', { method: 'POST', token: sync(), body: {} });
  assert.notEqual(measured.status, 401);
  assert.notEqual(measured.status, 403);

  const foods = await call('/api/v1/foods', { token: sync() });
  assert.equal(foods.status, 403);
  assert.equal(foods.body.code, 'auth_scope');
  const workouts = await call('/api/v1/workouts', { method: 'POST', token: sync(), body: {} });
  assert.equal(workouts.status, 403);
});

test('requireScope: a sync token holds write:activity, read:body-stats, write:body-measurements and nothing else', (t) => {
  if (skip(t)) return;
  const user = { id: 1, username: 'u', full_name: null, role: 'admin' };
  const req = { hub: { scope: 'sync', user }, get: () => '' };
  const res = { headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  mods.bearer.bearerAuth(req, res, () => { passed = true; });
  assert.ok(passed);
  assert.deepEqual(req.apiToken.scopes, ['write:activity', 'read:body-stats', 'write:body-measurements']);
  const holds = scope => { let ok = false; mods.bearer.requireScope(scope)(req, { ...res }, () => { ok = true; }); return ok; };
  for (const s of mods.hub.HUB_SYNC_SCOPES) assert.ok(holds(s), s);
  for (const s of mods.KNOWN_SCOPES) if (!mods.hub.HUB_SYNC_SCOPES.includes(s)) assert.ok(!holds(s), s);
});

test('a sync backfill has its own bucket and a higher limit than an API token', (t) => {
  if (skip(t)) return;
  const limit = mods.bearer.HUB_SYNC_RATE_LIMIT_PER_MIN;
  assert.ok(limit > 60, 'above the 60/min API-token default');
  const user = { id: 424242, username: 'u', full_name: null, role: 'user' };
  const admit = () => {
    const req = { hub: { scope: 'sync', user }, get: () => '' };
    const res = { headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    let passed = false;
    mods.bearer.bearerAuth(req, res, () => { passed = true; });
    return { passed, res };
  };
  for (let i = 1; i <= limit; i++) {
    const { passed, res } = admit();
    assert.ok(passed, `request ${i} of ${limit}`);
    assert.equal(res.headers['X-RateLimit-Limit'], String(limit));
  }
  const over = admit();
  assert.equal(over.passed, false);
  assert.equal(over.res.code, 429);
});

test('scope=user does not unlock /api/v1, and scope=sync reaches nothing else', async (t) => {
  if (skip(t)) return;
  hubOn();
  const user = await call('/api/v1/activity', { method: 'POST', token: tokenFor('og-friend-1'), body: { date: '2026-10-14', name: 'Run', kcal: 1 } });
  assert.equal(user.status, 401);
  assert.equal((await call('/api/v1/me', { token: tokenFor('og-friend-1') })).status, 401);
  const sync = await call('/api/whoami', { token: tokenFor('og-sync', { scope: 'sync' }) });
  assert.equal(sync.status, 401);
  assert.equal(sync.body.code, 'hub_token_scope');
  assert.equal((await call('/api/auth/me', { token: tokenFor('og-sync', { scope: 'sync' }) })).status, 401);
});

// ── Configuration ─────────────────────────────────────────────────────────
test('HUB_JWKS and HUB_ISSUER are checked, not trusted', (t) => {
  if (skip(t)) return;
  const { hubConfig } = mods.hub;
  const keys = list => JSON.stringify({ keys: list });
  assert.equal(hubConfig({}), null, 'off when HUB_JWKS is unset');
  assert.equal(hubConfig({ HUB_JWKS: '  ' }), null, 'off when HUB_JWKS is blank');
  assert.throws(() => hubConfig({ HUB_JWKS: JWKS }), /HUB_ISSUER/);
  assert.throws(() => hubConfig({ HUB_JWKS: '{nope', HUB_ISSUER: ISSUER }), /not valid JSON/);
  assert.throws(() => hubConfig({ HUB_JWKS: keys([]), HUB_ISSUER: ISSUER }), /no keys/);
  assert.throws(() => hubConfig({ HUB_JWKS: keys([{ ...jwk(k1, 'a') }, { ...jwk(k2, 'a') }]), HUB_ISSUER: ISSUER }), /twice/);
  assert.throws(() => hubConfig({ HUB_JWKS: keys([{ ...jwk(k1, '') }]), HUB_ISSUER: ISSUER }), /kid/);
  assert.throws(() => hubConfig({ HUB_JWKS: keys([{ ...k1.privateKey.export({ format: 'jwk' }), kid: 'p' }]), HUB_ISSUER: ISSUER }), /private key/);
  assert.throws(() => hubConfig({ HUB_JWKS: keys([{ ...jwk(k1, 'a'), alg: 'RS256' }]), HUB_ISSUER: ISSUER }), /ES256/);
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' });
  assert.throws(() => hubConfig({ HUB_JWKS: keys([{ ...p384, kid: 'a' }]), HUB_ISSUER: ISSUER }), /P-256/);
  assert.equal(hubConfig({ HUB_JWKS: JWKS, HUB_ISSUER: ISSUER }).keys.size, 2);
});

// ── The owner's one-time link ─────────────────────────────────────────────
test('scripts/link-hub-user.js links an existing account and can make it admin', async (t) => {
  if (skip(t)) return;
  hubOn();
  const script = fileURLToPath(new URL('../server/scripts/link-hub-user.js', import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { env: { ...process.env }, encoding: 'utf8', stdio: 'pipe' });
  const owner = localUser('owner');
  const sub = 'og-owner';
  // The owner opened the app before the link: an empty account was made.
  const early = await call('/api/whoami', { token: tokenFor(sub) });
  assert.notEqual(early.body.user.id, owner.id);
  db.prepare(`UPDATE users SET email = 'typed-in-hub@example.test' WHERE id = ?`).run(early.body.user.id);

  assert.throws(() => run('--user', 'owner', '--sub', sub), /already linked/, 'never moves a link silently');
  assert.throws(() => run('--user', 'nobody', '--sub', sub), /no user/);
  const out = run('--user', 'owner', '--sub', sub, '--replace', '--admin', '--claim-anonymous');
  assert.match(out, /linked owner/);
  assert.match(out, /claimed 1 row\(s\) from single-user mode/);
  assert.equal(orphanFast().user_id, owner.id, 'the single-user data is the owner\'s now');
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(early.body.user.id).email, null,
    'the account left behind loses the email typed from hub sessions');

  const after = await call('/api/whoami', { token: tokenFor(sub) });
  assert.equal(after.body.user.id, owner.id);
  assert.equal(after.body.user.role, 'admin');
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub) })).status, 200);
  assert.match(run('--user', String(owner.id), '--sub', sub), /linked owner/, 'running it again is a no-op');
  assert.equal(linkCount(sub), 1);
});

test('a full backup keeps the hub links (a restore would otherwise re-key everyone)', async (t) => {
  if (skip(t)) return;
  hubOn();
  const admin = 'og-backup-admin';
  assert.equal((await call('/api/whoami', { token: tokenFor(admin) })).status, 200);
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = (SELECT user_id FROM user_hub_links WHERE sub = ?)`).run(admin);
  const links = () => db.prepare('SELECT user_id, issuer, sub FROM user_hub_links ORDER BY id').all();
  const before = links();
  assert.ok(before.length > 1);

  const made = await call('/api/full-backup', { method: 'POST', token: tokenFor(admin) });
  assert.equal(made.status, 200);
  db.prepare('DELETE FROM user_hub_links WHERE sub != ?').run(admin);
  const restored = await call(`/api/full-backup/${made.body.filename}/restore`, { method: 'POST', token: tokenFor(admin) });
  assert.equal(restored.status, 200);
  assert.deepEqual(links(), before, 'every link is back, on the same accounts');

  // A backup made before user_hub_links existed still restores (to no links).
  const AdmZip = req('adm-zip');
  const backups = join(dir, 'uploads', 'backups');
  const zip = new AdmZip(join(backups, made.body.filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  delete data.user_hub_links;
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  zip.writeZip(join(backups, 'nutritrace-backup-older.zip'));
  const older = await call('/api/full-backup/nutritrace-backup-older.zip/restore', { method: 'POST', token: tokenFor(admin) });
  assert.equal(older.status, 200);
  assert.equal(links().length, 0);

  // Back to the full backup for the tests after this one.
  const adminLink = before.find(l => l.sub === admin);
  db.prepare('INSERT INTO user_hub_links (user_id, issuer, sub) VALUES (?, ?, ?)').run(adminLink.user_id, ISSUER, admin);
  assert.equal((await call(`/api/full-backup/${made.body.filename}/restore`, { method: 'POST', token: tokenFor(admin) })).status, 200);
  assert.deepEqual(links(), before);
});

// ── HUB_JWKS unset: upstream behaviour ────────────────────────────────────
// Last: it empties the users table.
test('HUB_JWKS unset: hub tokens are foreign bearers, and single-user mode is back', async (t) => {
  if (skip(t)) return;
  hubOff();
  try {
    const cookieUser = localUser(`cookie-${crypto.randomUUID()}`);
    const both = await call('/api/whoami', { token: tokenFor('og-friend-1'), cookie: mods.auth.signToken(cookieUser) });
    assert.equal(both.status, 200);
    assert.equal(both.body.via, 'cookie', 'the hub token is ignored, the cookie decides');
    assert.equal((await call('/api/whoami', { token: tokenFor('og-friend-1') })).status, 401, 'a hub token signs nobody in');
    assert.equal((await call('/api/whoami', { token: BAD['bad signature']() })).status, 401);
    const linked = db.prepare('SELECT user_id FROM user_hub_links LIMIT 1').get().user_id;
    assert.equal(mods.hub.isHubManaged(linked), false, 'passwords are upstream again');

    db.prepare('DELETE FROM users').run();
    assert.equal(mods.auth.userMgmtActive(), false);
    assert.equal((await call('/api/whoami')).status, 200, 'single-user pass-through');
    assert.equal((await call('/api/admin-only')).status, 200);
    const reg = await call('/api/auth/register', { method: 'POST', body: { username: 'first', password: 'Str0ng!Passw0rd#' } });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.user.role, 'admin', 'the first account is the admin, as upstream');
  } finally {
    hubOn();
  }
});
