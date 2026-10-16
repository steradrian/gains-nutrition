/**
 * create-keys.js: a new row sent twice is made once.
 *
 * The Android app gives every row it makes a stable key (its install and
 * its own row id), sent with the create: Connect > Upload, and the sync
 * push for rows the server hasn't seen. A retry, or an answer lost on the
 * way back, sends the same key again, and gets the row made the first
 * time instead of a second one. Kept in client_key (db.js), per account.
 */
import db from '../db.js';

export function cleanCreateKey(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 128) : null;
}

// The tables with a client_key (db.js), each with a deleted_at: a delete is a soft delete.
const KEYED_TABLES = new Set(['foods', 'meals', 'activity_log', 'fasts']);

/**
 * The account's live row made with this key before, or null.
 *
 * A row that has been deleted (deleted_at set) is not "the row made the first
 * time": sending its key again is a new save, and it makes a new row, rather
 * than handing back the deleted one (which brought a deleted food back).
 *
 * The sync push is the one caller that wants the deleted row too
 * (`includeDeleted`): it sends a key again because its answer was lost, and
 * if the row was deleted in between (on the web, or on another device),
 * "already made" is still the right answer. Making a second row there would
 * bring back what the person just deleted, a duplicate of it.
 */
export function findByCreateKey(table, userId, key, { includeDeleted = false } = {}) {
  if (!key) return null;
  if (!KEYED_TABLES.has(table)) throw new Error(`findByCreateKey: ${table} has no create keys`);
  const live = includeDeleted ? '' : ' AND deleted_at IS NULL';
  // A key can now sit on a deleted row and on the live row that replaced it: the live one first.
  return db.prepare(`SELECT * FROM ${table} WHERE client_key = ? AND user_id IS ?${live} ORDER BY (deleted_at IS NULL) DESC, id DESC`).get(key, userId ?? null) || null;
}

export function setCreateKey(table, id, key) {
  if (key) db.prepare(`UPDATE ${table} SET client_key = ? WHERE id = ?`).run(key, id);
}
