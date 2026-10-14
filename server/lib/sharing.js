import db from '../db.js';
import { hubInstance } from './hub-auth.js';

/** Is food sharing enabled on this instance? */
export function sharingEnabled() {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = 'sharing_enabled'`).get();
  return row?.value === 'true';
}

/** Returns true if user u can see item (owns it, or it's shared with them).
 *  Unowned single-user rows are anyone's, except on a hub instance, where
 *  they are nobody's until the owner claims them (link-hub-user.js
 *  --claim-anonymous): the accounts there are the hub's people, not the
 *  single user. */
export function canRead(item, u, shareTable, shareCol) {
  if (item.user_id === u) return true;
  if (item.user_id == null) return !hubInstance();
  if (item.visibility === 'group') return true;
  if (item.visibility === 'specific') {
    const row = db.prepare(`SELECT 1 FROM ${shareTable} WHERE ${shareCol} = ? AND user_id = ?`).get(item.id, u);
    return !!row;
  }
  return false;
}
