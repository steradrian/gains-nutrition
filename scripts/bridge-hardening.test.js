/**
 * Bridge hardening (the openGym sync's endpoints and what they rely on):
 *   - the hub token replay cache fails closed when full: 503 with
 *     Retry-After, never an eviction that would reopen a jti;
 *   - GET /api/v1/body-stats polling reads one page through an index, not
 *     the user's whole diary;
 *   - a new external_id over 128 characters is refused (bridge-endpoints
 *     .test.js has the legacy-row case);
 *   - kcal must be a number (or a numeric string), name a string;
 *   - a re-post without source keeps the row's stored source;
 *   - a batch spends one unit of the rate limit per item;
 *   - on a hub instance, diary items never pick up an unowned row, whatever
 *     its visibility;
 *   - a restore without hub links keeps a current link only when the
 *     restored account under its id has the same username.
 *
 * The express server is made on first use, so the cases that only need the
 * database run without it.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const ISSUER = 'https://hub.test/bridge';
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.HUB_JWKS = JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'b1', alg: 'ES256', use: 'sig' }] });
process.env.HUB_ISSUER = ISSUER;

const req = createRequire(new URL('../server/package.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nt-bridge-hardening-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.UPLOADS_PATH = join(dir, 'uploads');
delete process.env.API_RATE_LIMIT_PER_MIN;
delete process.env.HUB_SYNC_RATE_LIMIT_PER_MIN;

const db = (await import('../server/db.js')).default;
const auth = await import('../server/middleware/auth.js');
const hub = await import('../server/lib/hub-auth.js');
const diaryHelpers = await import('../server/lib/diary-helpers.js');
const { createToken } = await import('../server/lib/api-tokens.js');

let server = null, base = null;
async function http() {
  if (base) return base;
  const express = req('express');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(req('cookie-parser')());
  app.use(auth.authenticate);
  app.use('/api/v1', (await import('../server/routes/api/v1/index.js')).default);
  app.use('/api/full-backup', (await import('../server/routes/full-backup.js')).default);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
test.after(() => { server?.close(); hub.setReplayCacheMaxForTests(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

// ── Helpers ───────────────────────────────────────────────────────────────
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
function hubToken(sub, extra = {}) {
  const claims = {
    iss: ISSUER, aud: 'nutritrace', sub, scope: 'sync', act: 'bridge',
    iat: now(), exp: now() + 60, jti: crypto.randomBytes(16).toString('base64url'), ...extra,
  };
  const input = `${b64({ alg: 'ES256', kid: 'b1', typ: 'JWT' })}.${b64(claims)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
let seq = 0;
const newUser = (username = `bh-${++seq}`, role = 'user') => {
  const id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'x', role).lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const pat = user => createToken({ userId: user.id, name: 'bridge', scopes: ['write:activity', 'read:body-stats', 'write:body-measurements'] }).raw;
async function call(path, { token, method = 'GET', body } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch((await http()) + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}
const workout = (extra = {}) => ({ date: '2026-10-14', name: 'Push day', kcal: 190, external_id: `og:w:${++seq}`, source: 'opengym', ...extra });
const rows = (user, key) => db.prepare('SELECT * FROM activity_log WHERE user_id = ? AND external_id = ?').all(user.id, key);
const countFor = user => db.prepare('SELECT COUNT(*) n FROM activity_log WHERE user_id = ?').get(user.id).n;

// ── 1. Replay cache: fail closed ──────────────────────────────────────────
test('a full replay cache refuses new tokens instead of evicting a jti, and a replay stays a replay', () => {
  const config = hub.hubConfig();
  const t0 = now() + 100_000; // ahead of every other entry, so they are trimmed
  const at = (sub, s = t0) => hubToken(sub, { iat: s, exp: s + 60 });
  hub.setReplayCacheMaxForTests(2);
  try {
    const first = at('og-a'), second = at('og-b');
    assert.equal(hub.verifyHubToken(first, config, t0).ok, true);
    assert.equal(hub.verifyHubToken(second, config, t0).ok, true);
    assert.equal(hub.replayCacheSize(), 2);
    assert.equal(hub.verifyHubToken(at('og-c'), config, t0).reason, 'replay_cache_full');
    assert.equal(hub.replayCacheSize(), 2, 'nothing was evicted');
    assert.equal(hub.verifyHubToken(first, config, t0 + 1).reason, 'replay', 'the first token is still spent');
    assert.equal(hub.replayCacheRetryAfter(t0), 91, 'room once the oldest entry (exp + 30 s) goes');
    // Once the entries expire there is room again.
    const later = t0 + 91;
    assert.equal(hub.verifyHubToken(at('og-d', later), config, later).ok, true);
  } finally { hub.setReplayCacheMaxForTests(); }
});

test('over HTTP a full replay cache is 503 with Retry-After, and the next token goes through once there is room', async () => {
  const linked = () => db.prepare(`SELECT COUNT(*) n FROM user_hub_links WHERE sub = 'og-full'`).get().n;
  hub.setReplayCacheMaxForTests(0);
  let full;
  try {
    full = await call('/api/v1/activity', { method: 'POST', token: hubToken('og-full'), body: workout() });
  } finally { hub.setReplayCacheMaxForTests(); }
  assert.equal(full.status, 503);
  assert.equal(full.body.code, 'hub_replay_cache_full');
  assert.ok(Number(full.headers.get('retry-after')) >= 1);
  assert.equal(linked(), 0, 'refused before anything happened, not even the account');
  const ok = await call('/api/v1/activity', { method: 'POST', token: hubToken('og-full'), body: workout() });
  assert.equal(ok.status, 201);
  assert.equal(linked(), 1);
});

// ── 2. Body-stats polling reads one page ──────────────────────────────────
test('body-stats polling runs its keyset and LIMIT in SQL on idx_diary_user_changed', async () => {
  const user = newUser();
  const put = db.prepare(`INSERT INTO diary (user_id, date, body_stats, updated_at) VALUES (?, ?, ?, ?)`);
  // 300 days, each changed at its own second, oldest first.
  const day = i => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
  const stamp = i => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString().slice(0, 19).replace('T', ' ');
  for (let i = 0; i < 300; i++) put.run(user.id, day(i), JSON.stringify({ weight: 80, weight_unit: 'kg' }), stamp(i));
  const token = pat(user);

  const seen = [];
  const prepare = db.prepare;
  db.prepare = function (sql) { seen.push(sql); return prepare.call(this, sql); };
  let first;
  try {
    first = await call('/api/v1/body-stats?updated_since=2026-01-01T00:00:00Z&limit=100', { token });
  } finally { db.prepare = prepare; }
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 100);
  assert.equal(first.body.total, 300);
  assert.equal(first.body.has_more, true);

  const pageSql = seen.find(s => /FROM diary/.test(s) && /LIMIT \?/.test(s));
  assert.ok(pageSql, 'the page query has a LIMIT');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${pageSql}`).all(user.id, 'x', 'x', '', 100).map(r => r.detail).join(' | ');
  assert.match(plan, /idx_diary_user_changed \(user_id=\? AND <expr>>\?\)/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, 'no sort: the index gives the order');
  const countSql = seen.find(s => /COUNT\(\*\)/.test(s) && /FROM diary/.test(s));
  const countPlan = db.prepare(`EXPLAIN QUERY PLAN ${countSql}`).all(user.id, 'x', 'x', '').map(r => r.detail).join(' | ');
  // A range from the cursor on the same index. (Newer SQLite calls it a
  // covering index; the one better-sqlite3 bundles reads the row too.)
  assert.match(countPlan, /USING (COVERING )?INDEX idx_diary_user_changed \(user_id=\? AND <expr>>\?\)/, countPlan);

  // Paging through gives every day once, in change order.
  const dates = first.body.items.map(i => i.date);
  let cursor = first.body.next_cursor, more = first.body.has_more;
  while (more) {
    const page = await call(`/api/v1/body-stats?cursor=${cursor}&limit=100`, { token });
    dates.push(...page.body.items.map(i => i.date));
    cursor = page.body.next_cursor;
    more = page.body.has_more;
  }
  assert.deepEqual(dates, Array.from({ length: 300 }, (_, i) => day(i)));
});

// ── 3/4. Keys and types ───────────────────────────────────────────────────
test('kcal must be a number (or a numeric string) and name a string; null, true and objects are 400', async () => {
  const user = newUser();
  const token = pat(user);
  const post = body => call('/api/v1/activity', { method: 'POST', token, body: workout(body) });
  for (const kcal of [null, true, false, {}, [], [5], '', ' ', 'abc', '12abc', 'NaN', 'Infinity']) {
    const r = await post({ kcal });
    assert.equal(r.status, 400, `kcal ${JSON.stringify(kcal)}`);
    assert.equal(r.body.code, 'bad_kcal', `kcal ${JSON.stringify(kcal)}`);
  }
  for (const name of [5, true, {}, ['Run'], null]) {
    const r = await post({ name });
    assert.equal(r.status, 400, `name ${JSON.stringify(name)}`);
    assert.equal(r.body.code, 'bad_name');
  }
  assert.equal((await post({ duration_min: true })).body.code, 'bad_duration');
  assert.equal(countFor(user), 0, 'nothing written');
  // Well-formed requests work as before, including a numeric string.
  assert.equal((await post({ kcal: 270 })).status, 201);
  assert.equal((await post({ kcal: 270.6 })).body.kcal, 271);
  assert.equal((await post({ kcal: '270' })).body.kcal, 270);
  assert.equal((await post({ kcal: 0 })).status, 201);
  const batch = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: [workout({ kcal: null }), workout()] } });
  assert.deepEqual(batch.body.results.map(r => [r.status, r.code ?? null]), [['error', 'bad_kcal'], ['created', null]]);
});

// ── 5. Source ─────────────────────────────────────────────────────────────
test('a re-post without source keeps the stored source; an explicit one still decides', async () => {
  const user = newUser();
  const token = pat(user);
  const w = workout();
  const { source, ...noSource } = w;
  await call('/api/v1/activity', { method: 'POST', token, body: w });
  assert.equal((await call('/api/v1/activity', { method: 'POST', token, body: noSource })).body.status, 'unchanged', 'same content, source left out');
  const changed = await call('/api/v1/activity', { method: 'POST', token, body: { ...noSource, kcal: 250 } });
  assert.equal(changed.body.status, 'updated');
  assert.equal(rows(user, w.external_id)[0].source, 'opengym', 'still an openGym row');
  await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: [{ ...noSource, kcal: 260 }] } });
  assert.equal(rows(user, w.external_id)[0].source, 'opengym', 'the batch keeps it too');
  await call('/api/v1/activity', { method: 'POST', token, body: { ...noSource, kcal: 260, source: 'garmin' } });
  assert.equal(rows(user, w.external_id)[0].source, 'external', 'an explicit non-openGym source still makes it external');
  const fresh = workout({ source: undefined });
  await call('/api/v1/activity', { method: 'POST', token, body: fresh });
  assert.equal(rows(user, fresh.external_id)[0].source, 'external', 'a new row without source is external, as before');
});

// ── 6. Rate limit per batch item ──────────────────────────────────────────
test('a batch spends one unit of the rate limit per item, all or nothing', async () => {
  const user = newUser();
  const token = pat(user); // 60 a minute
  const items = n => Array.from({ length: n }, () => workout());
  const a = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: items(30) } });
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('x-ratelimit-remaining'), '30');
  const b = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: items(40) } });
  assert.equal(b.status, 429, '30 + 40 > 60');
  assert.equal(b.body.code, 'rate_limited');
  assert.ok(Number(b.headers.get('retry-after')) >= 1);
  assert.equal(countFor(user), 30, 'nothing of the refused batch was written');
  // The refused batch cost its one request; 29 items still fit.
  assert.equal((await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: items(29) } })).status, 200);
  assert.equal((await call('/api/v1/activity', { method: 'POST', token, body: workout() })).status, 429, 'the minute is spent');
  assert.equal(countFor(user), 59);

  const big = await call('/api/v1/activity/batch', { method: 'POST', token: pat(newUser()), body: { items: items(61) } });
  assert.equal(big.status, 400);
  assert.equal(big.body.code, 'batch_over_rate_limit');
});

test('the hub sync token\'s full batch of 100 costs 100 of its 600 a minute', async () => {
  const items = Array.from({ length: 100 }, () => workout());
  const res = await call('/api/v1/activity/batch', { method: 'POST', token: hubToken('og-batch'), body: { items } });
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 100);
  assert.equal(res.headers.get('x-ratelimit-limit'), '600');
  assert.equal(res.headers.get('x-ratelimit-remaining'), '500');
});

// ── 8. Diary items on a hub instance ──────────────────────────────────────
test('hub instance: a diary item never picks up an unowned row, even one marked group', () => {
  const reader = newUser(), friend = newUser();
  const food = (owner, name, visibility, img, category) => db.prepare(
    `INSERT INTO foods (user_id, name, visibility, img_url, category) VALUES (?, ?, ?, ?, ?)`
  ).run(owner, name, visibility, img, category).lastInsertRowid;
  const orphanId = food(null, 'Orphan Oats', 'group', '/uploads/orphan.jpg', 'orphan-cat');
  const sharedId = food(friend.id, 'Shared Rice', 'group', '/uploads/shared.jpg', 'grains');
  const item = (id, name) => ({ id, name, nutrition: {}, quantity: 1 });
  assert.equal(hub.hubInstance(), true);
  const [orphanImg, sharedImg] = diaryHelpers.freshenItemImages([item(orphanId, 'Orphan Oats'), item(sharedId, 'Shared Rice')], reader.id);
  assert.equal(orphanImg.imgUrl, '', 'the unowned group row is nobody\'s on a hub');
  assert.equal(sharedImg.imgUrl, '/uploads/shared.jpg', 'a friend\'s group row still is shared');
  const [orphanCat, sharedCat] = diaryHelpers.hydrateItems([item(orphanId, 'Orphan Oats'), item(sharedId, 'Shared Rice')], reader.id);
  assert.notEqual(orphanCat.category, 'orphan-cat');
  assert.equal(sharedCat.category, 'grains');
});

// ── 9. Restore without hub links ──────────────────────────────────────────
test('a restore without hub links keeps a link only for the same account (id and username)', async () => {
  const admin = newUser('bh-admin', 'admin');
  const kept = newUser('bh-kept');
  const swapped = newUser('bh-swapped');
  const link = (user, sub) => db.prepare('INSERT INTO user_hub_links (user_id, issuer, sub) VALUES (?, ?, ?)').run(user.id, ISSUER, sub);
  link(admin, 'og-restore-admin');
  link(kept, 'og-restore-kept');
  link(swapped, 'og-restore-swapped');

  // The backup routes need an admin: the admin, through the hub.
  const admTok = () => hubToken('og-restore-admin', { scope: 'user' });
  const backup = await call('/api/full-backup', { method: 'POST', token: admTok() });
  assert.equal(backup.status, 200);

  // Another instance's backup: no hub links, and the account under
  // swapped's id is somebody else.
  const AdmZip = req('adm-zip');
  const backups = join(dir, 'uploads', 'backups');
  const zip = new AdmZip(join(backups, backup.body.filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  delete data.user_hub_links;
  data.users = data.users.map(u => (u.id === swapped.id ? { ...u, username: 'someone-else' } : u));
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  zip.writeZip(join(backups, 'nutritrace-backup-elsewhere.zip'));

  const restored = await call('/api/full-backup/nutritrace-backup-elsewhere.zip/restore', { method: 'POST', token: admTok() });
  assert.equal(restored.status, 200);
  const subFor = id => db.prepare('SELECT sub FROM user_hub_links WHERE user_id = ?').get(id)?.sub ?? null;
  assert.equal(subFor(kept.id), 'og-restore-kept', 'same id, same username: kept');
  assert.equal(subFor(admin.id), 'og-restore-admin');
  assert.equal(subFor(swapped.id), null, 'same id, different person: dropped');
  assert.equal(db.prepare(`SELECT username FROM users WHERE id = ?`).get(swapped.id).username, 'someone-else');
});
