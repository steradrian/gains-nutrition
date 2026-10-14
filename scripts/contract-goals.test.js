/**
 * API contract: goals and the settings they live in (docs/api-contract.md,
 * "Goals and settings").
 *
 * Goals have no endpoint of their own: they are the `goals` setting, beside
 * mealNames (the diary's meal names; an item stores only its index),
 * waterGoalMl, calorieGoalMode and the rest, all through /api/settings,
 * values stored as JSON. GET /api/goals/adaptive-tdee is computed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { ADAPTIVE_TDEE } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

const GOALS = {
  calories: { min: 2200, max: 2400, sharedGoal: false, isMin: false, isPercent: false, showInDiary: true, showInStats: true, days: [true, true, true, true, true, true, true] },
  proteins: { min: 140, isMin: true, isPercent: false, showInDiary: true, showInStats: true },
};

test('PUT /api/settings stores one key; GET /api/settings answers every key, values as JSON', async () => {
  const put = await srv.api('PUT', '/api/settings', { key: 'goals', value: GOALS }, { example: 'settings.put' });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { ok: true });
  await srv.api('PUT', '/api/settings', { key: 'mealNames', value: ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Second breakfast'] });
  const r = await srv.api('GET', '/api/settings', undefined, { example: 'settings.get' });
  assert.equal(r.status, 200);
  assertShape(r.body, { goals: 'object', mealNames: ['string'] });
  assert.deepEqual(r.body.goals, GOALS);
  assert.equal(r.body.mealNames[4], 'Second breakfast');
});

test('PUT /api/settings/bulk writes many keys at once and counts what it skipped', async () => {
  const r = await srv.api('PUT', '/api/settings/bulk', { settings: { calorieGoalMode: 'adaptive', waterGoalMl: 2000, weightUnit: 'kg', fitbit_client_secret: 'nope' } }, { example: 'settings.bulk' });
  assert.equal(r.status, 200);
  assertShape(r.body, { ok: 'boolean', written: 'integer', skipped: 'integer' });
  assert.equal(r.body.written, 3);
  assert.equal(r.body.skipped, 1, 'server-only keys are never written from a client');
  const all = (await srv.api('GET', '/api/settings')).body;
  assert.equal(all.calorieGoalMode, 'adaptive');
  assert.ok(!('fitbit_client_secret' in all));
});

test('settings errors: no key 400, a server-only key 403, no settings object 400', async () => {
  const noKey = await srv.api('PUT', '/api/settings', { value: 1 });
  assert.equal(noKey.status, 400);
  assert.deepEqual(noKey.body, { error: 'key required' });
  const secret = await srv.api('PUT', '/api/settings', { key: 'withings_client_secret', value: 'x' });
  assert.equal(secret.status, 403);
  assert.deepEqual(secret.body, { error: 'forbidden key' });
  const bulk = await srv.api('PUT', '/api/settings/bulk', {});
  assert.equal(bulk.status, 400);
  assert.deepEqual(bulk.body, { error: 'settings object required' });
});

test('GET /api/goals/adaptive-tdee: not ready without 21 days of intake and weight', async () => {
  const r = await srv.api('GET', '/api/goals/adaptive-tdee', undefined, { example: 'goals.adaptive-tdee' });
  assert.equal(r.status, 200);
  assertShape(r.body, ADAPTIVE_TDEE);
  assert.equal(r.body.ready, false);
  assert.equal(r.body.daysRequired, 21);
  assert.equal(r.body.windowDays, 35);
  assert.equal(r.body.tdee, null);
});

test('GET /api/goals/adaptive-tdee with a month of logging: a TDEE in kcal and a weekly trend in kg', async () => {
  const day = n => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  for (let i = 27; i >= 0; i--) {
    await srv.api('PUT', `/api/diary/${day(i)}`, {
      items: [{ uuid: `tdee-${i}`, meal: 0, name: 'Food', quantity: 1, nutrition: { calories: 2500 } }],
      body_stats: { weight: Math.round((82 - (27 - i) * 0.05) * 100) / 100, weight_unit: 'kg' }, water: [], notes: '',
    });
  }
  const r = await srv.api('GET', '/api/goals/adaptive-tdee');
  assertShape(r.body, { ...ADAPTIVE_TDEE, ready: 'boolean', tdee: 'integer', trendKgPerWeek: 'number', confidence: 'number', weightSource: 'string' });
  assert.equal(r.body.ready, true);
  assert.equal(r.body.weightSource, 'manual');
  assert.ok(Math.abs(r.body.trendKgPerWeek - (-0.35)) < 0.02, String(r.body.trendKgPerWeek));
  assert.ok(Math.abs(r.body.tdee - (2500 + 0.05 * 7700)) < 20, String(r.body.tdee));
});
