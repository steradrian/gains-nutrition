// The response shapes the contract pins (docs/api-contract.md). Shared by
// the per-feature contract tests. See shape.mjs for the schema notation.
import { oneOf, optional } from './shape.mjs';

const NULLABLE_TEXT = 'string|null';

// server/routes/foods.js parse(): every column, nutrition and alt_units parsed.
export const FOOD = {
  id: 'integer', user_id: 'integer|null', name: 'string', brand: NULLABLE_TEXT,
  nutrition: 'object', portion: 'number', unit: 'string',
  img_url: NULLABLE_TEXT, notes: NULLABLE_TEXT, category: NULLABLE_TEXT, barcode: NULLABLE_TEXT,
  visibility: 'string', source_id: 'integer|null', source_app: NULLABLE_TEXT, source_external_id: NULLABLE_TEXT, source_url: NULLABLE_TEXT,
  favorite: 'integer', usage_count: 'integer', last_used_at: 'date|null',
  nutrition_basis: NULLABLE_TEXT, alt_units: oneOf('null', [{ abbr: 'string', grams: 'number' }]), density_g_ml: 'number|null',
  created_at: 'sqltime', updated_at: 'sqltime|null', deleted_at: 'sqltime|null', changed_at: NULLABLE_TEXT, client_key: NULLABLE_TEXT,
};

// server/routes/meals.js parse(): nutrition and items parsed, is_recipe a boolean.
export const MEAL = {
  id: 'integer', user_id: 'integer|null', name: 'string',
  nutrition: 'object', items: 'array', is_recipe: 'boolean',
  portion: 'number', unit: 'string', servings: 'integer|null',
  img_url: NULLABLE_TEXT, notes: NULLABLE_TEXT, visibility: 'string',
  source_id: 'integer|null', source_app: NULLABLE_TEXT, source_external_id: NULLABLE_TEXT, source_url: NULLABLE_TEXT,
  favorite: 'integer', usage_count: 'integer', last_used_at: 'date|null',
  created_at: 'sqltime', updated_at: 'sqltime|null', deleted_at: 'sqltime|null', changed_at: NULLABLE_TEXT, client_key: NULLABLE_TEXT,
};

// One logged item as the server hands it back: what the client wrote, with
// imgUrl always replaced by the food's current picture ('' when none).
export const DIARY_ITEM = {
  uuid: 'string', meal: 'integer', name: 'string', nutrition: 'object', imgUrl: 'string',
  portion: 'number?', unit: 'string?', quantity: 'number?', type: 'string?', addedAt: 'string?',
};

// Water: amount in ml; time a display string the client formats (no date).
export const WATER_ENTRY = { uuid: 'string', amount: 'number', time: 'string' };

export const TOMBSTONE = { kind: 'string', uuid: 'string', deleted_at: 'sqltime' };

// A stored day (server/routes/diary.js parse()).
export const DIARY_DAY = {
  id: 'integer', user_id: 'integer|null', date: 'date',
  items: [DIARY_ITEM], body_stats: 'object', water: [WATER_ENTRY], notes: 'string',
  completed_at: 'sqltime|null', completed_meals: ['integer'],
  updated_at: 'sqltime', deleted_at: 'null',
  notes_updated_at: NULLABLE_TEXT, completion_marked_at: NULLABLE_TEXT,
  // A raw JSON string, unlike completed_meals.
  meal_marks_at: 'json|null',
};

// GET /api/diary/index (server/lib/diary-index.js): a day reduced to what a
// search on the device needs. brand and parts are left out when empty.
export const DIARY_INDEX_ITEM = {
  uuid: 'string', name: 'string', brand: 'string?', food_id: 'integer|null', meal: 'integer', kcal: 'integer', parts: optional(['string']),
};
export const DIARY_INDEX_LIVE_DAY = { date: 'date', rev: 'isotime', kcal: 'integer', items: [DIARY_INDEX_ITEM] };
export const DIARY_INDEX_DELETED_DAY = { date: 'date', rev: 'isotime', deleted: 'boolean' };
export const DIARY_INDEX_PAGE = {
  days: [oneOf(DIARY_INDEX_LIVE_DAY, DIARY_INDEX_DELETED_DAY)],
  total: 'integer', next: 'string', has_more: 'boolean',
};

// GET /api/diary/:date for a day with no row.
export const EMPTY_DAY = {
  date: 'date', items: 'array', body_stats: 'object', water: 'array', notes: 'string',
  completed_at: 'null', completed_meals: 'array', tombstones: [TOMBSTONE],
};

// server/routes/fasts.js _row(): start/end are ISO instants (UTC, Z).
export const FAST = {
  id: 'integer', user_id: 'integer|null', start_at: 'isotime', end_at: 'isotime|null',
  goal_hours: 'number', notes: NULLABLE_TEXT, created_at: 'sqltime', updated_at: 'sqltime',
};

// GET /api/goals/adaptive-tdee (server/lib/adaptive-tdee.js).
export const ADAPTIVE_TDEE = {
  ready: 'boolean', daysAvailable: 'integer', daysRequired: 'integer', windowDays: 'integer',
  tdee: 'integer|null', trendKgPerWeek: 'number|null', confidence: 'number|null',
  weightSource: NULLABLE_TEXT, computedAt: 'isotime',
};

export const ERROR = { error: 'string' };
