/**
 * server/middleware/bearer-auth.js
 *
 * Bearer-token auth for the federation API (/api/v1/*). Validates the
 * Authorization header against api_tokens, attaches { user, token } to
 * the request, and rate-limits per token.
 *
 * See docs/federation.md for the contract.
 */
import { lookupRawToken } from '../lib/api-tokens.js';
import { HUB_SYNC_SCOPES } from '../lib/hub-auth.js';

const RATE_LIMIT_PER_MIN = Number(process.env.API_RATE_LIMIT_PER_MIN) || 60;
// The hub's background sync backfills history in bursts (one request per
// activity or measurement), so it gets its own bucket per user and a higher
// ceiling than a hand-made API token.
export const HUB_SYNC_RATE_LIMIT_PER_MIN = Number(process.env.HUB_SYNC_RATE_LIMIT_PER_MIN) || 600;
const WINDOW_MS = 60 * 1000;

// Per-token sliding-window counters. Cleared lazily on access.
const _buckets = new Map();

function _take(tokenId, limit) {
  const now = Date.now();
  let b = _buckets.get(tokenId);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    _buckets.set(tokenId, b);
  }
  b.count++;
  return {
    count: b.count,
    remaining: Math.max(0, limit - b.count),
    resetAt: b.resetAt,
    over: b.count > limit,
  };
}

/**
 * Express middleware. Extracts the Bearer token, validates it, and
 * attaches:
 *   req.apiToken = { id, user_id, name, scopes, ... }
 *   req.apiUser  = { id, username, full_name, role }
 *
 * Sets X-RateLimit-* headers on every response. Returns 401/403/429
 * with a stable `code` field on errors.
 */
export function bearerAuth(req, res, next) {
  // A hub token was verified by authenticate() (middleware/auth.js). Only
  // the hub's scope=sync reaches the API, with exactly HUB_SYNC_SCOPES; a
  // browser-originated scope=user token does not.
  if (req.hub) {
    if (req.hub.scope !== 'sync') {
      return res.status(401).json({ error: 'Hub user tokens do not reach /api/v1', code: 'auth_invalid' });
    }
    return _admit(req, res, next, {
      token: {
        id: `hub-sync:${req.hub.user.id}`, user_id: req.hub.user.id, name: 'hub sync',
        scopes: [...HUB_SYNC_SCOPES], expires_at: null, last_used_at: null, created_at: null,
      },
      user: req.hub.user,
    }, HUB_SYNC_RATE_LIMIT_PER_MIN);
  }

  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
  if (!m) {
    return res.status(401).json({ error: 'Token required', code: 'auth_missing' });
  }

  const lookup = lookupRawToken(m[1]);
  if (!lookup) {
    return res.status(401).json({ error: 'Invalid token', code: 'auth_invalid' });
  }
  return _admit(req, res, next, lookup, RATE_LIMIT_PER_MIN);
}

function _limited(res, bucket) {
  const retry = Math.ceil((bucket.resetAt - Date.now()) / 1000);
  res.set('Retry-After', String(retry));
  return res.status(429).json({ error: 'Rate limited', code: 'rate_limited' });
}

function _admit(req, res, next, lookup, limit) {
  const bucket = _take(lookup.token.id, limit);
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(bucket.remaining));
  res.set('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));
  if (bucket.over) return _limited(res, bucket);

  req.apiToken = lookup.token;
  req.apiUser = lookup.user;
  req.rateLimit = { key: lookup.token.id, limit };
  next();
}

/**
 * Make a request cost `cost` units of its token's rate limit in all, the
 * one bearerAuth already took included: a batch costs one per item, so a
 * batch of 100 is not one request's worth of writes. All or nothing: when
 * the rest does not fit in what is left this window, nothing more is spent
 * and the request gets 429 with Retry-After. A cost above the whole limit
 * can never fit and gets 400 batch_over_rate_limit. Returns true when the
 * handler may go on; false when it must return without writing.
 */
export function chargeRateLimit(req, res, cost) {
  const extra = cost - 1;
  if (!req.rateLimit || extra <= 0) return true;
  const { key, limit } = req.rateLimit;
  if (cost > limit) {
    res.status(400).json({ error: `this token may make ${limit} writes a minute; send at most ${limit} items per batch`, code: 'batch_over_rate_limit' });
    return false;
  }
  const now = Date.now();
  let b = _buckets.get(key);
  if (!b || now >= b.resetAt) {
    // The window turned over since bearerAuth counted the request.
    b = { count: 0, resetAt: now + WINDOW_MS };
    _buckets.set(key, b);
  }
  if (b.count + extra > limit) {
    _limited(res, b);
    return false;
  }
  b.count += extra;
  res.set('X-RateLimit-Remaining', String(Math.max(0, limit - b.count)));
  return true;
}

/**
 * Scope-check middleware factory. Use AFTER bearerAuth.
 *   router.get('/foods', bearerAuth, requireScope('read:foods'), handler)
 */
export function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiToken) {
      return res.status(401).json({ error: 'Token required', code: 'auth_missing' });
    }
    if (!req.apiToken.scopes.includes(scope)) {
      return res.status(403).json({ error: `Token lacks ${scope}`, code: 'auth_scope' });
    }
    next();
  };
}
