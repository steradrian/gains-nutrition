// The upstream hosts the contract tests fake: the ones /api/proxy may reach
// for food data (server/routes/proxy.js API_ALLOWED).
export const FAKE_HOSTS = new Set(['world.openfoodfacts.org', 'search.openfoodfacts.org', 'api.nal.usda.gov']);

// A public documentation address (TEST-NET-3), so the SSRF guard's check of
// the resolved address passes without a real DNS lookup.
export const FAKE_ADDRESS = '203.0.113.10';

export const isLoopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());

/**
 * Where a request may go: { url, host } with the fake upstream's URL for a
 * faked host (host is the one it was meant for), { url } unchanged for this
 * machine, or { refused } for anything else.
 */
export function route(input) {
  const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
  if (FAKE_HOSTS.has(url.hostname)) {
    const fake = process.env.CONTRACT_FAKE_UPSTREAM;
    if (!fake) return { refused: `no fake upstream for ${url.hostname}` };
    return { url: new URL(url.pathname + url.search, fake), host: url.hostname };
  }
  if (!isLoopback(url.hostname)) return { refused: `no network (${url.hostname})` };
  return { url };
}

/** fetch through route(): faked hosts reach the fake upstream, tagged with X-Contract-Host. */
export function routedFetch(realFetch, input, init = {}) {
  const r = route(input);
  if (r.refused) return Promise.reject(new Error(`contract tests: ${r.refused}`));
  if (!r.host) return realFetch(input, init);
  const headers = new Headers(init.headers || {});
  headers.set('x-contract-host', r.host);
  // A pinned dispatcher would connect to the checked address; the fake
  // listens on loopback instead.
  const { dispatcher, ...rest } = init;
  return realFetch(r.url, { ...rest, headers });
}
