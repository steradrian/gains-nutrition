/**
 * clean-text.js: the one place that decides what a stored name may contain.
 *
 * Food, meal and recipe names, diary item names, activity names and the
 * names and labels in the settings are free text that the app shows
 * everywhere (the diary, pickers, exports, the AI's prompt). They took any
 * character, NUL and the other C0 control characters included, and a NUL in
 * a name is stored, returned and written into every place the name is used.
 *
 * Every write path (the routes, the Android sync push, the JSON and CSV
 * imports, the backup restore, the MCP tools) cleans a name with this file:
 * a tab becomes a space (it separates words), and every other C0 character
 * (U+0000 to U+001F: NUL, newline, carriage return, escape, ...) is dropped.
 * Nothing else is touched: letters of every script, accents, emoji and ZWJ
 * sequences, flags, right-to-left text, DEL and C1 all stay.
 *
 * A name that is nothing but control characters would be cleaned to an empty
 * one, which is worse than the one that was sent. A caller that can answer
 * (a route, a setting) refuses it with `controlOnly`; a batch that cannot
 * (a push, an import, a restore) stores what is left.
 */

const TAB = /\t/g;
const C0 = /[\u0000-\u001f]/g;

/** `s` with each tab as a space and every other C0 character dropped. */
export function cleanText(s) {
  return s.replace(TAB, ' ').replace(C0, '');
}

/** A string is cleaned; anything else (null, a number, undefined) comes back as it was. */
export function cleanName(v) {
  return typeof v === 'string' ? cleanText(v) : v;
}

/** Something was sent and nothing is left of it but control characters. */
export function controlOnly(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  const out = cleanText(raw);
  return out !== raw && out.trim() === '';
}

/**
 * A copy of a stored row (a backup's) with the named text columns cleaned.
 * A column that is not a string is left as it is, so a row that lacked one
 * still lacks it.
 */
export function cleanFields(row, keys) {
  const out = { ...row };
  for (const k of keys) if (typeof out[k] === 'string') out[k] = cleanText(out[k]);
  return out;
}

// The keys of a diary item or a meal's ingredient that hold a name: the item's own, and its brand.
const NAME_KEYS = new Set(['name', 'brand']);
// A list, an item, its ingredients, an ingredient's split parts: a handful of levels, never more.
const MAX_DEPTH = 8;

/**
 * Diary items and a meal's ingredients: the `name` and `brand` of every item
 * in the list, and in any list or object nested inside one (a recipe logged
 * as an item carries its ingredients). A copy; the input is not changed and
 * nothing but those two keys is read.
 */
export function cleanItemNames(value, depth = 0) {
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(x => cleanItemNames(x, depth + 1));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(value)) {
      o[k] = NAME_KEYS.has(k) && typeof x === 'string' ? cleanText(x) : cleanItemNames(x, depth + 1);
    }
    return o;
  }
  return value;
}

/**
 * The same for a list as it sits in a column (a JSON string), which is what
 * a backup holds. Text that is not JSON, or has nothing to clean, comes back
 * as it was, byte for byte.
 */
export function cleanItemsJson(text) {
  if (typeof text !== 'string') return text;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  const cleaned = JSON.stringify(cleanItemNames(parsed));
  return cleaned === JSON.stringify(parsed) ? text : cleaned;
}
