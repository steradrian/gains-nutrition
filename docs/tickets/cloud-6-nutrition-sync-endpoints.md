# Cloud handoff 6: NutriTrace endpoints the Gains sync and diary need

Repo: `steradrian/gains-nutrition` (fork of TraceApps/nutritrace; Node/Express + Svelte, SQLite). Branch: `feat/sync-endpoints`, cut from **`fix/bridge-hardening`** (an open PR that reworks body-stats and the v1 bridge; building on it avoids conflicts). If that branch no longer exists, cut from `main`. Open one PR into `main` and say in the body which branch it is based on. Stop when the PR is open and CI is green; the owner's main session reviews and merges.

## Context
"Gains" combines openGym (workouts) with this fork (nutrition). A gateway called the "hub" syncs the two using short-lived hub tokens (`scope=sync`) against the `/api/v1` bridge endpoints:
- activity upsert, batch and delete;
- body-stats polled with `updated_since` / `next_cursor`;
- body-measurements.

The hub's sync worker is merged. Its review left these gaps on the NutriTrace side. Owner rules to keep: a user edit is never overwritten by any integration, a delete at the source removes the row, a wearable wins, one weight per day, and unit-tagged.

## Tasks (each with a behaviour test)
1. **Delete a day's weight via `/api/v1`.** Today an openGym weigh-in deletion cannot propagate. Add a `scope=sync`-only route (for example `DELETE /api/v1/body-stats/:date` or a `weight: null` write; pick whichever fits the existing v1 style). It removes the weight for that date and leaves the other body stats alone. It must create a tombstone or change entry so the body-stats poll reports the deletion.
2. **Separate change time for weight.** Body-stats `updated_at` also moves when food changes, which skews the hub's "later wins". Add a weight-specific change time (for example `weight_updated_at`), set only when the weight value or unit changes. Expose it in `GET /api/v1/body-stats`, keep the existing fields, and migrate existing rows by copying `updated_at` once.
3. **Read route for the hub's display.** Gains wants to show, for an activity row, the stored kcal and `covered_by` when the user edited it. Make sure `GET /api/activity/:date` (user scope) already returns `source`, `external_id`, an edited flag (or `user_edited_at`) and `covered_by`. Add whatever is missing. Document the response shape.
4. **Diary range read.** The Gains calendar marks the days with food logged and today has to make one request per day. If no range read exists, add a user-scope `GET /api/diary?from=YYYY-MM-DD&to=YYYY-MM-DD&fields=logged`. It returns only which dates have items, at most 62 days per call, scoped to the caller. Document it.

## Rules
- Make file changes only with your editor tools, never sed, awk, python or heredocs.
- Run the full test suite, lint and build, and report the real exit codes.
- Every well-formed request that works today must keep working. List every contract change in the PR body: the hub sync worker and the Gains frontend will consume them.
- Changesets, if the repo uses them, are `patch` only. Don't bump versions.
- Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`. Stage specific paths.
