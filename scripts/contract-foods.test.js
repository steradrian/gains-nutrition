/**
 * API contract: foods (docs/api-contract.md, "Foods").
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { ERROR, FOOD } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

const OATS = {
  name: 'Rolled oats', brand: 'Contract Mills', portion: 100, unit: 'g', category: 'Grains',
  nutrition: { calories: 379, kilojoules: 1586, proteins: 13.2, carbohydrates: 67.7, fat: 6.5, fiber: 10.1, salt: 0.01 },
};
let oats = null;

test('POST /api/foods creates a food: 201 and the stored row', async () => {
  const r = await srv.api('POST', '/api/foods', OATS, { example: 'foods.create' });
  assert.equal(r.status, 201);
  assertShape(r.body, FOOD);
  oats = r.body;
  assert.equal(oats.name, OATS.name);
  assert.deepEqual(oats.nutrition, OATS.nutrition, 'nutrition is an object, per `portion` `unit`');
  assert.equal(oats.portion, 100);
  assert.equal(oats.unit, 'g');
  assert.equal(oats.favorite, 0, 'favorite is 0/1, not a boolean');
  assert.equal(oats.usage_count, 0);
  assert.equal(oats.visibility, 'private');
  assert.equal(oats.alt_units, null);
});

test('defaults: portion 100, unit g, nutrition {}', async () => {
  const r = await srv.api('POST', '/api/foods', { name: 'Plain' });
  assert.equal(r.status, 201);
  assert.equal(r.body.portion, 100);
  assert.equal(r.body.unit, 'g');
  assert.deepEqual(r.body.nutrition, {});
});

test('POST /api/foods without a name is 400', async () => {
  const r = await srv.api('POST', '/api/foods', { brand: 'Nameless' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Name required' });
});

test('POST /api/foods is idempotent on client_key: the second post answers 200 with the same row', async () => {
  const first = await srv.api('POST', '/api/foods', { name: 'Keyed', client_key: 'contract-key-1' });
  const second = await srv.api('POST', '/api/foods', { name: 'Keyed again', client_key: 'contract-key-1' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
});

test('POST /api/foods with a barcode already in the library answers that food, 200, unchanged', async () => {
  const first = await srv.api('POST', '/api/foods', { name: 'Scanned', barcode: '5000000000017' });
  const dup = await srv.api('POST', '/api/foods', { name: 'Scanned twice', barcode: '5000000000017' }, { example: 'foods.create.barcode-dedup' });
  assert.equal(first.status, 201);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.id, first.body.id);
  assert.equal(dup.body.name, 'Scanned');
});

test('GET /api/foods lists the account\'s foods by name', async () => {
  const r = await srv.api('GET', '/api/foods', undefined, { example: 'foods.list' });
  assert.equal(r.status, 200);
  assertShape(r.body, [FOOD]);
  const names = r.body.map(f => f.name);
  assert.ok(names.includes('Rolled oats'));
  // ORDER BY name: SQLite's binary collation, so case-sensitive (code point order).
  assert.deepEqual(names, [...names].sort(), 'name order');
});

test('GET /api/foods/:id; 404 for an id that does not exist', async () => {
  const r = await srv.api('GET', `/api/foods/${oats.id}`);
  assert.equal(r.status, 200);
  assertShape(r.body, FOOD);
  const missing = await srv.api('GET', '/api/foods/999999');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Not found' });
});

test('PUT /api/foods/:id changes the fields sent and keeps the rest', async () => {
  const r = await srv.api('PUT', `/api/foods/${oats.id}`, { name: 'Oats, rolled', favorite: true }, { example: 'foods.update' });
  assert.equal(r.status, 200);
  assertShape(r.body, FOOD);
  assert.equal(r.body.name, 'Oats, rolled');
  assert.equal(r.body.favorite, 1);
  assert.equal(r.body.brand, 'Contract Mills');
  assert.deepEqual(r.body.nutrition, OATS.nutrition);
});

test('POST /api/foods/:id/used counts a use on the given day', async () => {
  const r = await srv.api('POST', `/api/foods/${oats.id}/used`, { date: '2026-10-14' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  const after = await srv.api('GET', `/api/foods/${oats.id}`);
  assert.equal(after.body.usage_count, 1);
  assert.equal(after.body.last_used_at, '2026-10-14');
});

test('DELETE /api/foods/:id is a soft delete: gone from the list', async () => {
  const made = await srv.api('POST', '/api/foods', { name: 'To delete' });
  const r = await srv.api('DELETE', `/api/foods/${made.body.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  const list = await srv.api('GET', '/api/foods');
  assert.ok(!list.body.some(f => f.id === made.body.id));
  const again = await srv.api('DELETE', '/api/foods/999999');
  assert.equal(again.status, 404);
  assertShape(again.body, ERROR);
});

test('GET /api/foods/:id of a deleted food is 404', async () => {
  const made = await srv.api('POST', '/api/foods', { name: 'Deleted, then read' });
  await srv.api('DELETE', `/api/foods/${made.body.id}`);
  assert.equal((await srv.api('GET', `/api/foods/${made.body.id}`)).status, 404);
});
