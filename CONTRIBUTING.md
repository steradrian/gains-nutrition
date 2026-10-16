# Contributing

This repository is the nutrition backend and web app used by Gains. It is based on NutriTrace by TraceApps (see the README credits) and is maintained here independently.

- Open pull requests against `main` of [steradrian/gains-nutrition](https://github.com/steradrian/gains-nutrition), from a branch named `<type>/<kebab-slug>`.
- Keep changes focused, one concern per PR.
- Do not paste server logs publicly without redacting them: debug output and trace request bodies can contain private health data.

## Setup

Node 20 and npm 10.

```bash
npm ci
npm ci --prefix server
npm test
npm run i18n:check
```

`npm test` runs `node --test scripts/*.test.js`. CI runs the same checks.

## Code

- Frontend: Svelte, no TypeScript. Server: Node ES modules.
- Server changes: parameterize all SQL, and give every new route the right `requireAuth` / `requireAdmin` middleware.
- User-facing strings live in `src/i18n/en.json`, the source of truth for the other locale files in `src/i18n/`. Run `npm run i18n:check` after adding keys.
- Add a `CHANGELOG.md` entry under the unreleased section for user-visible changes.

## License

By contributing you agree that your contribution is licensed under [AGPL-3.0](LICENSE), the same license as the rest of the code.
