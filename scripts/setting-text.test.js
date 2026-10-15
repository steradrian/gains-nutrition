/**
 * Free-text settings (server/lib/setting-text.js): the names and labels in
 * mealNames, foodCategories, customUnits and customNutriments lose C0 control
 * characters on write; the rest of Unicode, emoji included, stays. Through
 * PUT /api/settings it is in small-fixes.test.js.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanTextSetting, TEXT_SETTING_KEYS } from '../server/lib/setting-text.js';

const clean = (key, value) => cleanTextSetting(key, value);

test('the four name settings, and no other', () => {
  assert.deepEqual([...TEXT_SETTING_KEYS].sort(), ['customNutriments', 'customUnits', 'foodCategories', 'mealNames']);
  const prompt = 'a\nb\tc\u0000';
  assert.deepEqual(clean('aiSystemPrompt', prompt), { value: prompt }, 'anything else is returned as it came');
  assert.deepEqual(clean('mealNames', 'not a list'), { value: 'not a list' }, 'another shape is not this function’s to judge');
  assert.deepEqual(clean('mealNames', null), { value: null });
});

test('every C0 character goes: U+0000 to U+001F, the whitespace ones too', () => {
  const all = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
  assert.deepEqual(clean('mealNames', [`A${all}B`]), { value: ['AB'] });
  assert.deepEqual(clean('mealNames', ['Tab\there', 'New\nline', 'Car\rriage']), { value: ['Tabhere', 'Newline', 'Carriage'] });
});

test('normal Unicode stays: spaces, accents, other scripts, emoji, ZWJ sequences, and DEL and C1 are not C0', () => {
  const names = ['Breakfast', 'Second breakfast', 'Frühstück', 'Déjeuner', '朝ごはん', 'Завтрак', 'وجبة', '🍪 Snacks', '👩‍🍳 Cook', '🇨🇭', 'a\u007fb', 'a\u0085b', 'tab nbsp'];
  assert.deepEqual(clean('mealNames', names), { value: names });
});

test('categories: a string or { name, label }, the label an emoji', () => {
  assert.deepEqual(
    clean('foodCategories', ['Dai\u0000ry', { name: 'Fr\u0007uit', label: '🍎\u0000' }, { name: 'Veg', label: '🥦' }, { name: 'Plain' }]),
    { value: ['Dairy', { name: 'Fruit', label: '🍎' }, { name: 'Veg', label: '🥦' }, { name: 'Plain' }] }
  );
});

test('custom units and nutrients: every string inside, ids made from a label included', () => {
  assert.deepEqual(clean('customUnits', [{ abbr: 'sc\u0000p', full: 'sco\nop' }]), { value: [{ abbr: 'scp', full: 'scoop' }] });
  assert.deepEqual(
    clean('customNutriments', [{ id: 'custom_om\u0000ega', label: 'Om\u0000ega', unit: 'g', order: 3, hidden: false, note: null }]),
    { value: [{ id: 'custom_omega', label: 'Omega', unit: 'g', order: 3, hidden: false, note: null }] },
    'numbers, booleans and null pass through'
  );
});

test('a value with nothing to strip comes back equal, and the input is not changed', () => {
  const input = [{ abbr: 'tbsp', full: 'tablespoon' }];
  const copy = structuredClone(input);
  assert.deepEqual(clean('customUnits', input), { value: copy });
  assert.deepEqual(input, copy);
  assert.deepEqual(clean('mealNames', []), { value: [] });
  assert.deepEqual(clean('mealNames', ['']), { value: [''] }, 'an empty name that was sent empty is as before');
  assert.deepEqual(clean('mealNames', ['  ']), { value: ['  '] }, 'so is a blank one: no control character was involved');
});

test('a name that is nothing but control characters is refused, not stored empty', () => {
  for (const [key, value] of [
    ['mealNames', ['Fine', '\u0000']],
    ['mealNames', ['\u0001\u0002 \u0003']],
    ['foodCategories', [{ name: '\u0000', label: '🍎' }]],
    ['customUnits', [{ abbr: 'ok', full: '\n\r\t' }]],
    ['customNutriments', [{ id: 'x', label: '\u001f', unit: 'g' }]],
  ]) {
    const r = clean(key, value);
    assert.equal(r.value, undefined, key);
    assert.match(r.error, new RegExp(key), key);
  }
});

test('a value nested deeper than a setting ever is left alone rather than walked for ever', () => {
  let deep = 'x\u0000';
  for (let i = 0; i < 50; i++) deep = [deep];
  assert.doesNotThrow(() => clean('mealNames', deep));
});
