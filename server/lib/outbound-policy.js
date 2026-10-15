// Who may reach the server's own network when a feature fetches an
// address a user chose. Started as the same file in all four Trace apps;
// homeServiceAllowed() is NutriTrace's own.
//
// Features made for services on the home network (push, Mealie, CookTrace)
// ask homeServiceAllowed(): an admin may, and so may a single-user install
// (one person, the owner); other signed-in accounts only when the owner
// sets ALLOW_PRIVATE_SERVICE_URLS. Otherwise any account could point the
// server at the machines next to it.
// Features made for the public web ask ownerOrOptIn(): an admin may; other
// accounts only when the owner sets that feature's ALLOW_PRIVATE_* variable.
// A single-user install has no sign-in, so every visitor would count as
// the owner; there only the variable opens it.
import db from '../db.js';
import { logger } from '../logger.js';
import { hasAdminRole, userMgmtActive } from '../middleware/auth.js';

export const SERVICE_OPT_IN = 'ALLOW_PRIVATE_SERVICE_URLS';

export function envOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/** The role is read from the database (hasAdminRole), not the session. */
export function ownerOrOptIn(req, envVar) {
  return (userMgmtActive() && hasAdminRole(req)) || envOn(process.env[envVar]);
}

/** May this account reach a home service on a private address? The role is
 *  read from the database, not the session: a session token outlives a
 *  demotion by up to a year, and the background push has no session. */
export function homeServiceAllowed(userId) {
  if (!userMgmtActive() || envOn(process.env[SERVICE_OPT_IN])) return true;
  if (userId == null) return false;
  return db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role === 'admin';
}

// The SSRF guard's words (lib/ssrf-guard.js) when an address resolved to a
// refused range, or did not resolve at all.
const _REFUSED = /addresses are (not allowed|blocked)/;
const _UNRESOLVED = /^Could not resolve host$/;

/**
 * What a caller may be told when the SSRF guard turned a service address
 * down, or null when `err` is not about the address (the route then answers
 * as it always has).
 *
 * The refusal says which range the address fell in and which ALLOW_PRIVATE_*
 * to set: an admin (or a single-user install) can act on that and gets it.
 * Anyone else gets `generic`, the route's own "could not reach" message,
 * for refusals and failed lookups alike: telling them apart would let any
 * account map which internal names exist and which resolve to private
 * addresses. The detail goes to the server log either way.
 */
export function addressErrorForClient(req, err, generic, label) {
  const message = String(err?.message || '');
  const refused = _REFUSED.test(message);
  if (!refused && !_UNRESOLVED.test(message)) return null;
  const owner = !userMgmtActive() || hasAdminRole(req);
  logger.warn(`[${label}] service address turned down for user ${req?.user?.id ?? '-'}: ${message}`);
  if (owner) return refused ? message : null;
  return generic;
}
