# TraceApps Federation API

A Bearer-authenticated REST API that NutriTrace exposes for sister apps
in the TraceApps ecosystem (LiftTrace public, CookTrace in private
development, plus any self-hosted custom integrations) to consume.

This is an **internal cross-app contract**, not a public API for
third-party developers. The wire format is stable across NT releases
within a major version; consumers code against this document, not
against NT's internal database schema.

Looking for the routes a user's own scripts and automations can call,
rather than a sister-app contract? See [the general public API](public-api.md)
and [outgoing webhooks](webhooks.md), both mounted alongside this API
but gated behind their own opt-in flags and reusing the `mcp:read`/
`mcp:write` token scopes instead of the federation-specific ones below.

---

## Versioning

Endpoints live at `/api/v1/`. The `v1` namespace is the contract.
Breaking schema changes require shipping `v2` in parallel; v1 is not
broken without long lead time.

Within v1, additive changes (new fields on existing objects, new
endpoints) are non-breaking and may ship at any time. Consumers must
ignore unknown fields.

---

## Authentication

Bearer token. Tokens are generated per-user in the NutriTrace UI
(Settings → Admin → API Tokens), shown to the user once at creation,
and stored as a SHA-256 hash on the server.

```
Authorization: Bearer nt_pat_<32-byte-base64>
```

A token belongs to exactly one user. Calls made with the token act as
that user, scoped to that user's foods, recipes, and diary entries.
There is no concept of a "service account" or app-level token.

Token format prefix: `nt_pat_` so leaked tokens are recognizable in
logs and credential scanners.

### Scopes

Each token carries a list of scopes. Calls outside a token's scopes
return `403 Forbidden`. Available scopes:

| Scope             | Grants                                                                           |
|-------------------|----------------------------------------------------------------------------------|
| `read:foods`      | List + read foods owned by the user. Used by CookTrace (in private development). |
| `write:workouts`  | Push completed workouts to the user's wellness data via `POST /api/v1/workouts`. Used by LiftTrace so its calorie estimates feed NutriTrace's dynamic-TDEE calculations. |
| `write:activity`  | Log diary Activity rows via `POST /api/v1/activity`, `POST /api/v1/activity/batch` and `DELETE /api/v1/activity/external/{external_id}`. Used by external trackers and the openGym bridge. |
| `write:body-measurements` | Push scale readings (weight, body composition) via `POST /api/v1/body-measurements`. Aimed at Home Assistant, Node-RED, Gadgetbridge and other headless integrations that pull data from BLE smart scales the phone can't see. |
| `read:body-stats` | Read the diary's daily weight via `GET /api/v1/body-stats`. Used by the openGym bridge. |

A hub's `scope=sync` token (see the hub token contract) holds exactly
`write:activity`, `read:body-stats` and `write:body-measurements`; a
hub's `scope=user` token never reaches `/api/v1`. Each hub token is
accepted once: a `jti` seen again before the token expires is a 401.
The jti is spent when the token is checked, before rate limiting and
the handler, so a retry after a 429, a 5xx or a timeout must carry a
newly minted token. The record of spent jtis is in memory (a restart
forgets it, acceptable with 60 s tokens) and holds up to 100,000
unexpired ones; when it is full, new hub tokens get
`503 { "code": "hub_replay_cache_full" }` with `Retry-After` until
entries expire, rather than an old jti being forgotten.

Future scopes (`read:meals`, `read:diary`, etc.) will be added alongside
the endpoints they unlock; gating tokens on scopes the server can't
actually serve is confusing UI.

### Rate limiting

60 requests / minute per token by default (a batch counts one per
item). Configurable via `API_RATE_LIMIT_PER_MIN` env var; a hub's sync
token has its own, `HUB_SYNC_RATE_LIMIT_PER_MIN` (600). Limit headers
returned on every response:

```
X-RateLimit-Limit:     60
X-RateLimit-Remaining: 47
X-RateLimit-Reset:     1714750000
```

Over-limit responses return `429 Too Many Requests` with a
`Retry-After` header (seconds).

---

## Wire format conventions

- All responses are JSON.
- Timestamps are ISO 8601 UTC strings.
- Numeric nutrition fields are in the units listed in the field name
  (e.g. `calories` is kcal, `proteins` is grams). Consumers map to
  their own unit preferences on the way in.
- `null` is used for "not set." Empty string is reserved for "set to
  empty" (rarely used).
- Unknown fields must be ignored by consumers (forward-compat).
- Identifiers are integers, scoped to the issuing instance. A food
  with `id: 42` on instance A has nothing to do with `id: 42` on
  instance B.

---

## Phase 1 endpoints

### `GET /api/v1/me`

Identity check. Useful for clients to verify the token is valid and
discover which user it belongs to.

```json
{
  "user": {
    "id": 1,
    "username": "alice",
    "full_name": "Alice Example",
    "role": "admin"
  },
  "instance": {
    "url":     "https://nutritrace.example.com",
    "version": "1.0.0-rc.14"
  },
  "scopes": ["read:foods"]
}
```

Always available regardless of token scopes (it's identity, not data).

### `GET /api/v1/foods`

List foods owned by the authenticated user. Supports basic filtering.

Query parameters:

| Param      | Type    | Default | Description                          |
|------------|---------|---------|--------------------------------------|
| `q`        | string  | —       | Substring match on `name` or `brand` |
| `limit`    | int     | 100     | Max results, capped at 500           |
| `offset`   | int     | 0       | Pagination offset                    |
| `category` | string  | —       | Filter by exact category match       |

Response:

```json
{
  "items": [ Food, Food, ... ],
  "total": 1240,
  "limit": 100,
  "offset": 0
}
```

### `GET /api/v1/foods/{id}`

Fetch a single food by its NutriTrace id. Returns `404` if the food
doesn't exist or is not readable by the token's user.

### `POST /api/v1/body-measurements`

**Requires scope:** `write:body-measurements`.

Record a scale reading (weight + body composition) for the
authenticated user. Values land in `diary.body_stats` for the day in
`date` (`YYYY-MM-DD`, the user's own day, taken as sent). Without
`date`, the day `measured_at` falls on in the user's timezone setting,
else the date written in `measured_at` itself (always so for a time
with no zone). Never the server's timezone. It is the same row the manual body-stats UI, the Withings
sync, and the diary view all read from.

A day erased in the app is refused with `409 diary_tombstoned`. Every
accepted write fires the `body_stat.logged` webhook.

**Semantics.** Overwrites only the fields the payload actually sends.
Anything already in `body_stats` under other keys stays untouched, so
a HA-pushed weight doesn't stomp a manual `notes` entry. Send the
same measurement twice → last write wins (fine for idempotency: same
values, same result).

**Request body** — snake_case or camelCase accepted; snake_case wins
on collision. `date` or `measured_at` is required; any subset of the
measurement fields can be provided.

```json
{
  "date":           "2026-07-25",
  "measured_at":    "2026-07-25T16:10:51Z",
  "source":         "home-assistant",

  "weight":         76.9,
  "body_fat":       21.2,
  "muscle_mass":    56.14,
  "bone_mass":      3.01,
  "body_water":     54,
  "lean_body_mass": 60,

  "bmi":            24.3,
  "visceral_fat":   11,
  "protein":        20.7,
  "bmr":            1590,
  "metabolic_age":  28,
  "impedance":      465,
  "body_score":     73
}
```

**Field → storage mapping.** The first six map to NT's native
`body_stats` keys used by the diary UI:

| Wire field       | Unit | Storage key            |
|------------------|------|------------------------|
| `weight`         | kg   | `weight` (tagged `weight_unit: "kg"`, what the Weight card and the adaptive TDEE read) and `weight_kg` |
| `body_fat`       | %    | `body_fat_pct`         |
| `muscle_mass`    | kg   | `muscle_mass_kg`       |
| `bone_mass`      | kg   | `bone_mass_kg`         |
| `body_water`     | %    | `body_water_pct`       |
| `lean_body_mass` | kg   | `lean_mass_kg`         |

The remaining fields (`bmi`, `visceral_fat`, `protein`, `bmr`,
`metabolic_age`, `impedance`, `body_score`) are stored under their
wire names in the same JSON blob. NT doesn't render them today but
they round-trip cleanly if the UI ever exposes them, and they're
included in server backups.

**Where the values show up.** Every numeric metric writes to two
places, matching the Withings sync pattern:

- **`diary.body_stats`** — populates the Body Stats card on the diary
  page for that date.
- **`wellness_data`** with `source='federation'` — populates the
  Wellness → Body tab (Weight, Body Fat, Muscle Mass, Bone Mass,
  Body Water, Lean Mass, etc.) so all six standard metrics render
  alongside anything synced from Withings / Fitbit / Health Connect.

**Validation.** Each numeric field is range-checked against a
sanity envelope (e.g. `weight` 10-500 kg, `body_fat` 1-80 %). Any
out-of-range value rejects the whole request with
`400 out_of_range` and a `field` pointer, so a mis-scaled
integration (grams instead of kg) fails loudly instead of
corrupting the diary.

**Response** — `201 Created`:

```json
{
  "ok":     true,
  "date":   "2026-07-25",
  "stored": ["weight", "weight_kg", "body_fat_pct", "muscle_mass_kg", "bone_mass_kg"]
}
```

`stored` lists the storage keys that were actually written, so the
integration can log/confirm what landed.

**Example** — one-liner from a Home Assistant automation:

```bash
curl -X POST https://nutritrace.example.com/api/v1/body-measurements \
  -H 'Authorization: Bearer nt_pat_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "measured_at": "2026-07-25T07:12:00Z",
    "source":      "xiaomi-bodymiscale",
    "weight":      76.9,
    "body_fat":    21.2
  }'
```

**Reading data back.** The day's weight reads back through
`GET /api/v1/body-stats` (below).

### `GET /api/v1/body-stats`

**Requires scope:** `read:body-stats`.

One weight per day: the diary's `body_stats.weight`, in kg (converted
from its `weight_unit` tag; an untagged legacy value is read in the
user's `weightUnit` setting, as the app shows it).

| Param           | Type    | Default | Description |
|-----------------|---------|---------|-------------|
| `from`, `to`    | date    | open    | `YYYY-MM-DD`, inclusive. No default range. |
| `updated_since` | instant | —       | ISO 8601 with `Z` or an offset, inclusive. Starts polling (below). |
| `cursor`        | string  | —       | A `next_cursor` from an earlier poll. Not with `updated_since` or `offset`. |
| `limit`         | int     | 200     | 1..1000 |
| `offset`        | int     | 0       | Listing only. |

**Listing** (no `updated_since`, no `cursor`): days with a weight, in
date order, paged by `limit`/`offset`.

```json
{
  "items": [ { "date": "2026-10-14", "weight_kg": 78.4, "updated_at": "2026-10-14T06:41:10Z" } ],
  "total": 41, "limit": 200, "offset": 0
}
```

**Polling** (`updated_since` for the first call, then `cursor`): every
day whose diary row changed at or after the start, oldest change first
(ties in date order), with `weight_kg: null` when the day has no weight
now (a removed weight or an erased day), so a poller sees removals.

```json
{
  "items": [ { "date": "2026-10-13", "weight_kg": null, "updated_at": "2026-10-14T06:41:10Z" } ],
  "total": 300, "limit": 200, "next_cursor": "eyJ1Ijoi...", "has_more": true
}
```

Keep `next_cursor` (always set) and send it as `cursor` next time; while
`has_more` is true, call again straight away (it is false when the
cursor could not move, so that never spins). The cursor is a position
on (`updated_at`, `date`), so any number of days changed in one second
(as "Clear all data" does) pages through. It never moves into the
current second, which can still be written to, so rows from it come
again on the next poll: keep one value per `date` and let the row from the
later poll replace the earlier one, even when `updated_at` is the same (a day
can change again within the second it was polled). Do not drop a row as a
repeat because its `(date, updated_at)` was seen before.
`updated_at` is the diary row's last change (any change to the day, so
an upper bound for the weight), in whole seconds. A full-backup restore
brings back the backup's rows with their own `updated_at`, so polling
cannot see what it removed: after a restore, read the whole range again.

### `POST /api/v1/activity`

**Requires scope:** `write:activity`.

One diary Activity row:
`{ date, name, kcal, duration_min?, distance?, external_id?, source? }`.
`name` is a string; `kcal` and `duration_min` are numbers (a string that
spells a number is accepted too); anything else (`null`, `true`, an
object) is `400 bad_name` / `bad_kcal` / `bad_duration`. `source` left
out on an update keeps the row's own (an openGym row stays one).
`external_id` is at most 128 characters: a longer one is accepted only
when its first 128 characters already name a row (rows from before this
rule, when longer keys were cut), and is otherwise
`400 external_id_too_long`, since two long keys could cut to one.
It names one row per user for good: re-posting it updates that row in
place (a new `date` moves it), a post after a delete brings the same
row back, and a second row is never made (a unique index backs this).
`source: "opengym"` marks the openGym bridge's rows: on a day a wearable
reports active calories they are shown with
`covered_by: "<wearable source>"` but not counted toward the day's
activity total, whatever the user's policy.

**The user's edit wins, for every integration.** Once the user changes
or deletes a row an integration made (in the web app, on the phone, or
with "Clear all data"), no update from any integration writes over it:
upserts leave it as the user made it and answer `user_edited`. A delete
from the integration (`DELETE /api/v1/activity/external/{external_id}`
or a batch delete: the workout no longer exists) still removes the row,
edited or not. It then stays the user's: a later post answers
`user_edited` and does not bring it back.

Response `201` (created) or `200`:
`{ ok, status, activity_id, date, kcal, daily_total_kcal, updated }`,
where `status` is `created`, `updated`, `unchanged` or `user_edited`
(the row was left as the user made it).

### `POST /api/v1/activity/batch`

**Requires scope:** `write:activity`. Counts as one request per item
against the token's rate limit: a batch that does not fit in what is left
of the minute is refused whole (`429`, `Retry-After`, nothing written),
and one larger than the whole limit (over 60 items for a personal token
at the default) is `400 batch_over_rate_limit`. The hub's sync token
(600 a minute) takes full batches.

`{ "items": [ ... ] }`, at most 100 (`400 too_many_items`). Each item
is an entry as above with `external_id` required, or
`{ "op": "delete", "external_id": "..." }`. Items run in order, in one
transaction. Response `200`:
`{ ok, results: [ { external_id, status, activity_id, code?, error? } ] }`
with `status` one of `created`, `updated`, `unchanged`, `user_edited`,
`deleted`, `not_found` or `error` (with the same `code` the single
route would answer).

### `DELETE /api/v1/activity/external/{external_id}`

**Requires scope:** `write:activity`.

Soft-deletes the row with that key, even one the user edited (the
source says the workout is gone). Idempotent: an unknown or already
deleted key answers `200 { ok: true, deleted: false, activity_id: null }`.
Otherwise `200 { ok: true, deleted: true, activity_id, date, daily_total_kcal }`.

---

## Object: `Food`

```json
{
  "id":       42,
  "name":     "Skyr, plain",
  "brand":    "Siggi's",
  "category": "Dairy",
  "barcode":  "0098463900008",
  "portion":  100.0,
  "unit":     "g",
  "img_url":  "https://nutritrace.example.com/uploads/abc123.jpg",
  "notes":    "1 cup ≈ 245g cooked",
  "nutrition": {
    "calories":      59,
    "fat":           0.2,
    "saturated-fat": 0.1,
    "carbohydrates": 4.0,
    "sugars":        4.0,
    "fiber":         0,
    "proteins":      11.0,
    "sodium":        65,
    "calcium":       150
  },
  "created_at": "2026-04-12T18:32:11.000Z",
  "updated_at": "2026-05-01T09:14:00.000Z"
}
```

Field reference:

| Field         | Type             | Notes                                               |
|---------------|------------------|-----------------------------------------------------|
| `id`          | integer          | Stable within instance. Cross-instance refs MUST include the instance URL. |
| `name`        | string           | Required.                                           |
| `brand`       | string \| null   |                                                     |
| `category`    | string \| null   | Free text, user-defined category.                   |
| `barcode`     | string \| null   | EAN-13 / UPC-A as digit string. Leading zeros preserved. |
| `portion`     | number           | Reference quantity for `nutrition` values. Default 100. |
| `unit`        | string           | Unit for `portion`. Common values: `g`, `ml`, `oz`, `cup`. |
| `img_url`     | string \| null   | Absolute URL. May require auth (use `/uploads/...` proxy with the same Bearer token). |
| `notes`       | string \| null   | User-authored note (e.g. cooked-vs-raw clarifications). |
| `nutrition`   | object           | Keys are nutrient ids. Values are numbers per `portion`. See nutrient list. |
| `created_at`  | ISO 8601 string  |                                                     |
| `updated_at`  | ISO 8601 string  |                                                     |

### Nutrition keys (Phase 1)

The following keys are guaranteed present in `nutrition` if the food
has the data. Unknown keys may appear in future versions; consumers
must ignore them.

| Key                | Unit          |
|--------------------|---------------|
| `calories`         | kcal          |
| `fat`              | g             |
| `saturated-fat`    | g             |
| `trans-fat`        | g             |
| `monounsaturated-fat` | g          |
| `polyunsaturated-fat` | g          |
| `cholesterol`      | mg            |
| `sodium`           | mg            |
| `potassium`        | mg            |
| `carbohydrates`    | g             |
| `fiber`            | g             |
| `sugars`           | g             |
| `added-sugars`     | g             |
| `proteins`         | g             |
| `calcium`          | mg            |
| `iron`             | mg            |
| `magnesium`        | mg            |
| `phosphorus`       | mg            |
| `zinc`             | mg            |
| `caffeine`         | mg            |
| `alcohol`          | g             |
| `vitamin-a`        | µg            |
| `vitamin-c`        | mg            |
| `vitamin-d`        | µg            |
| `vitamin-e`        | mg            |
| `vitamin-k`        | µg            |
| `b1` ... `b12`     | mg / µg       |

---

## Errors

Standard HTTP status codes plus a JSON body:

```json
{ "error": "Token required",        "code": "auth_missing" }
{ "error": "Invalid token",         "code": "auth_invalid" }
{ "error": "Token lacks read:foods","code": "auth_scope" }
{ "error": "Not found",             "code": "not_found" }
{ "error": "Rate limited",          "code": "rate_limited" }
```

Consumers should switch on `code` (stable) rather than parsing
`error` (human-readable, may change).

---

## Phasing

**Phase 1 (current):** read-only. `read:foods` scope, foods endpoints,
token management UI, rate limiting, this document.

**Phase 2 (later):** more read scopes — `read:meals` (recipes),
`read:diary`. Strictly additive; existing tokens keep working.

**Phase 3 (later, with care):** targeted write endpoints for cross-app
flows (e.g. `write:diary` for LiftTrace pushing workouts into the NT
diary as activity entries). Each write endpoint is specific and
audit-logged; no generic "write anything" surface.

**Phase 4:** LiftTrace and CookTrace expose their own `/api/v1/` with
the same conventions, becoming peers to NutriTrace in the federation.

---

## Cross-instance references

Each instance issues its own integer ids. A CookTrace recipe that
references NutriTrace food id `42` should store both the food id and
the issuing instance URL, so the reference resolves correctly even if
the user later runs CookTrace against a different NutriTrace
instance.

Recommended reference shape (defined once here, used by all consumer
apps):

```json
{
  "instance_url": "https://nutritrace.example.com",
  "type":         "food",
  "id":           42
}
```
