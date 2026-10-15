/**
 * server/lib/login-throttle.js
 *
 * The fixed-window counters behind the sign-in throttle (routes/auth.js):
 * one per client address, one per username.
 *
 * Bounded: a map holds at most `cap` keys. Entries are kept in the order
 * their windows started (a new window moves its key to the end), so expired
 * ones are trimmed from the front as new keys arrive, and when the map is
 * still full the oldest window goes. Evicting an entry forgets its count,
 * so the cap is set far above what an invite-only instance sees; reaching
 * it takes that many distinct addresses (or /64s) inside one window.
 *
 * IPv6 clients are counted per /64: one connection usually gets a whole
 * /64 and can pick a fresh address from it for every try.
 */
import net from 'net';
import { ipv6Groups } from './ssrf-guard.js';

export const DEFAULT_CAP = 50_000;

/**
 * The throttle key for a client address: IPv4 as is (also when it arrives
 * IPv4-mapped, ::ffff:a.b.c.d), IPv6 as its /64 prefix.
 */
export function clientKey(ip) {
  const raw = String(ip ?? '');
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  const groups = ipv6Groups(raw);
  if (!groups) return raw;
  return `${groups.slice(0, 4).map(g => g.toString(16)).join(':')}::/64`;
}

/**
 * A bucket map: hit(key) counts one try and says whether it is allowed
 * (at most `max` per `windowMs`).
 */
export function createBuckets({ max, windowMs, cap = DEFAULT_CAP, now = Date.now }) {
  const map = new Map(); // key -> { count, resetAt }, oldest window first

  function trim(t) {
    for (const [key, entry] of map) {
      if (entry.resetAt > t) break;
      map.delete(key);
    }
  }

  function hit(key) {
    const t = now();
    const entry = map.get(key);
    if (entry && t < entry.resetAt) {
      entry.count++;
      return entry.count <= max;
    }
    if (entry) map.delete(key);
    trim(t);
    while (map.size >= cap) map.delete(map.keys().next().value);
    map.set(key, { count: 1, resetAt: t + windowMs });
    return true;
  }

  return { hit, size: () => map.size, has: key => map.has(key) };
}
