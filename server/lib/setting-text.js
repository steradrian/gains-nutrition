/**
 * setting-text.js: the names and labels a person types into their settings.
 *
 * Meal names, food category names and labels, custom unit names and custom
 * nutrient labels are free text that the app shows everywhere (the diary,
 * pickers, exports, the AI's prompt). They took any character, NUL and the
 * other C0 control characters included, and a NUL in a name is stored,
 * returned and written into every place the name is used.
 *
 * On write, the settings route strips U+0000 to U+001F from these. Nothing
 * else is touched: letters of every script, accents, emoji (a category's
 * `label` is one) and spaces all stay. A name that is nothing but control
 * characters would be stripped to an empty name, which is worse than the
 * one that was sent, so that write is refused instead.
 *
 * Only the four settings below, and only the strings inside them: other
 * settings (a prompt, a note) legitimately hold a newline or a tab.
 */

// What each is: mealNames is ['Breakfast', ...]; foodCategories holds a
// string or { name, label }; customUnits is [{ abbr, full }]; customNutriments
// is [{ id, label, unit }]. Every string inside is free text or derived from
// it (a custom nutrient's id is made from its label), so every string is cleaned.
export const TEXT_SETTING_KEYS = new Set(['mealNames', 'foodCategories', 'customUnits', 'customNutriments']);

// C0: U+0000 to U+001F (so tab, newline and carriage return too: none of these is a multi-line field).
const C0 = /[\u0000-\u001f]/g;
const MAX_DEPTH = 4;

class OnlyControl extends Error {}

function clean(v, depth) {
  if (typeof v === 'string') {
    const out = v.replace(C0, '');
    // Something was sent and nothing is left of it.
    if (v.length > 0 && out.trim() === '' && out !== v) throw new OnlyControl();
    return out;
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
