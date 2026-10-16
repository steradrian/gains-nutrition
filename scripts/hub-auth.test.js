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
 *   - a full backup round-trips the hub links, and an older one keeps them;
 *   - unowned single-user rows are hidden from hub accounts until claimed;
 *   - `hub-` usernames are the hub's alone;
 *   - HUB_JWKS unset while hub accounts exist stays closed (a restart
 *     included), and says so;
 *   - with HUB_JWKS unset and no hub accounts, everything is as upstream.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ISSUER = 'https://hub.test/hub';
const keyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const k1 = keyPair(), k2 = keyPair(), stranger = keyPair();
const jwk = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' });
const JWKS = JSON.stringify({ keys: [jwk(k1, 'k1'), jwk(k2, 'k2')] });

const hubOn = () => { process.env.HUB_JWKS = JWKS; process.env.HUB_ISSUER = ISSUER; };
const hubOff = () => { delete process.env.HUB_JWKS; delete process.env.HUB_ISSUER; };

// No skipping: without a working better-sqlite3 (missing, or built for
// another Node) the import of db.js below throws and this file fails, so CI
// cannot pass while none of these cases ran.
const req = createRequire(new URL('../server/package.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nt-hub-auth-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.UPLOADS_PATH = join(dir, 'uploads');
hubOn();
const db = (await import('../server/db.js')).default;
const auth = await import('../server/middleware/auth.js');
const { csrfProtect } = await import('../server/middleware/csrf.js');
const bearer = await import('../server/middleware/bearer-auth.js');
const hub = await import('../server/lib/hub-auth.js');
const claim = await import('../server/lib/claim-anonymous-data.js');
const diaryHelpers = await import('../server/lib/diary-helpers.js');
const sharing = await import('../server/lib/sharing.js');
const oidc = await import('../server/routes/oidc.js');
const oidcLib = await import('../server/lib/oidc.js');
const { KNOWN_SCOPES } = await import('../server/lib/api-tokens.js');
const { default: authRoutes } = await import('../server/routes/auth.js');
const { default: apiV1Routes } = await import('../server/routes/api/v1/index.js');
const { default: backupRoutes } = await import('../server/routes/full-backup.js');
const { default: foodsRoutes } = await import('../server/routes/foods.js');
const mods = { auth, bearer, hub, claim, diaryHelpers, sharing, oidc, oidcLib, csrfProtect, KNOWN_SCOPES };

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
app.use('/api/foods', foodsRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

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
  hubOn();
  const res = await call('/api/whoami', { token: sign(claimsFor('og-friend-1'), { kid: 'k2', key: k2.privateKey }) });
  assert.equal(res.status, 200);
});

test('the role comes from the database, never from the token', async (t) => {
  hubOn();
  const sub = 'og-role';
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub, { role: 'admin', admin: true }) })).status, 403);
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = (SELECT user_id FROM user_hub_links WHERE sub = ?)`).run(sub);
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub) })).status, 200);
  db.prepare(`UPDATE users SET role = 'user' WHERE id = (SELECT user_id FROM user_hub_links WHERE sub = ?)`).run(sub);
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub) })).status, 403, 'a demotion applies on the next request');
});

test('a hub user posts without a CSRF token, and a cookie beside it is not the session', async (t) => {
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
  hubOn();
  let passed = false;
  const res = { status() { return this; }, json() { return this; } };
  mods.csrfProtect({ method: 'POST', path: '/api/whoami', authVia: 'hub', user: { id: 1, csrf: 'x' }, headers: {} }, res, () => { passed = true; });
  assert.ok(passed);
});

// ── Bad tokens: 401, never the cookie ─────────────────────────────────────
// The same signature spelled another way: 64 bytes take 86 base64url
// characters, and the last one carries 4 unused bits that a lenient
// decoder ignores. Flipping the lowest of them keeps the bytes.
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// The same trick works on any segment whose length is not a multiple of
// 4 (a whole number of bytes leaves no spare bits otherwise).
function respell(token, index = 2) {
  const parts = token.split('.');
  const seg = parts[index];
  assert.notEqual(seg.length % 4, 0, `segment ${index} has spare bits`);
  const twin = seg.slice(0, -1) + B64URL[B64URL.indexOf(seg.at(-1)) ^ 1];
  assert.deepEqual(Buffer.from(twin, 'base64url'), Buffer.from(seg, 'base64url'), 'same bytes');
  parts[index] = twin;
  return parts.join('.');
}
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
  'non-canonical signature':  () => respell(tokenFor('og-bad')),
  'no jti':                   () => tokenFor('og-bad', { jti: undefined }),
  'jti under 128 bits':       () => tokenFor('og-bad', { jti: crypto.randomBytes(8).toString('base64url') }),
  'jti not base64url':        () => tokenFor('og-bad', { jti: `${crypto.randomBytes(16).toString('base64url')}+/` }),
};

for (const [name, make] of Object.entries(BAD)) {
  test(`hub token, ${name}: 401 and the cookie is not used`, async (t) => {
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
  hubOn();
  assert.equal((await call('/api/whoami', { token: tokenFor('og-skew', { iat: now() + 25, exp: now() + 60 }) })).status, 200);
});

test('a replayed jti is refused: the same token works once', async (t) => {
  hubOn();
  const token = tokenFor('og-replay');
  assert.equal((await call('/api/whoami', { token })).status, 200);
  const again = await call('/api/whoami', { token });
  assert.equal(again.status, 401);
  assert.equal(again.body.code, 'hub_token_invalid');
  // A fresh token (new jti) for the same person is fine.
  assert.equal((await call('/api/whoami', { token: tokenFor('og-replay') })).status, 200);

  const sync = tokenFor('og-replay', { scope: 'sync', act: 'bridge' });
  const body = { date: '2026-10-14', name: 'Run', kcal: 300, external_id: 'og:w:replay' };
  assert.equal((await call('/api/v1/activity', { method: 'POST', token: sync, body })).status, 201);
  assert.equal((await call('/api/v1/activity', { method: 'POST', token: sync, body })).status, 401);
});

test('a replayed jti is refused by verifyHubToken until its token expires', () => {
  hubOn();
  const config = mods.hub.hubConfig();
  const nowS = now();
  const token = tokenFor('og-replay-unit', { iat: nowS, exp: nowS + 60 });
  assert.equal(mods.hub.verifyHubToken(token, config, nowS).ok, true);
  assert.equal(mods.hub.verifyHubToken(token, config, nowS + 30).reason, 'replay');
  // Past exp it is refused as expired, whatever the cache holds.
  assert.equal(mods.hub.verifyHubToken(token, config, nowS + 61).reason, 'expired');
});

test('the replay cache outlives exp by the clock skew, then lets the entry go', () => {
  hubOn();
  const config = mods.hub.hubConfig();
  const t0 = now() + 1000; // ahead of every other test's entries
  // Signed 30 s ahead (the skew allows it): valid until t0 + 90.
  const ahead = tokenFor('og-cache', { iat: t0 + 30, exp: t0 + 90 });
  assert.equal(mods.hub.verifyHubToken(ahead, config, t0).ok, true);
  assert.equal(mods.hub.verifyHubToken(ahead, config, t0 + 89).reason, 'replay', 'blocked for its whole life');

  // Another verify 100 s on, past its exp, does not trim it yet (kept to
  // exp + 30)...
  assert.equal(mods.hub.verifyHubToken(tokenFor('og-cache', { iat: t0 + 100, exp: t0 + 160 }), config, t0 + 100).ok, true);
  // ...so a clock stepped back 20 s still finds it.
  assert.equal(mods.hub.verifyHubToken(ahead, config, t0 + 80).reason, 'replay', 'a clock stepped back does not reopen it');

  // Once every entry is past exp + 30, the next verify trims them all.
  assert.equal(mods.hub.verifyHubToken(tokenFor('og-cache', { iat: t0 + 300, exp: t0 + 360 }), config, t0 + 300).ok, true);
  assert.equal(mods.hub.replayCacheSize(), 1, 'only the newest entry is left');
});

test('jti length bounds: 22..128 base64url characters', () => {
  hubOn();
  const config = mods.hub.hubConfig();
  const jti = n => crypto.randomBytes(n).toString('base64url').slice(0, n);
  const reason = n => mods.hub.verifyHubToken(tokenFor('og-jti', { jti: jti(n) }), config).reason ?? 'ok';
  assert.equal(reason(21), 'jti');
  assert.equal(reason(22), 'ok');
  assert.equal(reason(128), 'ok');
  assert.equal(reason(129), 'jti');
});

test('a non-canonical spelling of any segment is refused even though its bytes verify', () => {
  hubOn();
  const config = mods.hub.hubConfig();
  // Pad the name until the payload segment has spare bits to flip.
  let claims = claimsFor('og-respell');
  while (b64(claims).length % 4 === 0) claims = { ...claims, name: `${claims.name}x` };
  for (const index of [0, 1, 2]) {
    assert.equal(mods.hub.verifyHubToken(respell(sign(claims), index), config).reason, 'encoding', `segment ${index}`);
    claims = { ...claims, jti: crypto.randomBytes(16).toString('base64url') };
  }
});

test('scope=user never reaches /api/v1, the bridge routes included', async (t) => {
  hubOn();
  const user = () => tokenFor('og-user-v1');
  for (const [method, path, body] of [
    ['GET', '/api/v1/body-stats'],
    ['POST', '/api/v1/activity', { date: '2026-10-14', name: 'Run', kcal: 1, external_id: 'og:w:u' }],
    ['POST', '/api/v1/activity/batch', { items: [] }],
    ['DELETE', '/api/v1/activity/external/og:w:u'],
    ['POST', '/api/v1/body-measurements', { date: '2026-10-14', weight: 80 }],
  ]) {
    const res = await call(path, { method, token: user(), body });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal(res.body.code, 'auth_invalid');
  }
});

test("a bearer that isn't the hub's is still left to the cookie (upstream)", async (t) => {
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
  hubOn();
  const sync = () => tokenFor('og-sync', { scope: 'sync', act: 'bridge' });
  const posted = await call('/api/v1/activity', { method: 'POST', token: sync(), body: { date: '2026-10-14', name: 'Run', kcal: 300, external_id: 'og:1' } });
  assert.ok(posted.status >= 200 && posted.status < 300, `activity: ${posted.status}`);
  const userId = db.prepare('SELECT user_id FROM user_hub_links WHERE sub = ?').get('og-sync').user_id;
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM activity_log WHERE user_id = ? AND external_id = 'og:1' AND source = 'external'`).get(userId).n, 1);

  const measured = await call('/api/v1/body-measurements', { method: 'POST', token: sync(), body: {} });
  assert.notEqual(measured.status, 401);
  assert.notEqual(measured.status, 403);
  assert.equal((await call('/api/v1/body-stats', { token: sync() })).status, 200, 'read:body-stats');

  const foods = await call('/api/v1/foods', { token: sync() });
  assert.equal(foods.status, 403);
  assert.equal(foods.body.code, 'auth_scope');
  const workouts = await call('/api/v1/workouts', { method: 'POST', token: sync(), body: {} });
  assert.equal(workouts.status, 403);
});

test('requireScope: a sync token holds write:activity, read:body-stats, write:body-measurements and nothing else', (t) => {
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
const linkScript = fileURLToPath(new URL('../server/scripts/link-hub-user.js', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [linkScript, ...args], { env: { ...process.env }, encoding: 'utf8', stdio: 'pipe' });
const runFailing = (...args) => {
  const r = spawnSync(process.execPath, [linkScript, ...args], { env: { ...process.env }, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'expected the script to refuse');
  return r;
};

test('scripts/link-hub-user.js links an existing account and can make it admin', async (t) => {
  hubOn();
  const owner = localUser('owner');
  const sub = 'og-owner';
  // The owner opened the app before the link: an empty account was made.
  const early = await call('/api/whoami', { token: tokenFor(sub) });
  assert.notEqual(early.body.user.id, owner.id);
  db.prepare(`UPDATE users SET email = 'typed-in-hub@example.test' WHERE id = ?`).run(early.body.user.id);

  assert.throws(() => run('--user', 'owner', '--sub', sub), /already linked/, 'never moves a link silently');
  assert.throws(() => run('--user', 'nobody', '--sub', sub), /no user named nobody/);
  assert.throws(() => run('--user', 'owner', '--user-id', String(owner.id), '--sub', sub), /exactly one of --user/);
  assert.throws(() => run('--user-id', 'owner', '--sub', sub), /--user-id must be a number/);

  // --replace names the account it would displace, and changes nothing without --yes.
  const linkedTo = () => db.prepare('SELECT user_id FROM user_hub_links WHERE issuer = ? AND sub = ?').get(ISSUER, sub).user_id;
  const unconfirmed = runFailing('--user', 'owner', '--sub', sub, '--replace', '--admin', '--claim-anonymous');
  assert.match(unconfirmed.stdout, new RegExp(`linked to ${early.body.user.username} \\(id ${early.body.user.id}\\); --replace moves the link to owner \\(id ${owner.id}\\)`));
  assert.match(unconfirmed.stderr, /nothing changed; run again with --yes/);
  assert.equal(linkedTo(), early.body.user.id);
  assert.equal(orphanFast().user_id, null, 'nor claimed anything');
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(owner.id).role, 'user', 'nor made anyone admin');

  const out = run('--user', 'owner', '--sub', sub, '--replace', '--yes', '--admin', '--claim-anonymous');
  assert.match(out, /--replace moves the link to owner/);
  assert.match(out, /linked owner/);
  assert.match(out, /claimed 1 row\(s\) from single-user mode/);
  assert.equal(orphanFast().user_id, owner.id, 'the single-user data is the owner\'s now');
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(early.body.user.id).email, null,
    'the account left behind loses the email typed from hub sessions');

  const after = await call('/api/whoami', { token: tokenFor(sub) });
  assert.equal(after.body.user.id, owner.id);
  assert.equal(after.body.user.role, 'admin');
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub) })).status, 200);
  assert.match(run('--user-id', String(owner.id), '--sub', sub), /linked owner/, 'running it again is a no-op');
  assert.equal(linkCount(sub), 1);
});

test('link-hub-user.js: a username of digits is a username, and the issuer must be the server\'s', () => {
  hubOn();
  const digits = localUser('4242');
  assert.notEqual(digits.id, 4242);
  assert.match(run('--user', '4242', '--sub', 'og-digits'), new RegExp(`linked 4242 \\(id ${digits.id},`));
  assert.equal(db.prepare('SELECT user_id FROM user_hub_links WHERE sub = ?').get('og-digits').user_id, digits.id);

  const spare = localUser('spare-owner');
  assert.throws(() => run('--user', 'spare-owner', '--sub', 'og-spare', '--issuer', 'https://other.test/hub'), /is not this server's HUB_ISSUER/);
  assert.match(run('--user', 'spare-owner', '--sub', 'og-spare', '--issuer', ISSUER), /linked spare-owner/, 'the same issuer, spelled out, is fine');
  const { HUB_JWKS: _k, HUB_ISSUER: _i, ...noHub } = process.env;
  assert.throws(() => execFileSync(process.execPath, [linkScript, '--user', 'spare-owner', '--sub', 'og-spare-2', '--issuer', ISSUER],
    { env: noHub, encoding: 'utf8', stdio: 'pipe' }), /HUB_ISSUER is not set/);
  assert.equal(linkCount('og-spare-2'), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_hub_links WHERE user_id = ?').get(spare.id).n, 1);
});

test('unowned single-user foods are hidden from hub accounts until claimed, HUB_JWKS set or not', async () => {
  hubOn();
  const foodId = Number(db.prepare(
    `INSERT INTO foods (user_id, name, category, img_url) VALUES (NULL, 'Owner Secret Stew', 'secret-cat', '/uploads/secret.jpg')`
  ).run().lastInsertRowid);
  const friend = (await call('/api/whoami', { token: tokenFor('og-friend-1') })).body.user.id;
  const owner = (await call('/api/whoami', { token: tokenFor('og-owner') })).body.user.id;
  const item = { id: foodId, food_server_id: foodId, name: 'Owner Secret Stew' };
  const seen = userId => ({
    category: mods.diaryHelpers.hydrateItems([item], userId)[0].category,
    imgUrl: mods.diaryHelpers.freshenItemImages([item], userId)[0].imgUrl,
  });
  const canRead = userId => mods.sharing.canRead(db.prepare('SELECT * FROM foods WHERE id = ?').get(foodId), userId, 'food_shares', 'food_id');
  try {
    assert.deepEqual(seen(friend), { category: undefined, imgUrl: '' });
    assert.equal(canRead(friend), false);
    assert.equal((await call(`/api/foods/${foodId}`, { token: tokenFor('og-friend-1') })).status, 404);
    assert.equal((await call(`/api/foods/${foodId}`, { token: tokenFor('og-owner') })).status, 404, 'the owner too, until claimed');
    hubOff();
    assert.deepEqual(seen(friend), { category: undefined, imgUrl: '' }, 'hub accounts exist: still hidden');
    assert.equal(canRead(friend), false);
  } finally {
    hubOn();
  }
  mods.claim.claimAnonymousData(owner);
  assert.deepEqual(seen(owner), { category: 'secret-cat', imgUrl: '/uploads/secret.jpg' });
  assert.equal((await call(`/api/foods/${foodId}`, { token: tokenFor('og-owner') })).status, 200);
  assert.deepEqual(seen(friend), { category: undefined, imgUrl: '' }, 'private to the one who claimed it');
  assert.equal((await call(`/api/foods/${foodId}`, { token: tokenFor('og-friend-1') })).status, 404);
});

test('usernames starting with hub- are reserved: register, accept-invite and OIDC sign-up', async () => {
  hubOn();
  const adminSub = 'og-password-admin';   // made admin above
  const adminId = db.prepare('SELECT user_id FROM user_hub_links WHERE sub = ?').get(adminSub).user_id;
  const password = 'Str0ng!Passw0rd#';
  for (const username of ['hub-0123456789abcdef', ' Hub-lookalike ']) {
    const reg = await call('/api/auth/register', { method: 'POST', token: tokenFor(adminSub), body: { username, password } });
    assert.equal(reg.status, 400, username);
    assert.match(reg.body.error, /reserved/);
  }
  assert.equal((await call('/api/auth/register', { method: 'POST', token: tokenFor(adminSub), body: { username: 'hubert', password } })).status, 200,
    'only the prefix is reserved');

  db.prepare(`INSERT INTO invite_tokens (token, email, role, created_by, expires_at) VALUES ('inv-hub', NULL, 'user', ?, ?)`)
    .run(adminId, new Date(Date.now() + 3600_000).toISOString());
  const accepted = await call('/api/auth/accept-invite', { method: 'POST', body: { token: 'inv-hub', username: 'HUB-x', password } });
  assert.equal(accepted.status, 400);
  assert.match(accepted.body.error, /reserved/);
  assert.equal(db.prepare(`SELECT used FROM invite_tokens WHERE token = 'inv-hub'`).get().used, 0, 'the invite is still good');

  const providerId = Number(db.prepare(`INSERT INTO oidc_providers (issuer_url, client_id) VALUES ('https://idp.test', 'nt')`).run().lastInsertRowid);
  const provider = { id: providerId, auto_link_verified_email: 0, auto_register_new_users: 1 };
  const made = mods.oidcLib.resolveUser(provider, { sub: 'idp-hubby', preferred_username: 'hub-0123456789abcdef' });
  assert.equal(made.created, true);
  assert.equal(made.user.username, 'user-hub-0123456789abcdef');
});

test('a full backup keeps the hub links (a restore would otherwise re-key everyone)', async (t) => {
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

  // A backup made before user_hub_links existed (no key) keeps the links
  // there are, except one whose account the restore did not bring back.
  const AdmZip = req('adm-zip');
  const backups = join(dir, 'uploads', 'backups');
  const zip = new AdmZip(join(backups, made.body.filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  delete data.user_hub_links;
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  zip.writeZip(join(backups, 'nutritrace-backup-older.zip'));
  assert.equal((await call('/api/whoami', { token: tokenFor('og-after-backup') })).status, 200);
  assert.equal(linkCount('og-after-backup'), 1);
  const older = await call('/api/full-backup/nutritrace-backup-older.zip/restore', { method: 'POST', token: tokenFor(admin) });
  assert.equal(older.status, 200);
  assert.deepEqual(links(), before, 'the links stay; the one made after the backup went with its account');
});

// ── HUB_JWKS unset after hub accounts were made: fail closed ──────────────
test('HUB_JWKS unset with hub accounts: no single-user mode, no adoption, no local passwords', async () => {
  hubOff();
  const leftOver = Number(db.prepare(`INSERT INTO fasts (user_id, start_at, notes) VALUES (NULL, '2026-10-02T20:00', 'left over')`).run().lastInsertRowid);
  try {
    assert.ok(mods.hub.hubLinkCount() > 0);
    assert.equal(mods.hub.hubMode(), false);
    assert.equal(mods.hub.hubInstance(), true, 'still the hub\'s instance');
    assert.equal(mods.auth.userMgmtActive(), true);
    const r = mods.claim.repairOrphanedData();
    assert.equal(r.hub, true);
    assert.equal(db.prepare('SELECT user_id FROM fasts WHERE id = ?').get(leftOver).user_id, null, 'not adopted');
    assert.equal((await call('/api/whoami')).status, 401);
    assert.equal((await call('/api/admin-only')).status, 403);
    const reg = await call('/api/auth/register', { method: 'POST', body: { username: 'walk-in', password: 'Str0ng!Passw0rd#' } });
    assert.equal(reg.status, 403);
    const linked = db.prepare('SELECT user_id FROM user_hub_links WHERE sub = ?').get('og-friend-1').user_id;
    assert.equal(mods.hub.isHubManaged(linked), true, 'a typed-in email still is no way in');
    const result = { created: true, user: { id: linked, username: 'x', role: 'user' } };
    assert.equal(mods.oidc.bootstrapFirstOidcUser(result), false);
  } finally {
    db.prepare('DELETE FROM fasts WHERE id = ?').run(leftOver);
    hubOn();
  }
});

// The real startup path, in a fresh process on a fresh database: the hub
// made the only account, then HUB_JWKS was unset and the server restarted.
test('restart with HUB_JWKS unset after the hub made the only account: nothing is handed to it, and it says why', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'nt-hub-restart-'));
  const { HUB_JWKS: _k, HUB_ISSUER: _i, ...noHub } = process.env;
  const env = { ...noHub, DB_PATH: join(fresh, 'test.db'), UPLOADS_PATH: join(fresh, 'uploads') };
  const mod = p => JSON.stringify(pathToFileURL(fileURLToPath(new URL(`../server/${p}`, import.meta.url))).href);
  const node = (code, extraEnv = {}) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { ...r, out: JSON.parse(r.stdout.trim().split('\n').pop()) };
  };
  const state = `
    const sdb = (await import(${mod('db.js')})).default;
    const fast = sdb.prepare("SELECT user_id FROM fasts WHERE notes = 'single-user'").get().user_id;
    const food = sdb.prepare("SELECT user_id FROM foods WHERE name = 'single-user stew'").get().user_id;
    const users = sdb.prepare('SELECT COUNT(*) n FROM users').get().n;`;
  try {
    // Single-user data, then the hub's first request makes a friend's account.
    node(`
      const db = (await import(${mod('db.js')})).default;
      const { resolveHubUser } = await import(${mod('lib/hub-auth.js')});
      db.prepare("INSERT INTO fasts (user_id, start_at, notes) VALUES (NULL, '2026-10-01T20:00', 'single-user')").run();
      db.prepare("INSERT INTO foods (user_id, name) VALUES (NULL, 'single-user stew')").run();
      console.log(JSON.stringify(resolveHubUser(${JSON.stringify(ISSUER)}, { sub: 'og-only-friend', name: 'Friend' })));
    `, { HUB_JWKS: JWKS, HUB_ISSUER: ISSUER });

    // Restart without the hub: the startup the server does (auth.js on
    // import, then repairOrphanedData in app.listen).
    const restart = node(`
      const auth = await import(${mod('middleware/auth.js')});
      const { repairOrphanedData } = await import(${mod('lib/claim-anonymous-data.js')});
      const repair = repairOrphanedData();
      ${state}
      console.log(JSON.stringify({ repair, fast, food, users, active: auth.userMgmtActive() }));
    `);
    assert.match(restart.stderr, /\[ERROR\] HUB_JWKS is not set, but 1 account\(s\) here belong to a hub/);
    assert.match(restart.stderr, /no single-user mode, no open first \/register/);
    assert.deepEqual(restart.out, { repair: { repaired: 0, rows: 2, hub: true }, fast: null, food: null, users: 1, active: true });

    // The guard is what decides: with no hub account, the same restart
    // adopts the data into the one account, as upstream does.
    const upstream = node(`
      const db = (await import(${mod('db.js')})).default;
      db.prepare('DELETE FROM user_hub_links').run();
      await import(${mod('middleware/auth.js')});
      const { repairOrphanedData } = await import(${mod('lib/claim-anonymous-data.js')});
      const repair = repairOrphanedData();
      ${state}
      console.log(JSON.stringify({ repair, fast, food, users }));
    `);
    assert.doesNotMatch(upstream.stderr, /belong to a hub/);
    assert.equal(upstream.out.repair.rows, 2);
    assert.equal(upstream.out.fast, upstream.out.repair.repaired);
    assert.equal(upstream.out.food, upstream.out.repair.repaired);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('bearerAuth reads the header as upstream does: any whitespace after Bearer', () => {
  for (const sep of [' ', '  ', '\t', '\u000b', ' ']) {
    const r = { get: () => `Bearer${sep}nt_not_a_real_token` };
    const res = { set() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    mods.bearer.bearerAuth(r, res, () => assert.fail('admitted'));
    assert.equal(res.code, 401);
    assert.equal(res.body.code, 'auth_invalid', `parsed past ${JSON.stringify(sep)}, then refused as unknown`);
  }
});

// ── HUB_JWKS unset, no hub accounts: upstream behaviour ───────────────────
// Last: it empties the users table.
test('HUB_JWKS unset: hub tokens are foreign bearers, and single-user mode is back', async () => {
  hubOff();
  try {
    const cookieUser = localUser(`cookie-${crypto.randomUUID()}`);
    const both = await call('/api/whoami', { token: tokenFor('og-friend-1'), cookie: mods.auth.signToken(cookieUser) });
    assert.equal(both.status, 200);
    assert.equal(both.body.via, 'cookie', 'the hub token is ignored, the cookie decides');
    assert.equal((await call('/api/whoami', { token: tokenFor('og-friend-1') })).status, 401, 'a hub token signs nobody in');
    assert.equal((await call('/api/whoami', { token: BAD['bad signature']() })).status, 401);

    db.prepare('DELETE FROM users').run();
    assert.equal(mods.hub.hubLinkCount(), 0, 'the links went with their accounts');
    assert.equal(mods.auth.userMgmtActive(), false);
    assert.equal((await call('/api/whoami')).status, 200, 'single-user pass-through');
    assert.equal((await call('/api/admin-only')).status, 200);
    // No req.user in single-user mode: the same 400 as upstream, not a crash.
    const pw = await call('/api/auth/password', { method: 'PUT', body: {} });
    assert.equal(pw.status, 400);
    assert.equal(pw.body.error, 'New password required');
    const reg = await call('/api/auth/register', { method: 'POST', body: { username: 'first', password: 'Str0ng!Passw0rd#' } });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.user.role, 'admin', 'the first account is the admin, as upstream');
    // Unowned rows are anyone's again, as upstream.
    assert.equal(mods.sharing.canRead({ id: 1, user_id: null, visibility: 'private' }, reg.body.user.id, 'food_shares', 'food_id'), true);
  } finally {
    hubOn();
  }
});
