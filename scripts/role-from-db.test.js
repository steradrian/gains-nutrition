/**
 * Admin checks read the role from the database on every request, never from
 * the session token (middleware/auth.js hasAdminRole, requireAdmin;
 * lib/outbound-policy.js ownerOrOptIn; POST /api/auth/register).
 *
 * A session token keeps the role it was signed with for up to a year: an
 * admin demoted since, or deleted, still carries role "admin" in it.
 *
 * Runs the real authenticate middleware with real signed cookies on a
 * scratch database. No skipping: without a working better-sqlite3 the
 * import of db.js throws and this file fails.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const req = createRequire(new URL('../server/package.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nt-role-db-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.UPLOADS_PATH = join(dir, 'uploads');
delete process.env.HUB_JWKS;
delete process.env.ALLOW_PRIVATE_ROLE_TEST;
const db = (await import('../server/db.js')).default;
const auth = await import('../server/middleware/auth.js');
const { ownerOrOptIn } = await import('../server/lib/outbound-policy.js');
const { default: authRoutes } = await import('../server/routes/auth.js');

const express = req('express');
const cookieParser = req('cookie-parser');
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(auth.authenticate);
app.get('/admin-only', auth.requireAdmin, (r, res) => res.json({ ok: true }));
app.get('/opt-in', (r, res) => res.json({ allowed: ownerOrOptIn(r, 'ALLOW_PRIVATE_ROLE_TEST') }));
app.use('/api/auth', authRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const account = (username, role) => {
  const id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'x', role).lastInsertRowid);
  return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
};
const setRole = (user, role) => db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
const call = async (path, cookie, { method = 'GET', body } = {}) => {
  const headers = { cookie: `nt_token=${cookie}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

const owner = account('owner', 'admin');
const ownerCookie = auth.signToken(owner);

test('an admin token works while the account is an admin', async () => {
  assert.equal((await call('/admin-only', ownerCookie)).status, 200);
  assert.equal((await call('/opt-in', ownerCookie)).body.allowed, true);
});

test('demoted after sign-in: the token still says admin, every admin check says no', async () => {
  const demoted = account('was-admin', 'admin');
  const cookie = auth.signToken(demoted);
  assert.equal((await call('/admin-only', cookie)).status, 200, 'before the demotion');
  setRole(demoted, 'user');
  assert.equal((await call('/admin-only', cookie)).status, 403, 'requireAdmin');
  assert.equal((await call('/opt-in', cookie)).body.allowed, false, 'ownerOrOptIn');
  const reg = await call('/api/auth/register', cookie, { method: 'POST', body: { username: 'sneaky', password: 'Str0ng!Passw0rd#' } });
  assert.equal(reg.status, 403, '/register');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE username = 'sneaky'`).get().n, 0);
});

test('promoted after sign-in: the database decides the other way too', async () => {
  const promoted = account('now-admin', 'user');
  const cookie = auth.signToken(promoted);
  assert.equal((await call('/admin-only', cookie)).status, 403);
  setRole(promoted, 'admin');
  assert.equal((await call('/admin-only', cookie)).status, 200);
  assert.equal((await call('/opt-in', cookie)).body.allowed, true);
});

test('deleted after sign-in: an admin token for an account that is gone is no admin', async () => {
  const gone = account('gone', 'admin');
  const cookie = auth.signToken(gone);
  db.prepare('DELETE FROM users WHERE id = ?').run(gone.id);
  assert.equal((await call('/admin-only', cookie)).status, 403);
  assert.equal((await call('/opt-in', cookie)).body.allowed, false);
});

test('the opt-in variable still opens ownerOrOptIn for everyone', async () => {
  const friend = account('friend', 'user');
  const cookie = auth.signToken(friend);
  assert.equal((await call('/opt-in', cookie)).body.allowed, false);
  process.env.ALLOW_PRIVATE_ROLE_TEST = '1';
  try { assert.equal((await call('/opt-in', cookie)).body.allowed, true); }
  finally { delete process.env.ALLOW_PRIVATE_ROLE_TEST; }
});

test('hasAdminRole: no signed-in account is no admin', () => {
  assert.equal(auth.hasAdminRole({}), false);
  assert.equal(auth.hasAdminRole({ user: null }), false);
  assert.equal(auth.hasAdminRole({ user: { role: 'admin' } }), false, 'a role without an account id');
  assert.equal(auth.hasAdminRole({ user: { id: owner.id, role: 'user' } }), true, 'the row, not the object');
});
