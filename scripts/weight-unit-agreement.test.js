/**
 * An untagged legacy weight (body_stats.weight with no weight_unit) means
 * the same thing to every server reader (lib/body-weight.js):
 *   - GET /api/v1/body-stats (what the openGym bridge syncs),
 *   - the adaptive TDEE (lib/adaptive-tdee.js),
 * read in the user's weightUnit setting, the unit the diary shows it in.
 *
 * Before: body-stats read 200 (untagged, a lb user) as 90.7 kg while the
 * adaptive TDEE read it as 200 kg, so its weekly trend was 2.2x too steep
 * and its TDEE off by hundreds of kcal.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const req = createRequire(new URL('../server/package.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nt-weight-unit-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.UPLOADS_PATH = join(dir, 'uploads');
const db = (await import('../server/db.js')).default;
const { computeAdaptiveTdee } = await import('../server/lib/adaptive-tdee.js');
test.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const LB_PER_KG = 2.2046226218;
const DAYS = 35;
// The same calendar the adaptive TDEE uses (UTC noon, counted back).
const daysAgo = n => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

/** A user who logs 2,500 kcal a day and a weight that falls 0.1 a day. */
function person(username, { weightUnit, tag = null, start = 200 }) {
  const id = Number(db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'user')`).run(username).lastInsertRowid);
  if (weightUnit) db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'weightUnit', ?)`).run(id, JSON.stringify(weightUnit));
  const items = JSON.stringify([{ name: 'Food', nutrition: { calories: 2500 }, quantity: 1 }]);
  const put = db.prepare(`INSERT INTO diary (user_id, date, items, body_stats) VALUES (?, ?, ?, ?)`);
  for (let i = DAYS - 1; i >= 0; i--) {
    const weight = Math.round((start - (DAYS - 1 - i) * 0.1) * 10) / 10;
    put.run(id, daysAgo(i), items, JSON.stringify(tag ? { weight, weight_unit: tag } : { weight }));
  }
  return id;
}

// 0.1 per day, in the unit the person typed it in, as kg per week.
const perWeekKg = unit => -(0.1 * 7) / (unit === 'lb' ? LB_PER_KG : 1);

test('adaptive TDEE reads an untagged weight in the user\'s weightUnit (lb), as the diary shows it', () => {
  const r = computeAdaptiveTdee(person('lb-legacy', { weightUnit: 'lb' }));
  assert.equal(r.ready, true);
  assert.ok(Math.abs(r.trendKgPerWeek - perWeekKg('lb')) < 0.02, `trend ${r.trendKgPerWeek} kg/week, expected ${perWeekKg('lb').toFixed(2)}`);
  // 0.0454 kg/day x 7700 = 349 kcal/day deficit below 2,500 intake: TDEE about 2,850.
  assert.ok(Math.abs(r.tdee - (2500 + (0.1 / LB_PER_KG) * 7700)) < 15, `tdee ${r.tdee}`);
});

test('no weightUnit setting: untagged is lb, the app\'s default display unit', () => {
  const r = computeAdaptiveTdee(person('unset-legacy', {}));
  assert.ok(Math.abs(r.trendKgPerWeek - perWeekKg('lb')) < 0.02, `trend ${r.trendKgPerWeek}`);
});

test('a kg user\'s untagged weights, and tagged weights, read as before', () => {
  assert.ok(Math.abs(computeAdaptiveTdee(person('kg-legacy', { weightUnit: 'kg', start: 90 })).trendKgPerWeek - perWeekKg('kg')) < 0.02);
  assert.ok(Math.abs(computeAdaptiveTdee(person('lb-tagged', { weightUnit: 'kg', tag: 'lb' })).trendKgPerWeek - perWeekKg('lb')) < 0.02, 'the tag wins over the setting');
  assert.ok(Math.abs(computeAdaptiveTdee(person('kg-tagged', { weightUnit: 'lb', tag: 'kg', start: 90 })).trendKgPerWeek - perWeekKg('kg')) < 0.02);
});

test('GET /api/v1/body-stats and the adaptive TDEE agree on an untagged lb history', async () => {
  const express = req('express');
  const { default: bodyStats } = await import('../server/routes/api/v1/body-stats.js');
  const userId = person('agree', { weightUnit: 'lb' });
  const app = express();
  app.use((r, _res, next) => { r.apiToken = { scopes: ['read:body-stats'] }; r.apiUser = { id: userId }; next(); });
  app.use('/body-stats', bodyStats);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/body-stats?from=${daysAgo(DAYS - 1)}&to=${daysAgo(0)}&limit=1000`);
    const { items } = await res.json();
    assert.equal(items.length, DAYS);
    assert.equal(items[0].weight_kg, Math.round((200 / LB_PER_KG) * 100) / 100, '200 lb');
    const apiPerWeek = (items.at(-1).weight_kg - items[0].weight_kg) / (DAYS - 1) * 7;
    const tdee = computeAdaptiveTdee(userId);
    assert.ok(Math.abs(tdee.trendKgPerWeek - apiPerWeek) < 0.02, `TDEE ${tdee.trendKgPerWeek} vs body-stats ${apiPerWeek.toFixed(3)} kg/week`);
  } finally { server.close(); }
});
