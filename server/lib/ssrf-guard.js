/**
 * server/lib/ssrf-guard.js
 *
 * The guard for every server-side request to an address a user can
 * influence. The same file in all four Trace apps: change one, change all.
 *
 * Address classes:
 *   - Link-local / IPv6 link-local / cloud metadata (169.254.169.254):
 *     always refused. Never legitimate for any caller.
 *   - Loopback, RFC1918, CGNAT, IPv6 ULA (the server's own network):
 *     refused unless the caller allows them. Callers decide by purpose:
 *     features made for services on the home network (push, Mealie,
 *     CookTrace, NutriTrace, Navidrome) allow them for everyone; features
 *     made for the public web (recipe URLs, link previews, radio streams,
 *     a user's own AI address) allow them for the owner only, unless the
 *     owner opts everyone in with that feature's ALLOW_PRIVATE_* variable.
 *
 * fetchChecked() is the way to make such a request: it checks every
 * address the host resolves to, connects only to those addresses, and
 * checks every redirect hop the same way. assertSafeUrl() only checks; a
 * plain fetch after it resolves again, so prefer fetchChecked().
 */
import dns from 'dns/promises';
import net from 'net';
import { Agent, fetch as undiciFetch } from 'undici';

const _CLOUD_META = new Set(['100.100.100.200', '168.63.129.16']);

/**
 * The eight 16-bit groups of an IPv6 address (any spelling: `::`, a
 * trailing dotted quad, a zone id), or null when it is not one.
 */
export function ipv6Groups(ip) {
  let s = String(ip ?? '').toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  const quad = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (quad) {
    const [a, b, c, d] = quad.slice(2).map(Number);
    s = `${quad[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => g >= 0 && g <= 0xffff) ? groups : null;
}

const _v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
const _zero = (g, from, to) => g.slice(from, to).every(x => x === 0);

// The IPv4 address an IPv6 address stands for, or null:
//   ::ffff:a.b.c.d      IPv4-mapped
//   ::ffff:0:a.b.c.d    IPv4-translated (SIIT)
//   ::a.b.c.d           IPv4-compatible (deprecated, ::7f00:1 is 127.0.0.1),
//                       but not :: or ::1
//   64:ff9b::a.b.c.d    NAT64 well-known prefix
//   2002:AABB:CCDD::/48 6to4, the IPv4 address in groups 1 and 2
function _embeddedV4(g) {
  if (_zero(g, 0, 5) && g[5] === 0xffff) return _v4(g[6], g[7]);
  if (_zero(g, 0, 4) && g[4] === 0xffff && g[5] === 0) return _v4(g[6], g[7]);
  if (_zero(g, 0, 6) && !(g[6] === 0 && g[7] <= 1)) return _v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && _zero(g, 2, 6)) return _v4(g[6], g[7]);
  if (g[0] === 0x2002) return _v4(g[1], g[2]);
  return null;
}

export function isLinkLocalOrCloudMeta(ip) {
  if (net.isIPv4(ip)) return ip.startsWith('169.254.') || _CLOUD_META.has(ip);
  const g = ipv6Groups(ip);
  if (g) {
    const v4 = _embeddedV4(g);
    if (v4) return isLinkLocalOrCloudMeta(v4);
    // fd00:ec2::254, AWS's IPv6 metadata address
    if (g[0] === 0xfd00 && g[1] === 0xec2 && _zero(g, 2, 7) && g[7] === 0x254) return true;
    // fe80::/10, link-local
    if ((g[0] & 0xffc0) === 0xfe80) return true;
  }
  return false;
}

export function isPrivateOrLoopback(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0) return true;                                  // 0.0.0.0/8
    if (o[0] === 127) return true;                                 // 127.0.0.0/8 loopback
    if (o[0] === 10) return true;                                  // 10.0.0.0/8
    if (o[0] === 192 && o[1] === 168) return true;                 // 192.168.0.0/16
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;     // 172.16.0.0/12
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;    // 100.64.0.0/10 CGNAT
    if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;     // 192.0.0.0/24 IETF special use
    if (o[0] >= 224) return true;                                  // multicast, reserved, broadcast
    return false;
  }
  const g = ipv6Groups(ip);
  if (g) {
    const v4 = _embeddedV4(g);
    if (v4) return isPrivateOrLoopback(v4);
    if (_zero(g, 0, 7) && g[7] <= 1) return true;                  // :: and ::1
    if ((g[0] & 0xff00) === 0xff00) return true;                   // ff00::/8 multicast
    if ((g[0] & 0xfe00) === 0xfc00) return true;                   // fc00::/7 unique-local
    if ((g[0] & 0xffc0) === 0xfec0) return true;                   // fec0::/10 site-local (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  }
  return false;
}

/**
 * Resolve the URL's hostname and reject anything that lands on a blocked
 * IP. Returns a parsed URL on success; throws Error with a friendly
 * message on failure. Caller should map to 400 / silent-skip as
 * appropriate.
 *
 * `allowPrivate` (default false) governs whether a loopback/RFC1918/ULA
 * address is permitted: pass the calling feature's own opt-in flag.
 * `allowPrivateEnvHint` is used only in the error message so a self-
 * hoster knows which env var to set: callers pass their own var name.
 *
 * Note on DNS rebinding: this function resolves once, and a plain fetch
 * after it resolves again, so a host could answer the two lookups
 * differently. fetchChecked() connects to the checked addresses instead.
 */
export async function assertSafeUrl(url, { allowPrivate = false, allowPrivateEnvHint = 'ALLOW_PRIVATE_URLS' } = {}) {
  return (await _checkedTarget(url, { allowPrivate, allowPrivateEnvHint })).parsed;
}

// The URL parsed, plus every address its host resolves to, all checked.
async function _checkedTarget(url, { allowPrivate = false, allowPrivateEnvHint = 'ALLOW_PRIVATE_URLS' } = {}) {
  // URL parsing silently drops tabs and line breaks, so ".\t." would pass a
  // caller's path check and then become "..": refuse control characters.
  if (/[\u0000-\u001f\u007f]/.test(String(url))) throw new Error('Invalid URL');
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  // Every address the host resolves to has to pass, not just the first
  // one: the fetch that follows resolves independently and may pick any
  // of them, so a host publishing one public and one private record
  // would otherwise sail through this check and then connect privately.
  let resolved;
  try {
    const r = await dns.lookup(parsed.hostname.replace(/^\[(.*)\]$/, '$1'), { all: true });
    resolved = (Array.isArray(r) ? r : [r]).filter(a => a?.address);
  } catch {
    throw new Error('Could not resolve host');
  }
  if (resolved.length === 0) throw new Error('Could not resolve host');
  const addresses = resolved.map(a => a.address);
  if (addresses.some(isLinkLocalOrCloudMeta)) {
    throw new Error('Link-local / cloud-metadata addresses are not allowed');
  }
  if (!allowPrivate && addresses.some(isPrivateOrLoopback)) {
    throw new Error(`Private / loopback addresses are blocked. Set ${allowPrivateEnvHint}=1 to enable LAN targets.`);
  }
  return { parsed, resolved };
}

/**
 * The base address of a service a user configured (push server, NutriTrace,
 * music server): origin and path only, without a trailing slash. A query or
 * fragment is dropped, so a path the app appends stays a path. Null when it
 * isn't an http(s) address.
 */
export function serviceBase(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * Whether a redirect from `from` to `to` stays on the same server: the
 * same origin, or http to https on the same host and default ports (a
 * reverse proxy's upgrade).
 */
export function isSameServer(from, to) {
  const a = new URL(from), b = new URL(to);
  if (a.origin === b.origin) return true;
  return a.protocol === 'http:' && b.protocol === 'https:' && a.hostname === b.hostname && !a.port && !b.port;
}

/**
 * A reply's body, at most `maxBytes` (a larger one throws), so an address
 * that answers with an endless stream can't fill the server's memory.
 */
export async function readBody(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('Reply too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

const _proxied = !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy);

/**
 * fetch() a user-supplied URL through the guard. Unlike assertSafeUrl
 * followed by a plain fetch, it connects only to the addresses it
 * checked, so a host can't answer the check with a public address and
 * the connection with a private one (DNS rebinding), and it checks every
 * redirect hop the same way (at most `maxRedirects`, 0 = none: a 3xx is
 * returned as is). A redirect to another origin drops Authorization,
 * Cookie and Proxy-Authorization, as browsers do; `sameOrigin: true`
 * refuses such a redirect (the 3xx is returned), for callers that send
 * credentials in headers of their own (X-Plex-Token, X-Emby-Token).
 * Behind a forward proxy (HTTP_PROXY/HTTPS_PROXY) the proxy connects, so
 * only the check applies.
 */
export async function fetchChecked(url, init = {}, { allowPrivate = false, allowPrivateEnvHint = 'ALLOW_PRIVATE_URLS', maxRedirects = 0, sameOrigin = false } = {}) {
  let target = url;
  let request = { ...init };
  for (let hop = 0; ; hop++) {
    const { parsed, resolved } = await _checkedTarget(target, { allowPrivate, allowPrivateEnvHint });
    const options = { ...request, redirect: 'manual' };
    if (!_proxied) options.dispatcher = _pinnedAgent(resolved);
    const res = await (_proxied ? globalThis.fetch : undiciFetch)(parsed, options);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location || hop >= maxRedirects) return res;
    const next = new URL(location, parsed);
    const crossOrigin = !isSameServer(parsed, next);
    if (crossOrigin && sameOrigin) return res;
    try { await res.body?.cancel(); } catch {}
    target = next.toString();
    if (crossOrigin) {
      const headers = new Headers(request.headers || {});
      for (const h of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(h);
      request = { ...request, headers };
    }
    // As fetch does: a 303 (except after GET or HEAD), or a 301/302 after a
    // POST, continues as a GET without the body; 307/308 repeat it as it was.
    const method = String(request.method || 'GET').toUpperCase();
    if ((res.status === 303 && method !== 'GET' && method !== 'HEAD') || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      const headers = new Headers(request.headers || {});
      headers.delete('content-type');
      headers.delete('content-length');
      request = { ...request, method: 'GET', body: undefined, headers };
    }
  }
}

// An HTTP agent whose every connection goes to the given, already
// checked, addresses. TLS still verifies the certificate for the
// original hostname.
function _pinnedAgent(resolved) {
  const lookup = (_hostname, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (opts?.all) cb(null, resolved.map(a => ({ address: a.address, family: a.family })));
    else cb(null, resolved[0].address, resolved[0].family);
  };
  return new Agent({ connect: { lookup }, keepAliveTimeout: 1000 });
}
