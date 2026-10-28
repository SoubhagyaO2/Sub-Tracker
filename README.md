# SubCycle

A personal subscription tracker. You enter what you subscribe to; SubCycle shows what it costs, when it renews, what you recorded paying, and reminds you before renewals.

**What it is not.** SubCycle holds only data you type in. It does not connect to banks, cards or providers, it cannot see what you were actually charged, and it cannot cancel anything for you: "cancelled" is your own record. Amounts in different currencies are never added together and nothing is converted.

React + TypeScript (Vite, Tailwind) · Express + TypeScript · PostgreSQL · shared Zod schemas. npm workspaces: `packages/shared`, `apps/api`, `apps/web`, `e2e`.

## Fresh local setup

Requirements: **Node 24.15 or newer** (see `.nvmrc`; the web test environment, jsdom, requires `^22.22.2 || ^24.15.0 || >=26`), npm 10+, Docker (for PostgreSQL).

```bash
git clone <repo> subcycle && cd subcycle
nvm use                      # or any Node satisfying the range above
npm ci
cp .env.example .env         # development defaults; edit nothing for a local run
npm run db:up                # PostgreSQL 16 in Docker on 127.0.0.1:5434; creates `subcycle` and `subcycle_test` (the second only on a brand-new volume; on an existing one run `npm run db:reset`, which DELETES the local development data)
npm run migrate              # applies apps/api/migrations to the development database
npm run dev:api              # API on http://localhost:3001  (terminal 1)
npm run dev:web              # web app on http://localhost:5173 (terminal 2)
```

Open http://localhost:5173 and register. No email provider is configured by default, so email verification and email reminders are reported as unavailable (never as "sent").

## Checks

```bash
npm run typecheck && npm run lint && npm run build
npm test                     # API + web unit/integration tests against the disposable `subcycle_test` database
npm audit
```

Browser tests (Playwright, real built API + real PostgreSQL, Chromium):

```bash
npx playwright install chromium     # once
npm run test:e2e                    # builds, starts the API and web servers itself, creates the `subcycle_e2e` database
```

See [docs/TESTING.md](docs/TESTING.md) for environment variables, safety rules and CI, and [docs/RELEASE.md](docs/RELEASE.md) for production readiness. `node scripts/verify-backup-restore.mjs` proves a dump/restore round trip on throwaway databases.

## Third-party artwork

Brand logos shown for well-known services come from [Simple Icons](https://simpleicons.org) and [SVG Logos](https://github.com/gilbarbara/logos) (both CC0-1.0, dev dependencies, bundled at build time; nothing is loaded from the network). They are trademarks of their respective owners and appear only to identify the service a user tracks; SubCycle is not affiliated with or endorsed by any of them. See [docs/FRONTEND.md](docs/FRONTEND.md#brand-logos).

## Documentation

[SPEC](docs/SPEC.md) · [API](docs/API.md) · [DATA_MODEL](docs/DATA_MODEL.md) · [FRONTEND](docs/FRONTEND.md) · [DESIGN_SYSTEM](docs/DESIGN_SYSTEM.md) · [SECURITY](docs/SECURITY.md) · [OPERATIONS](docs/OPERATIONS.md) · [RELEASE](docs/RELEASE.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [TESTING](docs/TESTING.md)
