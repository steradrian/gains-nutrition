# Gains Nutrition

The nutrition backend and web app inside [Gains](https://github.com/steradrian/gains), a PWA fitness app. It is a modified fork of NutriTrace (see [Credits](#credits)): a Node/Express server with a SQLite database, plus a Svelte PWA served by the same container.

In production it runs behind fitness-hub (`steradrian/gains-hub`), which signs users in and sends hub tokens to this server (see `HUB_JWKS` in [DEPLOY.md](DEPLOY.md)). It can also run on its own with local accounts.

![Diary view: a full day of food logging with macro bar, per-meal breakdowns, and water tracking](docs/screenshots/01-diary.png)

## What it does

- Diary and meal logging with configurable meal slots, foods, meals and recipes.
- Goals, including adaptive TDEE.
- Open Food Facts lookups, optionally against a local Parquet mirror.
- Wellness integrations (Fitbit, Withings, Garmin, Health Connect), activity and intermittent fasting.
- AI assistant with a provider you configure, and an optional MCP endpoint.
- Federation API (`/api/v1/*`) with scoped Bearer tokens, plus an optional public REST API and outgoing webhooks. Contracts are in [docs/](docs/).
- Multi-user with OIDC SSO, or hub sign-in.
- Offline mode in the browser: diary, own foods, settings and goals are kept on the device and sync when the connection returns.

## Run locally

Requires Node 20 and npm 10.

```bash
npm ci
npm ci --prefix server
npm run dev              # Vite dev server for the frontend
npm start --prefix server   # API server on http://localhost:3001 (override with PORT)
```

The Docker image builds the frontend and copies `dist/` into the server's `dist/`; the server serves the app from there. `DB_PATH` and `UPLOADS_PATH` default to paths in the working directory.

To run the published image instead, see [DEPLOY.md](DEPLOY.md), which also documents the environment variables.

## Tests

```bash
npm test            # node --test scripts/*.test.js
npm run i18n:check
```

## Docs

- [DEPLOY.md](DEPLOY.md): image, compose, environment variables, reverse proxy, local OFF mirror
- [ARCHITECTURE.md](ARCHITECTURE.md): how the app is put together
- [PRIVACY.md](PRIVACY.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CHANGELOG.md](CHANGELOG.md): history, including the upstream releases

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Svelte 5 (compat mode), svelte-spa-router, Vite 6, PWA (service worker) |
| Mobile shell | Capacitor 8 (Android) |
| Backend | Node.js, Express 5, better-sqlite3, optional DuckDB for the local OFF mirror |
| Auth | JWT (httpOnly cookie), bcryptjs, OpenID Connect (PKCE), hub tokens |

## License

[AGPL-3.0](LICENSE). Third-party licenses are listed in [LICENSES.md](LICENSES.md).

## Credits

Based on [NutriTrace](https://github.com/TraceApps/nutritrace) by TraceApps (AGPL-3.0), modified.

NutriTrace itself was inspired by [Waistline](https://github.com/davidhealey/waistline) by David Healey and [SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness) by CodeWithCJ.
