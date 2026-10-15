/**
 * The User-Agent sent to Open Food Facts (server/lib/off-user-agent.js): the
 * app name, version and contact OFF asks for, configurable with
 * OFF_USER_AGENT, sent to OFF hosts and only to them. The same agent on the
 * wire, through /api/proxy, is in off-user-agent-proxy.test.js.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_OFF_USER_AGENT, offUserAgent, isOffHost, userAgentFor } from '../server/lib/off-user-agent.js';

const BROWSER = 'Mozilla/5.0 (compatible; NutriTrace/1.0)';

test('the default names the app, its version and where to reach it', () => {
  assert.equal(DEFAULT_OFF_USER_AGENT, 'Gains/0.1.0 (+https://github.com/steradrian/gains)');
  assert.equal(offUserAgent({}), DEFAULT_OFF_USER_AGENT);
  assert.match(DEFAULT_OFF_USER_AGENT, /^\S+\/\d+\.\d+\.\d+ \(\+https:\/\/\S+\)$/, 'name/version (+contact)');
});

test('OFF_USER_AGENT replaces it; empty or blank means the default', () => {
  assert.equal(offUserAgent({ OFF_USER_AGENT: 'MyGains/2.1 (me@example.com)' }), 'MyGains/2.1 (me@example.com)');
  assert.equal(offUserAgent({ OFF_USER_AGENT: '  padded/1.0 (a@b.c)  ' }), 'padded/1.0 (a@b.c)');
  for (const v of ['', '   ', '\n', undefined, null, 42]) assert.equal(offUserAgent({ OFF_USER_AGENT: v }), DEFAULT_OFF_USER_AGENT, JSON.stringify(v));
});

test('only printable ASCII goes out, and no more than 200 characters', () => {
  assert.equal(offUserAgent({ OFF_USER_AGENT: 'A/1 (x)\r\nX-Evil: 1' }), 'A/1 (x)X-Evil: 1', 'a header cannot be smuggled in');
  assert.equal(offUserAgent({ OFF_USER_AGENT: 'Gäins/1 (é)' }), 'Gins/1 ()');
  assert.equal(offUserAgent({ OFF_USER_AGENT: '\u0000\u0001\u007f' }), DEFAULT_OFF_USER_AGENT, 'nothing left: the default');
  assert.equal(offUserAgent({ OFF_USER_AGENT: 'x'.repeat(500) }).length, 200);
});

test('it follows the environment at the time of the call', () => {
  const was = process.env.OFF_USER_AGENT;
  try {
    delete process.env.OFF_USER_AGENT;
    assert.equal(offUserAgent(), DEFAULT_OFF_USER_AGENT);
    process.env.OFF_USER_AGENT = 'Later/1.0 (x@y.z)';
    assert.equal(offUserAgent(), 'Later/1.0 (x@y.z)');
  } finally { if (was === undefined) delete process.env.OFF_USER_AGENT; else process.env.OFF_USER_AGENT = was; }
});

test('an OFF host is openfoodfacts.org or a subdomain of it, never a look-alike', () => {
  for (const h of ['openfoodfacts.org', 'world.openfoodfacts.org', 'search.openfoodfacts.org', 'images.openfoodfacts.org', 'WORLD.OpenFoodFacts.org', 'world.openfoodfacts.org.']) {
    assert.equal(isOffHost(h), true, h);
  }
  for (const h of ['openfoodfacts.org.evil.tld', 'notopenfoodfacts.org', 'openfoodfacts.com', 'api.nal.usda.gov', 'i.imgur.com', '', undefined, null]) {
    assert.equal(isOffHost(h), false, String(h));
  }
});

test('userAgentFor: the configured agent for an OFF URL (search, product, image), what the call sent before for the rest', () => {
  const was = process.env.OFF_USER_AGENT;
  try {
    process.env.OFF_USER_AGENT = 'Mine/1 (m@e.x)';
    for (const url of [
      'https://search.openfoodfacts.org/search?q=oats',
      'https://world.openfoodfacts.org/api/v3/product/3017620422003',
      'https://world.openfoodfacts.org/api/v2/search?search_terms=oats',
      'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.jpg',
      'https://challenges.openfoodfacts.org/products.duckdb',
    ]) assert.equal(userAgentFor(url, BROWSER), 'Mine/1 (m@e.x)', url);
    for (const url of ['https://api.nal.usda.gov/fdc/v1/foods/search', 'https://i.imgur.com/a.jpg', 'https://openfoodfacts.org.evil.tld/x', 'https://huggingface.co/datasets/x', 'not a url', '']) {
      assert.equal(userAgentFor(url, BROWSER), BROWSER, url);
    }
    assert.equal(userAgentFor('https://huggingface.co/x', null), null, 'a call that sent none before still sends none');
  } finally { if (was === undefined) delete process.env.OFF_USER_AGENT; else process.env.OFF_USER_AGENT = was; }
});

test('no outbound request to an OFF host is left with the old agent (source check)', async () => {
  const { readFileSync } = await import('node:fs');
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const file of ['../server/routes/proxy.js', '../server/lib/image-localizer.js', '../server/lib/off-local.js']) {
    const src = read(file);
    assert.match(src, /userAgentFor\(/, `${file} asks for the agent by host`);
  }
  // The literal survives only as the fallback for hosts that are not OFF.
  for (const file of ['../server/routes/proxy.js', '../server/lib/image-localizer.js']) {
    const lines = read(file).split('\n').filter(l => l.includes('NutriTrace/1.0'));
    assert.ok(lines.length > 0 && lines.every(l => l.includes('userAgentFor(')), `${file}: the old agent is only the fallback`);
  }
});
