# NutriTrace internal API contract

The `/api/*` endpoints the Svelte client calls for the diary, foods, meals,
recipes, search, barcode lookup, portions, quick calories, water, fasting,
goals and stats. Gains' React frontend calls the same endpoints through its
gateway, so this document and the contract tests (`scripts/contract-*.test.js`)
pin them. The API is unversioned and upstream can change it in any merge, so
when a contract test fails, a field changed under the client.

The federation API (`/api/v1`) is a separate, versioned contract:
[federation.md](federation.md).

> **About the examples.** The request and response examples below were
> written from the code and from the contract tests' own fixtures. They
> were **not** captured from a test run: the environment this was written in
> could not install the server's dependencies. To capture real ones, run
> `CONTRACT_EXAMPLES_DIR=/tmp/contract npm test`. Every test step labelled
> `example: '…'` then writes its request and response to
> `/tmp/contract/<file>.json`. Replace the examples here with those.

## Conventions

**Transport.** JSON in and out. The web client sends the `nt_token` cookie,
and on non-GET requests an `X-CSRF-Token` header (from `/api/auth/me`'s
`csrf`). A client can instead send the token from `POST /api/auth/login`
as `Authorization: Bearer <token>`, as the Android app does. Bearer
requests need no CSRF token. The contract tests use Bearer.

**Auth.**
- Every endpoint here needs a signed-in account (`requireAuth`, otherwise
  **401** `{ "error": "Not authenticated" }`). The exceptions are
  `/api/proxy` (no auth; mounted before sign-in) and `/api/auth/*`.
- On a fresh install with no accounts, every `/api/*` except `/api/auth/*`
  and `/api/proxy` answers **503** `{ "error": "Setup required", "setup_required": true }`.
- In single-user mode (user management turned off), routes run without an
  account and read every row whatever its `user_id`.

**Errors.**
- Always `{ "error": "<message>" }`. A few error bodies add fields, listed
  where they occur.
- The web client throws `Error(body.error)` and drops the status code.
- A body over its limit is **413** `{ error, request_id, size_bytes, declared_bytes, limit_bytes }`.
  The limits are: `/api/diary` 5 MB, `/api/foods` and `/api/meals` 6 MB,
  everything else 1 MB.
- An uncaught failure is `{ "error": err.message }` with the error's status,
  or 500.

**Dates and times.**

| Kind | Format | Where |
|---|---|---|
| Calendar day | `YYYY-MM-DD`, the user's **local** day, chosen by the client | the diary path `:date`, `last_used_at`, `/used` bodies |
| Server stamp | SQLite `YYYY-MM-DD HH:MM:SS`, **UTC**, no `T`, no zone | `created_at`, `updated_at`, `deleted_at`, `completed_at`, `notes_updated_at` |
| Instant | ISO 8601 UTC with milliseconds and `Z` | fasting `start_at` / `end_at`, `computedAt`, items' `addedAt` / `updatedAt` (client-made) |

The server never turns a local day into a time, or a time into a local day,
for these routes. The exception is `POST /api/foods/:id/used` without a
`date`, which uses the server's UTC day.

**Units.**
- Energy in kcal (`calories`), with `kilojoules` alongside when known.
- Macros and fibre in g. Sodium, cholesterol and minerals in mg; vitamins
  A, D, K, B9 and B12 in mcg.
- Water in ml.
- Weight in the unit it was entered in, tagged with `weight_unit` (`kg` or
  `lb`).
- Lengths tagged with `lengths_unit` (`cm` or `in`).

**Numbers and booleans as stored.**
- `favorite` is `0`/`1`, never a boolean.
- A meal's `is_recipe` is a boolean.
- JSON columns are parsed (`nutrition`, `items`, `alt_units`, `body_stats`,
  `water`, `completed_meals`), **except** the diary's `meal_marks_at`, which
  stays a JSON string.

---

## Diary

`server/routes/diary.js`. One row per local day. Items, water, body stats,
notes and completion marks all live in that row.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/diary` | none | Every day with a row, `date` ascending, no paging (the whole history). The Statistics screen reads this. |
| `GET /api/diary/index` | query `since` (the `next` of an earlier response; absent = start of history), `limit` 1..500, default 200 | A search index of the days, in change order: `{ days, total, next, has_more }`. See **Index** below. **400** `{ error, code: "bad_cursor" \| "bad_limit" }` |
| `GET /api/diary/:date` | none | The day, plus `tombstones`. A day with no row: `{ date, items: [], body_stats: {}, water: [], notes: "", completed_at: null, completed_meals: [], tombstones: [] }` |
| `PUT /api/diary/:date` | `{ items[], body_stats{}, water[], notes, deleted_uuids: { items: [uuid], water: [uuid] } }`, optional `notes_updated_at`, `client_now` (Android) | The day as stored, plus `tombstones`. **400** `{ "error": "invalid date", "code": "bad_date" }` unless `:date` is a real `YYYY-MM-DD` (`2026-02-30` is refused); nothing is written anywhere, the quarantine included, so the caller corrects the date and sends again. The batch writers check the same date but keep the day instead of refusing it, since a batch has no one to ask: the Android push (`POST /api/sync/push`: the answer names `quarantined_diary: [{ client_id, date }]`, the rest of the batch lands; a weight reading under a bad date, mirrored into the diary, is named there too), `POST /api/data/import`, `POST /api/nutrition-import/commit` and the backup restores (each answers `quarantined_diary: [{ date }]`); what was sent is kept whole in `diary_quarantine`. That table holds at most 500 days per account. Past it a batch writer skips the bad day, keeps it nowhere, and names it in `quarantine_full` (same shape as `quarantined_diary`, always present, `[]` when empty); the rest of the batch still lands. The boot migration that moves rows an earlier version stored ignores the cap. The table itself refuses a bad date as well. |
| `PUT /api/diary/:date/completion` | `{ completed: boolean }` (anything but `false` counts as true) | `{ ok: true, date, completed_at }`. **400** `{ "error": "invalid date", "code": "bad_date" }` unless `:date` is a real `YYYY-MM-DD` |
| `PUT /api/diary/:date/meal-completion` | `{ slot: 0..31, completed }` | `{ ok: true, date, completed_meals: [int] }`. **400** for a bad date (as above) or `{ "error": "slot must be an integer in [0, 31]" }` |
| `DELETE /api/diary/:date` | none | `{ ok: true }` (soft delete). The client does not call it today. |

**Day** (`parse()`):

| Field | Type |
|---|---|
| `id`, `user_id` | int |
| `date` | `YYYY-MM-DD` |
| `items` | array of items |
| `body_stats` | object |
| `water` | array of water entries |
| `notes` | string (`''` when none) |
| `completed_at` | stamp or null |
| `completed_meals` | int array |
| `updated_at` | stamp |
| `deleted_at` | null on every read |
| `notes_updated_at`, `completion_marked_at` | stamp or null |
| `meal_marks_at` | JSON **string** or null |
| `tombstones` | `[{ kind: "item" \| "water", uuid, deleted_at }]`, on the single-day GET and on PUT |

**Index** (`GET /api/diary/index`, `server/lib/diary-index.js`). Each day is
reduced to what a search on the device needs, read from the stored JSON only
(no food or image lookups). The signed-in account's days only.

| Field | Type |
|---|---|
| `days[]` live | `{ date, rev, kcal, items: [{ uuid, name, brand?, food_id, meal, kcal, parts? }], truncated? }` |
| `truncated` | `true` only: the day alone is over the page cap, so `items` holds the first ones that fit (`kcal` is still the whole day's). Its `rev` is sent, so `next` moves past it |
| `days[]` deleted | `{ date, rev, deleted: true }`: remove the day |
| `rev` | the row's last change, UTC whole seconds, `YYYY-MM-DDTHH:MM:SSZ`; compare as a string |
| `kcal` | integer; the day's is the rounded sum of the unrounded item values |
| item `brand` | left out when empty |
| item `food_id` | the source food's id; `null` for a quick entry, a recipe or a phone-only food |
| item `meal` | slot index into `mealNames` |
| item `parts` | the ingredient names of a split recipe (`_splitItems`), left out otherwise |
| `total` | live days this account has, the length of `GET /api/diary`; a lower count than the client holds means rows were removed outright (a restore): rebuild |
| `next` | always set; pass as `since` to continue or to poll later |
| `has_more` | another call returns more right now; false while the cursor cannot move |

A page also stops before the day that would take the days' JSON past 2 MiB
of UTF-8 bytes (`has_more` is then true and `next` sits on the last day sent),
so a page can hold fewer than `limit` days. A day that is over that on its own
is trimmed to fit and marked `truncated`, so every page holds at least one day
and the cursor always moves. A row whose date is not a real calendar date
(`2026-02-30` too) is left out of the page and of `total`; none should exist,
the diary quarantines them. `limit` is plain digits, `1`..`500`.

The cursor is a keyset position on `(updated_at, date)`, the same one
`GET /api/v1/body-stats` polls with, so any number of rows sharing one second
page through. It never moves into the current second, so rows from it come
again on the next call: applying a day is idempotent. A removed item re-sends
the whole day (no per-item tombstones on the wire).

**Item.** Whatever the client wrote, plus:
- `imgUrl` is always replaced with the source food's (or recipe's) current
  picture, `''` when there is none.
- When the item names a food (`food_server_id`, or `id` when that is
  absent), the server adds the food's `nutrition_basis`, `alt_units`,
  `density_g_ml`, `category` and `barcode`, unless the item already has them.

The client writes:

| Field | Meaning |
|---|---|
| `uuid` | the merge key |
| `meal` | index into the `mealNames` setting |
| `name`, `brand` | strings |
| `portion`, `unit` | the amount logged, in that unit |
| `quantity` | number of portions |
| `nutrition` | for the logged portion; the day total is `nutrition × quantity` |
| `id` / `food_server_id` | the source food |
| `is_recipe` | a recipe item (then `id` is the meal id) |
| `addedAt`, `updatedAt` | ISO instants |
| `type: "quick_calories"` | a quick entry (see below) |
| `_splitItems` | a recipe split into its ingredients |

**Merge rules of PUT** (`server/lib/diary-merge.js`):
- Items and water entries merge by `uuid`.
- A server entry the request does not mention is **kept**, so a client
  that never saw it cannot delete it.
- An entry is removed only through `deleted_uuids`, and that leaves a
  tombstone. A tombstoned uuid sent again is not brought back.
- On a uuid clash, the later `updatedAt` (or `addedAt`) wins.
- An empty `body_stats` never overwrites a non-empty one. Otherwise the
  request's `body_stats` replaces the stored one.
- `notes`: the newer edit wins. The web client always sends `notes` (`''`
  when empty) and no time, so a web save that changes the note wins. A
  request without `notes` keeps the day's note.

```json
PUT /api/diary/2026-10-14
{
  "items": [{ "uuid": "item-oats", "meal": 0, "name": "Rolled oats", "brand": "Contract Mills",
              "portion": 40, "unit": "g", "quantity": 1,
              "nutrition": { "calories": 152, "proteins": 5.2, "carbohydrates": 27.2, "fat": 2.6 },
              "addedAt": "2026-10-14T07:30:00.000Z" }],
  "body_stats": { "weight": 80.4, "weight_unit": "kg" },
  "water": [{ "uuid": "water-1", "amount": 250, "time": "8:05 AM" }],
  "notes": "Slept well",
  "deleted_uuids": { "items": [], "water": [] }
}

200
{ "id": 1, "user_id": 1, "date": "2026-10-14",
  "items": [{ "uuid": "item-oats", "meal": 0, "name": "Rolled oats", "brand": "Contract Mills",
              "portion": 40, "unit": "g", "quantity": 1, "nutrition": { "calories": 152, "proteins": 5.2, "carbohydrates": 27.2, "fat": 2.6 },
              "addedAt": "2026-10-14T07:30:00.000Z", "imgUrl": "" }],
  "body_stats": { "weight": 80.4, "weight_unit": "kg" },
  "water": [{ "uuid": "water-1", "amount": 250, "time": "8:05 AM" }],
  "notes": "Slept well", "updated_at": "2026-10-14 07:31:02", "deleted_at": null,
  "completed_at": null, "completed_meals": [], "notes_updated_at": "2026-10-14 07:31:02",
  "completion_marked_at": null, "meal_marks_at": null, "tombstones": [] }
```

Tests: `scripts/contract-diary.test.js`.

---

## Foods

`server/routes/foods.js`. The client maps `img_url` to `imgUrl` and
`category` to `categories: [category]`, both ways (`src/lib/api.js`
`_foodFromApi` / `_foodToApi`).

| Method and path | Request | Response |
|---|---|---|
| `GET /api/foods` | none | The account's foods, `ORDER BY name` (SQLite binary collation: case-sensitive) |
| `GET /api/foods?group=1` | none | Foods others share with the account (with `_shared_by`), only when sharing is on |
| `GET /api/foods/:id` | none | The food. **404** `{ "error": "Not found" }`, **403** `{ "error": "Forbidden" }`. Also answers a deleted food (see Known issues) |
| `POST /api/foods` | `name` (required). Optional: `brand`, `nutrition{}`, `portion` (100), `unit` (`g`), `img_url`, `notes`, `category`, `barcode`, `visibility`, `nutrition_basis`, `alt_units`, `density_g_ml`, `source_app`, `source_external_id`, `source_url`, `client_key` | **201** with the row. **200** with an existing row for: a `client_key` already used, a `(source_app, source_external_id)` already imported, or a **barcode already in the library** (that food is returned unchanged). **400** `{ "error": "Name required" }` |
| `PUT /api/foods/:id` | Any of the POST fields, plus `favorite` (boolean in, 0/1 stored). Omitted fields are kept; `null` clears `img_url`, `nutrition_basis`, `alt_units` and `density_g_ml` | The row. 404, 403 |
| `DELETE /api/foods/:id` | none | `{ ok: true }` (soft delete). 404, 403 |
| `POST /api/foods/:id/used` | `{ date: "YYYY-MM-DD" }` (otherwise the server's UTC day) | `{ ok: true }`: `usage_count + 1`, `last_used_at = max(last_used_at, date)` |
| `PATCH /api/foods/:id/share` | `{ visibility: "private" \| "group" \| "specific", user_ids: [int] }` | `{ ok: true, visibility }`. 403 when sharing is off |
| `POST /api/foods/:id/copy` | none | 201 the copy (200 if already copied). 400 `{ "error": "Already yours" }` |

**Food.**

| Field | Type |
|---|---|
| `id` | int |
| `user_id` | int or null |
| `name` | string |
| `brand`, `img_url`, `notes`, `category`, `barcode` | string or null |
| `nutrition` | object, values per `portion` `unit` |
| `portion` | number (100 by default) |
| `unit` | string (`g` by default) |
| `visibility` | `private` / `group` / `specific` |
| `source_id` | int or null |
| `source_app`, `source_external_id`, `source_url` | string or null |
| `favorite` | 0/1 |
| `usage_count` | int |
| `last_used_at` | `YYYY-MM-DD` or null |
| `nutrition_basis` | `g` / `ml` / null; stored as sent, not checked |
| `alt_units` | `[{ abbr, grams }]` or null |
| `density_g_ml` | number or null |
| `created_at` | stamp |
| `updated_at`, `deleted_at` | stamp or null |
| `changed_at`, `client_key` | string or null |

```json
POST /api/foods
{ "name": "Rolled oats", "brand": "Contract Mills", "portion": 100, "unit": "g", "category": "Grains",
  "nutrition": { "calories": 379, "kilojoules": 1586, "proteins": 13.2, "carbohydrates": 67.7, "fat": 6.5, "fiber": 10.1, "salt": 0.01 } }

201
{ "id": 1, "user_id": 1, "name": "Rolled oats", "brand": "Contract Mills", "nutrition": { "calories": 379, "kilojoules": 1586, "...": "..." },
  "portion": 100, "unit": "g", "img_url": null, "notes": null, "category": "Grains", "barcode": null,
  "created_at": "2026-10-14 08:00:00", "visibility": "private", "source_id": null, "source_app": null,
  "source_external_id": null, "source_url": null, "updated_at": "2026-10-14 08:00:00", "deleted_at": null,
  "changed_at": "2026-10-14 08:00:00", "client_key": null, "favorite": 0, "usage_count": 0, "last_used_at": null,
  "nutrition_basis": null, "alt_units": null, "density_g_ml": null }
```

Tests: `scripts/contract-foods.test.js`.

---

## Meals and recipes

`server/routes/meals.js`. **A recipe is a meal row with `is_recipe: true`.**

| Method and path | Notes |
|---|---|
| `GET /api/meals` | Meals only (`is_recipe` false), own, by name |
| `GET /api/meals?recipes=1` | Recipes only |
| `GET /api/meals?group=1`, `?recipes=1&group=1` | Shared by others, when sharing is on |
| `GET /api/meals/:id` | 404, 403. Also answers a deleted row |
| `POST /api/meals` | `name` (required, 400 `Name required`). Optional: `items[]`, `nutrition{}`, `is_recipe`, `portion` (100), `unit` (`g`), `servings` (int ≥ 1; **null when left out**), `img_url`, `notes`, `visibility`, `source_*`, `import_warnings[]`, `client_key`. 201, or 200 for a repeat |
| `PUT /api/meals/:id` | The same fields plus `favorite`. Omitted fields are kept (`servings` and `is_recipe` included) |
| `DELETE /api/meals/:id` | `{ ok: true }`, soft delete |
| `POST /api/meals/:id/used` | Same as foods |
| `PATCH /api/meals/:id/share`, `POST /api/meals/:id/copy` | Same as foods |

**Meal.** The food columns without `brand`, `category`, `barcode` and the
unit fields, plus:
- `items`: an array.
- `is_recipe`: a boolean.
- `servings`: int or null.
- `import_warnings`: an array, present only when set.

What the numbers mean:
- **Meal:** `items` are its ingredients, each a food with `portion` scaled
  in, `quantity: 1`, and `nutrition` for that portion. `nutrition` is their
  sum. Logging a meal writes one diary item per ingredient
  (`src/routes/Foods.svelte`).
- **Recipe:** `nutrition` is **per serving** (the total ÷ `servings`), and
  `portion` `unit` is one serving's weight
  (`src/routes/MealEditor.svelte`). Logging a recipe writes one diary
  item with `is_recipe: true` and the recipe's `id`.

Tests: `scripts/contract-meals.test.js`.

---

## Search

**There is no server search endpoint.**
- **Library:** the client filters `GET /api/foods` and `GET /api/meals`
  (and `?recipes=1`) in memory.
- **Open Food Facts and USDA:** the client calls them through
  **`GET /api/proxy?url=<encoded upstream URL>[&live=1]`**
  (`server/routes/proxy.js`), which passes the upstream JSON through
  unchanged.

**`GET /api/proxy`**
- **Auth:** none.
- **Rate limit:** 60 a minute per address; over it, **429**
  `{ "error": "Too many requests. Try again in Ns." }`.
- **Allowed API hosts:** `world.openfoodfacts.org`,
  `search.openfoodfacts.org`, `api.nal.usda.gov` (exact host or a
  subdomain). There is also a short list of image hosts.
- **Timeout:** 15 s. Bodies are capped at 5 MB for JSON and 10 MB for
  images.

| Case | Answer |
|---|---|
| No `url` | 400 `{ "error": "url required" }` |
| Not http/https | 403 `{ "error": "Protocol not allowed" }` |
| Host not listed | 403 `{ "error": "Domain not allowed" }` |
| Upstream non-2xx | **the same status**, `{ "error": "Upstream <status>" }` |
| Network error, non-JSON body, blocked address | 503 `{ "error": "Could not reach that service" }` |
| Image host answering a non-image | 502 `{ "error": "That address is not an image" }` |
| `OFF_LOCAL_ONLY` and the local mirror has nothing | 503 `{ "error": "Local OFF mirror has no answer; remote disabled (OFF_LOCAL_ONLY)" }` |

With a local Open Food Facts mirror (`OFF_LOCAL_DB`), barcode and search
URLs are answered from it first (`server/lib/off-local.js`) unless
`live=1` is sent. A miss falls through to the real Open Food Facts unless
`OFF_LOCAL_ONLY` is set.

**Open Food Facts search** (`API.searchByNameWithMeta`, `src/lib/api.js`):
- Upstream URL: `https://search.openfoodfacts.org/search?q=<query>[ +countries_tags:"en:<country>"]&page_size=<n>&page=<n>&langs=<lang>`.
- Page size: 50 when searching one source, 20 in "all sources".
- Answer: `{ hits: [product], count, page, page_size }`. The client also
  accepts `products` in place of `hits`.
- **Paging:** `count` is the total. There is more while
  `page * page_size < count`.

**USDA search** (`USDA.searchByNameWithMeta`):
- Upstream URL: `https://api.nal.usda.gov/fdc/v1/foods/search?query=<q>&pageSize=<n>&pageNumber=<n>&api_key=<the user's key>`.
- **The user's key travels in the proxied URL** (see Known issues).
- Answer: `{ foods: [{ fdcId, description, dataType, brandOwner?, gtinUpc?, servingSize?, servingSizeUnit?, foodNutrients: [{ nutrientId, nutrientName, unitName, value }] }], totalHits, currentPage, totalPages }`.
- There is more while `page < totalPages`.
- The client maps each food to
  `{ name, brand, barcode: "fdcId_<id>", unit, portion: 100, quantity: 1, nutrition, dataType, _source: "usda" }`
  and orders a page Foundation, then SR Legacy, then Survey, then Branded.

```json
GET /api/proxy?url=https%3A%2F%2Fsearch.openfoodfacts.org%2Fsearch%3Fq%3DBlue%2520Label%2520Marie%2520Biscuits%26page_size%3D50%26page%3D1%26langs%3Den

200
{ "hits": [{ "code": "6009704170273", "product_name": "Blue Label Marie Biscuits", "_score": 76.9989, "completeness": 0.3, "nutriscore_grade": "unknown" }],
  "count": 10000, "page": 1, "page_size": 50 }
```

Tests: `scripts/contract-search.test.js`. The upstream is faked by
`scripts/fixtures/contract/upstream.mjs`, using real trimmed responses from
`scripts/fixtures/off-search-213.json`.

---

## Barcode

1. The client normalises a 12-digit UPC-A code to EAN-13 by adding a
   leading `0`.
2. It looks the code up in the account's library.
3. Then Open Food Facts:
   `GET /api/proxy?url=https://world.openfoodfacts.org/api/v3/product/<code>?lc=<lang>`.
4. When v3 has only "as prepared" values, it also asks
   `…/api/v3.5/product/<code>?fields=nutrition` for the "as sold" set.

USDA is never asked for a barcode (`USDA.lookupBarcode` has no callers).

- **Hit:** `{ status: "success", product }`, passed through.
- **Miss:** Open Food Facts answers 404, so the proxy answers
  **404 `{ "error": "Upstream 404" }`**. The client returns `null`, shows
  "Not in Open Food Facts…", and opens the food editor with only `barcode`
  filled in.

Logging a scanned food saves it first with `POST /api/foods`. The server
then keeps one food per barcode in the library.

Tests: `scripts/contract-barcode.test.js`.

---

## Portions and units

No endpoint of its own. **Grams are worked out on the client**
(`src/lib/units.js` `scaleFactor`). A diary item is written already
scaled: the new `portion` and `unit`, and `nutrition` for that portion. The
server never rescales anything. It stores three fields on the food that the
client uses:

| Field | Meaning | Server rule |
|---|---|---|
| `alt_units` | `[{ abbr, grams }]`: grams in one of that unit | Kept only with a name and grams > 0. Stored as a JSON string, served as an array; `null` when nothing is left |
| `nutrition_basis` | `g` or `ml`: what `portion` counts | Stored as sent |
| `density_g_ml` | grams per ml, to cross between weight and volume | A number > 0, otherwise null |

On a diary read, the server adds these fields (plus `category` and
`barcode`) from the item's food when the item lacks them.

Tests: `scripts/contract-portions.test.js`.

---

## Quick calories

A diary item written with the day:
`{ uuid, meal, type: "quick_calories", name (≤ 60 chars, "Quick Calories" by default), nutrition: { calories, proteins?, carbohydrates?, fat? }, addedAt }`.
- `calories` is in kcal and macros in g; a macro is present only when
  given. The client converts kJ input (÷ 4.184).
- There is **no** `portion`, `unit` or `quantity`.
- `meal` is the section it was added from.

Tests: `scripts/contract-quick-kcal.test.js`.

---

## Water

**No endpoint and no table.** A day's water is the diary row's `water`
array, written with `PUT /api/diary/:date`. Each entry is
`{ uuid, amount, time, updatedAt? }`:
- `amount` is in **ml**. The client converts oz (29.5735 ml), L and gal
  before saving.
- `time` is a **display string** the client formatted (`"8:05 AM"`,
  `"20:15"`), with no date.

Water merges by uuid like items do. Deleting sends
`deleted_uuids.water` and leaves a `kind: "water"` tombstone. The goal is
the `waterGoalMl` setting (2000 by default).

Tests: `scripts/contract-water.test.js`.

---

## Fasting

`server/routes/fasts.js`. One fast is active at a time (`end_at` null).

| Method and path | Request | Response |
|---|---|---|
| `GET /api/fasts?limit=N` | `limit`: 30 by default, kept between 1 and 365 | Fasts, `start_at` newest first |
| `GET /api/fasts/active` | none | The active fast, or `null` |
| `POST /api/fasts/start` | `{ goal_hours?, start_at? }` | **201** the fast. **409** `{ "error": "A fast is already in progress. End it before starting a new one." }` |
| `POST /api/fasts/:id/end` | `{}` | The fast with `end_at` = now. 404 `{ "error": "Fast not found" }`, 403, 400 `{ "error": "Fast is already ended" }` |
| `PATCH /api/fasts/:id` | `start_at`, `end_at` (ISO or `null`), `goal_hours`, `notes` (≤ 500 chars) | The fast. 404, 403 |
| `DELETE /api/fasts/:id` | none | `{ ok: true }`. 404, 403 |

**Fast:** `{ id, user_id, start_at, end_at, goal_hours, notes, created_at, updated_at }`.
- `start_at` and `end_at` are ISO instants in UTC (`Z`).
- `created_at` and `updated_at` are server stamps.

**Out-of-range input is replaced, not refused:**
- `goal_hours` outside (0, 168] becomes 16; otherwise it is rounded to 0.1.
- A `start_at` in the future or more than 24 h back becomes now.
- `PATCH` has no bounds on `start_at`. The client keeps it within the last
  7 days.

Tests: `scripts/contract-fasting.test.js`.

---

## Goals and settings

**Goals have no endpoint of their own.** They are the `goals` setting.
Settings live in `user_settings`, with values stored as JSON
(`server/routes/settings.js`):

| Method and path | Request | Response |
|---|---|---|
| `GET /api/settings` | none | `{ key: value }` for every key, server-only keys left out |
| `PUT /api/settings` | `{ key, value }` | `{ ok: true }`. 400 `{ "error": "key required" }`, 403 `{ "error": "forbidden key" }` |
| `PUT /api/settings/bulk` | `{ settings: { key: value } }` | `{ ok: true, written, skipped }` (server-only keys skipped). 400 `{ "error": "settings object required" }` |

In single-user mode the GET answers `{}` and the PUTs do nothing.
Server-only keys are OAuth app credentials: anything ending in
`_client_secret`, `_consumer_secret`, `_api_secret`, `_redirect_uri` or
`_client_id`.

The keys the features use (`src/stores/settings.js`):

| Key | Shape |
|---|---|
| `mealNames` | string array, `["Breakfast", "Lunch", "Dinner", "Snacks"]` by default. **A diary item stores only the index.** |
| `goals` | `{ <nutrient or metric>: { min?, max?, sharedGoal, isMin, isPercent, showInDiary, showInStats, days: [7 × boolean] } }`; calories in kcal, macros in g, or % when `isPercent` |
| `calorieGoalMode` | `fixed` / `dynamic` / `adaptive` |
| `calorieGoalFactor` | number |
| `waterGoalMl` | number, ml |
| `weightUnit` | `kg` / `lb` |
| `customUnits` | `[{ abbr, full }]`, with **no gram weight** |

**`GET /api/goals/adaptive-tdee`** (`server/lib/adaptive-tdee.js`)
- Answer: `{ ready, daysAvailable, daysRequired: 21, windowDays: 35, tdee, trendKgPerWeek, confidence, weightSource, computedAt }`.
- `tdee` is an int in kcal or null; `trendKgPerWeek` is in kg;
  `confidence` is between 0.5 and 0.95; `weightSource` is `wellness`,
  `manual`, `mixed` or null.
- Not ready (fewer than 21 days with both intake and weight): `tdee`,
  `trendKgPerWeek`, `confidence` and `weightSource` are null.
- The window is UTC days. Single-user mode answers 401
  `{ "error": "Unauthorized" }`.

Tests: `scripts/contract-goals.test.js`.

---

## Stats

**No stats endpoint.** The Statistics screen reads `GET /api/diary` (the
whole history) and adds it up in the client:
- calories: `nutrition.calories × quantity` per item;
- water: from `water`;
- weight: from `body_stats` with its unit tag.

Fasting insights read `GET /api/fasts?limit=60`.

Tests: `scripts/contract-stats.test.js`.

---

## Answers

**(a) Which meal does logging pick when it is not started from a meal row?**
The first meal, **index 0** (`mealNames[0]`, "Breakfast" by default). There
is no time-of-day logic.
- `addDiaryItem` uses `meal != null ? Number(meal) : 0`
  (`src/stores/diary.js:294`).
- Adding from a meal section passes that section's index through the URL
  `?meal=` (`src/routes/Diary.svelte:932`, then `src/routes/Foods.svelte:1276`).
- From the food list, "Add to Diary" asks which meal
  (`src/components/ui/FoodDetailSheet.svelte:147-153`) and falls back to 0
  (`Foods.svelte:1061`).
- The sheet's comment mentions a default or last-used meal; that is not
  implemented.
- The AI quick log matches the meal name it was given
  (`src/lib/quick-log.js:181-232`), otherwise 0.

**(b) Can a diary entry be written for a past or future date, and how is the date sent?**
Yes, both. The date is the **path segment** of `PUT /api/diary/:date`
(`server/routes/diary.js:111`). It is the client's local `YYYY-MM-DD`
(`src/lib/db.js:312-317`, or the diary's current date). The body carries
no date.
- The server stores the date as sent and does not check it at all; only
  `/completion` and `/meal-completion` check the format (`diary.js:275`,
  `:331`). See Known issues.
- The client logs to `date || viewDate || today` (`src/stores/diary.js:278`).
  Moving between days has no bounds.

**(c) Which fields does a barcode lookup return, and what happens on a miss?**
The server returns whatever Open Food Facts sent, through `/api/proxy`.
From that, the client (`src/lib/api.js` `_mapOFFProduct`, about lines
486-645) maps:

| Field | Value |
|---|---|
| `name` | |
| `brand` | the first brand |
| `barcode` | |
| `unit` | `g`, or the serving unit |
| `portion` | 100, or the serving size with the per-serving import setting |
| `quantity` | 1 |
| `imgUrl` | |
| `nutrition` | kcal (or kJ ÷ 4.184), kJ, macros in g, minerals in mg, vitamins in mcg, all from `nutriments.*_100g` |
| `nutrition_basis` | from `nutrition_data_per` or the serving unit |
| `alt_units` | from `serving_size`, e.g. "1 slice (35 g)" |
| `completeness`, `nutriscore`, `nova`, origin | quality signals |

On a miss, Open Food Facts answers 404 and the proxy keeps it
(`{ "error": "Upstream 404" }`). `lookupBarcode` returns `null`, and the UI
says so and opens the food editor with only the barcode
(`src/routes/Foods.svelte:1626-1634`; a lookup error does the same with a
different message). USDA is not asked.

**(d) How do custom units and portions convert to grams?**
On the client, in `scaleFactor(origPortion, origUnit, newPortion, newUnit, food)`
(`src/lib/units.js:263`). It tries these in order:
1. The food's **`alt_units`**: grams in one of that unit. When
   `nutrition_basis` is `ml`, grams are divided by `density_g_ml`; without
   a density this step gives nothing.
2. The built-in table **`UNIT_TO_G`** (`units.js:69-84`):

   | Unit | Grams (or ml) |
   |---|---|
   | g | 1 |
   | mg | 0.001 |
   | kg | 1000 |
   | oz | 28.3495 |
   | lb | 453.592 |
   | ml | 1 |
   | l | 1000 |
   | tsp | 4.929 |
   | tbsp | 14.787 |
   | fl oz | 29.574 |
   | cup | 236.588 |

   Weight and volume are bridged with `density_g_ml` when the unit and the
   food's `nutrition_basis` differ. Without a basis, 1 ml counts as 1 g.
3. Otherwise the plain ratio `newPortion / origPortion`.

The new nutrition is the food's `nutrition × factor`, and that is what the
diary item stores.

**Custom units** (the `customUnits` setting) have **no gram weight**, so
they always end up at the ratio. A gram conversion for a food comes only
from its `alt_units`.

---

## Quirks worth knowing

- `GET /api/foods`, `/api/meals` and `/api/diary` in single-user mode read
  every row, whatever `user_id` it has.
- `meal_marks_at` is a JSON string, while `completed_meals` next to it is
  parsed.
- `GET /api/diary` has no paging; it is the whole history.
- `nutrition_basis` is not checked: any string is stored.
- `/api/proxy` answers before sign-in, and its rate limit is per address
  (behind a gateway that is the gateway's address unless `TRUST_PROXY` is
  set).
- `POST /api/foods/:id/used` without a `date` uses the server's UTC day,
  which can be a day off from the user's.
- Open Food Facts contributions go from the browser straight to
  `world.openfoodfacts.org/cgi/product_jqm2.pl`, not through `/api`.

## Known issues

The contract tests mark these `todo`: they assert the behaviour that should
be, and they do not fail the suite while it is not.

| Issue | Where | Test |
|---|---|---|
| `PUT /api/diary/:date` accepts any path segment as the date | `server/routes/diary.js` | `contract-diary.test.js` |
| `GET /api/foods/:id` (and `GET /api/meals/:id`) answer a soft-deleted row with 200 | `server/routes/foods.js`, `meals.js` | `contract-foods.test.js` |
| On an error, `/api/proxy` logs the whole upstream URL, including a USDA `api_key` | `server/routes/proxy.js` | `contract-search.test.js` |
| `PATCH /api/fasts/:id` with `end_at: null` re-opens a fast without the one-active-fast check, so two fasts can be active | `server/routes/fasts.js` | `contract-fasting.test.js` |

## Running the contract tests

They are part of `npm test`. Each file boots `server/index.js` on a scratch
database through `scripts/fixtures/contract/server.mjs`. The preload
`scripts/fixtures/contract/net.mjs` sends the three food-database hosts to
a local fake and refuses every other outside host, so the tests make no
network calls.
