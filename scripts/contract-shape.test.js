/**
 * The contract tests' shape checker (scripts/fixtures/contract/shape.mjs)
 * fails exactly when the API drifts: a field renamed, removed or retyped.
 * An added field passes. No server here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertShape, oneOf, optional, shapeProblems } from './fixtures/contract/shape.mjs';
import { FOOD } from './fixtures/contract/schemas.mjs';

const food = () => ({
  id: 1, user_id: 1, name: 'Oats', brand: null, nutrition: { calories: 379 }, portion: 100, unit: 'g',
  img_url: null, notes: null, category: null, barcode: null, visibility: 'private', source_id: null,
  source_app: null, source_external_id: null, source_url: null, favorite: 0, usage_count: 0, last_used_at: null,
  nutrition_basis: null, alt_units: null, density_g_ml: null, created_at: '2026-10-14 08:00:00',
  updated_at: '2026-10-14 08:00:00', deleted_at: null, changed_at: '2026-10-14 08:00:00', client_key: null,
});

test('a matching response passes, and an added field does not break it', () => {
  assertShape(food(), FOOD);
  assertShape({ ...food(), shiny_new_field: true }, FOOD);
  assertShape({ ...food(), alt_units: [{ abbr: 'cup', grams: 80 }] }, FOOD);
});

test('a removed field fails', () => {
  const { portion, ...rest } = food();
  assert.deepEqual(shapeProblems(rest, FOOD), ['$.portion: missing']);
});

test('a renamed field fails', () => {
  const { img_url, ...rest } = food();
  assert.ok(shapeProblems({ ...rest, image_url: null }, FOOD).includes('$.img_url: missing'));
});

test('a retyped field fails', () => {
  assert.equal(shapeProblems({ ...food(), favorite: false }, FOOD).length, 1, 'favorite is 0/1, not a boolean');
  assert.equal(shapeProblems({ ...food(), nutrition: '{"calories":379}' }, FOOD).length, 1, 'nutrition is parsed, not a string');
  assert.equal(shapeProblems({ ...food(), portion: '100' }, FOOD).length, 1);
  assert.equal(shapeProblems({ ...food(), alt_units: '[{"abbr":"cup","grams":80}]' }, FOOD).length, 1);
  assert.equal(shapeProblems({ ...food(), alt_units: [{ abbr: 'cup', grams: '80' }] }, FOOD).length, 1, 'inside arrays too');
  assert.equal(shapeProblems({ ...food(), created_at: '2026-10-14T08:00:00Z' }, FOOD).length, 1, 'a time in another format');
});

test('optional keys, unions and the special string types', () => {
  assertShape({}, { a: 'string?', b: optional({ c: 'integer' }) });
  assert.equal(shapeProblems({ b: { c: 1.5 } }, { b: optional({ c: 'integer' }) }).length, 1);
  assertShape({ d: '2026-10-14', t: '2026-10-14T08:00:00.123Z', j: '{"0":"x"}' }, { d: 'date', t: 'isotime', j: 'json' });
  assert.equal(shapeProblems({ d: '14/10/2026' }, { d: 'date' }).length, 1);
  assert.equal(shapeProblems({ v: 'x' }, { v: oneOf('null', ['string']) }).length, 1);
  assertShape({ v: ['x'] }, { v: oneOf('null', ['string']) });
  assert.throws(() => assertShape({ a: 1 }, { a: 'strng' }), /unknown type/);
});
