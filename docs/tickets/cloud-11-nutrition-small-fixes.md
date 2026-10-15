# Cloud handoff 11: NutriTrace small fixes

Repo: `steradrian/gains-nutrition` (fork of TraceApps/nutritrace; Node/Express + Svelte, SQLite). Branch: `fix/small-fixes` off the latest `main`. One PR into `main`. Stop when it's open and CI is green; the owner's main session runs the tests locally (Node 20), reviews and merges.

## Context
"Gains" is a private fitness PWA. This fork is its nutrition backend, reached only through a gateway (the "hub") with short-lived hub tokens. NutriTrace's tests need Node 20 (better-sqlite3 is built for it).

## Tasks (each with a behaviour test)
1. **Open Food Facts User-Agent.** `/api/proxy` sends `User-Agent: Mozilla/5.0 (compatible; NutriTrace/1.0)`. OFF asks for an app name, version and contact. Make it configurable through an env var (for example `OFF_USER_AGENT`), defaulting to `Gains/0.1.0 (+https://github.com/steradrian/gains)`. Use it for every outbound OFF request (search, product lookups, images).
2. **`findByCreateKey` returns soft-deleted rows** (`server/lib/create-keys.js`). Deleting a food and then saving the same online result again brings the deleted food back. Skip soft-deleted rows, so the save creates a fresh food. Check every caller.
3. **`POST /api/meals/:id/used` is not owner-scoped.** Any user can bump `usage_count` and `updated_at` on another user's non-private meal, and a 403 vs 200 tells them whether a meal is private. Scope it to the owner, and answer 404 for any meal the caller doesn't own, so nothing leaks.
4. **Free-text settings.** Meal names and labels (`mealNames`, category and custom unit and nutrient labels) accept control characters (NUL etc.). Strip or refuse C0 control characters on write, in the settings route. Keep normal Unicode, emoji included.

## Rules
- File changes only with your editor tools, never sed/awk/python/heredocs.
- If you can, run the full test suite and build on Node 20 and report real exit codes. If you can't run them, say so in the PR body.
- Keep every well-formed request working; list any behaviour change in the PR body.
- Changesets, if the repo uses them, are `patch` only. No version bumps.
- Commit trailer `Co-Authored-By: Claude <noreply@anthropic.com>`. Stage specific paths.
