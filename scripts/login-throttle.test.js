/**
 * The sign-in throttle's counters (server/lib/login-throttle.js).
 *
 *   - a map never holds more than its cap: the oldest window goes first,
 *     and expired windows are trimmed as new keys arrive;
 *   - IPv6 clients are counted per /64, so rotating addresses inside one
 *     /64 does not buy fresh tries; IPv4 (also IPv4-mapped) per address.
 *
 * Pure: no database, no Express.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientKey, createBuckets } from '../server/lib/login-throttle.js';

const clock = (t = 1_000_000) => { const c = () => t; c.advance = ms => { t += ms; }; return c; };

test('counts tries per key inside the window, then lets the key try again', () => {
  const now = clock();
  const b = createBuckets({ max: 3, windowMs: 1000, now });
  assert.deepEqual([b.hit('a'), b.hit('a'), b.hit('a'), b.hit('a')], [true, true, true, false]);
  assert.equal(b.hit('b'), true, 'another key has its own count');
  now.advance(1000);
  assert.equal(b.hit('a'), true, 'a new window');
});

test('the map never grows past its cap; the oldest window is evicted first', () => {
  const now = clock();
  const b = createBuckets({ max: 1, windowMs: 60_000, cap: 100, now });
  for (let i = 0; i < 1000; i++) { b.hit(`k${i}`); now.advance(1); }
  assert.equal(b.size(), 100);
  assert.equal(b.has('k0'), false, 'oldest gone');
  assert.equal(b.has('k899'), false);
  assert.equal(b.has('k900'), true, 'the newest 100 stay');
  assert.equal(b.has('k999'), true);
  assert.equal(b.hit('k999'), false, 'a kept key still counts');
});

test('a key that starts a new window moves to the back of the eviction order', () => {
  const now = clock();
  const b = createBuckets({ max: 5, windowMs: 100, cap: 3, now });
  b.hit('old');
  now.advance(50);
  b.hit('mid');
  now.advance(60); // 'old' expired, 'mid' has not
  b.hit('old'); // new window for 'old'
  b.hit('x'); b.hit('y'); // full: the oldest live window is 'mid'
  assert.equal(b.has('mid'), false);
  assert.equal(b.has('old'), true);
});

test('expired windows are trimmed as new keys arrive, without waiting for the cap', () => {
  const now = clock();
  const b = createBuckets({ max: 5, windowMs: 100, cap: 1000, now });
  for (let i = 0; i < 50; i++) b.hit(`k${i}`);
  now.advance(100);
  b.hit('fresh');
  assert.equal(b.size(), 1);
});

test('IPv6 clients are keyed by /64, IPv4 by address', () => {
  assert.equal(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:DB8:1:2:FFFF::'), '2001:db8:1:2::/64', 'any spelling');
  assert.equal(clientKey('2001:db8:1:3::1'), '2001:db8:1:3::/64', 'the next /64 is another client');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('203.0.113.9'), '203.0.113.9');
  assert.equal(clientKey('::ffff:203.0.113.9'), '203.0.113.9', 'IPv4-mapped is the IPv4 client');
  assert.equal(clientKey(undefined), '');
});

test('rotating addresses inside one /64 shares one bucket', () => {
  const b = createBuckets({ max: 10, windowMs: 60_000 });
  const tries = [];
  for (let i = 0; i < 12; i++) tries.push(b.hit(clientKey(`2001:db8:aa:bb::${(i + 1).toString(16)}`)));
  assert.deepEqual(tries.slice(0, 10), Array(10).fill(true));
  assert.deepEqual(tries.slice(10), [false, false]);
  assert.equal(b.hit(clientKey('2001:db8:aa:bc::1')), true, 'a different /64 is not throttled');
});
