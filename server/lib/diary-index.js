/**
 * One entry of GET /api/diary/index: a diary day reduced to what a search on
 * the device needs (names, meal slot, kcal). It reads the stored JSON only:
 * no hydrateItems, no freshenItemImages, no joins, so nothing is read from
 * another account's foods and a page costs one indexed query.
 */
import { Nutrition } from '../../src/lib/nutrition.js';
import { foodKey } from './diary-helpers.js';
import { safeJson } from './mcp/_util.js';

// A page stops after the day that takes its items past this many bytes.
export const INDEX_MAX_BYTES = 2 * 1024 * 1024;

// Split recipes nest a few levels at most; deeper than this is not read.
const PARTS_MAX_DEPTH = 6;

const isText = v => typeof v === 'string' && v.trim() !== '';

// A stored item that makes the sum throw (a split nested past the stack, say)
// counts for nothing: one bad row must not fail the page.
const kcalOf = item => {
  try {
    const kcal = Number(Nutrition.calculate(item).calories);
    return Number.isFinite(kcal) ? kcal : 0;
  } catch {
    return 0;
  }
};

// The names of what a split recipe was exploded into, nested splits included
// down to PARTS_MAX_DEPTH levels.
function partNames(children, depth = 1) {
  const names = [];
  if (depth > PARTS_MAX_DEPTH) return names;
  try {
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      if (isText(child.name)) names.push(child.name);
      if (Array.isArray(child._splitItems)) names.push(...partNames(child._splitItems, depth + 1));
    }
  } catch {
    return [];
  }
  return names;
}

function indexItem(item) {
  const id = item.is_recipe ? null : foodKey(item);
  const meal = Number(item.meal);
  const out = {
    uuid: typeof item.uuid === 'string' ? item.uuid : '',
    name: typeof item.name === 'string' ? item.name : '',
  };
  if (isText(item.brand)) out.brand = item.brand;
  out.food_id = typeof id === 'number' ? id : null;
  out.meal = Number.isInteger(meal) ? meal : 0;
  out.kcal = Math.round(kcalOf(item));
  if (Array.isArray(item._splitItems) && item._splitItems.length > 0) {
    const parts = partNames(item._splitItems);
    if (parts.length > 0) out.parts = parts;
  }
  return out;
}

/** `row` is a diary row plus `changed` (lib/diary-keyset.js). */
export function diaryIndexEntry(row) {
  // changed is SQLite's 'YYYY-MM-DD HH:MM:SS' in UTC; rev is the same instant as ISO seconds.
  const rev = `${row.changed.replace(' ', 'T')}Z`;
  if (row.deleted_at != null) return { date: row.date, rev, deleted: true };
  const stored = safeJson(row.items, []);
  const items = (Array.isArray(stored) ? stored : []).filter(it => it && typeof it === 'object');
  const kcal = items.reduce((sum, it) => sum + kcalOf(it), 0);
  return { date: row.date, rev, kcal: Math.round(kcal), items: items.map(indexItem) };
}
