# Cloud handoff 1: NutriTrace security hardening

Repo: `steradrian/gains-nutrition` (fork of TraceApps/nutritrace, Node/Express + Svelte, SQLite). Branch: `fix/security-hardening` off `main`. One PR into `main`. Stop when the PR is open and CI is green; the owner's main session reviews and merges.

## Context
This fork is the nutrition backend of "Gains", a private, invite-only fitness PWA for the owner and friends. In production NutriTrace is NOT exposed directly: a gateway ("hub") checks the user's session and forwards allow-listed requests with a short-lived ES256 "hub token" (JWS, `aud=nutritrace`, `scope=user|sync`, `jti`, 60 s). Code for that is in `server/` (look for hub token verification, `hubInstance()`, `hubMode()`, the replay cache). NutriTrace's port is not published; `TRUST_PROXY` is set for the gateway.

## Tasks (each with a behaviour test)
1. `TRUST_PROXY` hop-count form lets a direct client choose its own `req.ip` if the port is ever published. Prefer the address-list form, and log a startup warning when a hop count is configured.
2. Sign-in throttle maps have no size cap, and IPv6 clients can rotate within a /64. Cap the maps (evict oldest) and key IPv6 by /64.
3. `middleware/auth.js` (~35, ~94): `ownerOrOptIn` and `requireAdmin` read the role from the token. Read it from the database on each request.
4. The widened SSRF `refused` error tells non-admins which internal hostnames resolve to private addresses. Return a generic message to non-admins and keep the detail in the server log.
5. `webhooks.js` (~178) checks the address and then fetches separately, which allows DNS rebinding. Pin the resolved address for the fetch (custom lookup/agent). It's admin-only and off by default, but fix it.
6. The SSRF check misses IPv6 ranges: `::7f00:1` (IPv4-compatible), `64:ff9b:1::/48`, `2002::/16` (6to4, check the embedded IPv4), `fec0::/10`. Block or unwrap them.
7. Hub-token signature canonicality: reject a token whose signature segment does not re-encode identically (`sig.toString('base64url') !== parts[2]`).
8. Audit trail for hub requests: log `jti`, a hash of `sub` and `act` at debug level. Never log the raw token.
9. Add a test that fails if any new caller uses `hubMode()` where `hubInstance()` is required. Read both to understand the difference first.
10. Pin the base images in `Dockerfile` (exact `node:20-slim` version tag; a digest is fine too).

## Rules
- Make file changes only with your editor tools, never sed/awk/python/heredocs.
- Run the full test suite, lint and build; report their real exit codes. Do not pipe a command through grep in a way that hides its exit code.
- Keep upstream behaviour for normal (non-hub, non-attack) requests. Any API behaviour change goes in the PR body.
- Changesets, if the repo uses them, are `patch` only. Do not bump versions.
- Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`. Stage specific paths.
- Do not touch deploy secrets. English only for any new strings.
- PR body: list each task with its file, its test, and anything you could not verify.
