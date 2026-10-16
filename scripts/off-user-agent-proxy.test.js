/**
 * The User-Agent on the wire (docs/tickets/cloud-11-nutrition-small-fixes.md,
 * task 1): through GET /api/proxy, a request to an Open Food Facts host (a
 * search, a product lookup, an image) carries the app name, version and
 * contact OFF asks for: Gains/0.1.0 (+https://github.com/steradrian/gains)
 * unless OFF_USER_AGENT sets another. A host that is not OFF is sent what it
 * always was. The agent function itself is in off-user-agent.test.js.
 *
 * Two servers on the contract tests' fake upstream (fixtures/contract), one
 * with the default and one with the variable set. No network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { startUpstream, OFF_PRODUCT_CODE, OFF_SEARCH_QUERY, USDA_QUERY } from './fixtures/contract/upstream.mjs';

const DEFAULT = 'Gains/0.1.0 (+https://github.com/steradrian/gains)';
const CUSTOM = 'MyGains/2.0 (+https://github.com/you/your-gains)';
const BROWSER = 'Mozilla/5.0 (compatible; NutriTrace/1.0)';

const upstream = await startUpstream();
const plain = await startServer({ file: import.meta.url, upstream: upstream.origin });
const custom = await startServer({ file: import.meta.url, upstream: upstream.origin, env: { OFF_USER_AGENT: CUSTOM } });
test.after(async () => { await plain.stop(); await custom.stop(); await upstream.close(); });

// What the upstream saw for one proxied URL: { status, host, agent }.
async function viaProxy(srv, url) {
  const before = upstream.seen.length;
  const r = await srv.api('GET', `/api/proxy?url=${encodeURIComponent(url)}`, undefined, { token: null });
  assert.equal(upstream.seen.length, before + 1, `exactly one request reached the upstream for ${url}`);
  return { status: r.status, host: upstream.seen.at(-1).host, agent: upstream.agents.at(-1) };
}

const SEARCH = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(OFF_SEARCH_QUERY)}&page_size=5&page=1&langs=en`;
const PRODUCT = `https://world.openfoodfacts.org/api/v3/product/${OFF_PRODUCT_CODE}`;
const IMAGE = 'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.jpg';
const USDA = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${USDA_QUERY}&api_key=DEMO`;

test('by default an OFF search, a product lookup and an image all send the Gains agent', async () => {
  for (const [what, url, host] of [['search', SEARCH, 'search.openfoodfacts.org'], ['product', PRODUCT, 'world.openfoodfacts.org'], ['image', IMAGE, 'images.openfoodfacts.org']]) {
    const seen = await viaProxy(plain, url);
    assert.equal(seen.status, 200, what);
    assert.equal(seen.host, host, what);
    assert.equal(seen.agent, DEFAULT, `${what} sends the configured agent`);
  }
});

test('OFF_USER_AGENT changes it for every one of them', async () => {
  for (const [what, url] of [['search', SEARCH], ['product', PRODUCT], ['image', IMAGE]]) {
    const seen = await viaProxy(custom, url);
    assert.equal(seen.status, 200, what);
    assert.equal(seen.agent, CUSTOM, what);
  }
});

test('a host that is not Open Food Facts is sent what it was before', async () => {
  const seen = await viaProxy(custom, USDA);
  assert.equal(seen.status, 200);
  assert.equal(seen.host, 'api.nal.usda.gov');
  assert.equal(seen.agent, BROWSER, 'the setting is for OFF, not for every host the proxy reaches');
});

test('the old agent is not sent to OFF any more', async () => {
  for (const srv of [plain, custom]) {
    const seen = await viaProxy(srv, PRODUCT);
    assert.notEqual(seen.agent, BROWSER);
    assert.doesNotMatch(seen.agent, /Mozilla|NutriTrace/);
  }
});
