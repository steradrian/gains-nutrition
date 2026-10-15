/**
 * API contract: quick calories (docs/api-contract.md, "Quick calories").
 *
 * There is no endpoint of its own: a quick entry is a diary item with
 * type "quick_calories", a name and nutrition (calories in kcal, macros in
 * g, each only when given), and no portion, unit or quantity
 * (src/stores/diary.js addQuickCalories). It is written with the day.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { DIARY_ITEM } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

const quick = (over = {}) => ({
  uuid: 'quick-1', meal: 3, type: 'quick_calories', name: 'Quick Calories',
  nutrition: { calories: 320, proteins: 12.5 }, addedAt: '2026-10-14T15:00:00.000Z', ...over,
});

test('a quick entry round-trips as written, with no portion, unit or quantity', async () => {
  const r = await srv.api('PUT', '/api/diary/2026-10-14', { items: [quick()], body_stats: {}, water: [], notes: '' }, { example: 'quick-kcal.put' });
  assert.equal(r.status, 200);
  const [got] = r.body.items;
  assertShape(got, { ...DIARY_ITEM, type: 'string' });
  assert.equal(got.type, 'quick_calories');
  assert.deepEqual(got.nutrition, { calories: 320, proteins: 12.5 });
  assert.equal(got.meal, 3);
  for (const k of ['portion', 'unit', 'quantity']) assert.ok(!(k in got), `no ${k}`);
});

test('a quick entry sits beside ordinary items, and a delete removes it like any item', async () => {
  const food = { uuid: 'food-1', meal: 3, name: 'Apple', portion: 150, unit: 'g', quantity: 1, nutrition: { calories: 78 } };
  const both = await srv.api('PUT', '/api/diary/2026-10-14', { items: [quick(), food], body_stats: {}, water: [], notes: '' });
  assert.deepEqual(both.body.items.map(i => i.uuid).sort(), ['food-1', 'quick-1']);
  const gone = await srv.api('PUT', '/api/diary/2026-10-14', { items: [food], body_stats: {}, water: [], notes: '', deleted_uuids: { items: ['quick-1'], water: [] } });
  assert.deepEqual(gone.body.items.map(i => i.uuid), ['food-1']);
});
