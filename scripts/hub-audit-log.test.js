/**
 * The audit trail of hub requests (middleware/auth.js, lib/hub-auth.js
 * hubAuditFields): every request a verified hub token signs logs, at debug
 * level, its jti, a hash of its sub and its act. Never the token, never the
 * raw sub.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const ISSUER = 'https://hub.test/audit';
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.HUB_JWKS = JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'a1', alg: 'ES256', use: 'sig' }] });
process.env.HUB_ISSUER = ISSUER;

const req = createRequire(new URL('../server/package.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nt-hub-audit-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.UPLOADS_PATH = join(dir, 'uploads');
const db = (await import('../server/db.js')).default;
const { logger } = await import('../server/logger.js');
const auth = await import('../server/middleware/auth.js');
const { hubAuditFields } = await import('../server/lib/hub-auth.js');

const express = req('express');
const app = express();
app.use(auth.authenticate);
app.get('/api/whoami', auth.requireAuth, (r, res) => res.json({ id: r.user.id }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
function token(claims) {
  const input = `${b64({ alg: 'ES256', kid: 'a1', typ: 'JWT' })}.${b64(claims)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const claims = (extra = {}) => ({
  iss: ISSUER, aud: 'nutritrace', sub: 'opengym-user-42', scope: 'user', act: 'browser',
  iat: now(), exp: now() + 60, jti: crypto.randomBytes(16).toString('base64url'), ...extra,
});

// Every logger level, recorded by name.
async function logsDuring(fn) {
  const lines = [];
  const saved = { ...logger };
  for (const level of ['error', 'warn', 'info', 'debug', 'trace']) logger[level] = (...a) => lines.push({ level, text: a.join(' ') });
  try { await fn(); } finally { Object.assign(logger, saved); }
  return lines;
}
const subHash = sub => crypto.createHash('sha256').update(`${ISSUER}\0${sub}`).digest('hex').slice(0, 16);

test('a hub request logs jti, the sub hash and act at debug level, and never the token or the raw sub', async () => {
  const c = claims();
  const t = token(c);
  let status;
  const lines = await logsDuring(async () => {
    status = (await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${t}` } })).status;
  });
  assert.equal(status, 200);
  const audit = lines.filter(l => l.text.includes(`jti=${c.jti}`));
  assert.equal(audit.length, 1, 'one audit line');
  assert.equal(audit[0].level, 'debug');
  assert.match(audit[0].text, /^\[hub\] GET \/api\/whoami scope=user /);
  assert.ok(audit[0].text.includes(`sub_hash=${subHash(c.sub)}`));
  assert.ok(audit[0].text.includes('act=browser'));
  for (const line of lines) {
    assert.ok(!line.text.includes(t), 'never the token');
    assert.ok(!line.text.includes(t.split('.')[2]), 'not even its signature');
    assert.ok(!line.text.includes(c.sub), 'never the raw sub');
  }
});

test('the sub hash is the one the account\'s hub- username starts from', async () => {
  const c = claims({ sub: 'opengym-user-77' });
  const res = await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${token(c)}` } });
  const { id } = await res.json();
  const { username } = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  assert.equal(username, `hub-${hubAuditFields(ISSUER, c).sub}`);
});

test('a sync token turned away by its scope is still in the audit trail', async () => {
  const c = claims({ scope: 'sync', act: 'bridge' });
  let status;
  const lines = await logsDuring(async () => {
    status = (await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${token(c)}` } })).status;
  });
  assert.equal(status, 401);
  const audit = lines.find(l => l.text.includes(`jti=${c.jti}`));
  assert.ok(audit && /scope=sync/.test(audit.text) && /act=bridge/.test(audit.text));
});

test('act is printable and bounded, whatever shape the hub sends', () => {
  assert.equal(hubAuditFields(ISSUER, claims({ act: undefined })).act, '-');
  assert.equal(hubAuditFields(ISSUER, claims({ act: { sub: 'svc' } })).act, '{"sub":"svc"}');
  assert.equal(hubAuditFields(ISSUER, claims({ act: 'a\nfake line' })).act, 'a?fake line');
  assert.equal(hubAuditFields(ISSUER, claims({ act: 'x'.repeat(500) })).act.length, 64);
});
