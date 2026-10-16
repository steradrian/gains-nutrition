/**
 * setting-text.js: the names and labels a person types into their settings.
 *
 * Meal names, food category names and labels, custom unit names and custom
 * nutrient labels are free text that the app shows everywhere (the diary,
 * pickers, exports, the AI's prompt). They took any character, NUL and the
 * other C0 control characters included, and a NUL in a name is stored,
 * returned and written into every place the name is used.
 *
 * On write, the settings route, the Android sync push and the backup restore
 * clean these (lib/clean-text.js). Nothing else is touched: letters of every
 * script, accents, emoji (a category's `label` is one) and spaces all stay. A
 * name that is nothing but control characters would be cleaned to an empty
 * name, which is worse than the one that was sent, so that write is refused
 * instead (the sync push and the restore leave that one setting out).
 *
 * Only the four settings below, and only the strings inside them: other
 * settings (a prompt, a note) legitimately hold a newline or a tab.
 */
import { cleanText, controlOnly } from './clean-text.js';

// What each is: mealNames is ['Breakfast', ...]; foodCategories holds a
// string or { name, label }; customUnits is [{ abbr, full }]; customNutriments
// is [{ id, label, unit }]. Every string inside is free text or derived from
// it (a custom nutrient's id is made from its label), so every string is cleaned.
export const TEXT_SETTING_KEYS = new Set(['mealNames', 'foodCategories', 'customUnits', 'customNutriments']);

// What a name may contain is decided in clean-text.js, for every write path: a tab becomes a
// space, the other C0 characters (newline and carriage return too: none of these is a multi-line
// field) are dropped.
const MAX_DEPTH = 4;

class OnlyControl extends Error {}

function clean(v, depth) {
  if (typeof v === 'string') {
    // Something was sent and nothing is left of it.
    if (controlOnly(v)) throw new OnlyControl();
    return cleanText(v);
  }
  if (depth >= MAX_DEPTH) return v;
  if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = clean(x, depth + 1);
    return o;
  }
  return v;
}

/**
 * The value to store for `key`: `{ value }`, cleaned if the key is one of the
 * text settings (anything else comes back untouched), or `{ error }` when a
 * name in it is nothing but control characters.
 */
export function cleanTextSetting(key, value) {
  if (!TEXT_SETTING_KEYS.has(key)) return { value };
  try {
    return { value: clean(value, 0) };
  } catch (e) {
    if (e instanceof OnlyControl) return { error: `${key} has a name made only of control characters` };
    throw e;
  }
}

/**
 * The same for a value as it sits in user_settings (a JSON string), which is
 * what a backup holds. A value that is not JSON is returned as it came, for
 * whoever reads it to deal with, as before.
 */
export function cleanStoredTextSetting(key, stored) {
  if (!TEXT_SETTING_KEYS.has(key) || typeof stored !== 'string') return { value: stored };
  let parsed;
  try { parsed = JSON.parse(stored); } catch { return { value: stored }; }
  const text = cleanTextSetting(key, parsed);
  if (text.error) return text;
  const cleaned = JSON.stringify(text.value);
  // Nothing to clean: the stored text, byte for byte.
  return { value: cleaned === JSON.stringify(parsed) ? stored : cleaned };
}
