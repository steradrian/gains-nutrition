/**
 * API contract: portions and units (docs/api-contract.md, "Portions and
 * units").
 *
 * Grams are worked out on the client (src/lib/units.js scaleFactor), from
 * what the server stores on the food: alt_units ([{ abbr, grams }], grams of
 * one of that unit), nutrition_basis ('g' or 'ml': what `portion` counts)
 * and density_g_ml (g per ml, to cross between weight and volume). A diary
 * item is written already scaled (portion, unit, nutrition for that
 * portion); on read the server adds the food's unit fields back to it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { FOOD } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

let bread = null, milk = null;

test('alt_units are stored cleaned: positive grams and a name only, as an array (null when none is left)', async () => {
  const r = await srv.api('POST', '/api/foods', {
    name: 'Sourdough', portion: 100, unit: 'g', nutrition: { calories: 250 }, nutrition_basis: 'g',
    alt_units: [{ abbr: 'slice', grams: 35 }, { abbr: 'loaf', grams: '800' }, { abbr: 'crumb', grams: 0 }, { abbr: '', grams: 5 }, 'junk'],
  }, { example: 'portions.food-alt-units' });
  assert.equal(r.status, 201);
  assertShape(r.body, FOOD);
  bread = r.body;
  assert.deepEqual(bread.alt_units, [{ abbr: 'slice', grams: 35 }, { abbr: 'loaf', grams: 800 }]);
  assert.equal(bread.nutrition_basis, 'g');
  const none = await srv.api('POST', '/api/foods', { name: 'No units', alt_units: [{ abbr: 'x', grams: -1 }] });
  assert.equal(none.body.alt_units, null);
});

test('density_g_ml is a positive number or null; nutrition_basis ml means portion counts millilitres', async () => {
  const r = await srv.api('POST', '/api/foods', {
    name: 'Whole milk', portion: 100, unit: 'ml', nutrition: { calories: 64 }, nutrition_basis: 'ml', density_g_ml: 1.03,
    alt_units: [{ abbr: 'glass', grams: 257.5 }],
  });
  milk = r.body;
  assert.equal(milk.density_g_ml, 1.03);
  assert.equal(milk.nutrition_basis, 'ml');
  for (const density of [0, -2, 'thick']) {
    assert.equal((await srv.api('POST', '/api/foods', { name: `Bad density ${density}`, density_g_ml: density })).body.density_g_ml, null, String(density));
  }
});

test('PUT: an omitted unit field is kept, null clears it', async () => {
  const kept = await srv.api('PUT', `/api/foods/${bread.id}`, { name: 'Sourdough loaf' });
  assert.deepEqual(kept.body.alt_units, bread.alt_units);
  const cleared = await srv.api('PUT', `/api/foods/${bread.id}`, { alt_units: null, nutrition_basis: null });
  assert.equal(cleared.body.alt_units, null);
  assert.equal(cleared.body.nutrition_basis, null);
  await srv.api('PUT', `/api/foods/${bread.id}`, { alt_units: [{ abbr: 'slice', grams: 35 }], nutrition_basis: 'g' });
});

test('a diary item is stored as scaled by the client, and read back with its food\'s unit fields', async () => {
  // Two slices: 70 g of a 250 kcal / 100 g food.
  const item = { uuid: 'two-slices', meal: 0, id: bread.id, name: 'Sourdough', portion: 2, unit: 'slice', quantity: 1, nutrition: { calories: 175 } };
  const glass = { uuid: 'a-glass', meal: 0, id: milk.id, name: 'Whole milk', portion: 1, unit: 'glass', quantity: 1, nutrition: { calories: 160 } };
  await srv.api('PUT', '/api/diary/2026-10-14', { items: [item, glass], body_stats: {}, water: [], notes: '' });
  const day = await srv.api('GET', '/api/diary/2026-10-14', undefined, { example: 'portions.diary-item-hydrated' });
  const got = Object.fromEntries(day.body.items.map(i => [i.uuid, i]));
  assertShape(got['two-slices'], {
    portion: 'number', unit: 'string', quantity: 'number', nutrition: 'object',
    alt_units: [{ abbr: 'string', grams: 'number' }], nutrition_basis: 'string',
  });
  assert.equal(got['two-slices'].portion, 2);
  assert.equal(got['two-slices'].unit, 'slice');
  assert.deepEqual(got['two-slices'].nutrition, { calories: 175 }, 'nutrition as written: the server does not rescale');
  assert.deepEqual(got['two-slices'].alt_units, [{ abbr: 'slice', grams: 35 }]);
  assert.equal(got['a-glass'].density_g_ml, 1.03);
  assert.equal(got['a-glass'].nutrition_basis, 'ml');
});

test('an item\'s own unit fields win over the food\'s', async () => {
  const item = { uuid: 'own-units', meal: 1, id: bread.id, name: 'Sourdough', portion: 1, unit: 'chunk', quantity: 1, nutrition: { calories: 100 }, alt_units: [{ abbr: 'chunk', grams: 40 }] };
  await srv.api('PUT', '/api/diary/2026-10-15', { items: [item], body_stats: {}, water: [], notes: '' });
  const day = await srv.api('GET', '/api/diary/2026-10-15');
  assert.deepEqual(day.body.items[0].alt_units, [{ abbr: 'chunk', grams: 40 }]);
});
