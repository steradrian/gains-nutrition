import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import db from '../db.js';
import { logger } from '../logger.js';
import { headerCarriesHubToken, hubBearer, hubConfig, hubInstance, hubLinkCount, hubMode } from '../lib/hub-auth.js';

// A broken HUB_JWKS / HUB_ISSUER must stop the server, not quietly turn the
// hub's path off (the hub's requests would then be anonymous).
if (hubMode()) {
  try {
    const { issuer, keys } = hubConfig();
    console.log(`[auth] hub tokens on: issuer ${issuer}, ${keys.size} key(s)`);
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    process.exit(1);
  }
} else if (hubInstance()) {
  // HUB_JWKS was unset on an instance the hub made accounts on. Not fatal
  // (the local accounts still sign in), but it must not fall back to
  // single-user mode or adopt single-user data into a friend's account.
  console.error(`[ERROR] HUB_JWKS is not set, but ${hubLinkCount()} account(s) here belong to a hub (user_hub_links). `
    + 'Staying closed: no single-user mode, no open first /register, no automatic adoption of single-user data, '
    + 'and hub accounts cannot sign in or get a local password. Set HUB_JWKS and HUB_ISSUER again to let hub users back in.');
}

// In production, refuse to start without an explicit JWT_SECRET — silently falling
// back to a known default would mean every deploy ships forgeable tokens.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is required in production. Generate one with: openssl rand -base64 48');
  process.exit(1);
}
export const JWT_SECRET = process.env.JWT_SECRET || 'nutritrace-dev-secret-change-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET not set — using insecure dev default. Set JWT_SECRET in your environment for production.');
}

/** Returns true if user management is active (at least one user exists).
 *  Always true behind a hub, and while hub accounts exist with HUB_JWKS
 *  unset: an empty users table must not turn into single-user mode, where
 *  every request is the owner and the first /register becomes admin. */
export function userMgmtActive() {
  if (hubInstance()) return true;
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() != null;
}

// Default raised from 720h (30 days) to 8760h (1 year) on 2026-06-09 after
// users with biometric sign-in hit the silent 30-day token expiry. With
// biometric on, the JWT is essentially a refresh proxy — the actual auth
// gate is fingerprint/face on app open — so a 30-day expiry forces a
// password re-login every month without any security benefit. Admins who
// want shorter sessions still set Settings, Users, Session Duration.
const DEFAULT_SESSION_HOURS = 8760;

/** Sign a JWT for a user row */
export function signToken(user) {
  const cfg = db.prepare("SELECT value FROM app_config WHERE key = 'session_hours'").get();
  const hours = cfg?.value != null && cfg.value !== '' ? parseInt(cfg.value) : DEFAULT_SESSION_HOURS;
  const opts = hours > 0 ? { expiresIn: `${hours}h` } : {};
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, csrf: crypto.randomBytes(16).toString('hex') },
    JWT_SECRET,
    opts
  );
}

/** Read session maxAge for cookies (in ms). 0 = max-allowed (default 1 year). */
const MAX_SESSION_HOURS = parseInt(process.env.MAX_SESSION_HOURS || '8760'); // 1 year default cap
export function sessionMaxAge() {
  const cfg = db.prepare("SELECT value FROM app_config WHERE key = 'session_hours'").get();
  const raw = cfg?.value != null && cfg.value !== '' ? parseInt(cfg.value) : DEFAULT_SESSION_HOURS;
  const hours = raw > 0 ? Math.min(raw, MAX_SESSION_HOURS) : MAX_SESSION_HOURS;
  return hours * 60 * 60 * 1000;
}

// A bearer token is ours when its signature verifies with our secret,
// expired or not: { user } (null once expired). Anything else (an API
// token, a reverse proxy's or identity provider's token) isn't: null.
// jsonwebtoken checks the signature before the times, so an expiry error
// means the signature held.
function _ourBearer(token) {
  try { return { user: jwt.verify(token, JWT_SECRET) }; } catch (e) {
    return e?.name === 'TokenExpiredError' || e?.name === 'NotBeforeError' ? { user: null } : null;
  }
}

const _isApiV1 = path => path === '/api/v1' || path.startsWith('/api/v1/');

/** The credential of an `Authorization: Bearer <token>` header, or null.
 *  The scheme is case-insensitive (RFC 7235): `bearer <hub token>` must
 *  reach the hub check rather than slip past it to the cookie. */
function bearerToken(header) {
  const m = typeof header === 'string' ? header.match(/^Bearer[ \t]+(\S+)[ \t]*$/i) : null;
  return m ? m[1] : null;
}

/** Attach req.user from a hub token, our bearer token or the session cookie
 *  (non-blocking, except that a bad hub token is refused).
 *  req.authVia says which one decided: 'hub', 'bearer', 'cookie' or null. */
export function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  // Without a hub, the header is read exactly as upstream does.
  const bearer = hubMode() ? bearerToken(auth) : (auth?.startsWith('Bearer ') ? auth.slice(7) : null);

  // A hub token (HUB_JWKS) decides before anything else, and a bad one is a
  // 401, never a fall-through to the cookie. scope=user acts as that person
  // on our own routes; scope=sync reaches /api/v1 only, where bearerAuth
  // turns it into the sync scopes (req.hub).
  let hub = hubBearer(bearer);
  if (hub.kind === 'none' && headerCarriesHubToken(auth)) hub = { kind: 'invalid', reason: 'header' };
  if (hub.kind === 'invalid') {
    logger.warn(`[auth] refused a hub token (${hub.reason}) on ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Invalid hub token', code: 'hub_token_invalid' });
  }
  if (hub.kind === 'ok') {
    // The audit trail of hub requests (LOG_LEVEL=debug): which token, for
    // whom, asked by what at the hub. Never the token or the raw sub.
    const { jti, sub, act } = hub.audit;
    logger.debug(`[hub] ${req.method} ${req.path} scope=${hub.scope} jti=${jti} sub_hash=${sub} act=${act} user=${hub.user.id}`);
    if (hub.scope === 'sync' && !_isApiV1(req.path)) {
      return res.status(401).json({ error: 'Hub sync tokens only reach /api/v1', code: 'hub_token_scope' });
    }
    req.hub = { scope: hub.scope, user: hub.user };
    req.user = hub.scope === 'user' ? { id: hub.user.id, username: hub.user.username, role: hub.user.role } : null;
    req.authVia = 'hub';
    return next();
  }

  // Our token in the Authorization header decides: the Android app sends
  // the signed-in account's token there, and its HTTP layer can also carry
  // a cookie an earlier account's sign-in left behind. Expired, it is no
  // session, never the cookie's. A bearer that isn't ours (a reverse proxy
  // in front of the web app can add its own) is left alone, and the web
  // signs in with its cookie as before.
  const ours = bearer != null ? _ourBearer(bearer) : null;
  if (ours) { req.user = ours.user; req.authVia = 'bearer'; return next(); }
  const cookie = req.cookies?.nt_token;
  req.user = null;
  if (cookie) { try { req.user = jwt.verify(cookie, JWT_SECRET); } catch { /* no session */ } }
  req.authVia = req.user ? 'cookie' : null;
  next();
}

/** Require a logged-in user when user management is active; pass through otherwise */
export function requireAuth(req, res, next) {
  if (!userMgmtActive()) return next();           // single-user mode — always allow
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

/** Is the signed-in account an admin right now? Read from the users row on
 *  every call, never from req.user.role: a session token keeps the role it
 *  was signed with for up to a year, through a demotion, and even after the
 *  account is deleted. False without a signed-in account. */
export function hasAdminRole(req) {
  const id = req?.user?.id;
  if (id == null) return false;
  return db.prepare('SELECT role FROM users WHERE id = ?').get(id)?.role === 'admin';
}

/** Require admin role. When user management is off the whole admin/non-admin
 *  distinction is meaningless (the single user IS the owner), so pass through
 *  in that mode — mirrors requireAuth above. Without this, admin-gated routes
 *  like POST /api/full-backup are unreachable from single-user installs even
 *  though the frontend correctly identifies them as effectively-admin. */
export function requireAdmin(req, res, next) {
  if (!userMgmtActive()) return next();  // single-user mode = effectively admin
  if (!hasAdminRole(req)) return res.status(403).json({ error: 'Admin only' });
  next();
}
