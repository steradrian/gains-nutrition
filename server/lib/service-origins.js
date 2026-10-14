/**
 * For federation-sourced imports (source_app 'cooktrace' or 'mealie'), let
 * localizeImage pull from the user's own configured integration base URL
 * even when it resolves to a private/LAN IP. Without this the SSRF guard
 * silently leaves the raw private-IP URL in the row and the image slot
 * renders empty on any client whose network can't reach that IP.
 *
 * Only integration URLs the user themselves saved in Settings qualify, and
 * only for an account that may reach home services on the server's network
 * (lib/outbound-policy.js). Anyone else gets [] and the public-web rules,
 * or a saved "CookTrace" address would open any machine next to the server.
 */
import db from '../db.js';
import { homeServiceAllowed } from './outbound-policy.js';

export function trustedServiceOrigins(userId, sourceApp) {
  if (!sourceApp || !homeServiceAllowed(userId)) return [];
  const key = sourceApp === 'cooktrace' ? 'cooktraceBaseUrl'
            : sourceApp === 'mealie'    ? 'mealieBaseUrl'
            : null;
  if (!key) return [];
  const row = userId == null
    ? db.prepare(`SELECT value FROM user_settings WHERE key = ? AND deleted_at IS NULL LIMIT 1`).get(key)
    : db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL`).get(userId, key);
  const v = (row?.value || '').replace(/^"|"$/g, '');
  return v ? [v] : [];
}
