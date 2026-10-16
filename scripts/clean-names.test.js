/**
 * Control characters in names, on every path that writes one (the shared
 * helper is server/lib/clean-text.js): a tab becomes a space, every other C0
 * character (U+0000 to U+001F) is dropped, and nothing else is touched. The
 * settings are in small-fixes.test.js and setting-text.test.js, the backup
 * restore in clean-names-restore.test.js.
 *
 * Here: the helper, then each writer in turn.
 *   routes     POST/PUT /api/foods, /api/meals, /api/activity, PUT /api/diary/:date
 *   imports    POST /api/data/import (JSON), POST /api/nutrition-import/commit (CSV)
 *   sync       POST /api/sync/push: foods, meals, diary, activity, workouts, settings
 *   API        POST /api/v1/activity and /api/v1/workouts
 *   MCP        create_food, and the diary writer every logging tool goes through
 *   wearables  the Fitbit and Google Health workout syncs (the provider's activity name)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootInProcess } from './fixtures/in-process-server.mjs';
import { cleanFields, cleanItemNames, cleanItemsJson, cleanName, cleanText, controlOnly } from '../server/lib/clean-text.js';

// What a person types by accident or a bad file carries.
const DIRTY = 'Ra\u0000w\toats\u0007\n';
const CLEAN = 'Raw oats';
// Names the cleaning must leave exactly as they are: emoji, ZWJ sequences, flags, CJK, right to left, accents.
const KEPT = ['🍪 Snacks', '👩‍🍳 Cook', '🇨🇭 Swiss', '朝ごはん', 'وجبة', 'Frühstück', 'a\u007fb', 'a\u0085b', 'Second breakfast'];

// ── The helper ────────────────────────────────────────────────────────────
test('cleanText: a tab is a space, every other C0 character goes, the rest of Unicode stays', () => {
  assert.equal(cleanText(DIRTY), CLEAN);
  const all = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
  assert.equal(cleanText(`A${all}B`), 'A B');
  assert.equal(cleanText('a\t\tb'), 'a  b');
  for (const name of KEPT) assert.equal(cleanText(name), name);
});

test('cleanName leaves anything that is not a string as it was; controlOnly names what would be cleaned to nothing', () => {
  for (const v of [undefined, null, 7, ['a\u0000']]) assert.equal(cleanName(v), v);
  assert.equal(controlOnly('\u0000'), true);
  assert.equal(controlOnly('\t'), true, 'a tab alone is a space alone: nothing');
  assert.equal(controlOnly(' \n\u0001 '), true);
  for (const v of ['', '   ', 'Oats', 'Oa\u0000ts', null, undefined, 5]) assert.equal(controlOnly(v), false, String(v));
});

test('cleanItemNames: name and brand of every item, nested ones included; nothing else, and the input is not changed', () => {
  const input = [{ uuid: 'a\u0000', name: DIRTY, brand: 'Br\u0001and', notes: 'keep\u0000me', nutrition: { calories: 1 },
    items: [{ name: 'In\u0000gredient', _splitItems: [{ name: 'De\tep', brand: null }] }] }, 'text', null, 3];
  const copy = structuredClone(input);
  assert.deepEqual(cleanItemNames(input), [{ uuid: 'a\u0000', name: CLEAN, brand: 'Brand', notes: 'keep\u0000me', nutrition: { calories: 1 },
    items: [{ name: 'Ingredient', _splitItems: [{ name: 'De ep', brand: null }] }] }, 'text', null, 3]);
  assert.deepEqual(input, copy);
  assert.deepEqual(cleanItemNames(KEPT.map(name => ({ name }))), KEPT.map(name => ({ name })));
  let deep = [{ name: 'x\u0000' }];
  for (let i = 0; i < 50; i++) deep = [deep];
  assert.doesNotThrow(() => cleanItemNames(deep));
});

test('cleanItemsJson and cleanFields: a stored list and a stored row, untouched when there is nothing to clean', () => {
  const clean = '[ {"name":"Oats"} ]';
  assert.equal(cleanItemsJson(clean), clean, 'byte for byte');
  assert.equal(cleanItemsJson('not json'), 'not json');
  assert.equal(cleanItemsJson(null), null);
  assert.deepEqual(JSON.parse(cleanItemsJson(JSON.stringify([{ name: DIRTY }]))), [{ name: CLEAN }]);
  assert.deepEqual(cleanFields({ name: DIRTY, brand: null, kcal: 3, note: DIRTY }, ['name', 'brand', 'missing']), { name: CLEAN, brand: null, kcal: 3, note: DIRTY });
});

// ── The writers ───────────────────────────────────────────────────────────
const env = await bootInProcess({
  prefix: 'nt-clean-names',
  routes: {
    '/api/foods': 'foods.js', '/api/meals': 'meals.js', '/api/activity': 'activity.js', '/api/diary': 'diary.js',
    '/api/data': 'data.js', '/api/nutrition-import': 'nutrition-import.js', '/api/sync': 'sync.js',
    '/api/settings': 'settings.js', '/api/v1': 'api/v1/index.js',
    '/api/fitbit': 'fitbit.js', '/api/google-health': 'google-health.js',
  },
});
const db = env?.db;
const skip = t => { if (!env) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };
const { newUser, call, base } = env ?? {};
const createToken = env ? (await import('../server/lib/api-tokens.js')).createToken : null;
const pat = (user, scopes) => createToken({ userId: user.id, name: 'clean-names', scopes }).raw;
const diaryItems = (user, date) => JSON.parse(db.prepare('SELECT items FROM diary WHERE user_id = ? AND date = ?').get(user.id, date).items);

test('POST and PUT /api/foods: name, brand and category are cleaned; Unicode stays; a name of only control characters is a 400', async t => {
  if (skip(t)) return;
  const u = newUser();
  const made = await call(u, 'POST', '/api/foods', { name: DIRTY, brand: 'Br\u0000and', category: 'Gra\tins', nutrition: { calories: 380 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.name, made.body.brand, made.body.category], [CLEAN, 'Brand', 'Gra ins']);
  assert.deepEqual(db.prepare('SELECT name, brand, category FROM foods WHERE id = ?').get(made.body.id), { name: CLEAN, brand: 'Brand', category: 'Gra ins' });

  const put = await call(u, 'PUT', `/api/foods/${made.body.id}`, { name: 'Ste\u0000el cut', brand: 'B\nrand', category: 'Gr\u0000ains' });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.name, put.body.brand, put.body.category], ['Steel cut', 'Brand', 'Grains']);

  for (const name of KEPT) {
    const r = await call(u, 'POST', '/api/foods', { name, nutrition: { calories: 1 } });
    assert.equal(r.body.name, name);
  }

  const refused = await call(u, 'POST', '/api/foods', { name: '\u0000\t\u0001', nutrition: {} });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /control characters/);
  const refusedEdit = await call(u, 'PUT', `/api/foods/${made.body.id}`, { name: '\u0000' });
  assert.equal(refusedEdit.status, 400);
  assert.equal(db.prepare('SELECT name FROM foods WHERE id = ?').get(made.body.id).name, 'Steel cut', 'the name stands');
});

test('POST /api/foods: a source-stamped save that updates in place cleans the name too', async t => {
  if (skip(t)) return;
  const u = newUser();
  const stamp = { source_app: 'cooktrace', source_external_id: 'pantry:7', nutrition: { calories: 1 } };
  const first = await call(u, 'POST', '/api/foods', { name: 'Pantry', ...stamp });
  const again = await call(u, 'POST', '/api/foods', { name: 'Pan\u0000try 2', ...stamp });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  assert.equal(again.body.name, 'Pantry 2');
});

test('POST and PUT /api/meals: the name and the ingredients\' names are cleaned, for meals and recipes alike', async t => {
  if (skip(t)) return;
  const u = newUser();
  for (const is_recipe of [false, true]) {
    const made = await call(u, 'POST', '/api/meals', { name: DIRTY, is_recipe, items: [{ name: 'Mi\u0000lk', brand: 'B\trand', qty: 1 }], nutrition: {} });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.name, CLEAN);
    assert.deepEqual(made.body.items, [{ name: 'Milk', brand: 'B rand', qty: 1 }]);

    const put = await call(u, 'PUT', `/api/meals/${made.body.id}`, { name: 'Po\u0000rridge', items: [{ name: 'Oa\u0007ts' }] });
    assert.equal(put.status, 200);
    assert.equal(put.body.name, 'Porridge');
    assert.deepEqual(put.body.items, [{ name: 'Oats' }]);
    const kept = await call(u, 'PUT', `/api/meals/${made.body.id}`, { notes: 'only the note' });
    assert.deepEqual(kept.body.items, [{ name: 'Oats' }], 'a PUT without items keeps them');
  }
  for (const name of KEPT) assert.equal((await call(u, 'POST', '/api/meals', { name, items: [], nutrition: {} })).body.name, name);

  const refused = await call(u, 'POST', '/api/meals', { name: '\u0000', items: [], nutrition: {} });
  assert.equal(refused.status, 400);
  const id = (await call(u, 'POST', '/api/meals', { name: 'Fine', items: [], nutrition: {} })).body.id;
  assert.equal((await call(u, 'PUT', `/api/meals/${id}`, { name: '\n' })).status, 400);
  assert.equal(db.prepare('SELECT name FROM meals WHERE id = ?').get(id).name, 'Fine');
});

test('POST and PUT /api/activity: the name is cleaned', async t => {
  if (skip(t)) return;
  const u = newUser();
  const made = await call(u, 'POST', '/api/activity', { name: 'Mor\u0000ning\twalk', date: '2026-10-14', kcal: 120 });
  assert.equal(made.status, 201);
  assert.equal(made.body.name, 'Morning walk');
  const put = await call(u, 'PUT', `/api/activity/${made.body.id}`, { name: 'Ru\u0001n' });
  assert.equal(put.body.name, 'Run');
  assert.equal((await call(u, 'POST', '/api/activity', { name: '\u0000', date: '2026-10-14', kcal: 1 })).status, 400, 'only control characters is no name');
  assert.equal((await call(u, 'POST', '/api/activity', { name: '🏃‍♀️ Run', date: '2026-10-14', kcal: 1 })).body.name, '🏃‍♀️ Run');
});

test('PUT /api/diary/:date: item names, ingredients inside an item included, are cleaned and the rest of the item is kept', async t => {
  if (skip(t)) return;
  const u = newUser();
  const items = [
    { uuid: 'd-1', meal: 0, name: DIRTY, brand: 'Br\u0000and', nutrition: { calories: 100 }, addedAt: '2026-10-14T07:30:00.000Z', items: [{ name: 'In\u0000g' }] },
    ...KEPT.map((name, i) => ({ uuid: `k-${i}`, meal: 1, name, nutrition: { calories: 1 }, addedAt: '2026-10-14T08:00:00.000Z' })),
  ];
  const r = await call(u, 'PUT', '/api/diary/2026-10-14', { items, body_stats: {}, water: [], notes: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stored = diaryItems(u, '2026-10-14');
  assert.deepEqual(stored[0], { ...items[0], name: CLEAN, brand: 'Brand', items: [{ name: 'Ing' }] });
  assert.deepEqual(stored.slice(1).map(i => i.name), KEPT);
});

test('POST /api/data/import (JSON): foods, meals, recipes, diary items and activity are cleaned', async t => {
  if (skip(t)) return;
  const u = newUser();
  const r = await call(u, 'POST', '/api/data/import', {
    foodList: [{ name: DIRTY, brand: 'Br\u0000and', category: 'Gr\tains', nutrition: { calories: 1 } }, { name: KEPT[1], nutrition: {} }],
    meals: [{ name: 'Me\u0000al', items: [{ name: 'Mi\u0000lk' }] }],
    recipes: [{ name: 'Rec\tipe', items: [{ name: 'Fl\u0000our' }] }],
    diary: [{ date: '2026-10-15', items: [{ uuid: 'j-1', name: 'Eg\u0000g', nutrition: {} }], water: [] }],
    activity: [{ date: '2026-10-15', name: 'Sw\u0000im', kcal: 200 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(db.prepare('SELECT name, brand, category FROM foods WHERE user_id = ? ORDER BY id').all(u.id), [
    { name: CLEAN, brand: 'Brand', category: 'Gr ains' }, { name: KEPT[1], brand: null, category: null },
  ]);
  const meals = db.prepare('SELECT name, items, is_recipe FROM meals WHERE user_id = ? ORDER BY id').all(u.id).map(m => [m.name, JSON.parse(m.items)[0].name, m.is_recipe]);
  assert.deepEqual(meals, [['Meal', 'Milk', 0], ['Rec ipe', 'Flour', 1]]);
  assert.equal(diaryItems(u, '2026-10-15')[0].name, 'Egg');
  assert.equal(db.prepare('SELECT name FROM activity_log WHERE user_id = ?').get(u.id).name, 'Swim');
});

test('POST /api/nutrition-import/commit (CSV): item names are cleaned', async t => {
  if (skip(t)) return;
  const u = newUser();
  const csv = ['Date,Meal,Name,Calories', '2026-10-16,Breakfast,"Oa\u0000ts\u0007",300', '2026-10-16,Lunch,"Rice\tbowl",400'].join('\n');
  const form = new FormData();
  form.set('source', 'spreadsheet');
  form.set('file', new Blob([csv], { type: 'text/csv' }), 'diary.csv');
  const res = await fetch(`${base}/api/nutrition-import/commit`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: form });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.imported >= 1, JSON.stringify(body));
  assert.deepEqual(diaryItems(u, '2026-10-16').map(i => i.name).sort(), ['Oats', 'Rice bowl']);
});

test('POST /api/sync/push: foods, meals, diary, activity and workouts are cleaned, on insert and on update', async t => {
  if (skip(t)) return;
  const u = newUser();
  const push = body => call(u, 'POST', '/api/sync/push', body);
  const first = await push({
    foods: [{ client_id: 1, client_key: 'p:foods:1', name: DIRTY, brand: 'Br\u0000and', category: 'Gr\tains', nutrition: {} }],
    meals: [{ client_id: 1, client_key: 'p:meals:1', name: 'Me\u0000al', items: [{ name: 'Mi\u0000lk' }], nutrition: {} }],
    diary: [{ client_id: 1, date: '2026-10-17', items: [{ uuid: 's-1', name: 'Eg\u0000g', nutrition: {} }], water: [], body_stats: {} }],
    activity: [{ client_id: 1, client_key: 'p:activity:1', date: '2026-10-17', name: 'Sw\u0000im', kcal: 100 }],
    workouts: [{ client_id: 1, source: 'health_connect', source_id: 'w1', date: '2026-10-17', activity_name: 'Ru\u0000n' }],
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const food = first.body.foods[0].server_id, meal = first.body.meals[0].server_id, activity = first.body.activity[0].server_id;
  assert.deepEqual(db.prepare('SELECT name, brand, category FROM foods WHERE id = ?').get(food), { name: CLEAN, brand: 'Brand', category: 'Gr ains' });
  const storedMeal = db.prepare('SELECT name, items FROM meals WHERE id = ?').get(meal);
  assert.deepEqual([storedMeal.name, JSON.parse(storedMeal.items)[0].name], ['Meal', 'Milk']);
  assert.equal(diaryItems(u, '2026-10-17')[0].name, 'Egg');
  assert.equal(db.prepare('SELECT name FROM activity_log WHERE id = ?').get(activity).name, 'Swim');
  assert.equal(db.prepare('SELECT activity_name FROM workouts WHERE user_id = ?').get(u.id).activity_name, 'Run');

  const later = '2099-01-01T00:00:00.000Z';
  const second = await push({
    foods: [{ client_id: 1, server_id: food, name: 'Ste\u0000el', updated_at: later, nutrition: {} }],
    meals: [{ client_id: 1, server_id: meal, name: 'Sto\tck', items: [{ name: 'Wa\u0000ter' }], updated_at: later, nutrition: {} }],
    diary: [{ client_id: 1, date: '2026-10-17', items: [{ uuid: 's-2', name: 'Ba\u0007con', nutrition: {} }], water: [], body_stats: {} }],
    activity: [{ client_id: 1, server_id: activity, name: 'Ru\u0000n', date: '2026-10-17', kcal: 100, updated_at: later }],
    workouts: [{ client_id: 1, source: 'health_connect', source_id: 'w1', date: '2026-10-17', activity_name: 'Wal\tk' }],
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(db.prepare('SELECT name FROM foods WHERE id = ?').get(food).name, 'Steel');
  const updatedMeal = db.prepare('SELECT name, items FROM meals WHERE id = ?').get(meal);
  assert.deepEqual([updatedMeal.name, JSON.parse(updatedMeal.items)[0].name], ['Sto ck', 'Water']);
  assert.deepEqual(diaryItems(u, '2026-10-17').map(i => i.name).sort(), ['Bacon', 'Egg']);
  assert.equal(db.prepare('SELECT name FROM activity_log WHERE id = ?').get(activity).name, 'Run');
  assert.equal(db.prepare('SELECT activity_name FROM workouts WHERE user_id = ?').get(u.id).activity_name, 'Wal k');
});

test('POST /api/sync/push settings: the four name settings are cleaned, a name of only control characters leaves that setting out, the rest land', async t => {
  if (skip(t)) return;
  const u = newUser();
  const stored = key => db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(u.id, key);
  const r = await call(u, 'POST', '/api/sync/push', { settings: [
    { key: 'mealNames', value: ['Break\u0000fast', 'Lun\tch', '🍪 Snacks'] },
    { key: 'foodCategories', value: [{ name: 'Fr\u0007uit', label: '🍎\u0000' }] },
    { key: 'customUnits', value: [{ abbr: 'sc\u0000p', full: 'sco\nop' }] },
    { key: 'customNutriments', value: [{ id: 'custom_om\u0000ega', label: 'Om\u0000ega', unit: 'g' }] },
    { key: 'aiSystemPrompt', value: 'Line one\nLine\ttwo' },
    { key: 'language', value: 'de' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(JSON.parse(stored('mealNames').value), ['Breakfast', 'Lun ch', '🍪 Snacks']);
  assert.deepEqual(JSON.parse(stored('foodCategories').value), [{ name: 'Fruit', label: '🍎' }]);
  assert.deepEqual(JSON.parse(stored('customUnits').value), [{ abbr: 'scp', full: 'scoop' }]);
  assert.deepEqual(JSON.parse(stored('customNutriments').value), [{ id: 'custom_omega', label: 'Omega', unit: 'g' }]);
  assert.equal(JSON.parse(stored('aiSystemPrompt').value), 'Line one\nLine\ttwo', 'a setting that is not a name keeps its newlines');
  assert.equal(r.body.settings.length, 6);

  const refused = await call(u, 'POST', '/api/sync/push', { settings: [
    { key: 'mealNames', value: ['Fine', '\u0000\u0001'] },
    { key: 'language', value: 'fr' },
  ] });
  assert.equal(refused.status, 200);
  assert.deepEqual(JSON.parse(stored('mealNames').value), ['Breakfast', 'Lun ch', '🍪 Snacks'], 'the earlier value stands');
  assert.deepEqual(refused.body.settings, [{ key: 'language' }], 'the refused setting is not acknowledged');
  assert.equal(JSON.parse(stored('language').value), 'fr', 'the others in the push land');
});

test('POST /api/v1/activity and /api/v1/workouts (API tokens): the name is cleaned', async t => {
  if (skip(t)) return;
  const u = newUser();
  const headers = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const act = await fetch(`${base}/api/v1/activity`, { method: 'POST', headers: headers(pat(u, ['write:activity'])), body: JSON.stringify({ date: '2026-10-18', name: 'Push\u0000 day\t1', kcal: 190, external_id: 'v1:a:1' }) });
  assert.equal(act.status < 300, true, await act.text());
  assert.equal(db.prepare('SELECT name FROM activity_log WHERE user_id = ? AND external_id = ?').get(u.id, 'v1:a:1').name, 'Push day 1');

  const wo = await fetch(`${base}/api/v1/workouts`, { method: 'POST', headers: headers(pat(u, ['write:workouts'])), body: JSON.stringify({ date: '2026-10-18', name: 'Pu\u0000ll\tday', calories_burned: 200, external_id: 'v1:w:1' }) });
  assert.equal(wo.status < 300, true, await wo.text());
  assert.equal(db.prepare('SELECT activity_name FROM workouts WHERE user_id = ?').get(u.id).activity_name, 'Pull day');
});

test('MCP create_food and the diary writer of the logging tools clean names', async t => {
  if (skip(t)) return;
  const u = newUser();
  let handler = null;
  (await import('../server/lib/mcp/tools/create-food.js')).registerCreateFood({ registerTool: (name, meta, fn) => { handler = fn; } }, { userId: u.id });
  const out = await handler({ confirm: true, name: 'Pro\u0000tein\tbar', brand: 'Br\u0001and', portion: 50, unit: 'g', nutrition: { calories: 200 }, category: 'Sn\u0000acks' });
  assert.notEqual(out.isError, true, JSON.stringify(out));
  assert.deepEqual(db.prepare('SELECT name, brand, category FROM foods WHERE user_id = ?').get(u.id), { name: 'Protein bar', brand: 'Brand', category: 'Snacks' });
  const blank = await handler({ confirm: true, name: '\u0000\u0001', portion: 50, unit: 'g', nutrition: { calories: 200 } });
  assert.equal(blank.isError, true, 'a name of only control characters is no name');

  const { mutateDiaryDay } = await import('../server/lib/mcp/_diary-write.js');
  mutateDiaryDay(u.id, '2026-10-19', day => ({ ...day, items: [...day.items, { name: 'Ba\u0000gel', brand: 'B\tr', nutrition: { calories: 1 } }] }));
  const [item] = diaryItems(u, '2026-10-19');
  assert.deepEqual([item.name, item.brand], ['Bagel', 'B r']);
});

// The wearables' workout sync: the provider's text is cleaned like any other writer's. The sync
// functions are called directly with the provider's HTTP replaced; the reply is what the API sends.
async function withProviderReplies(reply, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => reply(String(url));
  try { return await run(); } finally { globalThis.fetch = real; }
}
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const workoutNames = user => db.prepare('SELECT activity_name FROM workouts WHERE user_id = ? ORDER BY source_id').all(user.id).map(r => r.activity_name);

test('the Fitbit workout sync cleans the activity name; one of only control characters is Unknown', async t => {
  if (skip(t)) return;
  const u = newUser();
  const { encrypt } = await import('../server/lib/token-crypto.js');
  db.prepare('INSERT INTO fitbit_tokens (user_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)')
    .run(u.id, encrypt('access'), encrypt('refresh'), new Date(Date.now() + 3600_000).toISOString());
  const activity = (logId, activityName) => ({ logId, activityName, startDate: '2026-10-10', originalStartTime: `2026-10-10T0${logId}:00:00.000+00:00`, activeDuration: 600000, calories: 90, activityTypeId: 90009 });
  const { syncWorkouts } = await import('../server/routes/fitbit.js');
  await withProviderReplies(
    url => json(url.includes('/activities/list.json')
      ? { activities: [activity(1, DIRTY), activity(2, '\u0000\u0001'), activity(3, '🏃 Run')] }
      : { 'activities-heart-intraday': { dataset: [] } }),
    () => syncWorkouts(u.id, '2026-10-10', '2026-10-10'),
  );
  assert.deepEqual(workoutNames(u), [CLEAN, 'Unknown', '🏃 Run']);
});

test('the Google Health workout sync cleans the exercise name', async t => {
  if (skip(t)) return;
  const u = newUser();
  const { encrypt } = await import('../server/lib/token-crypto.js');
  db.prepare('INSERT INTO google_health_tokens (user_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)')
    .run(u.id, encrypt('access'), encrypt('refresh'), new Date(Date.now() + 3600_000).toISOString());
  for (const key of ['google_health_client_id', 'google_health_client_secret']) {
    db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(u.id, key, JSON.stringify('x'));
  }
  const exercise = (id, displayName) => ({
    name: `users/me/dataTypes/exercise/dataPoints/${id}`,
    exercise: { displayName, exerciseType: 'RUNNING', activeDuration: '600s', interval: { startTime: '2026-10-10T07:00:00+00:00', endTime: '2026-10-10T07:10:00+00:00' }, metricsSummary: {} },
  });
  const { syncWorkouts } = await import('../server/routes/google-health.js');
  await withProviderReplies(
    url => json(url.includes('dataPoints:rollUp') ? {} : { dataPoints: [exercise('a', DIRTY), exercise('b', '\u0000'), exercise('c', '🏃 Run')] }),
    () => syncWorkouts(u.id, '2026-10-10', '2026-10-10'),
  );
  assert.deepEqual(workoutNames(u), [CLEAN, null, '🏃 Run']);
});
