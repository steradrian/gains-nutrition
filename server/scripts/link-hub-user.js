#!/usr/bin/env node
/**
 * Link an existing NutriTrace account to a hub user (an openGym user id),
 * so the hub's requests for that person reach this account instead of a new,
 * empty one. Run on the host, once, for the owner's own account:
 *
 *   docker exec <container> node scripts/link-hub-user.js \
 *     --user <username or id> --sub <openGym user id> [--admin] [--replace]
 *     [--claim-anonymous] [--issuer <iss>]
 *
 *   --issuer           the hub's issuer; defaults to HUB_ISSUER
 *   --admin            also make the account an admin (role is read from the
 *                      database on every request, never from the hub's token)
 *   --replace          the hub user already has an account here (made on its
 *                      first request): move the link to --user. The other
 *                      account is left as it is; delete it from Settings,
 *                      Users if unwanted.
 *   --claim-anonymous  give --user the data written while the instance ran
 *                      in single-user mode. Behind a hub this never happens
 *                      on its own (the only account may be a friend's).
 *
 * DB_PATH must point at the same database the server uses (it does inside
 * the container).
 */
import { parseArgs } from 'node:util';
import db from '../db.js';
import { linkHubUser } from '../lib/hub-auth.js';
import { claimAnonymousData, countOrphanedRows } from '../lib/claim-anonymous-data.js';

function fail(message) {
  console.error(`link-hub-user: ${message}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      user:              { type: 'string' },
      sub:               { type: 'string' },
      issuer:            { type: 'string' },
      admin:             { type: 'boolean', default: false },
      replace:           { type: 'boolean', default: false },
      'claim-anonymous': { type: 'boolean', default: false },
    },
  }));
} catch (e) {
  fail(e.message);
}

const issuer = String(values.issuer || process.env.HUB_ISSUER || '').trim();
const sub = String(values.sub || '').trim();
const who = String(values.user || '').trim();
const claim = values['claim-anonymous'];
if (!who || !sub) fail('--user and --sub are required');
if (!issuer) fail('--issuer is required when HUB_ISSUER is not set');

const user = /^\d+$/.test(who)
  ? db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(Number(who))
  : db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(who.toLowerCase());
if (!user) fail(`no user ${who}`);

try {
  const { previousUserId, claimed } = db.transaction(() => {
    const result = linkHubUser({ userId: user.id, issuer, sub, replace: values.replace });
    if (values.admin) db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(user.id);
    const claimed = claim ? countOrphanedRows() : 0;
    if (claim) claimAnonymousData(user.id);
    return { ...result, claimed };
  }).immediate();
  const role = db.prepare('SELECT role FROM users WHERE id = ?').get(user.id).role;
  console.log(`linked ${user.username} (id ${user.id}, role ${role}) to hub user ${sub} at ${issuer}`);
  if (previousUserId != null && previousUserId !== user.id) {
    console.log(`the link moved from user id ${previousUserId}, which still exists`);
  }
  if (claim) console.log(`claimed ${claimed} row(s) from single-user mode`);
} catch (e) {
  fail(e.message);
}
