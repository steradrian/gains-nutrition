/**
 * hubMode() vs hubInstance() (server/lib/hub-auth.js).
 *
 *   hubMode()      HUB_JWKS is set: hub tokens are read and verified.
 *   hubInstance()  this instance belongs to a hub: HUB_JWKS is set, OR hub
 *                  accounts exist (user_hub_links has rows) while it is not.
 *
 * Every guard that keeps the instance from being handed to whoever arrives
 * first (single-user mode, the open first /register, adopting single-user
 * data, unowned rows readable by everyone, the first OIDC admin) must ask
 * hubInstance(). Asking hubMode() there reopens all of it the moment
 * HUB_JWKS is unset by mistake, with friends' accounts still in the
 * database. hubMode() is only right where hub tokens themselves are
 * handled: parsing the Authorization header and checking HUB_JWKS at
 * startup.
 *
 * So hubMode() is allowed in the places listed below and nowhere else.
 * A new caller fails this test: use hubInstance(), or, if the call really
 * is about reading hub tokens, add it here with the reason.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'server');

// file -> how many times it may name hubMode (import, definition, calls),
// with why each is about hub tokens rather than about who owns the instance.
const ALLOWED = {
  'server/lib/hub-auth.js': {
    count: 3,
    why: 'the definition; hubInstance() builds on it; hubConfig() parses HUB_JWKS only when it is set',
  },
  'server/middleware/auth.js': {
    count: 3,
    why: 'the import; the startup check of HUB_JWKS/HUB_ISSUER; how the Authorization header is parsed for a hub token',
  },
};

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...jsFiles(path));
    else if (/\.(c|m)?js$/.test(name)) out.push(path);
  }
  return out;
}

// Comments mention both names freely; only code counts.
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function hubModeUses() {
  const uses = {};
  for (const file of jsFiles(SERVER)) {
    const n = (stripComments(readFileSync(file, 'utf8')).match(/\bhubMode\b/g) || []).length;
    if (n) uses[relative(ROOT, file).split('\\').join('/')] = n;
  }
  return uses;
}

test('hubMode() is used only where hub tokens are handled; every ownership guard asks hubInstance()', () => {
  const uses = hubModeUses();
  for (const [file, n] of Object.entries(uses)) {
    const allowed = ALLOWED[file];
    assert.ok(allowed, `${file} uses hubMode() (${n}x). Guards that decide who owns the instance must use hubInstance(); `
      + 'see the comment at the top of this test.');
    assert.ok(n <= allowed.count, `${file} uses hubMode() ${n}x, ${allowed.count} expected (${allowed.why}). `
      + 'If the new use guards ownership, use hubInstance() instead.');
  }
});

test('the known ownership guards ask hubInstance()', () => {
  // Each of these reopens the instance if it asks hubMode() instead.
  const guards = {
    'server/middleware/auth.js': /export function userMgmtActive\(\) \{\s*if \(hubInstance\(\)\) return true;/,
    'server/lib/claim-anonymous-data.js': /if \(hubInstance\(\)\) return \{ repaired: 0/,
    'server/lib/sharing.js': /if \(item\.user_id == null\) return !hubInstance\(\);/,
    'server/lib/diary-helpers.js': /hubInstance\(\) \? READABLE_FOOD_HUB : READABLE_FOOD/,
    'server/routes/oidc.js': /if \(hubInstance\(\) \|\| !result\.created\) return false;/,
  };
  for (const [file, pattern] of Object.entries(guards)) {
    assert.match(readFileSync(join(ROOT, file), 'utf8'), pattern, file);
  }
});

test('the scan sees a new hubMode() caller (self-check)', () => {
  const src = "import { hubMode } from './hub-auth.js';\n// hubMode() in a comment\nif (hubMode()) open();\n";
  assert.equal((stripComments(src).match(/\bhubMode\b/g) || []).length, 2);
});
