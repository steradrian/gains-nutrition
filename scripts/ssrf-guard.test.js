/**
 * Unit tests for server/lib/ssrf-guard.js, the shared SSRF guard used by
 * outgoing webhooks. Pure functions plus one DNS lookup against
 * 'localhost' (resolved via the OS hosts file, no external network
 * needed), no db.js import, runs without a compiled better-sqlite3
 * native binding. Ported from LiftTrace's scripts/ssrf-guard.test.js.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLinkLocalOrCloudMeta, isPrivateOrLoopback, assertSafeUrl, ipv6Groups } from '../server/lib/ssrf-guard.js';

test('isLinkLocalOrCloudMeta blocks the cloud-metadata address and link-local ranges', () => {
  assert.equal(isLinkLocalOrCloudMeta('169.254.169.254'), true);
  assert.equal(isLinkLocalOrCloudMeta('169.254.0.1'), true);
  assert.equal(isLinkLocalOrCloudMeta('fe80::1'), true);
  assert.equal(isLinkLocalOrCloudMeta('::ffff:169.254.169.254'), true);
  assert.equal(isLinkLocalOrCloudMeta('8.8.8.8'), false);
});

test('isPrivateOrLoopback blocks loopback, RFC1918, and IPv6 ULA', () => {
  assert.equal(isPrivateOrLoopback('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopback('10.0.0.5'), true);
  assert.equal(isPrivateOrLoopback('192.168.1.1'), true);
  assert.equal(isPrivateOrLoopback('172.16.0.1'), true);
  assert.equal(isPrivateOrLoopback('172.32.0.1'), false); // just outside the 172.16-31 range
  assert.equal(isPrivateOrLoopback('::1'), true);
  assert.equal(isPrivateOrLoopback('fc00::1'), true);
  assert.equal(isPrivateOrLoopback('8.8.8.8'), false);
});

test('ipv6Groups reads every spelling of an IPv6 address', () => {
  assert.deepEqual(ipv6Groups('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ipv6Groups('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(ipv6Groups('fe80::'), [0xfe80, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ipv6Groups('2001:DB8::8:800:200C:417A'), [0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a]);
  assert.deepEqual(ipv6Groups('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(ipv6Groups('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(ipv6Groups('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const bad of ['127.0.0.1', 'not-an-ip', '1::2::3', '12345::', '', null, undefined]) assert.equal(ipv6Groups(bad), null, String(bad));
});

// Every spelling that reaches an IPv4 address, or a range that is local by
// definition, is classified as what it reaches.
test('isPrivateOrLoopback unwraps or blocks the IPv6 forms that reach a private address', () => {
  const blocked = {
    'IPv4-compatible loopback (::7f00:1)':       '::7f00:1',
    'IPv4-compatible loopback, dotted':           '::127.0.0.1',
    'IPv4-compatible RFC1918':                    '::10.1.2.3',
    'IPv4-mapped loopback, hex':                  '::ffff:7f00:1',
    'IPv4-mapped, long form':                     '0:0:0:0:0:ffff:c0a8:101',
    'IPv4-translated (SIIT) loopback':            '::ffff:0:7f00:1',
    'local-use NAT64 (64:ff9b:1::/48)':           '64:ff9b:1::a00:1',
    'local-use NAT64 of a public address':        '64:ff9b:1:ffff::808:808',
    '6to4 of loopback (2002:7f00:1::)':           '2002:7f00:1::1',
    '6to4 of RFC1918':                            '2002:c0a8:101::1',
    '6to4 of 0.0.0.0':                            '2002::',
    'site-local (fec0::/10)':                     'fec0::1',
    'site-local, top of the range':               'feff:ffff::1',
    'loopback, long form':                        '0:0:0:0:0:0:0:1',
    'unspecified, long form':                     '0:0:0:0:0:0:0:0',
    'unique-local':                               'fd12:3456::1',
    'multicast':                                  'ff0e::1',
  };
  for (const [name, ip] of Object.entries(blocked)) assert.equal(isPrivateOrLoopback(ip), true, `${name}: ${ip}`);

  const allowed = {
    'IPv4-compatible public':      '::8.8.8.8',
    '6to4 of a public address':    '2002:808:808::1',
    'NAT64 of a public address':   '64:ff9b::808:808',
    'global unicast':              '2606:4700:4700::1111',
    'just below site-local':       'febf::1',
    'not ULA, not multicast (fc::1 is 00fc::1)': 'fc::1',
  };
  for (const [name, ip] of Object.entries(allowed)) assert.equal(isPrivateOrLoopback(ip), false, `${name}: ${ip}`);
});

test('isLinkLocalOrCloudMeta sees cloud metadata behind every IPv6 wrapper', () => {
  for (const ip of ['::a9fe:a9fe', '::169.254.169.254', '2002:a9fe:a9fe::', '::ffff:0:a9fe:a9fe', 'fd00:ec2:0:0:0:0:0:254', 'febf::1', 'fe80::1%eth0']) {
    assert.equal(isLinkLocalOrCloudMeta(ip), true, ip);
  }
  for (const ip of ['fec0::1', '2002:808:808::', 'fd00:ec2::255']) assert.equal(isLinkLocalOrCloudMeta(ip), false, ip);
});

test('assertSafeUrl rejects a non-http(s) protocol before any DNS lookup', async () => {
  await assert.rejects(() => assertSafeUrl('ftp://example.com'), /http and https/);
});

test('assertSafeUrl rejects an unparseable URL', async () => {
  await assert.rejects(() => assertSafeUrl('not a url'), /Invalid URL/);
});

test('assertSafeUrl blocks localhost by default, allows it with allowPrivate: true', async () => {
  await assert.rejects(() => assertSafeUrl('http://localhost:8080/'), /Private|loopback/);
  const parsed = await assertSafeUrl('http://localhost:8080/', { allowPrivate: true });
  assert.equal(parsed.hostname, 'localhost');
});

test('assertSafeUrl error message includes the caller-supplied env var hint', async () => {
  await assert.rejects(
    () => assertSafeUrl('http://localhost/', { allowPrivateEnvHint: 'ALLOW_PRIVATE_WEBHOOK_URLS' }),
    /ALLOW_PRIVATE_WEBHOOK_URLS/
  );
});
