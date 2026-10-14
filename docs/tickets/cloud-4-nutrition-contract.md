# Cloud handoff 4: NutriTrace API contract and contract tests

Repo: `steradrian/gains-nutrition` (fork of TraceApps/nutritrace, Node/Express + Svelte, SQLite). Branch: `test/api-contract` off the latest `main`. One PR into `main`. Stop when the PR is open and CI is green; the owner's main session reviews and merges. Two other agents work in this repo on `fix/security-hardening` and `fix/bridge-hardening`. Add only new docs and test files; do not change server or client source. If you find a bug, write a test marked `.todo`/`.skip` with a comment, and list it in the PR body.

## Why
"Gains" is a private fitness PWA. Its next big step re-implements NutriTrace's screens (diary, foods, meals, recipes, search, barcode, portions, quick kcal, water, fasting, goals, stats) in a React frontend that calls this server's internal `/api/*` through a gateway. That API is unversioned, and upstream may change it on any merge. A pinned contract with tests that fail on drift is the guard.

## Tasks
1. Inventory every endpoint the existing Svelte client calls for those features (start from the client API module under `src/lib/`, then the routes in `server/routes/`). For each endpoint, record: method and path; query and body fields with types, required or optional, and units (g, ml, kcal, kg or lb); the response shape; error codes; auth requirements; and how dates are handled (local date string vs timestamp, timezone).
2. Write `docs/api-contract.md`: one section per feature, endpoint tables, example requests and responses taken from real test runs. Note the quirks: meal names come from settings, recipes are meals with `is_recipe`, how the default meal is chosen, and how Open Food Facts / USDA search results are shaped and paginated.
3. Add contract tests under the repo's test setup: one file per feature. Each test boots the real server against a temp DB, as the existing tests do, and asserts the response shape (required keys, types, units), not just the status code. They must fail when a field is renamed, removed or changes type. External food-search providers must be faked at the HTTP boundary, with no network calls in CI.
4. Answer these from the code, with file:line, in the PR body:
   - (a) Which meal does logging pick by default when it isn't started from a meal row?
   - (b) Can a diary entry be written for a past or future date, and how is that date sent?
   - (c) Which fields does a barcode lookup return, and what happens on a miss?
   - (d) How do custom units and portions convert to grams?

## Rules
- Make file changes only with your editor tools, never sed/awk/python/heredocs.
- Run the full test suite and lint; report their real exit codes. Do not pipe a command through grep in a way that hides its exit code.
- Changesets, if the repo uses them, are `patch` only. Do not bump versions.
- Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`. Stage specific paths.
