/**
 * The backup restore cleans names like every other write path (see
 * clean-names.test.js): foods, meals and their ingredients, diary items,
 * activity and workout names, and the four name settings. A backup made
 * before names were cleaned can hold a NUL or a tab anywhere in them.
 *
 * A name setting that is only control characters is left out of the restore
 * (the others land). And a backup holding a deleted food or meal next to a
 * live one with the same source stamp restores both: the unique index on the
 * stamp leaves deleted rows out, so INSERT OR IGNORE no longer drops one.
 *
 * The real server, a real backup file edited the way diary-date-writers.test.js does.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';

const srv = await startServer({ file: import.meta.url });
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const Database = serverRequire('better-sqlite3');
const AdmZip = serverRequire('adm-zip');
const db = new Database(join(srv.dir, 'server.db'));
db.pragma('busy_timeout = 5000');
test.after(async () => { db.close(); await srv.stop(); });

const owner = db.prepare(`SELECT id FROM users WHERE username = 'contract'`).get().id;
const DIRTY = 'Ra\u0000w\toats\u0007\n';
const CLEAN = 'Raw oats';
const KEPT = ['🍪 Snacks', '👩‍🍳 Cook', '🇨🇭 Swiss', '朝ごはん', 'وجبة', 'Frühstück'];
const AT = '2026-10-01 10:00:00';

async function restoreWith(edit) {
  const made = await srv.api('POST', '/api/full-backup');
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const zipPath = join(srv.dir, 'uploads', 'backups', made.body.filename);
  const zip = new AdmZip(zipPath);
  const data = JSON.parse(zip.readAsText('database.json'));
  edit(data);
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  zip.writeZip(zipPath);
  const restored = await srv.api('POST', `/api/full-backup/${made.body.filename}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
}

const food = (id, over = {}) => ({
  id, user_id: owner, name: 'Food', brand: null, nutrition: '{}', portion: 100, unit: 'g', img_url: null, notes: null,
  category: null, barcode: null, created_at: AT, updated_at: AT, ...over,
});
const meal = (id, over = {}) => ({
  id, user_id: owner, name: 'Meal', nutrition: '{}', items: '[]', img_url: null, notes: null, is_recipe: 0, portion: 100, unit: 'g',
  created_at: AT, updated_at: AT, ...over,
});

test('restore: food, meal, diary, activity and workout names are cleaned, Unicode stays', async () => {
  await restoreWith(data => {
    data.foods.push(food(9001, { name: DIRTY, brand: 'Br\u0000and', category: 'Gr\tains' }), ...KEPT.map((name, i) => food(9010 + i, { name })));
    data.meals.push(meal(9001, { name: 'Me\u0000al', items: JSON.stringify([{ name: 'Mi\u0000lk', brand: 'B\trand' }]) }), meal(9002, { name: KEPT[1] }));
    data.diary.push({
      id: 9001, user_id: owner, date: '2026-10-20', body_stats: '{}', water: '[]', updated_at: AT,
      items: JSON.stringify([{ uuid: 'r-1', name: 'Eg\u0000g', items: [{ name: 'Yo\tlk' }] }, { uuid: 'r-2', name: KEPT[3] }]),
    });
    data.activity_log.push({ id: 9001, user_id: owner, date: '2026-10-20', name: 'Sw\u0000im\tlaps', kcal: 100, duration_min: null, distance: null, source: 'manual_form', created_at: AT, updated_at: AT });
    data.workouts.push({
      id: 9001, user_id: owner, source: 'health_connect', source_id: 'w9001', date: '2026-10-20', activity_type: null, activity_name: 'Ru\u0000n',
      start_time: null, duration_ms: null, distance_km: null, calories: null, avg_hr: null, max_hr: null, steps: null, has_gps: 0, gps_data: null, synced_at: AT, updated_at: AT,
    });
  });
  assert.deepEqual(db.prepare('SELECT name, brand, category FROM foods WHERE id = 9001').get(), { name: CLEAN, brand: 'Brand', category: 'Gr ains' });
  assert.deepEqual(db.prepare('SELECT name FROM foods WHERE id >= 9010 ORDER BY id').all().map(r => r.name), KEPT);
  const m = db.prepare('SELECT name, items FROM meals WHERE id = 9001').get();
  assert.deepEqual([m.name, JSON.parse(m.items)], ['Meal', [{ name: 'Milk', brand: 'B rand' }]]);
  assert.equal(db.prepare('SELECT name FROM meals WHERE id = 9002').get().name, KEPT[1]);
  const items = JSON.parse(db.prepare(`SELECT items FROM diary WHERE id = 9001`).get().items);
  assert.deepEqual(items, [{ uuid: 'r-1', name: 'Egg', items: [{ name: 'Yo lk' }] }, { uuid: 'r-2', name: KEPT[3] }]);
  assert.equal(db.prepare('SELECT name FROM activity_log WHERE id = 9001').get().name, 'Swim laps');
  assert.equal(db.prepare('SELECT activity_name FROM workouts WHERE id = 9001').get().activity_name, 'Run');
});

test('restore: the four name settings are cleaned, a setting of only control characters is left out, the others land', async () => {
  const setting = (key, value) => ({ user_id: owner, key, value: JSON.stringify(value), updated_at: AT });
  await restoreWith(data => {
    data.user_settings.push(
      setting('mealNames', ['Break\u0000fast', 'Lun\tch', '🍪 Snacks']),
      setting('foodCategories', [{ name: 'Fr\u0007uit', label: '🍎\u0000' }]),
      setting('customUnits', [{ abbr: 'sc\u0000p', full: 'sco\nop' }]),
      setting('customNutriments', [{ id: 'custom_om\u0000ega', label: 'Om\u0000ega', unit: 'g' }]),
      setting('aiSystemPrompt', 'Line one\nLine\ttwo'),
    );
  });
  const stored = key => JSON.parse(db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(owner, key).value);
  assert.deepEqual(stored('mealNames'), ['Breakfast', 'Lun ch', '🍪 Snacks']);
  assert.deepEqual(stored('foodCategories'), [{ name: 'Fruit', label: '🍎' }]);
  assert.deepEqual(stored('customUnits'), [{ abbr: 'scp', full: 'scoop' }]);
  assert.deepEqual(stored('customNutriments'), [{ id: 'custom_omega', label: 'Omega', unit: 'g' }]);
  assert.equal(stored('aiSystemPrompt'), 'Line one\nLine\ttwo', 'a setting that is not a name keeps its newlines');

  await restoreWith(data => {
    data.user_settings = data.user_settings.filter(s => !['mealNames', 'language'].includes(s.key));
    data.user_settings.push(setting('mealNames', ['Fine', '\u0000\u0001']), setting('language', 'de'));
  });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM user_settings WHERE user_id = ? AND key = 'mealNames'`).get(owner).n, 0, 'left out');
  assert.equal(stored('language'), 'de', 'the rest of the settings are restored');
  assert.deepEqual(stored('customUnits'), [{ abbr: 'scp', full: 'scoop' }]);
});

test('restore: a deleted row and a live one with the same source stamp are both restored', async () => {
  await restoreWith(data => {
    const stamp = { source_app: 'cooktrace', source_external_id: 'pantry:99' };
    data.foods.push(
      food(9101, { name: 'Old pantry', ...stamp, deleted_at: '2026-10-02 00:00:00' }),
      food(9102, { name: 'New pantry', ...stamp }),
    );
    data.meals.push(
      meal(9101, { name: 'Old recipe', ...stamp, deleted_at: '2026-10-02 00:00:00' }),
      meal(9102, { name: 'New recipe', ...stamp }),
    );
  });
  assert.deepEqual(db.prepare('SELECT id FROM foods WHERE id IN (9101, 9102) ORDER BY id').all().map(r => r.id), [9101, 9102]);
  assert.deepEqual(db.prepare('SELECT id FROM meals WHERE id IN (9101, 9102) ORDER BY id').all().map(r => r.id), [9101, 9102]);
});
