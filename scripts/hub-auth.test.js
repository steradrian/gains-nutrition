/**
 * Hub tokens (server/lib/hub-auth.js, HUB_JWKS + HUB_ISSUER).
 *
 * A hub in front of NutriTrace signs every forwarded request with a 60 s
 * ES256 token. These cases run the real middleware and routes on a scratch
 * database:
 *   - a valid token makes the account once and reuses it; the role is the
 *     database's, never the token's;
 *   - every kind of bad hub token is a 401 even with a good cookie on the
 *     same request (no fall-through);
 *   - an empty users table behind a hub refuses requireAuth, requireAdmin
 *     and /register instead of turning into single-user mode;
 *   - scope=sync reaches /api/v1 with exactly three scopes, scope=user not
 *     at all;
 *   - with HUB_JWKS unset, everything is as upstream.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  hubOn();
  db = (await import('../server/db.js')).default;
  const auth = await import('../server/middleware/auth.js');
  const { csrfProtect } = await import('../server/middleware/csrf.js');
  const bearer = await import('../server/middleware/bearer-auth.js');
  const hub = await import('../server/lib/hub-auth.js');
  const { KNOWN_SCOPES } = await import('../server/lib/api-tokens.js');
  const { default: authRoutes } = await import('../server/routes/auth.js');
  const { default: apiV1Routes } = await import('../server/routes/api/v1/index.js');
  mods = { auth, bearer, hub, KNOWN_SCOPES };

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

test('a hub user posts without a CSRF token (the credential is a header)', async (t) => {
  if (skip(t)) return;
  hubOn();
  assert.equal((await call('/api/whoami', { method: 'POST', token: tokenFor('og-friend-1'), body: {} })).status, 200);
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

  assert.throws(() => run('--user', 'owner', '--sub', sub), /already linked/, 'never moves a link silently');
  assert.throws(() => run('--user', 'nobody', '--sub', sub), /no user/);
  const out = run('--user', 'owner', '--sub', sub, '--replace', '--admin');
  assert.match(out, /linked owner/);

  const after = await call('/api/whoami', { token: tokenFor(sub) });
  assert.equal(after.body.user.id, owner.id);
  assert.equal(after.body.user.role, 'admin');
  assert.equal((await call('/api/admin-only', { token: tokenFor(sub) })).status, 200);
  assert.match(run('--user', String(owner.id), '--sub', sub), /linked owner/, 'running it again is a no-op');
  assert.equal(linkCount(sub), 1);
});

test('a full backup keeps the hub links (a restore would otherwise re-key everyone)', () => {
  const src = readFileSync(new URL('../server/routes/full-backup.js', import.meta.url), 'utf8');
  assert.match(src, /user_hub_links:\s+db\.prepare\('SELECT \* FROM user_hub_links'\)\.all\(\)/, 'dumped');
  assert.match(src, /INSERT OR IGNORE INTO user_hub_links/, 'restored');
  assert.match(src, /data\.user_hub_links \|\| \[\]/, 'older backups without it still restore');
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
