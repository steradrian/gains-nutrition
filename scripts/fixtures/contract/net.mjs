// Preloaded into the contract tests' server (node --import): no network.
//   - 'undici' resolves to undici.mjs (hooks.mjs), which sends the food
//     databases to the fake upstream and refuses every other outside host;
//   - DNS for those hosts answers a public test address without a lookup,
//     so the SSRF guard's check passes as it would for the real host;
//   - the built-in fetch does the same as undici.mjs's.
import { register } from 'node:module';
import dns from 'node:dns/promises';
import { FAKE_ADDRESS, FAKE_HOSTS, routedFetch } from './hosts.mjs';

register('./hooks.mjs', import.meta.url, {
  data: {
    wrapper: new URL('./undici.mjs', import.meta.url).href,
    serverUrl: new URL('../../../server/index.js', import.meta.url).href,
  },
});

const realLookup = dns.lookup.bind(dns);
dns.lookup = async (host, opts) => {
  if (!FAKE_HOSTS.has(host)) return realLookup(host, opts);
  const answer = { address: FAKE_ADDRESS, family: 4 };
  return opts?.all ? [answer] : answer;
};

// The built-in fetch is routed the same way (the SSRF guard uses it behind
// a forward proxy).
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => routedFetch(realFetch, input, init);
