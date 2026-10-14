#!/usr/bin/env node
/**
 * Link an existing NutriTrace account to a hub user (an openGym user id),
 * so the hub's requests for that person reach this account instead of a new,
 * empty one. Run on the host, once, for the owner's own account:
 *
 *   docker exec <container> node scripts/link-hub-user.js \
 *     (--user <username> | --user-id <id>) --sub <openGym user id>
 *     [--admin] [--replace --yes] [--claim-anonymous] [--issuer <iss>]
 *
 *   --user             the account, by username (a username of digits is
 *                      still a username)
 *   --user-id          the account, by id
 *   --issuer           the hub's issuer; HUB_ISSUER must be set, and this,
 *                      if given, must match it
 *   --admin            also make the account an admin (role is read from the
 *                      database on every request, never from the hub's token)
 *   --replace          the hub user already has an account here (made on its
 *                      first request): move the link to this account. The
 *                      script names the account being displaced and changes
 *                      nothing without --yes. The other account is left as
 *                      it is; delete it from Settings, Users if unwanted.
 *   --claim-anonymous  give the account the data written while the instance ran
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
      'user-id':         { type: 'string' },
      sub:               { type: 'string' },
      issuer:            { type: 'string' },
      admin:             { type: 'boolean', default: false },
      replace:           { type: 'boolean', default: false },
      yes:               { type: 'boolean', default: false },
      'claim-anonymous': { type: 'boolean', default: false },
    },
  }));
} catch (e) {
  fail(e.message);
}

const hubIssuer = String(process.env.HUB_ISSUER || '').trim();
const issuer = values.issuer === undefined ? hubIssuer : String(values.issuer).trim();
const sub = String(values.sub || '').trim();
const username = String(values.user || '').trim();
const userId = String(values['user-id'] || '').trim();
const claim = values['claim-anonymous'];
if (!sub) fail('--sub is required');
if (!username === !userId) fail('give exactly one of --user <username> or --user-id <id>');
if (userId && !/^\d+$/.test(userId)) fail('--user-id must be a number');
// A link under another issuer would never match a hub token, and would still
// mark the instance as a hub's (lib/hub-auth.js hubInstance).
if (!hubIssuer) fail('HUB_ISSUER is not set; run this where the server\'s HUB_ISSUER is');
if (issuer !== hubIssuer) fail(`--issuer ${issuer} is not this server's HUB_ISSUER (${hubIssuer})`);

const user = userId
  ? db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(Number(userId))
  : db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username.toLowerCase());
if (!user) fail(userId ? `no user with id ${userId}` : `no user named ${username}`);

const linkedAccount = () => db.prepare(
  `SELECT u.id, u.username FROM user_hub_links l JOIN users u ON u.id = l.user_id
    WHERE l.issuer = ? AND l.sub = ?`
).get(issuer, sub);

try {
  const { previousUserId, claimed } = db.transaction(() => {
    // Inside the write lock, so the account named is the one moved.
    const displaced = linkedAccount();
    if (values.replace && displaced && displaced.id !== user.id) {
      console.log(`hub user ${sub} is linked to ${displaced.username} (id ${displaced.id}); --replace moves the link to ${user.username} (id ${user.id})`);
      if (!values.yes) throw new Error('nothing changed; run again with --yes to move the link');
    }
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
