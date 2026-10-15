/**
 * API contract: food search (docs/api-contract.md, "Search").
 *
 * The server has no search endpoint of its own: the client searches its
 * library in memory, and Open Food Facts and USDA through GET /api/proxy,
 * which passes the upstream JSON through unchanged. These tests send the
 * upstream URLs the client builds (src/lib/api.js) to a fake upstream
 * (fixtures/contract/upstream.mjs) and pin both what reaches it and what
 * comes back. No network: the server's outbound requests are redirected
 * (fixtures/contract/net.mjs).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { startUpstream, OFF_SEARCH_QUERY, USDA_QUERY } from './fixtures/contract/upstream.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { ERROR } from './fixtures/contract/schemas.mjs';

const upstream = await startUpstream();
const srv = await startServer({ file: import.meta.url, upstream: upstream.origin });
test.after(async () => { await srv.stop(); await upstream.close(); });

// The proxy is reached before sign-in: no token.
const proxy = (url, opts = {}) => srv.api('GET', `/api/proxy?url=${encodeURIComponent(url)}`, undefined, { token: null, ...opts });
const last = () => upstream.seen.at(-1);

// search.openfoodfacts.org (search-a-licious), as API.searchByNameWithMeta builds it.
const offSearch = (q, page, pageSize) =>
  `https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&page_size=${pageSize}&page=${page}&langs=en`;

const OFF_HITS = { hits: [{ code: 'string', product_name: 'string' }], count: 'integer', page: 'integer', page_size: 'integer' };

test('Open Food Facts search: { hits, count, page, page_size }, passed through as the upstream sent it', async () => {
  const r = await proxy(offSearch(OFF_SEARCH_QUERY, 1, 50), { example: 'search.off' });
  assert.equal(r.status, 200);
  assertShape(r.body, OFF_HITS);
  assert.ok(r.body.hits.length > 0);
  assert.equal(r.body.page, 1);
  assert.deepEqual(last(), {
    host: 'search.openfoodfacts.org', path: '/search',
    query: { q: OFF_SEARCH_QUERY, page_size: '50', page: '1', langs: 'en' },
  });
});

test('Open Food Facts search pages with page / page_size; count is the total, so more = page * page_size < count', async () => {
  const p1 = await proxy(offSearch(OFF_SEARCH_QUERY, 1, 5));
  const p2 = await proxy(offSearch(OFF_SEARCH_QUERY, 2, 5));
  assert.equal(p1.body.hits.length, 5);
  assert.equal(p2.body.page, 2);
  assert.notDeepEqual(p2.body.hits.map(h => h.code), p1.body.hits.map(h => h.code));
  assert.ok(1 * 5 < p1.body.count, 'the client asks for page 2');
});

test('Open Food Facts search with no hits: hits [] and count 0', async () => {
  const r = await proxy(offSearch('zzz nothing matches', 1, 50));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.hits, []);
  assert.equal(r.body.count, 0);
});

test('USDA search: { foods, totalHits, currentPage, totalPages }, the key travelling in the URL', async () => {
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${USDA_QUERY}&pageSize=50&pageNumber=1&api_key=CONTRACT_KEY`;
  const r = await proxy(url, { example: 'search.usda' });
  assert.equal(r.status, 200);
  assertShape(r.body, {
    totalHits: 'integer', currentPage: 'integer', totalPages: 'integer',
    foods: [{ fdcId: 'integer', description: 'string', dataType: 'string', foodNutrients: [{ nutrientId: 'integer', value: 'number', unitName: 'string' }] }],
  });
  assert.deepEqual(last().query, { query: USDA_QUERY, pageSize: '50', pageNumber: '1', api_key: 'CONTRACT_KEY' });
});

test('an upstream error keeps its status: { error: "Upstream <status>" }', async () => {
  const badKey = await proxy(`https://api.nal.usda.gov/fdc/v1/foods/search?query=x&pageSize=50&pageNumber=1&api_key=BAD`);
  assert.equal(badKey.status, 403);
  assert.deepEqual(badKey.body, { error: 'Upstream 403' });
  const broken = await proxy('https://world.openfoodfacts.org/boom');
  assert.equal(broken.status, 500);
  assert.deepEqual(broken.body, { error: 'Upstream 500' });
});

test('the proxy reaches only the food databases (and listed image hosts)', async () => {
  const none = await srv.api('GET', '/api/proxy', undefined, { token: null });
  assert.equal(none.status, 400);
  assert.deepEqual(none.body, { error: 'url required' });
  const ftp = await proxy('ftp://world.openfoodfacts.org/x');
  assert.equal(ftp.status, 403);
  assert.deepEqual(ftp.body, { error: 'Protocol not allowed' });
  const other = await proxy('https://example.com/api');
  assert.equal(other.status, 403);
  assert.deepEqual(other.body, { error: 'Domain not allowed' });
  const lookalike = await proxy('https://world.openfoodfacts.org.example.com/api');
  assert.equal(lookalike.status, 403);
});

test('an upstream answer that is not JSON is 503 { error: "Could not reach that service" }', async () => {
  const r = await proxy(`https://api.nal.usda.gov/fdc/v1/foods/search?query=notjson&pageSize=50&pageNumber=1&api_key=SECRET_USDA_KEY`);
  assert.equal(r.status, 503);
  assertShape(r.body, ERROR);
  assert.deepEqual(r.body, { error: 'Could not reach that service' });
});

// Found while writing the contract: on an error routes/proxy.js logs the
// whole upstream URL, and a USDA search URL carries the user's api_key.
test('the proxy never logs a USDA api_key', { todo: 'routes/proxy.js logs the full upstream URL on error, api_key included' }, async () => {
  await proxy(`https://api.nal.usda.gov/fdc/v1/foods/search?query=notjson&pageSize=50&pageNumber=1&api_key=SECRET_USDA_KEY_2`);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!srv.log().includes('SECRET_USDA_KEY_2'));
});
