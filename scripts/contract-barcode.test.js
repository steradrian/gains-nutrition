/**
 * API contract: barcode lookup (docs/api-contract.md, "Barcode").
 *
 * The client looks a scanned code up in the account's library first, then
 * in Open Food Facts' v3 product API through GET /api/proxy (src/lib/api.js
 * API.lookupBarcode); USDA is not asked. The server passes the upstream
 * answer through; a miss keeps the upstream's 404, which the client reads
 * as "not found" and opens the food editor with only the barcode filled in.
 * The fields pinned below are the ones the client maps (_mapOFFProduct).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { startUpstream, OFF_PRODUCT, OFF_PRODUCT_CODE } from './fixtures/contract/upstream.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';

const upstream = await startUpstream();
const srv = await startServer({ file: import.meta.url, upstream: upstream.origin });
test.after(async () => { await srv.stop(); await upstream.close(); });

const proxy = (url, opts = {}) => srv.api('GET', `/api/proxy?url=${encodeURIComponent(url)}`, undefined, { token: null, ...opts });
const product = code => `https://world.openfoodfacts.org/api/v3/product/${code}?lc=en`;

// What the client reads from a product (src/lib/api.js _mapOFFProduct).
const OFF_PRODUCT_SHAPE = {
  code: 'string', product_name: 'string', brands: 'string',
  serving_quantity: 'string|number?', nutrition_data_per: 'string?', image_front_url: 'string?',
  nutriments: { 'energy-kcal_100g': 'number', proteins_100g: 'number', carbohydrates_100g: 'number', fat_100g: 'number' },
};

test('a hit: { status: "success", product }, passed through', async () => {
  const r = await proxy(product(OFF_PRODUCT_CODE), { example: 'barcode.hit' });
  assert.equal(r.status, 200);
  assertShape(r.body, { status: 'string', product: OFF_PRODUCT_SHAPE });
  assert.equal(r.body.status, 'success');
  assert.deepEqual(r.body.product.nutriments, OFF_PRODUCT.nutriments);
  assert.deepEqual(upstream.seen.at(-1), { host: 'world.openfoodfacts.org', path: `/api/v3/product/${OFF_PRODUCT_CODE}`, query: { lc: 'en' } });
});

test('the "as sold" nutrition set the client asks for when v3 has only prepared values', async () => {
  const r = await proxy(`https://world.openfoodfacts.org/api/v3.5/product/${OFF_PRODUCT_CODE}?fields=nutrition`);
  assert.equal(r.status, 200);
  assertShape(r.body, { status: 'string', product: { nutriments: 'object' } });
});

test('a miss keeps the upstream 404: { error: "Upstream 404" }', async () => {
  const r = await proxy(product('0000000000000'), { example: 'barcode.miss' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Upstream 404' });
});

test('live=1 (Refresh from Open Food Facts) skips a local mirror; without one it is the same answer', async () => {
  const r = await srv.api('GET', `/api/proxy?url=${encodeURIComponent(product(OFF_PRODUCT_CODE))}&live=1`, undefined, { token: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.product.code, OFF_PRODUCT_CODE);
});

test('logging a scanned food saves it first, and the server keeps one food per barcode', async () => {
  const body = { name: OFF_PRODUCT.product_name, brand: 'Contract Foods', barcode: OFF_PRODUCT_CODE, portion: 100, unit: 'g', nutrition: { calories: 539 } };
  const first = await srv.api('POST', '/api/foods', body);
  const second = await srv.api('POST', '/api/foods', body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
});
