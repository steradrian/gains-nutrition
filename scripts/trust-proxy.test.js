/**
 * TRUST_PROXY (server/lib/trust-proxy.js).
 *
 * Behind a proxy every request arrives from the proxy's address, so without
 * it the sign-in throttle is one bucket for everybody and one person's
 * guesses lock everyone out. With it, req.ip is the address the proxy added
 * (the rightmost X-Forwarded-For entry), never one the client typed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { applyTrustProxy, trustProxySetting, trustProxyWarning } from '../server/lib/trust-proxy.js';

const req = createRequire(new URL('../server/package.json', import.meta.url));
const express = req('express');

async function serve(app) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function ipSeen(env, xff) {
  const app = express();
  applyTrustProxy(app, env);
  app.get('/ip', (r, res) => res.json({ ip: r.ip }));
  const s = await serve(app);
  try {
    const res = await fetch(`${s.url}/ip`, { headers: xff ? { 'x-forwarded-for': xff } : {} });
    return (await res.json()).ip.replace(/^::ffff:/, '');
  } finally { s.close(); }
}

test('trustProxySetting reads the forms the README documents', () => {
  for (const v of [undefined, '', '  ', '0', 'false', 'no', 'OFF']) assert.equal(trustProxySetting(v), undefined, String(v));
  for (const v of ['1', 'true', 'yes', 'ON']) assert.equal(trustProxySetting(v), 1, v);
  assert.equal(trustProxySetting('2'), 2);
  assert.equal(trustProxySetting(' loopback, 172.16.0.0/12 '), 'loopback, 172.16.0.0/12');
});

test('unset: X-Forwarded-For is ignored (upstream)', async () => {
  assert.equal(await ipSeen({}, '203.0.113.9'), '127.0.0.1');
});

test('TRUST_PROXY=1: the address the proxy added, not the one the client typed', async () => {
  assert.equal(await ipSeen({ TRUST_PROXY: '1' }, '6.6.6.6, 203.0.113.9'), '203.0.113.9');
  assert.equal(await ipSeen({ TRUST_PROXY: 'true' }, '6.6.6.6, 203.0.113.9'), '203.0.113.9', 'true is one hop, never every hop');
});

test('TRUST_PROXY as a list of proxy addresses', async () => {
  assert.equal(await ipSeen({ TRUST_PROXY: 'loopback' }, '203.0.113.9'), '203.0.113.9');
  assert.equal(await ipSeen({ TRUST_PROXY: '10.9.9.9' }, '203.0.113.9'), '127.0.0.1', 'a request not from a listed proxy keeps its own address');
});

// Why the list form is preferred: with a count, a client that reaches the
// port directly is taken for the proxy, so its own X-Forwarded-For decides.
test('a hop count lets a direct client choose its address; the list form does not', async () => {
  assert.equal(await ipSeen({ TRUST_PROXY: '1' }, '198.51.100.77'), '198.51.100.77', 'direct client, count: its own choice');
  assert.equal(await ipSeen({ TRUST_PROXY: '10.9.9.9' }, '198.51.100.77'), '127.0.0.1', 'direct client, list: its real address');
});

test('a hop count warns at startup, the list form and unset do not', () => {
  const warned = env => {
    const lines = [];
    applyTrustProxy(express(), env, { warn: m => lines.push(m) });
    return lines;
  };
  for (const v of ['1', 'true', '2']) {
    const lines = warned({ TRUST_PROXY: v });
    assert.equal(lines.length, 1, v);
    assert.match(lines[0], /hop count/);
    assert.match(lines[0], /addresses or subnets/);
  }
  assert.deepEqual(warned({ TRUST_PROXY: 'loopback, 172.16.0.0/12' }), []);
  assert.deepEqual(warned({ TRUST_PROXY: '10.0.0.2' }), []);
  assert.deepEqual(warned({}), []);
  assert.equal(trustProxyWarning(undefined), null);
  assert.equal(trustProxyWarning('loopback'), null);
});

test('a TRUST_PROXY Express cannot read stops startup', () => {
  for (const v of ['not-an-address', '-1', '1.5', '300.1.1.1']) {
    assert.throws(() => applyTrustProxy(express(), { TRUST_PROXY: v }), /TRUST_PROXY/, v);
  }
});

// ── The sign-in throttle (routes/auth.js) ─────────────────────────────────
let sqlite = true;
try { req('better-sqlite3'); } catch { sqlite = false; }
let dir = null, authRoutes = null;
if (sqlite) {
  dir = mkdtempSync(join(tmpdir(), 'nt-trust-proxy-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const db = (await import('../server/db.js')).default;
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('someone', 'x', 'admin')`).run();
  authRoutes = (await import('../server/routes/auth.js')).default;
}
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

async function loginServer(env) {
  const app = express();
  applyTrustProxy(app, env);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return serve(app);
}
// A new username each time, so only the per-address bucket is in play.
let n = 0;
const attempt = (s, xff) => fetch(`${s.url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
  body: JSON.stringify({ username: `guess-${n++}`, password: 'wrong' }),
}).then(r => r.status);

test('behind a proxy with TRUST_PROXY, one visitor\'s guesses do not lock out the next', async (t) => {
  if (!sqlite) return t.skip('better-sqlite3 is not built for this Node');
  const s = await loginServer({ TRUST_PROXY: '1' });
  try {
    for (let i = 0; i < 10; i++) assert.equal(await attempt(s, '198.51.100.1'), 401);
    assert.equal(await attempt(s, '198.51.100.1'), 429, 'the guesser is throttled');
    assert.equal(await attempt(s, '198.51.100.2'), 401, 'someone else still gets to try');
    assert.equal(await attempt(s, '9.9.9.9, 198.51.100.1'), 429, 'a typed X-Forwarded-For entry does not reset the count');
  } finally { s.close(); }
});

test('an IPv6 visitor cannot rotate addresses inside its /64 to get fresh tries', async (t) => {
  if (!sqlite) return t.skip('better-sqlite3 is not built for this Node');
  const s = await loginServer({ TRUST_PROXY: '1' });
  try {
    for (let i = 1; i <= 10; i++) assert.equal(await attempt(s, `2001:db8:5:6::${i.toString(16)}`), 401);
    assert.equal(await attempt(s, '2001:db8:5:6:ffff:ffff:ffff:ffff'), 429, 'same /64, new address');
    assert.equal(await attempt(s, '2001:db8:5:7::1'), 401, 'the next /64 is someone else');
  } finally { s.close(); }
});

test('without TRUST_PROXY, every visitor behind the proxy shares one bucket (why it exists)', async (t) => {
  if (!sqlite) return t.skip('better-sqlite3 is not built for this Node');
  const s = await loginServer({});
  try {
    for (let i = 0; i < 10; i++) await attempt(s, '198.51.100.3');
    assert.equal(await attempt(s, '198.51.100.4'), 429);
  } finally { s.close(); }
});
