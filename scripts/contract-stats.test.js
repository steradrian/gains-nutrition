/**
 * API contract: stats (docs/api-contract.md, "Stats").
 *
 * No stats endpoint: the Statistics screen reads the whole diary with
 * GET /api/diary and adds it up in the client (calories = nutrition.calories
 * x quantity per item, water from `water`, weight from `body_stats`), and
 * fasting insights read GET /api/fasts?limit=60. This pins what those sums
 * read.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { DIARY_DAY } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

const write = (date, items, water = [], body_stats = {}) => srv.api('PUT', `/api/diary/${date}`, { items, body_stats, water, notes: '' });

test('GET /api/diary: every day, oldest first, with what the sums read', async () => {
  await write('2026-10-02', [{ uuid: 's2', meal: 1, name: 'Rice', portion: 150, unit: 'g', quantity: 2, nutrition: { calories: 195, carbohydrates: 42 } }], [{ uuid: 'w2', amount: 500, time: '12:00' }]);
  await write('2026-10-01', [{ uuid: 's1', meal: 0, name: 'Egg', portion: 50, unit: 'g', quantity: 1, nutrition: { calories: 72, proteins: 6.3 } }], [], { weight: 176.5, weight_unit: 'lb' });
  const r = await srv.api('GET', '/api/diary', undefined, { example: 'stats.diary-all' });
  assert.equal(r.status, 200);
  assertShape(r.body, [DIARY_DAY]);
  assert.deepEqual(r.body.map(d => d.date), ['2026-10-01', '2026-10-02']);
  const kcal = d => d.items.reduce((s, i) => s + i.nutrition.calories * (i.quantity ?? 1), 0);
  assert.deepEqual(r.body.map(kcal), [72, 390]);
  assert.deepEqual(r.body.map(d => d.water.reduce((s, w) => s + w.amount, 0)), [0, 500]);
  assert.deepEqual(r.body[0].body_stats, { weight: 176.5, weight_unit: 'lb' }, 'weight in the unit it was entered, tagged');
});

test('a deleted day is not in the list', async () => {
  await write('2026-10-03', [{ uuid: 's3', meal: 0, name: 'Gone', quantity: 1, nutrition: { calories: 1 } }]);
  const del = await srv.api('DELETE', '/api/diary/2026-10-03');
  assert.equal(del.status, 200);
  assert.ok(!(await srv.api('GET', '/api/diary')).body.some(d => d.date === '2026-10-03'));
});
