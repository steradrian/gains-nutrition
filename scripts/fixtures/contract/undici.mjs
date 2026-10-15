// The server's 'undici', for the contract tests (hooks.mjs maps it here).
// Everything is the real package except fetch: a request to one of the food
// databases goes to the fake upstream the test runs (CONTRACT_FAKE_UPSTREAM),
// with the host it was meant for in X-Contract-Host; a request to any other
// host that is not this machine is refused, so the tests never touch the
// network.
import { fetch as realFetch } from 'undici';
import { routedFetch } from './hosts.mjs';

export * from 'undici';

export function fetch(input, init) {
  return routedFetch(realFetch, input, init);
}
