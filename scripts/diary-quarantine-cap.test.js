/**
 * The quarantine holds at most QUARANTINE_MAX_PER_USER days per person
 * (server/lib/diary-quarantine.js). Past it a batch writer skips the bad day,
 * names it in `quarantine_full`, and the rest of the batch still lands. The
 * unit side (admitDiaryDay, the migration ignoring the cap) is in
 * diary-quarantine.test.js; this is every batch writer through the real server.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { QUARANTINE_MAX_PER_USER } from '../server/lib/diary-quarantine.js';
import { startServer } from './fixtures/contract/server.mjs';

const srv = await startServer({ file: import.meta.url });
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const Database = serverRequire('better-sqlite3');
const AdmZip = serverRequire('adm-zip');
const db = new Database(join(srv.dir, 'server.db'));
db.pragma('busy_timeout = 5000');
test.after(async () => { db.close(); await srv.stop(); });

const owner = db.prepare(`SELECT id FROM users WHERE username = 'contract'`).get().id;
const held = () => db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine WHERE user_id = ?').get(owner).n;
const dates = () => db.prepare('SELECT date FROM diary ORDER BY date').all().map(r => r.date);
const item = uuid => ({ uuid, meal: 0, name: `Item ${uuid}`, nutrition: { calories: 100 }, addedAt: '2026-10-14T07:30:00.000Z' });

// Leave room for two more.
const prefill = db.prepare(`INSERT INTO diary_quarantine (user_id, date, payload, source) VALUES (?, 'garbage', '{}', 'earlier')`);
for (let i = 0; i < QUARANTINE_MAX_PER_USER - 2; i++) prefill.run(owner);

test('Android push: the bad days past the cap are named in quarantine_full, and the rest of the batch lands', async () => {
  const diary = [
    { client_id: 'bad-0', date: '2026-02-30', items: [item('bad-0')], body_stats: {}, water: [] },
    { client_id: 'good-1', date: '2026-10-14', items: [item('good-1')], body_stats: {}, water: [] },
    { client_id: 'bad-1', date: 'garbage', items: [], body_stats: {}, water: [] },
    { client_id: 'bad-2', date: '2026-04-31', items: [], body_stats: {}, water: [] },
    { client_id: 'bad-3', date: '2026-13-01', items: [], body_stats: {}, water: [] },
    { client_id: 'good-2', date: '2024-02-29', items: [item('good-2')], body_stats: {}, water: [] },
  ];
  const r = await srv.api('POST', '/api/sync/push', { diary });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.quarantined_diary.map(d => d.client_id), ['bad-0', 'bad-1']);
  assert.deepEqual(r.body.quarantine_full, [{ client_id: 'bad-2', date: '2026-04-31' }, { client_id: 'bad-3', date: '2026-13-01' }]);
  assert.deepEqual(r.body.diary.map(d => d.client_id), ['good-1', 'good-2']);
  assert.deepEqual(dates(), ['2024-02-29', '2026-10-14']);
  assert.equal(held(), QUARANTINE_MAX_PER_USER);
});

test('Android push: a weight reading under a bad date, once the quarantine is full, is named and not mirrored', async () => {
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'mirrorWellnessWeight', 'true')`).run(owner);
  const wellness = [
    { date: '2026-02-30', source: 'health_connect', metric_type: 'weight_kg', value: 80 },
    { date: '2026-10-16', source: 'health_connect', metric_type: 'weight_kg', value: 79 },
  ];
  const r = await srv.api('POST', '/api/sync/push', { wellness });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.quarantined_diary, r.body.quarantine_full], [[], [{ date: '2026-02-30' }]]);
  assert.equal(r.body.wellness.length, 2, 'the wellness rows themselves are saved');
  assert.ok(dates().includes('2026-10-16'), 'a real date still mirrors');
  assert.equal(dates().includes('2026-02-30'), false);
  assert.equal(held(), QUARANTINE_MAX_PER_USER);
});

test('JSON import: past the cap the bad days are named in quarantine_full, the good ones import', async () => {
  const diary = [
    { date: 'not-a-date', items: [item('imp-bad')] },
    { date: '2026-09-01', items: [item('imp-1')] },
    { date: '2025-02-29', items: [] },
  ];
  const r = await srv.api('POST', '/api/data/import', { diary });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, quarantined_diary: [], quarantine_full: [{ date: 'not-a-date' }, { date: '2025-02-29' }] });
  assert.ok(dates().includes('2026-09-01'));
  assert.equal(held(), QUARANTINE_MAX_PER_USER);
});

test('backup restore: past the cap a bad day is named in quarantine_full, the rest of the backup is restored', async () => {
  const made = await srv.api('POST', '/api/full-backup');
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const zipPath = join(srv.dir, 'uploads', 'backups', made.body.filename);
  const zip = new AdmZip(zipPath);
  const data = JSON.parse(zip.readAsText('database.json'));
  const row = date => ({ id: null, user_id: owner, date, items: JSON.stringify([item(`r-${date}`)]), body_stats: '{}', water: '[]', notes: null, completed_at: null, completed_meals: null, updated_at: '2026-10-01 10:00:00', deleted_at: null });
  data.diary.push(row('2026-02-30'), row('2026-08-01'));
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  zip.writeZip(zipPath);

  const restored = await srv.api('POST', `/api/full-backup/${made.body.filename}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(restored.body, { ok: true, quarantined_diary: [], quarantine_full: [{ date: '2026-02-30' }] });
  assert.ok(dates().includes('2026-08-01'));
  assert.equal(dates().includes('2026-02-30'), false);
  assert.equal(held(), QUARANTINE_MAX_PER_USER, 'the backup\'s own quarantine rows are restored, not duplicated, and none added');
});
