/**
 * server/lib/hub-auth.js
 *
 * Hub tokens: short-lived ES256 JWS a trusted hub signs for each request it
 * forwards on a signed-in user's behalf (scope=user) or for its own
 * background sync (scope=sync). On only when HUB_JWKS is set; unset, on an
 * instance that never had hub accounts, the server behaves as upstream. One
 * that did (user_hub_links has rows) stays closed: see hubInstance().
 *
 *   HUB_ISSUER  the hub's `iss` (required with HUB_JWKS)
 *   HUB_JWKS    the hub's public keys, a JWKS JSON string. Never fetched.
 *
 * Rules (the hub token contract, v1):
 *   - header alg is ES256 (pinned, never read to pick a key) and kid is in
 *     HUB_JWKS; the signature verifies with that key;
 *   - iss === HUB_ISSUER, aud === 'nutritrace', exp in the future, iat at
 *     most 30 s ahead, exp - iat <= 60;
 *   - sub non-empty, scope 'user' or 'sync';
 *   - every segment is canonical base64url (one string per byte sequence),
 *     so the same bytes cannot be re-spelled into a second token string.
 *     That is hygiene, not replay protection: ECDSA signatures are
 *     malleable ((r, n - s) verifies too), and low-s is not enforced
 *     because Node and WebCrypto signers do not normalise s;
 *   - jti is base64url with at least 128 bits and is seen once, which is
 *     what stops a replay, re-signed twin included: the hub mints a token
 *     per request (and per retry), so a jti seen again is refused. The
 *     cache is in memory and keeps an entry until 30 s past its exp (at
 *     most 120 s), so a clock stepped back by up to 30 s does not reopen it;
 *   - a token that looks like a hub token and fails any check is refused,
 *     it never falls through to another way of signing in;
 *   - the token is never logged.
 *
 * People are mapped by (issuer, sub) in user_hub_links. A first request
 * creates the account: role 'user', a made-up username, no password. The
 * role always comes from the users row, never from the token.
 *
 * While the hub is on, a hub account gets no lasting credential of its own
 * from a request (no first password, no OIDC link), so a leaked token is
 * worth its 60 s. The exception is an admin's: an admin can make accounts
 * and API tokens, so a leaked admin hub token is as bad as a leaked admin
 * password. Keep admin accounts few.
 */
import crypto from 'crypto';
import db from '../db.js';
import { logger } from '../logger.js';

export const HUB_AUDIENCE = 'nutritrace';
// What a scope=sync token may do on /api/v1, and nothing else.
export const HUB_SYNC_SCOPES = Object.freeze(['write:activity', 'read:body-stats', 'write:body-measurements']);

const MAX_LIFETIME_S = 60;
const CLOCK_SKEW_S = 30;
const SEGMENT_RE = /^[A-Za-z0-9_-]*$/;
const SCOPES = new Set(['user', 'sync']);
// 22 base64url characters carry 132 bits, the least that holds 128.
const JTI_RE = /^[A-Za-z0-9_-]{22,128}$/;
const REPLAY_CACHE_MAX = 100_000;

// Node decodes base64url leniently: the unused low bits of the last
// character are ignored, so one signature has several spellings. Only the
// spelling Node itself would produce is accepted.
const isCanonicalBase64url = segment => Buffer.from(segment, 'base64url').toString('base64url') === segment;

// jti -> when the entry may go (seconds): the token's exp plus the clock
// skew. Insertion order is close to that order (every token lives at most
// 60 s), so stale entries are trimmed from the front. Over the cap the
// oldest entry goes first, which reopens that token for the rest of its
// life, so it is logged.
const _seenJti = new Map();

function _replayed(jti, exp, nowS) {
  for (const [seen, until] of _seenJti) {
    if (until > nowS) break;
    _seenJti.delete(seen);
  }
  if (_seenJti.has(jti)) return true;
  if (_seenJti.size >= REPLAY_CACHE_MAX) {
    _seenJti.delete(_seenJti.keys().next().value);
    logger.warn(`[auth] hub token replay cache is full (${REPLAY_CACHE_MAX}); dropped its oldest entry`);
  }
  _seenJti.set(jti, exp + CLOCK_SKEW_S);
  return false;
}

/** How many jti values the replay cache holds (for the tests). */
export const replayCacheSize = () => _seenJti.size;

/** True when the hub-token path is on (HUB_JWKS set). */
export function hubMode(env = process.env) {
  return String(env.HUB_JWKS || '').trim() !== '';
}

/** How many accounts the hub made or was linked to (user_hub_links rows). */
export function hubLinkCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM user_hub_links').get().n;
}

/**
 * True while this instance belongs to a hub: HUB_JWKS is set, or hub
 * accounts exist even though it is not (unset by mistake, or a broken
 * deploy). Everything that would otherwise hand the instance to whoever
 * arrives first (single-user mode, the open first /register, the startup
 * adoption of single-user data, unowned rows readable by every account)
 * asks this, not hubMode(), so unsetting HUB_JWKS fails closed rather than
 * giving a friend's account the owner's data.
 */
export function hubInstance(env = process.env) {
  return hubMode(env) || db.prepare('SELECT 1 FROM user_hub_links LIMIT 1').get() != null;
}

function parseKeySet(raw) {
  let jwks;
  try { jwks = JSON.parse(raw); } catch { throw new Error('HUB_JWKS is not valid JSON'); }
  const list = Array.isArray(jwks?.keys) ? jwks.keys : [];
  if (!list.length) throw new Error('HUB_JWKS has no keys');
  const keys = new Map();
  for (const jwk of list) {
    const kid = typeof jwk?.kid === 'string' ? jwk.kid : '';
    if (!kid) throw new Error('every HUB_JWKS key needs a kid');
    if (keys.has(kid)) throw new Error(`HUB_JWKS has kid ${kid} twice`);
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error(`HUB_JWKS key ${kid} is not an EC P-256 key`);
    if (jwk.alg != null && jwk.alg !== 'ES256') throw new Error(`HUB_JWKS key ${kid} is not for ES256`);
    if (jwk.use != null && jwk.use !== 'sig') throw new Error(`HUB_JWKS key ${kid} is not a signing key`);
    if (jwk.d != null) throw new Error(`HUB_JWKS key ${kid} is a private key; give NutriTrace the public key only`);
    try {
      keys.set(kid, crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }));
    } catch {
      throw new Error(`HUB_JWKS key ${kid} is not a valid P-256 public key`);
    }
  }
  return keys;
}

let _cache = null;  // { raw, issuer, config }

/**
 * { issuer, keys: Map<kid, KeyObject> } from the environment, or null when
 * the hub is off. Throws on a misconfiguration; the server checks this at
 * startup and refuses to run.
 */
export function hubConfig(env = process.env) {
  if (!hubMode(env)) return null;
  const raw = String(env.HUB_JWKS);
  const issuer = String(env.HUB_ISSUER || '').trim();
  if (_cache && _cache.raw === raw && _cache.issuer === issuer) return _cache.config;
  if (!issuer) throw new Error('HUB_ISSUER is required when HUB_JWKS is set');
  const config = { issuer, keys: parseKeySet(raw) };
  _cache = { raw, issuer, config };
  return config;
}

function _json(segment) {
  try {
    const v = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/**
 * Does this bearer look like a hub token? Three base64url segments whose
 * header names a hub kid, or whose payload names the hub as issuer (a token
 * signed with a retired key is still the hub's, and is refused, not ignored).
 * Anything else is left to the other ways of signing in.
 */
export function looksLikeHubToken(token, config) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts.every(p => SEGMENT_RE.test(p))) return false;
  const header = _json(parts[0]);
  if (!header) return false;
  if (typeof header.kid === 'string' && config.keys.has(header.kid)) return true;
  return _json(parts[1])?.iss === config.issuer;
}

/**
 * Verify a hub token. { ok: true, claims } or { ok: false, reason }, where
 * the reason is safe to log (it never contains the token).
 */
export function verifyHubToken(token, config, nowS = Math.floor(Date.now() / 1000)) {
  const fail = reason => ({ ok: false, reason });
  const parts = String(token).split('.');
  if (parts.length !== 3 || !parts.every(p => p && SEGMENT_RE.test(p))) return fail('malformed');
  if (!parts.every(isCanonicalBase64url)) return fail('encoding');
  const header = _json(parts[0]);
  const claims = _json(parts[1]);
  if (!header || !claims) return fail('malformed');

  if (header.alg !== 'ES256') return fail('alg');
  if (header.crit !== undefined) return fail('crit');
  const key = typeof header.kid === 'string' ? config.keys.get(header.kid) : undefined;
  if (!key) return fail('kid');
  const signature = Buffer.from(parts[2], 'base64url');
  if (signature.length !== 64) return fail('signature');
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
  if (!crypto.verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)) return fail('signature');

  if (claims.iss !== config.issuer) return fail('iss');
  if (claims.aud !== HUB_AUDIENCE) return fail('aud');
  const { iat, exp } = claims;
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return fail('times');
  if (exp <= nowS) return fail('expired');
  if (iat > nowS + CLOCK_SKEW_S) return fail('iat');
  if (exp <= iat || exp - iat > MAX_LIFETIME_S) return fail('lifetime');
  if (typeof claims.sub !== 'string' || !claims.sub) return fail('sub');
  if (!SCOPES.has(claims.scope)) return fail('scope');
  if (typeof claims.jti !== 'string' || !JTI_RE.test(claims.jti)) return fail('jti');
  // Last, so only a token that passed everything else takes a cache slot.
  if (_replayed(claims.jti, exp, nowS)) return fail('replay');
  return { ok: true, claims };
}

// Usernames the hub makes start with this; nobody else may pick one, so a
// local account can never pass for a hub one.
export const HUB_USERNAME_PREFIX = 'hub-';
export const HUB_USERNAME_ERROR = `Usernames starting with "${HUB_USERNAME_PREFIX}" are reserved.`;
export const isReservedUsername = username =>
  String(username || '').trim().toLowerCase().startsWith(HUB_USERNAME_PREFIX);

function _username(issuer, sub) {
  const base = HUB_USERNAME_PREFIX + crypto.createHash('sha256').update(`${issuer}\0${sub}`).digest('hex').slice(0, 16);
  let candidate = base;
  for (let n = 2; db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

const _findLinked = (issuer, sub) => db.prepare(
  `SELECT u.id, u.username, u.full_name, u.role
     FROM user_hub_links l JOIN users u ON u.id = l.user_id
    WHERE l.issuer = ? AND l.sub = ?`
).get(issuer, sub);

/**
 * The NutriTrace account for a hub user, made on first sight.
 * Returns { id, username, full_name, role } as stored in the database.
 * IMMEDIATE takes the write lock before the lookup, so a second process
 * (the link script) cannot slip a link in between the read and the insert.
 */
const _resolveHubUser = db.transaction((issuer, { sub, name }) => {
  const linked = _findLinked(issuer, sub);
  if (linked) return linked;
  const fullName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null;
  const r = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role) VALUES (?, NULL, ?, 'user')`
  ).run(_username(issuer, sub), fullName);
  db.prepare('INSERT INTO user_hub_links (user_id, issuer, sub) VALUES (?, ?, ?)').run(r.lastInsertRowid, issuer, sub);
  return _findLinked(issuer, sub);
});
// Known people (every request but their first) are a plain read, no lock.
export const resolveHubUser = (issuer, claims) =>
  _findLinked(issuer, claims.sub) ?? _resolveHubUser.immediate(issuer, claims);

/** True when the account is reached through the hub. Its password is the
 *  hub's business: it never gets a local one from a request, or a stolen
 *  60 s hub token would turn into a permanent local sign-in. Read from the
 *  link alone, HUB_JWKS set or not: with the hub switched off, an email
 *  typed in from a hub session must still not become a reset link. */
export function isHubManaged(userId) {
  return db.prepare('SELECT 1 FROM user_hub_links WHERE user_id = ?').get(userId) != null;
}

/**
 * Link an existing account to a hub user (the owner's one-time link, from
 * scripts/link-hub-user.js). `replace` moves a link the hub user already has
 * to another account (say, one made automatically before the link).
 * Returns { previousUserId } (null when the hub user had no link).
 */
export const linkHubUser = db.transaction(({ userId, issuer, sub, replace = false }) => {
  if (!issuer) throw new Error('issuer is required');
  if (!sub) throw new Error('sub is required');
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`no user with id ${userId}`);
  const current = db.prepare('SELECT user_id FROM user_hub_links WHERE issuer = ? AND sub = ?').get(issuer, sub);
  if (current?.user_id === userId) return { previousUserId: userId };
  const other = db.prepare('SELECT sub FROM user_hub_links WHERE user_id = ? AND issuer = ?').get(userId, issuer);
  if (other) throw new Error(`user ${userId} is already linked to hub user ${other.sub}`);
  if (current && !replace) throw new Error(`hub user ${sub} is already linked to user ${current.user_id}; pass --replace to move the link`);
  if (current) {
    db.prepare('DELETE FROM user_hub_links WHERE issuer = ? AND sub = ?').run(issuer, sub);
    // The account left behind is no longer the hub's, so its email (typed
    // from hub sessions) must not become a way into it by reset or OIDC.
    db.prepare('UPDATE users SET email = NULL WHERE id = ?').run(current.user_id);
  }
  db.prepare('INSERT INTO user_hub_links (user_id, issuer, sub) VALUES (?, ?, ?)').run(userId, issuer, sub);
  return { previousUserId: current?.user_id ?? null };
});

/**
 * The hub's say on a request's bearer token, for middleware/auth.js:
 *   { kind: 'none' }                  not a hub token (or the hub is off)
 *   { kind: 'invalid', reason }       a hub token that failed: refuse with 401
 *   { kind: 'ok', scope, user, audit } verified; user is the database row,
 *                                     audit is hubAuditFields()
 */
export function hubBearer(token) {
  const config = hubConfig();
  if (!config || !token || !looksLikeHubToken(token, config)) return { kind: 'none' };
  return _verified(token, config);
}

/**
 * Does an Authorization header that did not parse as `Bearer <token>` (or
 * whose token is not the hub's) still carry a hub token somewhere, as in
 * `Bearer <hub>,`, `Bearer <hub> x` or `Token <hub>`? Then it is a broken
 * hub request and is refused, rather than left to the cookie.
 */
export function headerCarriesHubToken(header) {
  const config = hubConfig();
  if (!config || typeof header !== 'string') return false;
  // A split, not a regex: this runs before sign-in on any header up to
  // Node's 16 KB limit, and a backtracking pattern there is a cheap stall.
  return header.split(/[^A-Za-z0-9_.-]+/).some(t => looksLikeHubToken(t, config));
}

// Printable ASCII only, bounded: the claim is the hub's, but it ends up in
// a log line.
const _printable = (value, max = 64) => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, max);

/**
 * What a hub request's audit line may say about its token: the jti, the
 * person as a hash (the same one their `hub-` username starts from, so a
 * line leads to the account without naming the hub's user id) and `act`,
 * who at the hub asked (absent: '-'). Never the token or the raw sub.
 */
export function hubAuditFields(issuer, claims) {
  const act = claims.act == null ? '-'
    : _printable(typeof claims.act === 'string' ? claims.act : JSON.stringify(claims.act));
  return {
    jti: claims.jti,
    sub: crypto.createHash('sha256').update(`${issuer}\0${claims.sub}`).digest('hex').slice(0, 16),
    act,
  };
}

function _verified(token, config) {
  const result = verifyHubToken(token, config);
  if (!result.ok) return { kind: 'invalid', reason: result.reason };
  const { claims } = result;
  return {
    kind: 'ok', scope: claims.scope, user: resolveHubUser(config.issuer, claims),
    audit: hubAuditFields(config.issuer, claims),
  };
}
