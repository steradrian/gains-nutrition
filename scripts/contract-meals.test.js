/**
 * API contract: saved meals and recipes (docs/api-contract.md, "Meals and
 * recipes"). A recipe is a meal row with is_recipe true; GET /api/meals
 * lists meals, GET /api/meals?recipes=1 recipes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { MEAL } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

// An ingredient as the meal editor stores it: the food, its portion scaled
// in, quantity 1, nutrition already for that portion.
const ingredient = (name, grams, kcal) => ({ id: null, name, portion: grams, unit: 'g', quantity: 1, nutrition: { calories: kcal } });
let meal = null, recipe = null;

test('POST /api/meals creates a saved meal: 201, is_recipe false', async () => {
  const items = [ingredient('Rolled oats', 40, 152), ingredient('Milk', 200, 128)];
  const r = await srv.api('POST', '/api/meals', { name: 'Breakfast bowl', items, nutrition: { calories: 280 } }, { example: 'meals.create' });
  assert.equal(r.status, 201);
  assertShape(r.body, MEAL);
  meal = r.body;
  assert.equal(meal.is_recipe, false, 'a boolean on the wire (0/1 in the table)');
  assert.deepEqual(meal.items, items, 'items is a parsed array, as sent');
  assert.deepEqual(meal.nutrition, { calories: 280 }, 'a meal\'s nutrition is the sum of its items');
  assert.equal(meal.servings, null, 'servings not sent: null');
});

test('POST /api/meals with is_recipe true is a recipe: nutrition per serving, servings kept', async () => {
  const r = await srv.api('POST', '/api/meals', {
    name: 'Overnight oats', is_recipe: true, servings: 2, portion: 260, unit: 'g',
    items: [ingredient('Rolled oats', 80, 304), ingredient('Yoghurt', 440, 264)], nutrition: { calories: 284 },
  }, { example: 'meals.create.recipe' });
  assert.equal(r.status, 201);
  assertShape(r.body, MEAL);
  recipe = r.body;
  assert.equal(recipe.is_recipe, true);
  assert.equal(recipe.servings, 2);
  assert.equal(recipe.portion, 260, 'portion is one serving');
});

test('POST /api/meals without a name is 400', async () => {
  const r = await srv.api('POST', '/api/meals', { items: [] });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Name required' });
});

test('GET /api/meals lists meals only; ?recipes=1 lists recipes only', async () => {
  const meals = await srv.api('GET', '/api/meals', undefined, { example: 'meals.list' });
  const recipes = await srv.api('GET', '/api/meals?recipes=1', undefined, { example: 'meals.list.recipes' });
  assert.equal(meals.status, 200);
  assertShape(meals.body, [MEAL]);
  assertShape(recipes.body, [MEAL]);
  assert.deepEqual(meals.body.map(m => m.id), [meal.id]);
  assert.deepEqual(recipes.body.map(m => m.id), [recipe.id]);
  assert.ok(recipes.body.every(m => m.is_recipe === true));
});

test('GET /api/meals/:id; 404 for an id that does not exist', async () => {
  const r = await srv.api('GET', `/api/meals/${recipe.id}`);
  assert.equal(r.status, 200);
  assertShape(r.body, MEAL);
  const missing = await srv.api('GET', '/api/meals/999999');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Not found' });
});

test('PUT /api/meals/:id: servings left out is kept, sent is changed', async () => {
  const renamed = await srv.api('PUT', `/api/meals/${recipe.id}`, { name: 'Overnight oats (big)' }, { example: 'meals.update' });
  assert.equal(renamed.status, 200);
  assertShape(renamed.body, MEAL);
  assert.equal(renamed.body.name, 'Overnight oats (big)');
  assert.equal(renamed.body.servings, 2);
  assert.equal(renamed.body.is_recipe, true);
  const four = await srv.api('PUT', `/api/meals/${recipe.id}`, { servings: 4 });
  assert.equal(four.body.servings, 4);
});

test('POST /api/meals/:id/used and DELETE /api/meals/:id', async () => {
  const used = await srv.api('POST', `/api/meals/${meal.id}/used`, { date: '2026-10-14' });
  assert.equal(used.status, 200);
  assert.deepEqual(used.body, { ok: true });
  assert.equal((await srv.api('GET', `/api/meals/${meal.id}`)).body.usage_count, 1);
  const del = await srv.api('DELETE', `/api/meals/${meal.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });
  assert.deepEqual((await srv.api('GET', '/api/meals')).body, []);
});
