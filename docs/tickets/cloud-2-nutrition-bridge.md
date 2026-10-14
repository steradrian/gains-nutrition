# Cloud handoff 2: NutriTrace bridge hardening and data correctness

Repo: `steradrian/gains-nutrition` (fork of TraceApps/nutritrace, Node/Express + Svelte, SQLite). Branch: `fix/bridge-hardening` off `main`. One PR into `main`. Stop when the PR is open and CI is green; the owner's main session reviews and merges. Another agent is working in the same repo on `fix/security-hardening` (auth middleware, SSRF, throttles, hub-token signature). Stay out of those files where you can.

## Context
"Gains" is a private fitness PWA that combines openGym (workouts) with this fork (nutrition). A gateway service ("hub") syncs between them with short-lived hub tokens (`scope=sync`). The sync uses the bridge endpoints merged in PR #4:
- `/api/v1/activity`: upsert by `external_id`, batch of up to 100, delete.
- `GET /api/v1/body-stats`: `updated_since` on the first call, then a keyset `next_cursor`.
- `POST /api/v1/body-measurements`.

A `jti` replay cache protects sync writes.

Owner rules that the code already implements and must keep: a user edit is never overwritten by any integration update; deleting at the source removes the row; a wearable wins over manual and openGym entries. A hub sync worker is being written against these endpoints right now. Keep every well-formed request working exactly as it does today, and put any contract change in the PR body.

## Tasks (each with a behaviour test)
1. The replay cache evicts the oldest `jti` once it holds 100k entries, which lets an attacker push out an entry and replay it. Fail closed instead: return 503 with `Retry-After` when full. Document that the cache is in-memory only, so a restart forgets it (acceptable with 60 s tokens).
2. Body-stats polling scans every row per poll. Push the LIMIT and the keyset condition into SQL, and add an index on `(user_id, updated_at, date)` through the repo's migration mechanism.
3. A 128-char `external_id` truncation can collide two long ids. Keep truncating ids that already exist (legacy rows), but reject a NEW over-length key with 400 and a clear error.
4. `kcal` and `name` type coercion: `null`, `true` and objects are accepted today. Require a finite number for kcal and a string for name; return 400 otherwise.
5. `_update` rewrites `source`, so a re-post without `source` flips an `opengym` row to external. Keep the stored source when the field is omitted.
6. A batch of 100 counts as one request against the rate limit (about 6,000 writes per minute per token). Count each item.
7. Unit mismatch, verify first and then fix: untagged legacy weights are read as the user's `weightUnit` (default lb), while upstream's adaptive TDEE reads them as kg. Trace both paths and write a failing test that shows the wrong number before fixing. Fix it so both paths agree. Prefer tagging the unit at write time, plus a one-time migration that tags legacy rows with the unit they were actually entered in, if that can be determined. If it can't be determined safely, stop and describe the options in the PR body instead of guessing.
8. `diary-helpers.js`: the hub query still matches unowned rows with `visibility='group'`. Restrict it to rows the user owns.
9. Backup restore without a links key keeps hub links by `user_id` only, so restoring another instance's backup could tie a hub user to a different person. Also match on username and drop links that don't match.
10. The client ignores `covered_by`, and `Diary.svelte`'s `manualCounted` shows bridge rows as counted under manual_wins/additive. Make the existing Svelte diary respect `covered_by` (small change; the Gains UI will replace this screen later).

## Rules
- Make file changes only with your editor tools, never sed/awk/python/heredocs.
- Run the full test suite, lint and build; report their real exit codes. Do not pipe a command through grep in a way that hides its exit code.
- Changesets, if the repo uses them, are `patch` only. Do not bump versions.
- Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`. Stage specific paths.
- English only for any new strings.
- PR body: list each task with its file, its test, every contract change for the sync worker, and anything you could not verify.
