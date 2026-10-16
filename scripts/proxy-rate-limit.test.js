/**
 * /api/proxy needs no sign-in (Android WebView and old <img> diary images
 * call it bare), but when a request carries a session its rate limit is that
 * account's own. It used to be mounted before `authenticate`, so every
 * request was keyed by address: behind the hub or Cloudflare, every friend
 * shared one bucket of 60 a minute.
 *
 * A host off the allow-list answers 403 without any network, and still
 * counts against the limit, which is all this needs.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PASSWORD, startServer } from './fixtures/contract/server.mjs';

const JWT_SECRET = 'contract-test-secret-0123456789abcdef';
const srv = await startServer({ file: import.meta.url, env: { JWT_SECRET } });
const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
test.after(() => srv.stop());

const LIMIT = 60;
const offList = '/api/proxy?url=' + encodeURIComponent('https://not-on-the-list.example/x');

async function account(username) {
  const reg = await srv.api('POST', '/api/auth/register', { username, password: PASSWORD });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const { id, role } = reg.body.user;
  return jwt.sign({ id, username, role, csrf: 'proxy' }, JWT_SECRET);
}
const hit = (token, times) => Promise.all(Array.from({ length: times }, () => srv.api('GET', offList, undefined, { token })));

test('each account has its own bucket, and a request with no session has the address', async () => {
  const alice = await account('alice');
  const bob = await account('bob');

  const spent = await hit(alice, LIMIT);
  assert.ok(spent.every(r => r.status === 403), 'the first 60 are answered (403: host not allowed)');
  const over = await srv.api('GET', offList, undefined, { token: alice });
  assert.equal(over.status, 429, 'alice is over her limit');
  assert.ok(Number(over.headers.get('retry-after')) > 0);

  assert.equal((await srv.api('GET', offList, undefined, { token: bob })).status, 403, 'bob is not limited by alice');
  assert.equal((await srv.api('GET', offList, undefined, { token: null })).status, 403, 'nor is a request with no session');
});

test('no session still works: the address is its own bucket, spent by anonymous requests only', async () => {
  const carol = await account('carol');
  const anon = await hit(null, LIMIT - 1);   // the first test spent one
  assert.ok(anon.every(r => r.status === 403));
  assert.equal((await srv.api('GET', offList, undefined, { token: null })).status, 429, 'the anonymous bucket is spent');
  assert.equal((await srv.api('GET', offList, undefined, { token: carol })).status, 403, 'a signed-in account behind the same address is not');
});
