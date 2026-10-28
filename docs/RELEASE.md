# Release readiness and deployment notes

Nothing here has been deployed. No hosting, domain, database service or email provider has been chosen or paid for; this page is what an operator needs to know before doing so. Statements marked **verified** were exercised in this repository; **not verified** means nothing here has tested it.

## What SubCycle is (say this to users)

SubCycle records what *you* type: subscriptions, prices, billing dates and payments you chose to record. It does **not** connect to banks, cards or providers; it cannot see charges, cannot confirm that a payment happened, and **cannot cancel anything**: "cancelled" is the user's own record. A passed renewal date is never treated as a payment. Amounts in different currencies are never added together and nothing is converted.

## Architecture to deploy

```
browser ──https──▶ reverse proxy ──┬─▶ static files: apps/web/dist   (the SPA)
                                   └─▶ /api/*  ──▶ one Node process: apps/api/dist/server.js ──▶ PostgreSQL 16
```

- The web app and the API **must share one origin** (same scheme, host and port). Session cookies are `SameSite=Lax`, `__Host-` prefixed and `Secure` in production; CSRF protection relies on same-origin requests carrying `X-SubCycle-Client: web` and an allowed `Origin`. The API does **not** serve the SPA: the proxy (nginx, Caddy, a CDN, …) must.
- The API is a single process. It runs the background scheduler in-process (see "Scheduler" and OPERATIONS.md).

## Environment variables

Read only in `apps/api/src/config.ts`; invalid or unsafe values stop the process at start-up with a message that never contains secrets.

| Variable | Required in production | Notes |
|---|---|---|
| `NODE_ENV` | yes: `production` | switches on the checks below, the `__Host-sc_sid` cookie name and `Secure` cookies |
| `DATABASE_URL` | yes | needs a **password**; the documented dev credentials `subcycle:subcycle` are **rejected**; add `?sslmode=require` (or `verify-full`) unless the database is only reachable over a private network (start-up warns otherwise) |
| `APP_URL` | yes | public `https://` URL of the app (used in email links); `localhost` rejected |
| `CORS_ORIGINS` | yes | comma-separated explicit `https://` origins (normally just `APP_URL`); wildcards, paths and `localhost` rejected |
| `TRUST_PROXY` | yes behind a proxy | hop count (usually `1`). With `false` every client appears to have the proxy's IP, so **rate limits apply to all users together** (start-up warns) |
| `PORT` | no (3001) | |
| `LOG_LEVEL` | no (`info`) | `debug`/`trace` warn in production |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` (+ `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_REQUIRE_TLS`) | optional | all three of host/port/from or none; partial configuration is an error. Without them email is disabled and the app says so. `SMTP_SECURE=true` = implicit TLS (usually port 465); otherwise STARTTLS is **required** (`SMTP_REQUIRE_TLS`, default `true`; `false` is refused in production) so credentials and mail never travel in cleartext |
| `SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_SECONDS` | no (`true`, 300) | 30-3600 s |

**Secrets.** There is no application signing key: sessions are random tokens stored hashed in PostgreSQL. The only secrets are the database password and (optionally) SMTP credentials. Generate the database password with `openssl rand -base64 32`, create a dedicated role, keep the values in your platform's secret store, never in git (`.env*` is git-ignored except `.env.example`). Rotate by changing the role's password and restarting; no data depends on the old one.

**Verified:** production start-up rejects dev credentials, passwordless URLs, http/localhost origins, wildcard CORS, partial SMTP, bad `TRUST_PROXY` (`apps/api/test/production-hardening.test.ts`).

## PostgreSQL

- PostgreSQL 16 was used for all testing. Use a dedicated database and role. The role needs `CONNECT`, and the ability to create tables and triggers *for the migration step*; a stricter setup runs migrations as one role and the app as another with DML-only rights (not tested here).
- Pool: up to 10 connections per API process; 10 s connection timeout, 30 s `statement_timeout`; idle connection errors are logged, not fatal. The scheduler's advisory lock needs a **session-level** connection: do **not** put PgBouncer in *transaction* pooling mode in front of the API (session pooling or direct connections are fine).
- TLS: set `sslmode` in `DATABASE_URL`. node-postgres treats `require` like `verify-full` today (this changes in a future major version): prefer `sslmode=verify-full` and, if the provider gives you a CA certificate, `sslrootcert=/path/ca.pem` in the URL (a parameter node-postgres' connection-string parser understands). **Not verified** against a real TLS-enforcing server.

## Migrations

From a full checkout `npm run migrate` works (it uses `tsx` and loads an optional `.env`). In a production tree (after `npm prune --omit=dev`, where `tsx` is absent) run the compiled command `node apps/api/dist/db/migrate-cli.js`, which does **not** read a `.env` file, so the variables must already be in the environment. Either way it applies `apps/api/migrations/*.sql` in order, one transaction per file, records name + checksum in `schema_migrations`, refuses to continue if an applied file was edited. Running it twice is a no-op (**verified**, also in CI).

Procedure: take a backup → deploy the new build → run migrations → start/restart the API. Both migrations so far are additive.
**Rollback limits:** there are no down-migrations. Rolling back means restoring the pre-migration backup (losing data written since) or shipping a new forward migration. Because migrations are applied before the new code serves traffic, keep each migration backward-compatible with the previous release (expand → backfill → contract) so a code rollback is possible without a restore.

## Health, shutdown, restarts

- `GET /api/health`: liveness (no database access). `GET /api/health/ready`: runs `SELECT 1`; `503` with a fixed body when the database is unreachable. **Verified.**
- `SIGTERM`/`SIGINT`: stop accepting connections, close idle ones, let in-flight requests and a running scheduler cycle finish, close the pool, exit 0; a 15 s watchdog forces exit. (Verified on Linux in a Node 24.15.0 container: `SIGTERM` and `SIGINT` each log `shutting_down` and `scheduler_stopped` and exit 0. Not verified: a slow in-flight request during shutdown, the forced-exit watchdog, or the fatal-error exit path. Windows cannot deliver `SIGTERM` gracefully; production is expected to be Linux.) `uncaughtException`/`unhandledRejection` log the error *class* only and exit 1 so a supervisor restarts the process. Run it under something that restarts it (systemd, Docker restart policy, a platform supervisor).

## Scheduler and instances

Details and the exact guarantees are in [OPERATIONS.md](OPERATIONS.md). Summary:
- One API process is the supported topology. A Postgres advisory lock keeps scheduler cycles from overlapping even if more instances run (verified in-process; **not verified across real separate processes**).
- **Rate limits (login, registration, password confirmation, general API) are in-memory per process**: more instances multiply the limits and a restart resets them. A shared store is required before scaling out.
- Reminders are only delivered while the API runs. After downtime the first cycle catches up and records missed windows honestly.

## Email, verification and account recovery

- Email is optional. **Not verified with any real SMTP provider**: the fake-mailer tests cover classification, retry/backoff, skip reasons and logging; real TLS/auth, provider error codes, bounces and rendering in mail clients are untested. Before relying on email, configure SMTP, verify an address and send one reminder end to end.
- Email reminders are sent only when SMTP is configured **and** the recipient verified their address. Otherwise they are recorded as skipped with the reason, never as sent. "Sent" means the SMTP server accepted the message. A crash between acceptance and the database update can send one reminder twice (documented at-least-once window).
- **There is no password reset and no email change in v1.** A user who loses their password and has no session cannot recover the account without operator intervention in the database. This was an agreed scope limit; decide before launch whether it is acceptable.
- Registration reveals whether an email is taken (`409`); mitigated by rate limits only.

## Account deletion and backups

Deletion removes the user and every dependent row in one transaction (**verified**: all dependent tables checked, rollback on failure, other users untouched). It does **not** touch backups, replicas, WAL archives or logs. Data deleted from the live database remains in any earlier backup until that backup expires, and **restoring a backup brings deleted accounts back**: after a restore, re-apply known deletions. Set and publish a retention period for backups; SubCycle ships no backup tooling and states none.

## Backup and restore

Use `pg_dump -Fc` on a schedule (and WAL archiving/PITR if you need less than a day of loss), store copies off the database host, encrypt them (they contain password hashes, email addresses and financial notes), and test restores.

`node scripts/verify-backup-restore.mjs` performs a full round trip against **throwaway databases it creates and drops itself** (it refuses any other name): it applies the migrations, inserts representative data, `pg_dump`s, `pg_restore`s into a second new database, and compares row counts and content checksums for every table, then confirms constraints, triggers, indexes and cascades survived. **Verified locally** with the Docker PostgreSQL 16 container (all checks pass; the development database was never read or written). It needs `docker exec` access to a PostgreSQL container (`BACKUP_CHECK_CONTAINER`, default `subtrack-postgres`).

## Web hosting headers

Serve `apps/web/dist` with at least:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=63072000; includeSubDomains   (only once https works everywhere)
```

This exact CSP is what the browser suite runs under (`apps/web/vite.config.ts` → `vite preview`); any violation fails a test. **Verified** for the built app. `index.html` and any `/assets/*` fallback must be served with SPA routing (unknown paths → `index.html`) and long-cache for hashed assets only. The API sets its own security headers (helmet, HSTS in production).

## Error responses and logging policy

- A 5xx response to a client is always `{ "error": { "code": "INTERNAL_ERROR" | …, "message": <fixed text>, "requestId": "<uuid>" } }`. The same id is in the `X-Request-Id` header and on every log line of that request. Nothing about the cause is ever returned, in any environment. 4xx responses keep their documented codes and carry no request id.
- Logs never contain an error's `message`, `detail`, `hint`, `where`, parameters or provider reply. All `err` / `error` values are reduced by `describeError` (`apps/api/src/errorLog.ts`) to: error class, a machine code (PostgreSQL SQLSTATE, Node error code, SMTP response code), schema identifier names (table / column / constraint) and the first stack frames without the message line. This is enforced in the logger itself (including the HTTP logger, whose default serializer would otherwise print everything), so a new `log.error({ err })` call elsewhere is sanitised too.
- Verified by `apps/api/test/error-handling.test.ts`: a unique-violation-shaped error full of sensitive-looking values, a real PostgreSQL `RAISE EXCEPTION` with message/DETAIL/HINT, a failing login, and a failing SMTP send (whose provider text and recipient previously reached the log; found and fixed in Stage 10) are all checked in both the HTTP response and the captured production log.
- To debug a 5xx: take the `requestId` from the user, find the `request_failed` event with that id, read `errorCode` / `table` / `constraint` / `frames`. The raw database message is available only in the database's own server log (`log_min_error_statement`), which is under the operator's control, not the application's.
- Reverse-proxy access logs: the verification link is `/verify-email?token=…` (a single-use token, valid 24 h). Configure the proxy not to log query strings for that path, or accept that unexpired tokens appear in proxy logs. The API itself logs only the path.

## Verifying a real SMTP provider (manual, not yet done)

Nothing in this repository has sent a message through a real provider. Do this once, on a non-production database or with a throwaway account, before turning email on for users:

1. Create a sending identity at the provider (SPF/DKIM set up for the sending domain) and an SMTP credential.
2. Set `SMTP_HOST`, `SMTP_PORT` (587 + STARTTLS, or 465 with `SMTP_SECURE=true`), `SMTP_FROM`, `SMTP_USER`, `SMTP_PASS`; leave `SMTP_REQUIRE_TLS` at its default. Restart the API; the start-up log must say email is enabled.
3. Register a test account with an address you control. Settings → Account shows "Not verified"; Reminders → "Send verification email". Confirm: the email arrives (check spam), the link opens `APP_URL/verify-email?token=…`, the page says verified, the account shows Verified. Reusing the link must say it is invalid.
4. Negative checks: request a second email inside a minute (expect the cooldown message); set a wrong `SMTP_PASS`, restart, request again (expect "We couldn't send the verification email" and a 502 with a `requestId`; the log shows an SMTP code and **no** recipient or provider text).
5. Turn on email reminders, add a subscription renewing in 1–2 days, wait for the next scheduler cycle (≤ `SCHEDULER_INTERVAL_SECONDS`). Confirm: one email arrives, the delivery log shows "Sent" with "Accepted by the email server", no duplicate arrives after 15 minutes.
6. Record the provider, date and result somewhere durable. Only then may email reminders be described as verified.

## What `verify-backup-restore.mjs` is, and what it is not

It is a **rehearsal** that proves this schema survives `pg_dump` → `pg_restore` (data, constraints, triggers, indexes, cascades) on throwaway databases, and that the dump/restore commands work in your environment. It is **not** a backup system: it creates no schedule, stores nothing, runs against no real data, and its output is deleted when it finishes. A recurring production backup needs, at minimum: a scheduler (cron, the platform's managed backups, or WAL archiving for point-in-time recovery), off-host encrypted storage, a retention period, monitoring that alerts when a backup does not happen, and a periodic *restore drill* into a scratch database. None of that exists here; it needs your decision (and, if managed, an approved paid service).

Safety of the script: it may only create, fill, dump, restore into and drop databases named exactly `restore_check_(src|dst)_<8 hex>` (checked by `scripts/backup-guard.mjs` before every statement, unit-tested against `subcycle`, `postgres`, `*_test`, `*_e2e`, injection attempts and path tricks). It talks to PostgreSQL only through `docker exec` into the container you name, so point `BACKUP_CHECK_CONTAINER` at the disposable development container, never at a production one.

## Findings from this review (and what was done)

Fixed in Stage 9:
- Destructive test setup could be pointed at any database via `TEST_DATABASE_URL`: it now refuses names not ending `_test`.
- Production accepted `http://` CORS origins, localhost URLs and the dev database credentials: now rejected; risky-but-legal settings log a start-up warning.
- An idle PostgreSQL connection error would have crashed the process (no pool error handler); added, plus connection/statement timeouts.
- No readiness endpoint; no forced-exit watchdog or fatal-error handling at shutdown; added.
- Links relied on colour alone and the "Mark as read" button's accessible name did not contain its visible text (found by the browser suite in light theme): fixed.
- Calendar keyboard navigation did not move focus (found in Stage 7) and is now covered in a real browser.

Fixed in Stage 10: raw error text (database messages that quote row values, SMTP replies that quote recipients) reached the logs; 5xx responses now carry a request id and logs a sanitised diagnosis only; SMTP STARTTLS was opportunistic and is now required; the readiness route could be used to exhaust the connection pool and is rate limited; shutdown waited for HTTP to drain before stopping the scheduler (now in parallel); the 30 s statement timeout would have applied to migrations (now exempt); concurrent browser-test runs deleted each other's users and artifacts (now namespaced).

Left as-is and documented: per-process rate limits; no password reset; no email change; no automated multi-process test; no Firefox/WebKit tests; no manual screen-reader pass.

The step-by-step provisioning, validation and backup specification for a private deployment is in [DEPLOYMENT.md](DEPLOYMENT.md).

## Pre-release checklist

1. `npm ci` → `npm run typecheck && npm run lint && npm run build && npm test && npm audit` all green on the release commit; `npm run test:e2e` green; CI green.
2. Production env set per the table; start-up logs show no `config_warning` you do not accept.
3. Fresh database: `npm run migrate`; existing database: backup first, then migrate.
4. Reverse proxy serves the SPA and `/api` on one https origin with the headers above; `TRUST_PROXY` matches the hop count.
5. `GET /api/health/ready` returns 200 from the load balancer; a supervisor restarts the process.
6. Backups scheduled, retention decided and published, one restore rehearsed.
7. Decision recorded on password reset / account recovery and on single-instance operation.
8. If email is wanted: SMTP configured and one real reminder email verified by a human.
