/**
 * The openGym bridge's NutriTrace endpoints, run on a scratch database
 * with the real middleware and routes:
 *   - POST /api/v1/activity: one row per (user, external_id) however often
 *     or concurrently it is posted; edits update that row, a date change
 *     moves it; DELETE /api/v1/activity/external/:id soft-deletes, and a
 *     re-post brings the same row back;
 *   - POST /api/v1/activity/batch: bounded, per-item results, upserts and
 *     deletes in one request;
 *   - source 'opengym' rows are shown but not counted on a day a wearable
 *     reports active calories, whatever the policy, and carry covered_by;
 *   - a person's edit or delete of a bridge row (web or phone) is never
 *     written over by the bridge; other integrations' rows keep their key
 *     and source through an app edit;
 *   - GET /api/v1/body-stats: kg per day, polling by updated_since;
 *   - POST /api/v1/body-measurements: writes the weight the diary and the
 *     adaptive TDEE read, takes the date as sent, never the server's
 *     timezone, mirrors to wellness and fires body_stat.logged;
 *   - scopes: each route needs its own scope;
 *   - the migration moves 'external:<id>' keys into external_id and folds
 *     duplicates before the unique index goes on.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const req = createRequire(new URL('../server/package.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nt-bridge-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.UPLOADS_PATH = join(dir, 'uploads');
process.env.WEBHOOKS_ENABLED = '1';
process.env.ALLOW_PRIVATE_WEBHOOK_URLS = '1';
delete process.env.HUB_JWKS;
delete process.env.HUB_ISSUER;

// No skipping: without a working better-sqlite3 this import throws and the
// file fails.
const db = (await import('../server/db.js')).default;
const auth = await import('../server/middleware/auth.js');
const { createToken } = await import('../server/lib/api-tokens.js');
const { createWebhook } = await import('../server/lib/webhooks.js');
const { BATCH_MAX_ITEMS } = await import('../server/routes/api/v1/activity.js');
const { default: apiV1Routes } = await import('../server/routes/api/v1/index.js');
const { default: activityRoutes } = await import('../server/routes/activity.js');
const { default: syncRoutes } = await import('../server/routes/sync.js');
const { default: dataRoutes } = await import('../server/routes/data.js');
const { default: backupRoutes } = await import('../server/routes/full-backup.js');
const { claimAnonymousData } = await import('../server/lib/claim-anonymous-data.js');

const express = req('express');
const cookieParser = req('cookie-parser');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(auth.authenticate);
app.use('/api/v1', apiV1Routes);
app.use('/api/activity', activityRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/full-backup', backupRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

let userSeq = 0;
const newUser = () => {
  const id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(`bridge-${++userSeq}`, 'x', 'user').lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const SYNC_SCOPES = ['write:activity', 'read:body-stats', 'write:body-measurements'];
const pat = (user, scopes = SYNC_SCOPES) => createToken({ userId: user.id, name: 'bridge', scopes }).raw;

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
const rowsFor = (user, externalId) => db.prepare('SELECT * FROM activity_log WHERE user_id = ? AND external_id = ?').all(user.id, externalId);
const workout = (extra = {}) => ({ date: '2026-10-14', name: 'Push day', kcal: 190, duration_min: 58, external_id: 'og:w:lq2k9x7a1b', source: 'opengym', ...extra });
const wearable = (user, date, source, kcal) => db.prepare(
  `INSERT INTO wellness_data (user_id, date, source, metric_type, value) VALUES (?, ?, ?, 'active_calories', ?)`
).run(user.id, date, source, kcal);

// ── Activity: idempotent upsert ───────────────────────────────────────────
test('the same external_id posted 10 times makes one row', async () => {
  const user = newUser();
  const token = pat(user);
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await call('/api/v1/activity', { method: 'POST', token, body: workout() })).body.status);
  assert.deepEqual(statuses, ['created', ...Array(9).fill('unchanged')]);
  const rows = rowsFor(user, 'og:w:lq2k9x7a1b');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'opengym');
  assert.equal(rows[0].kcal, 190);
});

test('10 concurrent first posts of one external_id still make one row', async () => {
  const user = newUser();
  const token = pat(user);
  const results = await Promise.all(Array.from({ length: 10 }, () => call('/api/v1/activity', { method: 'POST', token, body: workout() })));
  assert.ok(results.every(r => r.status === 201 || r.status === 200));
  assert.equal(results.filter(r => r.body.status === 'created').length, 1);
  assert.equal(rowsFor(user, 'og:w:lq2k9x7a1b').length, 1);
});

test('the key is unique in the database too', () => {
  const user = newUser();
  const insert = () => db.prepare(`INSERT INTO activity_log (user_id, date, name, kcal, source, external_id) VALUES (?, '2026-10-14', 'x', 1, 'opengym', 'og:w:dup')`).run(user.id);
  insert();
  assert.throws(insert, /UNIQUE/);
});

test('an edit updates the row in place, a date change moves it, and nothing is duplicated', async () => {
  const user = newUser();
  const token = pat(user);
  const created = await call('/api/v1/activity', { method: 'POST', token, body: workout() });
  assert.equal(created.status, 201);
  const edited = await call('/api/v1/activity', { method: 'POST', token, body: workout({ kcal: 240, name: 'Push day (longer)' }) });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.status, 'updated');
  assert.equal(edited.body.activity_id, created.body.activity_id);
  assert.equal(edited.body.daily_total_kcal, 240);
  const moved = await call('/api/v1/activity', { method: 'POST', token, body: workout({ kcal: 240, name: 'Push day (longer)', date: '2026-10-13' }) });
  assert.equal(moved.body.status, 'updated');
  const rows = rowsFor(user, 'og:w:lq2k9x7a1b');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-13');
  assert.equal(rows[0].kcal, 240);
  // The old day no longer counts it.
  const day = await call('/api/v1/activity', { method: 'POST', token, body: { date: '2026-10-14', name: 'Walk', kcal: 50 } });
  assert.equal(day.body.daily_total_kcal, 50);
});

test('DELETE soft-deletes by key, is idempotent, and a re-post brings the same row back', async () => {
  const user = newUser();
  const token = pat(user);
  const created = await call('/api/v1/activity', { method: 'POST', token, body: workout() });
  const del = await call('/api/v1/activity/external/og:w:lq2k9x7a1b', { method: 'DELETE', token });
  assert.equal(del.status, 200);
  assert.deepEqual(
    { deleted: del.body.deleted, activity_id: del.body.activity_id, date: del.body.date, daily_total_kcal: del.body.daily_total_kcal },
    { deleted: true, activity_id: created.body.activity_id, date: '2026-10-14', daily_total_kcal: 0 },
  );
  assert.ok(rowsFor(user, 'og:w:lq2k9x7a1b')[0].deleted_at);
  assert.equal((await call('/api/v1/activity/external/og:w:lq2k9x7a1b', { method: 'DELETE', token })).body.deleted, false);
  assert.equal((await call('/api/v1/activity/external/og:w:never', { method: 'DELETE', token })).body.deleted, false);
  const back = await call('/api/v1/activity', { method: 'POST', token, body: workout() });
  assert.equal(back.status, 201);
  assert.equal(back.body.status, 'created');
  assert.equal(back.body.activity_id, created.body.activity_id);
  const rows = rowsFor(user, 'og:w:lq2k9x7a1b');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deleted_at, null);
});

test("one user's key never touches another user's row", async () => {
  const a = newUser(), b = newUser();
  await call('/api/v1/activity', { method: 'POST', token: pat(a), body: workout() });
  await call('/api/v1/activity', { method: 'POST', token: pat(b), body: workout({ kcal: 300 }) });
  assert.equal((await call('/api/v1/activity/external/og:w:lq2k9x7a1b', { method: 'DELETE', token: pat(b) })).body.deleted, true);
  assert.equal(rowsFor(a, 'og:w:lq2k9x7a1b')[0].deleted_at, null);
  assert.equal(rowsFor(a, 'og:w:lq2k9x7a1b')[0].kcal, 190);
});

test('validation: bad fields are 400 with a stable code', async () => {
  const token = pat(newUser());
  const post = body => call('/api/v1/activity', { method: 'POST', token, body });
  assert.equal((await post(workout({ date: '2026-02-30' }))).body.code, 'bad_date');
  assert.equal((await post(workout({ kcal: 10001 }))).body.code, 'bad_kcal');
  assert.equal((await post(workout({ duration_min: -1 }))).body.code, 'bad_duration');
  assert.equal((await post(workout({ name: ' ' }))).body.code, 'bad_name');
  assert.equal((await post(workout({ external_id: { a: 1 } }))).body.code, 'bad_external_id');
});

test('an external_id over 128 characters is cut to 128, as before the key column, never refused', async () => {
  const user = newUser();
  const token = pat(user);
  const long = `og:w:${'x'.repeat(200)}`;
  const first = await call('/api/v1/activity', { method: 'POST', token, body: workout({ external_id: long }) });
  assert.equal(first.status, 201);
  const again = await call('/api/v1/activity', { method: 'POST', token, body: workout({ external_id: long, kcal: 200 }) });
  assert.equal(again.body.status, 'updated', 'the same long id finds its row');
  assert.equal(again.body.activity_id, first.body.activity_id);
  const rows = rowsFor(user, long.slice(0, 128));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_id.length, 128);
  const del = await call(`/api/v1/activity/external/${long}`, { method: 'DELETE', token });
  assert.equal(del.body.deleted, true, 'DELETE cuts the key the same way');
  const batch = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: [workout({ external_id: long })] } });
  assert.deepEqual([batch.body.results[0].status, batch.body.results[0].external_id], ['created', long.slice(0, 128)]);
});

// ── Batch ─────────────────────────────────────────────────────────────────
test(`batch: at most ${BATCH_MAX_ITEMS} items, and the body must be { items: [] }`, async () => {
  const token = pat(newUser());
  const items = n => Array.from({ length: n }, (_, i) => workout({ external_id: `og:w:b${i}` }));
  const over = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: items(BATCH_MAX_ITEMS + 1) } });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'too_many_items');
  assert.equal((await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: 'x' } })).body.code, 'bad_body');
  assert.equal((await call('/api/v1/activity/batch', { method: 'POST', token, body: {} })).body.code, 'bad_body');
  const full = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: items(BATCH_MAX_ITEMS) } });
  assert.equal(full.status, 200);
  assert.equal(full.body.results.length, BATCH_MAX_ITEMS);
  assert.ok(full.body.results.every(r => r.status === 'created'));
});

test('batch: upserts and deletes in one request, one result per item, in order', async () => {
  const user = newUser();
  const token = pat(user);
  await call('/api/v1/activity', { method: 'POST', token, body: workout({ external_id: 'og:w:old' }) });
  const res = await call('/api/v1/activity/batch', {
    method: 'POST', token, body: {
      items: [
        workout({ external_id: 'og:w:new' }),
        workout({ external_id: 'og:w:new', kcal: 210 }),
        { op: 'delete', external_id: 'og:w:old' },
        { op: 'delete', external_id: 'og:w:missing' },
        workout({ external_id: 'og:w:bad', kcal: -5 }),
        { ...workout(), external_id: undefined },
        { op: 'merge', external_id: 'og:w:x' },
        null,
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map(r => [r.external_id, r.status, r.code ?? null]), [
    ['og:w:new', 'created', null],
    ['og:w:new', 'updated', null],
    ['og:w:old', 'deleted', null],
    ['og:w:missing', 'not_found', null],
    ['og:w:bad', 'error', 'bad_kcal'],
    [null, 'error', 'bad_external_id'],
    ['og:w:x', 'error', 'bad_op'],
    [null, 'error', 'bad_external_id'],
  ]);
  assert.equal(rowsFor(user, 'og:w:new').length, 1);
  assert.equal(rowsFor(user, 'og:w:new')[0].kcal, 210);
  assert.ok(rowsFor(user, 'og:w:old')[0].deleted_at);
  assert.equal(rowsFor(user, 'og:w:bad').length, 0);
});

// ── Wearable covers bridge rows ───────────────────────────────────────────
test('a wearable day: the bridge row is shown, not counted, whatever the policy, and says what covers it', async () => {
  const user = newUser();
  const token = pat(user);
  const cookie = auth.signToken(user);
  await call('/api/v1/activity', { method: 'POST', token, body: workout({ kcal: 190 }) });

  const sum = async policy => (await call(`/api/activity/sum/2026-10-14?policy=${policy}`, { cookie })).body;
  // No wearable yet: the bridge row counts.
  assert.equal((await sum('wearable_wins')).effective, 190);
  assert.equal((await sum('wearable_wins')).covered_by, null);
  let rows = (await call('/api/activity/2026-10-14', { cookie })).body;
  assert.equal(rows[0].covered_by, null);

  wearable(user, '2026-10-14', 'garmin', 420);
  wearable(user, '2026-10-14', 'fitbit', 380);
  for (const policy of ['wearable_wins', 'manual_wins', 'additive']) {
    const s = await sum(policy);
    assert.equal(s.effective, 420, policy);
    assert.equal(s.wearable, 420);
    assert.equal(s.manual, 190, 'still listed');
    assert.equal(s.covered_by, 'garmin');
  }
  rows = (await call('/api/activity/2026-10-14', { cookie })).body;
  assert.equal(rows.length, 1, 'the row is still shown');
  assert.equal(rows[0].covered_by, 'garmin');
  const range = (await call('/api/activity?from=2026-10-01&to=2026-10-31', { cookie })).body;
  assert.equal(range[0].covered_by, 'garmin');

  // A person's own manual entry keeps the policy it always had.
  const manual = await call('/api/activity', { method: 'POST', cookie, body: { date: '2026-10-14', name: 'Swim', kcal: 100 } });
  assert.equal(manual.status, 201);
  assert.equal((await sum('additive')).effective, 520, 'wearable + manual, not the bridge row');
  assert.equal((await sum('manual_wins')).effective, 100);
  assert.equal((await sum('wearable_wins')).effective, 420);
  rows = (await call('/api/activity/2026-10-14', { cookie })).body;
  assert.equal(rows.find(r => r.name === 'Swim').covered_by, null);
});

// ── A person's edit wins over the bridge ──────────────────────────────────
test('an edit to a bridge row in the app is never written over by the bridge', async () => {
  const user = newUser();
  const token = pat(user);
  const cookie = auth.signToken(user);
  const created = await call('/api/v1/activity', { method: 'POST', token, body: workout() });
  const id = created.body.activity_id;

  // Re-saving without a change is not an edit.
  await call(`/api/activity/${id}`, { method: 'PUT', cookie, body: {} });
  assert.equal(db.prepare('SELECT user_edited_at FROM activity_log WHERE id = ?').get(id).user_edited_at, null);

  const put = await call(`/api/activity/${id}`, { method: 'PUT', cookie, body: { kcal: 250 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.source, 'opengym', 'the app edit keeps the source');
  assert.equal(put.body.external_id, 'og:w:lq2k9x7a1b');
  assert.ok(put.body.user_edited_at);

  const again = await call('/api/v1/activity', { method: 'POST', token, body: workout({ kcal: 205, name: 'Push day v2' }) });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'user_edited');
  assert.equal(again.body.updated, false);
  const row = db.prepare('SELECT * FROM activity_log WHERE id = ?').get(id);
  assert.equal(row.kcal, 250);
  assert.equal(row.name, 'Push day');
  const batch = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: [workout({ kcal: 1 })] } });
  assert.equal(batch.body.results[0].status, 'user_edited');
  assert.equal(db.prepare('SELECT kcal FROM activity_log WHERE id = ?').get(id).kcal, 250);
});

test('a bridge row deleted in the app stays deleted', async () => {
  const user = newUser();
  const token = pat(user);
  const cookie = auth.signToken(user);
  const created = await call('/api/v1/activity', { method: 'POST', token, body: workout() });
  assert.equal((await call(`/api/activity/${created.body.activity_id}`, { method: 'DELETE', cookie })).status, 200);
  const again = await call('/api/v1/activity', { method: 'POST', token, body: workout({ kcal: 300 }) });
  assert.equal(again.body.status, 'user_edited');
  const row = rowsFor(user, 'og:w:lq2k9x7a1b')[0];
  assert.ok(row.deleted_at, 'not brought back');
  assert.ok(row.user_edited_at);
});

test('an edit or delete pushed from the phone counts as the person\'s edit too', async () => {
  const user = newUser();
  const token = pat(user);
  const cookie = auth.signToken(user);
  const edit = await call('/api/v1/activity', { method: 'POST', token, body: workout({ external_id: 'og:w:phone-edit' }) });
  const gone = await call('/api/v1/activity', { method: 'POST', token, body: workout({ external_id: 'og:w:phone-del' }) });
  const later = new Date(Date.now() + 1000).toISOString().replace('Z', '+00:00');
  const push = await call('/api/sync/push', {
    method: 'POST', cookie, body: {
      activity: [
        { client_id: 1, server_id: edit.body.activity_id, date: '2026-10-14', name: 'Push day', kcal: 260, duration_min: 58, source: 'manual_form', updated_at: later },
        { client_id: 2, server_id: gone.body.activity_id, deleted_at: later, updated_at: later },
      ],
    },
  });
  assert.equal(push.status, 200);
  const edited = rowsFor(user, 'og:w:phone-edit')[0];
  assert.equal(edited.kcal, 260);
  assert.equal(edited.source, 'opengym', 'the phone cannot change an integration row\'s source');
  assert.ok(edited.user_edited_at);
  assert.ok(rowsFor(user, 'og:w:phone-del')[0].user_edited_at);
  assert.equal((await call('/api/v1/activity', { method: 'POST', token, body: workout({ external_id: 'og:w:phone-edit', kcal: 1 }) })).body.status, 'user_edited');
  assert.equal((await call('/api/v1/activity', { method: 'POST', token, body: workout({ external_id: 'og:w:phone-del', kcal: 1 }) })).body.status, 'user_edited');
});

test("every integration: the person's edit wins over its updates, the row keeps its key and source", async () => {
  const user = newUser();
  const token = pat(user);
  const cookie = auth.signToken(user);
  const ride = { date: '2026-10-14', name: 'Ride', kcal: 300, external_id: 'strava:1' };
  const created = await call('/api/v1/activity', { method: 'POST', token, body: ride });
  // Updates before any edit go through.
  assert.equal((await call('/api/v1/activity', { method: 'POST', token, body: { ...ride, kcal: 310 } })).body.status, 'updated');
  const put = await call(`/api/activity/${created.body.activity_id}`, { method: 'PUT', cookie, body: { kcal: 320 } });
  assert.equal(put.body.source, 'external');
  assert.equal(put.body.external_id, 'strava:1');
  assert.ok(put.body.user_edited_at);
  const again = await call('/api/v1/activity', { method: 'POST', token, body: { ...ride, kcal: 330 } });
  assert.equal(again.body.status, 'user_edited');
  const batch = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: [{ ...ride, kcal: 340 }] } });
  assert.equal(batch.body.results[0].status, 'user_edited');
  assert.equal(rowsFor(user, 'strava:1')[0].kcal, 320);
  assert.equal(rowsFor(user, 'strava:1').length, 1);
});

test('a delete from the integration removes the row even after the person edited it', async () => {
  const user = newUser();
  const token = pat(user);
  const cookie = auth.signToken(user);
  for (const body of [workout({ external_id: 'og:w:edited-then-gone' }), { date: '2026-10-14', name: 'Ride', kcal: 300, external_id: 'strava:gone' }]) {
    const created = await call('/api/v1/activity', { method: 'POST', token, body });
    await call(`/api/activity/${created.body.activity_id}`, { method: 'PUT', cookie, body: { kcal: 999 } });
    assert.ok(rowsFor(user, body.external_id)[0].user_edited_at, 'edited first');
    const del = await call(`/api/v1/activity/external/${body.external_id}`, { method: 'DELETE', token });
    assert.equal(del.body.deleted, true, body.external_id);
    assert.ok(rowsFor(user, body.external_id)[0].deleted_at);
    // And it stays gone: the row is still the person's.
    assert.equal((await call('/api/v1/activity', { method: 'POST', token, body })).body.status, 'user_edited');
  }
  const viaBatch = await call('/api/v1/activity', { method: 'POST', token, body: workout({ external_id: 'og:w:batch-gone' }) });
  await call(`/api/activity/${viaBatch.body.activity_id}`, { method: 'PUT', cookie, body: { kcal: 5 } });
  const batch = await call('/api/v1/activity/batch', { method: 'POST', token, body: { items: [{ op: 'delete', external_id: 'og:w:batch-gone' }] } });
  assert.equal(batch.body.results[0].status, 'deleted');
});

test('an integration row without a key keeps its source through an app edit', async () => {
  const user = newUser();
  const cookie = auth.signToken(user);
  const id = Number(db.prepare(`INSERT INTO activity_log (user_id, date, name, kcal, source) VALUES (?, '2026-10-14', 'Lift', 150, 'opengym')`).run(user.id).lastInsertRowid);
  const put = await call(`/api/activity/${id}`, { method: 'PUT', cookie, body: { kcal: 160 } });
  assert.equal(put.body.source, 'opengym', 'still a bridge row, still covered on a wearable day');
});

test('"Clear all data" counts as deleting every integration row: no integration brings them back', async () => {
  const user = newUser();
  const token = pat(user);
  const cookie = auth.signToken(user);
  const ride = { date: '2026-10-14', name: 'Ride', kcal: 300, external_id: 'strava:9' };
  await call('/api/v1/activity', { method: 'POST', token, body: workout() });
  await call('/api/v1/activity', { method: 'POST', token, body: ride });
  assert.equal((await call('/api/data', { method: 'DELETE', cookie })).status, 200);
  assert.equal((await call('/api/v1/activity', { method: 'POST', token, body: workout() })).body.status, 'user_edited');
  assert.equal((await call('/api/v1/activity', { method: 'POST', token, body: ride })).body.status, 'user_edited');
  assert.ok(rowsFor(user, 'og:w:lq2k9x7a1b')[0].deleted_at);
  assert.ok(rowsFor(user, 'strava:9')[0].deleted_at);
});

test('claiming anonymous data: an account row with the same key wins, the claim does not fail', () => {
  const user = newUser();
  db.prepare(`INSERT INTO activity_log (user_id, date, name, kcal, source, external_id) VALUES (NULL, '2026-10-14', 'anon', 100, 'opengym', 'og:w:claim')`).run();
  db.prepare(`INSERT INTO activity_log (user_id, date, name, kcal, source, external_id) VALUES (NULL, '2026-10-14', 'anon only', 120, 'opengym', 'og:w:claim-only')`).run();
  db.prepare(`INSERT INTO activity_log (user_id, date, name, kcal, source, external_id) VALUES (?, '2026-10-14', 'mine', 200, 'opengym', 'og:w:claim')`).run(user.id);
  claimAnonymousData(user.id);
  const rows = db.prepare(`SELECT name, external_id, deleted_at IS NOT NULL AS deleted FROM activity_log WHERE user_id = ? AND name IN ('anon', 'anon only', 'mine') ORDER BY name`).all(user.id);
  assert.deepEqual(rows, [
    { name: 'anon', external_id: null, deleted: 1 },
    { name: 'anon only', external_id: 'og:w:claim-only', deleted: 0 },
    { name: 'mine', external_id: 'og:w:claim', deleted: 0 },
  ]);
});

// ── Body stats ────────────────────────────────────────────────────────────
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const setDiary = (user, date, bodyStats, updatedAt = sqlNow(), extra = {}) => db.prepare(
  `INSERT INTO diary (user_id, date, items, body_stats, water, updated_at, deleted_at) VALUES (?, ?, '[]', ?, '[]', ?, ?)
   ON CONFLICT(date, user_id) DO UPDATE SET body_stats = excluded.body_stats, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`
).run(user.id, date, JSON.stringify(bodyStats), updatedAt, extra.deleted_at ?? null);

test('body-stats: one kg value per day from the diary weight, its unit tag honoured', async () => {
  const user = newUser();
  const token = pat(user);
  setDiary(user, '2026-10-01', { weight: 80, weight_unit: 'kg' });
  setDiary(user, '2026-10-02', { weight: 176.4, weight_unit: 'lb' });
  setDiary(user, '2026-10-03', { body_fat: 20 });                     // no weight: left out
  setDiary(user, '2026-10-04', { weight: 79.5 });                      // untagged legacy
  setDiary(user, '2026-10-05', { weight: 81, weight_unit: 'kg' }, sqlNow(), { deleted_at: sqlNow() });
  const res = await call('/api/v1/body-stats', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map(i => [i.date, i.weight_kg]), [
    ['2026-10-01', 80],
    ['2026-10-02', 80.01],
    ['2026-10-04', 36.06], // untagged reads as the app shows it: lb by default
  ]);
  assert.equal(res.body.total, 3);
  assert.match(res.body.items[0].updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'weightUnit', '"kg"')`).run(user.id);
  const kgUser = await call('/api/v1/body-stats?from=2026-10-04&to=2026-10-04', { token });
  assert.deepEqual(kgUser.body.items.map(i => i.weight_kg), [79.5], 'untagged in a kg profile is kg');
});

test('body-stats: from/to, limit/offset and bad parameters', async () => {
  const user = newUser();
  const token = pat(user);
  for (let d = 1; d <= 9; d++) setDiary(user, `2026-09-0${d}`, { weight: 70 + d, weight_unit: 'kg' });
  const page = await call('/api/v1/body-stats?from=2026-09-02&to=2026-09-08&limit=3&offset=3', { token });
  assert.deepEqual(page.body.items.map(i => i.date), ['2026-09-05', '2026-09-06', '2026-09-07']);
  assert.deepEqual([page.body.total, page.body.limit, page.body.offset], [7, 3, 3]);
  const bad = async (q, code) => {
    const r = await call(`/api/v1/body-stats?${q}`, { token });
    assert.equal(r.status, 400, q);
    assert.equal(r.body.code, code, q);
  };
  await bad('from=2026-9-1', 'bad_date');
  await bad('to=2026-02-30', 'bad_date');
  await bad('from=2026-09-05&to=2026-09-01', 'bad_range');
  await bad('updated_since=yesterday', 'bad_updated_since');
  await bad('updated_since=2026-10-14T10:00:00', 'bad_updated_since'); // no zone: refused, never read as server time
  await bad('limit=0', 'bad_limit');
  await bad('limit=1001', 'bad_limit');
  await bad('offset=-1', 'bad_offset');
});

test('body-stats polling: updated_since is inclusive, oldest change first, and shows a removed weight', async () => {
  const user = newUser();
  const token = pat(user);
  setDiary(user, '2026-10-10', { weight: 80, weight_unit: 'kg' }, '2026-10-14 08:00:00');
  setDiary(user, '2026-10-11', { weight: 79, weight_unit: 'kg' }, '2026-10-14 07:00:00');
  setDiary(user, '2026-10-12', { weight: 78, weight_unit: 'kg' }, '2026-10-13 07:00:00');
  setDiary(user, '2026-10-13', { body_fat: 19 }, '2026-10-14 09:00:00');          // weight removed / food-only day
  setDiary(user, '2026-10-09', { weight: 81, weight_unit: 'kg' }, '2026-10-14 09:30:00', { deleted_at: '2026-10-14 09:30:00' });

  // 10:00 in Bucharest (UTC+3) is 07:00 UTC: inclusive bound.
  const res = await call('/api/v1/body-stats?updated_since=2026-10-14T10:00:00%2B03:00', { token });
  assert.deepEqual(res.body.items, [
    { date: '2026-10-11', weight_kg: 79, updated_at: '2026-10-14T07:00:00Z' },
    { date: '2026-10-10', weight_kg: 80, updated_at: '2026-10-14T08:00:00Z' },
    { date: '2026-10-13', weight_kg: null, updated_at: '2026-10-14T09:00:00Z' },
    { date: '2026-10-09', weight_kg: null, updated_at: '2026-10-14T09:30:00Z' },
  ]);
  const later = await call('/api/v1/body-stats?updated_since=2026-10-14T09:00:00.900Z', { token });
  assert.deepEqual(later.body.items.map(i => i.date), ['2026-10-13', '2026-10-09'], 'milliseconds round down, so the bound stays inclusive');
  const ranged = await call('/api/v1/body-stats?updated_since=2026-10-14T00:00:00Z&from=2026-10-10&to=2026-10-11', { token });
  assert.deepEqual(ranged.body.items.map(i => i.date), ['2026-10-11', '2026-10-10']);
});

const decodeCursor = c => JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
const pollAll = async (token, start, limit, maxRounds) => {
  const seen = [];
  let query = `updated_since=${encodeURIComponent(start)}`;
  for (let round = 1; round <= maxRounds; round++) {
    const r = await call(`/api/v1/body-stats?${query}&limit=${limit}`, { token });
    assert.equal(r.status, 200);
    seen.push(...r.body.items);
    if (!r.body.has_more) return { seen, rounds: round, last: r.body };
    query = `cursor=${r.body.next_cursor}`;
  }
  assert.fail(`polling did not finish in ${maxRounds} rounds`);
};

test('body-stats polling pages through any number of rows sharing one second (keyset cursor)', async () => {
  const user = newUser();
  const token = pat(user);
  for (let d = 1; d <= 9; d++) setDiary(user, `2025-03-0${d}`, { weight: 70 + d, weight_unit: 'kg' }, '2025-03-10 12:00:00');
  const { seen, rounds } = await pollAll(token, '2025-03-10T00:00:00Z', 2, 10);
  assert.deepEqual(seen.map(i => i.date), Array.from({ length: 9 }, (_, i) => `2025-03-0${i + 1}`), 'every row once, in date order');
  assert.equal(rounds, 5);
});

test('body-stats polling after "Clear all data" on 300 days sees every removal (review repro)', async () => {
  const user = newUser();
  const token = pat(user);
  const cookie = auth.signToken(user);
  const dates = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
  for (const d of dates) setDiary(user, d, { weight: 80, weight_unit: 'kg' }, '2026-01-01 00:00:00');
  const start = '2026-01-02T00:00:00Z';
  assert.equal((await call('/api/data', { method: 'DELETE', cookie })).status, 200);   // every day stamped in one second

  await new Promise(r => setTimeout(r, 1100));   // that second is over
  const { seen, rounds } = await pollAll(token, start, 200, 5);
  assert.equal(rounds, 2);
  assert.equal(new Set(seen.map(i => i.date)).size, 300, 'all 300 removals seen');
  assert.ok(seen.every(i => i.weight_kg === null));
});

test('body-stats polling: the cursor never moves into the current second or later', async () => {
  const user = newUser();
  const token = pat(user);
  setDiary(user, '2025-05-01', { weight: 70, weight_unit: 'kg' }, '2025-05-02 00:00:00');
  // A row the clock has not passed yet: a write can still land in its
  // second under an earlier date, so the cursor stops before it and the
  // row comes again.
  setDiary(user, '2025-04-30', { weight: 71, weight_unit: 'kg' }, '2999-01-01 00:00:00');
  for (let i = 0; i < 2; i++) {
    const r = await call('/api/v1/body-stats?updated_since=2025-05-01T00:00:00Z', { token });
    assert.deepEqual(r.body.items.map(x => x.date), ['2025-05-01', '2025-04-30']);
    assert.deepEqual(decodeCursor(r.body.next_cursor), { u: '2025-05-02 00:00:00', d: '2025-05-01' });
    const next = await call(`/api/v1/body-stats?cursor=${r.body.next_cursor}`, { token });
    assert.deepEqual(next.body.items.map(x => x.date), ['2025-04-30'], 'comes again');
  }
  // More such rows than the limit: has_more stays false, so a poller
  // waits for its next round instead of spinning on the same page.
  setDiary(user, '2025-04-29', { weight: 72, weight_unit: 'kg' }, '2999-01-01 00:00:00');
  const held = await call('/api/v1/body-stats?updated_since=2025-05-02T00:00:01Z&limit=1', { token });
  assert.equal(held.body.items.length, 1);
  assert.equal(held.body.total, 2);
  assert.equal(held.body.has_more, false);
  assert.deepEqual(decodeCursor(held.body.next_cursor), { u: '2025-05-02 00:00:01', d: '' });
});

test('body-stats polling: cursor errors', async () => {
  const token = pat(newUser());
  const bad = async (q, code) => {
    const r = await call(`/api/v1/body-stats?${q}`, { token });
    assert.equal(r.status, 400, q);
    assert.equal(r.body.code, code, q);
  };
  const cursor = Buffer.from(JSON.stringify({ u: '2026-01-01 00:00:00', d: '2025-01-01' })).toString('base64url');
  await bad('cursor=not-a-cursor', 'bad_cursor');
  await bad(`cursor=${Buffer.from(JSON.stringify({ u: 'yesterday', d: '' })).toString('base64url')}`, 'bad_cursor');
  await bad(`cursor=${cursor}&updated_since=2026-01-01T00:00:00Z`, 'bad_cursor');
  await bad(`cursor=${cursor}&offset=5`, 'bad_offset');
  assert.equal((await call(`/api/v1/body-stats?cursor=${cursor}`, { token })).status, 200);
});

// ── Body measurements (P4) ────────────────────────────────────────────────
const setTz = tz => {
  process.env.TZ = tz;
  // Guard: the zone really changed for this process.
  const offset = new Date('2026-10-14T12:00:00Z').getTimezoneOffset();
  assert.equal(offset, tz === 'UTC' ? 0 : -180, `TZ ${tz} took effect`);
};
const originalTz = process.env.TZ;
test.after(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

test('body-measurements writes the weight the diary and adaptive TDEE read, and keeps weight_kg', async () => {
  const user = newUser();
  const token = pat(user);
  setDiary(user, '2026-10-14', { weight: 200, weight_unit: 'lb', notes: 'keep me', body_fat: 20 });
  const res = await call('/api/v1/body-measurements', { method: 'POST', token, body: { date: '2026-10-14', weight: 78.456, source: 'opengym' } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.stored, ['weight', 'weight_kg']);
  const bs = JSON.parse(db.prepare('SELECT body_stats FROM diary WHERE user_id = ? AND date = ?').get(user.id, '2026-10-14').body_stats);
  assert.equal(bs.weight, 78.46);
  assert.equal(bs.weight_unit, 'kg', 'the whole weight is replaced, so its tag is too');
  assert.equal(bs.weight_kg, 78.456);
  assert.equal(bs.notes, 'keep me');
  assert.equal(bs.body_fat, 20);
  assert.equal(bs._last_source, 'opengym');
  const wellness = db.prepare(`SELECT value FROM wellness_data WHERE user_id = ? AND date = ? AND source = 'federation' AND metric_type = 'weight_kg'`).get(user.id, '2026-10-14');
  assert.equal(wellness.value, 78.456);
  // And it reads back through the polling route.
  assert.deepEqual((await call('/api/v1/body-stats?from=2026-10-14&to=2026-10-14', { token })).body.items.map(i => i.weight_kg), [78.46]);
});

test('body-measurements: the date is taken as sent, whatever the server timezone', async () => {
  const user = newUser();
  const token = pat(user);
  for (const tz of ['Europe/Bucharest', 'UTC']) {
    setTz(tz);
    const sent = await call('/api/v1/body-measurements', { method: 'POST', token, body: { date: '2026-10-14', measured_at: '2026-10-13T22:30:00Z', weight: 80 } });
    assert.equal(sent.body.date, '2026-10-14', `${tz}: date wins`);
    // No date, no timezone setting: the day written in measured_at.
    const written = await call('/api/v1/body-measurements', { method: 'POST', token, body: { measured_at: '2026-10-15T01:30:00+03:00', weight: 80 } });
    assert.equal(written.body.date, '2026-10-15', `${tz}: the device's own day`);
    const stats = await call('/api/v1/body-stats', { token });
    assert.deepEqual(stats.body.items.map(i => i.date), ['2026-10-14', '2026-10-15'], tz);
  }
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'timezone', '"Europe/Bucharest"')`).run(user.id);
  for (const tz of ['UTC', 'Europe/Bucharest']) {
    setTz(tz);
    // 22:30 UTC is 01:30 the next day in Bucharest: the user's day.
    const r = await call('/api/v1/body-measurements', { method: 'POST', token, body: { measured_at: '2026-10-15T22:30:00Z', weight: 80 } });
    assert.equal(r.body.date, '2026-10-16', `${tz}: the user's timezone`);
    // A time with no zone is the device's wall clock: its written day.
    const wall = await call('/api/v1/body-measurements', { method: 'POST', token, body: { measured_at: '2026-10-17 23:30:00', weight: 80 } });
    assert.equal(wall.body.date, '2026-10-17', `${tz}: a zoneless time keeps its day`);
  }
});

test('body-measurements: date or measured_at required, both validated', async () => {
  const token = pat(newUser());
  const post = body => call('/api/v1/body-measurements', { method: 'POST', token, body });
  assert.equal((await post({ weight: 80 })).body.code, 'bad_measured_at');
  assert.equal((await post({ date: '2026-02-30', weight: 80 })).body.code, 'bad_date');
  assert.equal((await post({ date: 20261014, weight: 80 })).body.code, 'bad_date');
  assert.equal((await post({ measured_at: 'soon', weight: 80 })).body.code, 'bad_measured_at');
  assert.equal((await post({ date: '2026-10-14' })).body.code, 'no_fields');
  assert.equal((await post({ date: '2026-10-14', weight: 5000 })).body.code, 'out_of_range');
});

test('body-measurements refuses a day erased in the app', async () => {
  const user = newUser();
  setDiary(user, '2026-10-14', { weight: 80, weight_unit: 'kg' }, sqlNow(), { deleted_at: sqlNow() });
  const res = await call('/api/v1/body-measurements', { method: 'POST', token: pat(user), body: { date: '2026-10-14', weight: 79 } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'diary_tombstoned');
  assert.equal(JSON.parse(db.prepare('SELECT body_stats FROM diary WHERE user_id = ? AND date = ?').get(user.id, '2026-10-14').body_stats).weight, 80);
});

test('body-measurements fires body_stat.logged', async () => {
  const user = newUser();
  let resolve;
  const received = new Promise(r => { resolve = r; });
  const hook = createServer((rq, rs) => {
    let raw = '';
    rq.on('data', c => { raw += c; });
    rq.on('end', () => { rs.end('ok'); resolve({ headers: rq.headers, body: JSON.parse(raw) }); });
  }).listen(0);
  try {
    await createWebhook({ userId: user.id, url: `http://127.0.0.1:${hook.address().port}/hook`, events: ['body_stat.logged'] });
    const res = await call('/api/v1/body-measurements', { method: 'POST', token: pat(user), body: { date: '2026-10-14', weight: 77 } });
    assert.equal(res.status, 201);
    const delivery = await Promise.race([received, new Promise((_, rej) => setTimeout(() => rej(new Error('no webhook')), 5000))]);
    assert.equal(delivery.body.event, 'body_stat.logged');
    assert.equal(delivery.body.data.date, '2026-10-14');
    assert.equal(delivery.body.data.stats.weight, 77);
    assert.equal(delivery.body.data.stats.weight_unit, 'kg');
  } finally {
    hook.close();
  }
});

// ── Scopes ────────────────────────────────────────────────────────────────
test('each bridge route needs its own scope', async () => {
  const user = newUser();
  const only = scope => pat(user, [scope]);
  const cases = [
    ['GET', '/api/v1/body-stats', undefined, 'read:body-stats'],
    ['POST', '/api/v1/activity', workout(), 'write:activity'],
    ['POST', '/api/v1/activity/batch', { items: [] }, 'write:activity'],
    ['DELETE', '/api/v1/activity/external/og:w:x', undefined, 'write:activity'],
    ['POST', '/api/v1/body-measurements', { date: '2026-10-14', weight: 80 }, 'write:body-measurements'],
  ];
  for (const [method, path, body, scope] of cases) {
    const other = SYNC_SCOPES.find(s => s !== scope);
    const refused = await call(path, { method, body, token: only(other) });
    assert.equal(refused.status, 403, `${method} ${path} without ${scope}`);
    assert.equal(refused.body.code, 'auth_scope');
    const allowed = await call(path, { method, body, token: only(scope) });
    assert.ok(allowed.status >= 200 && allowed.status < 300, `${method} ${path} with ${scope}: ${allowed.status}`);
  }
  assert.equal((await call('/api/v1/body-stats')).status, 401);
});

// ── Migration ─────────────────────────────────────────────────────────────
test("migration: 'external:<id>' keys move to external_id and duplicates fold before the unique index", () => {
  const migDir = mkdtempSync(join(tmpdir(), 'nt-bridge-mig-'));
  const dbUrl = new URL('../server/db.js', import.meta.url).href;
  const env = { ...process.env, DB_PATH: join(migDir, 'test.db'), UPLOADS_PATH: join(migDir, 'uploads') };
  const run = code => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    // An upstream database: the full schema, then the two new columns and
    // the index taken off again, with rows as the old route wrote them.
    const lastLine = out => out.split('\n').at(-1);
    const before = JSON.parse(lastLine(run(`
      const db = (await import(${JSON.stringify(dbUrl)})).default;
      db.exec('DROP INDEX idx_activity_external');
      db.exec('ALTER TABLE activity_log DROP COLUMN external_id');
      db.exec('ALTER TABLE activity_log DROP COLUMN user_edited_at');
      const u = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('m', 'x', 'user')").run().lastInsertRowid);
      const add = (owner, date, source, deleted, updated) => db.prepare(
        "INSERT INTO activity_log (user_id, date, name, kcal, source, deleted_at, updated_at) VALUES (?, ?, 'x', 1, ?, ?, ?)"
      ).run(owner, date, source, deleted, updated);
      const t = '2026-10-10 00:00:00';
      add(u, '2026-10-09', 'external:og:w:a', null, t);                    // 1 the later day, the lower id
      add(u, '2026-10-05', 'external:og:w:a', '2026-10-06 00:00:00', t);   // 2 deleted
      add(u, '2026-10-02', 'external:og:w:a', null, t);                    // 3 the earlier day, a copy
      add(u, '2026-10-01', 'external:og:w:b', '2026-10-01 00:00:00', '2026-10-01 00:00:00'); // 4
      add(u, '2026-10-02', 'external:og:w:b', '2026-10-05 00:00:00', '2026-10-05 00:00:00'); // 5 deleted last
      add(u, '2026-10-14', 'external', null, t);                           // 6
      add(u, '2026-10-14', 'manual_form', null, t);                        // 7
      add(null, '2026-10-14', 'external:og:w:c', null, t);                 // 8 single-user
      add(null, '2026-10-13', 'external:og:w:c', null, t);                 // 9
      // The row the old upsert updated for each key (its exact lookup).
      const found = (owner, key) => (owner == null
        ? db.prepare('SELECT id FROM activity_log WHERE user_id IS NULL AND source = ? AND deleted_at IS NULL').get(key)
        : db.prepare('SELECT id FROM activity_log WHERE user_id = ? AND source = ? AND deleted_at IS NULL').get(owner, key)).id;
      console.log(JSON.stringify({ a: found(u, 'external:og:w:a'), c: found(null, 'external:og:w:c') }));
      db.close();
    `)));
    const out = run(`
      const db = (await import(${JSON.stringify(dbUrl)})).default;
      console.log(JSON.stringify(db.prepare('SELECT id, source, external_id, deleted_at IS NOT NULL AS deleted FROM activity_log ORDER BY id').all()));
      db.close();
    `);
    assert.match(out, /folded 4 duplicate row\(s\)/, 'the fold is logged');
    assert.deepEqual(before, { a: 1, c: 8 }, 'the old lookup resolved the lowest live id');
    assert.deepEqual(JSON.parse(lastLine(out)), [
      { id: 1, source: 'external', external_id: 'og:w:a', deleted: 0 }, // the row the old code kept updating
      { id: 2, source: 'external', external_id: null, deleted: 1 },
      { id: 3, source: 'external', external_id: null, deleted: 1 },     // the copy on another day: folded
      { id: 4, source: 'external', external_id: null, deleted: 1 },
      { id: 5, source: 'external', external_id: 'og:w:b', deleted: 1 }, // no live row: the last changed keeps it
      { id: 6, source: 'external', external_id: null, deleted: 0 },
      { id: 7, source: 'manual_form', external_id: null, deleted: 0 },
      { id: 8, source: 'external', external_id: 'og:w:c', deleted: 0 },
      { id: 9, source: 'external', external_id: null, deleted: 1 },
    ]);
  } finally {
    rmSync(migDir, { recursive: true, force: true });
  }
});

// Last: a restore replaces the whole database.
test('restoring an older backup keeps the row each key resolved to, as the migration does', async () => {
  const admin = newUser();
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(admin.id);
  const cookie = auth.signToken({ ...admin, role: 'admin' });
  const made = await call('/api/full-backup', { method: 'POST', cookie });
  assert.equal(made.status, 200);

  // As the old route wrote them: the key in source, a deleted row and the
  // live one the next post made.
  const AdmZip = req('adm-zip');
  const backups = join(dir, 'uploads', 'backups');
  const zip = new AdmZip(join(backups, made.body.filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  const old = { user_id: admin.id, date: '2026-10-14', name: 'Push day', duration_min: 58, distance: null, met: null, is_template: 0, created_at: '2026-10-14 08:00:00', updated_at: '2026-10-14 08:00:00' };
  data.activity_log = [
    { ...old, id: 900001, kcal: 190, source: 'external:og:w:twin', deleted_at: '2026-10-14 09:00:00' },
    { ...old, id: 900002, kcal: 210, source: 'external:og:w:twin', deleted_at: null },
    { ...old, id: 900003, kcal: 50, source: 'external:og:w:solo', deleted_at: null },
    { ...old, id: 900004, date: '2026-10-15', kcal: 60, source: 'external:og:w:pair', deleted_at: null },
    { ...old, id: 900005, date: '2026-10-12', kcal: 60, source: 'external:og:w:pair', deleted_at: null },
  ];
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  zip.writeZip(join(backups, 'nutritrace-backup-legacy.zip'));

  const restored = await call('/api/full-backup/nutritrace-backup-legacy.zip/restore', { method: 'POST', cookie });
  assert.equal(restored.status, 200);
  assert.deepEqual(
    db.prepare('SELECT id, source, external_id, deleted_at IS NOT NULL AS deleted FROM activity_log ORDER BY id').all(),
    [
      { id: 900001, source: 'external', external_id: null, deleted: 1 },
      { id: 900002, source: 'external', external_id: 'og:w:twin', deleted: 0 },
      { id: 900003, source: 'external', external_id: 'og:w:solo', deleted: 0 },
      { id: 900004, source: 'external', external_id: 'og:w:pair', deleted: 0 }, // the lowest live id
      { id: 900005, source: 'external', external_id: null, deleted: 1 },
    ],
  );
});
