# Testing

## Layers

| Layer | Where | Runs against | Command |
|---|---|---|---|
| API unit + integration | `apps/api/test` | real PostgreSQL (`subcycle_test`), Supertest | `npm test -w @subcycle/api` |
| Web unit/component | `apps/web/test` | jsdom + a fake API (axe-core scans included) | `npm test -w @subcycle/web` |
| Web ↔ real API smoke | `apps/web/test/smoke.test.tsx` | jsdom UI + the real API process + `subcycle_test` | part of the web tests |
| **Browser (Playwright)** | `e2e/` | Chromium + the **built** web app + the **built** API + PostgreSQL (`subcycle_e2e`) | `npm run test:e2e` |
| Backup/restore | `scripts/verify-backup-restore.mjs` | throwaway databases created and dropped by the script | `node scripts/verify-backup-restore.mjs` |

`npm test` at the root runs the first three. The browser suite is separate because it needs a Chromium download and takes about a minute.

## Safety rules (enforced in code, not just convention)

- **Destructive tests refuse to run against any other database.**
  - API tests drop and recreate the `public` schema of `TEST_DATABASE_URL`: the database name must end in `_test` (`apps/api/test/dbUrl.ts`, unit-tested). The web smoke test applies the same check.
  - The browser suite deletes the users it created: the database name must end in `_e2e` (checked in `playwright.config.ts`, the global setup/teardown, the API launcher and every query helper in `e2e/support/env.ts`).
  - The backup script only ever touches databases named `restore_check_{src,dst}_<random>` that it creates itself.
- **Browser-test users are identifiable and cleaned up even when a test fails:** emails are `e2e-<random>@example.com` (reserved domain, never deliverable); each test's fixture deletes its own users in a `finally`; global setup and teardown delete any leftovers by that pattern. Nothing else is ever deleted.
- **No secrets in output:** passwords in tests are throwaway constants; traces/screenshots are kept only on failure and are git-ignored; the API runs with `LOG_LEVEL=silent`.
- **SMTP:** the browser suite starts the API with no SMTP configured, so email is genuinely unavailable and the UI/API must say so. Delivery behaviour (success, failure, retry, skip reasons) is tested with the in-process fake mailer in the API tests. **No test sends mail through a real provider, and real-SMTP delivery is not verified.**

## Browser suite

Flows covered (`e2e/tests`):

- **auth** — register via UI, verification state (unavailable without SMTP), sign out, wrong password vs unknown account give the identical message, duplicate email, revoked and expired sessions (plain notice, no server details), return-to-page after sign-in, cookie flags (httpOnly, SameSite=Lax), no web storage.
- **subscriptions / payments** — create, edit with price history, delete with confirmation; form validation; status transitions (pause/resume/cancel) and an invalid transition refused by the API; record payment, duplicate billing period refused, same-amount different-period accepted, delete payment (billing date unchanged), foreign-currency payment; upcoming renewals; cross-user isolation.
- **insights** — recorded vs estimate vs projection labelled and separate; INR and USD never combined (dashboard and analytics); refunds/failed payments; calendar keyboard navigation (arrows, Home/End, Page Up/Down, single tab stop, never into the past); weekly occurrences, trials and paused plans; reminder preferences; and the **real scheduler**: a stale billing date rolls forward with **no payment created**, in-app reminders are delivered and can be dismissed, email reminders are honestly skipped ("no email provider configured").
- **settings** — theme (dark, light, system), currency and time zone persist across reload and apply on every route; changing them rewrites nothing; password change (wrong current password, other device signed out, old password rejected); account deletion with wrong and correct confirmation, and **no further API request after the DELETE**.
- **responsive** — every page, dark and light, at 320 / 390 / 820 / 1280 px: no horizontal overflow, nothing escaping the viewport, targets ≥ 24 px, bottom bar vs sidebar, bottom bar not covering content, axe-core (WCAG 2.0/2.1/2.2 A/AA + best practice, **including colour contrast measured in a real browser**); sign-in/registration pages; skip link; focus moved after navigation; account menu Escape/focus restore; dialogs (fit the viewport, trap focus in both directions, Escape and Cancel, focus restoration, axe in both themes); charts' text alternative and table view.
- Every test also fails if the page violates the **Content-Security-Policy** (the production build is served under the recommended CSP, see RELEASE.md) or throws an uncaught error.

The scheduler test waits for a real 30-second scheduler cycle (`SCHEDULER_INTERVAL_SECONDS=30`, the minimum) using `expect.poll`; there are no fixed sleeps.

### Environment variables (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `E2E_DATABASE_URL` | `postgres://subcycle:subcycle@localhost:5434/subcycle_e2e` | database for the browser suite; **name must end `_e2e`**; the API launcher creates it and applies the migrations if missing |
| `E2E_API_PORT` / `E2E_WEB_PORT` | `3101` / `4273` | ports for the API and the web preview server |
| `CI` | unset | when set: 2 workers, 1 retry, HTML report in `e2e/playwright-report` |
| `TEST_DATABASE_URL` | `postgres://subcycle:subcycle@localhost:5434/subcycle_test` | API/web test database; **name must end `_test`** |

**Parallel runs are isolated.** Each run has an id (`E2E_RUN_ID`, generated once by the runner and inherited by workers); its users are `e2e-<runid>-…@example.com`, it deletes only those, and its traces and reports go under `test-results/<runid>` and `playwright-report/<runid>`. Only users over an hour old (left by a crashed run) are ever removed by anyone else. Two runs may therefore share one database if they use different ports (`E2E_API_PORT`, `E2E_WEB_PORT`); this was verified by running two full suites at once (47/47 each). Prefer separate databases (`E2E_DATABASE_URL`) when running many in parallel, because every API instance runs the scheduler over every user in its database. The default of 3 workers (2 in CI) is stable; 5+ workers on a small machine can starve the first requests.

The PostgreSQL server (user/password in the URLs above) must already be running: `npm run db:up` locally, a service container in CI.

### Running a single test / debugging

```bash
npm run build                                  # the suite tests the built API and web bundle
npx playwright test -c e2e/playwright.config.ts settings          # one file
npx playwright test -c e2e/playwright.config.ts -g "keyboard"     # by title
npx playwright show-trace e2e/test-results/<test>/trace.zip        # after a failure
```

## CI

`.github/workflows/ci.yml` has three jobs on every push to `main` and every pull request: **static** (`npm ci`, typecheck, lint, build, `npm audit`), **test** (PostgreSQL service, migrations applied twice to prove idempotence, `npm test`) and **e2e** (PostgreSQL service, Chromium with system dependencies, build, Playwright; the report and traces are uploaded on failure). Node is read from `.nvmrc` (24.15.0). The workflow has not been executed on GitHub from this environment; the same commands were run locally.

## Known test limitations

- **Windows + Node 24.15.0 + vitest `forks`:** on one Windows machine the default process pool intermittently lost a worker at start-up (exit code `0xC0000409`, "Worker exited unexpectedly … during started state") in roughly 5 of 7 full API runs; Node 24.13 never did and the `threads` pool never did (0 of 8 runs on each Node version), so `apps/api/vitest.config.ts` uses `pool: 'threads'`. The root cause (Node/Windows child-process start-up, the portable Node binary used for the test, or antivirus interference) was not established. An unexplained 191-test web failure seen once in Stage 9 could not be reproduced in 20+ later runs and may be the same class of problem; if a run ever shows `Worker exited unexpectedly`, rerun and report it.

- Only Chromium is tested (no Firefox/WebKit).
- Screen readers are not driven; accessibility is verified with axe-core (automated rules) plus keyboard/focus assertions. Automated rules find roughly a third of accessibility problems: a manual screen-reader pass has not been done.
- Time-dependent behaviour in the browser suite uses the real clock in a UTC browser context; a test run exactly at UTC midnight could see "today" change mid-test.
- The browser suite uses a single API instance; multi-instance behaviour is covered only by the in-process concurrency tests in `apps/api/test`.
