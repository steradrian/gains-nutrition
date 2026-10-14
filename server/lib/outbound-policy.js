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
import { userMgmtActive } from '../middleware/auth.js';

export const SERVICE_OPT_IN = 'ALLOW_PRIVATE_SERVICE_URLS';

export function envOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

export function ownerOrOptIn(req, envVar) {
  return (userMgmtActive() && req?.user?.role === 'admin') || envOn(process.env[envVar]);
}

/** May this account reach a home service on a private address? The role is
 *  read from the database, not the session: a session token outlives a
 *  demotion by up to a year, and the background push has no session. */
export function homeServiceAllowed(userId) {
  if (!userMgmtActive() || envOn(process.env[SERVICE_OPT_IN])) return true;
  if (userId == null) return false;
  return db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role === 'admin';
}
