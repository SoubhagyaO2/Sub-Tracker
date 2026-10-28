# SubCycle — Product & Technical Specification

> **All your subscriptions. One clear picture.**

SubCycle is a **personal** subscription tracker. Users manually record subscriptions *they pay for elsewhere* (Netflix, Spotify, iCloud, an AI tool…). It is **not** a billing platform: no payment processing, no plans/quotas for customers, no merchant lifecycle. SubCycle cannot cancel, pause, or change anything at an external service; it only records what the user tells it.

Status: Stage 2 (design). Companion docs: [DATA_MODEL.md](DATA_MODEL.md), [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

---

## 1. Principles

1. **Honesty over polish.** Never invent payments, usage, or prices. Estimates and projections are labelled as such. "Recorded" ≠ "estimated".
2. **Privacy by default.** No card numbers, no third-party passwords, no scraping, no third-party trackers. Every query is scoped to the session user.
3. **Correctness of money and dates.** Integer minor units; calendar-date arithmetic anchored to the original billing date; injected clock for tests.
4. **No false claims.** Email is "sent" only if an SMTP provider is configured and accepted the message. "Cancelled" means *the user recorded* a cancellation.

## 2. Scope

### In scope (v1)
Auth · dashboard · subscription CRUD · payments & price history · library with search/filter/sort · renewal calendar · in-app + optional email reminders · analytics · CSV export · settings · profile edit · account deletion.

### Out of scope (v1) — explicitly
Bank/transaction import · automatic payment detection · real payments · acting on external services · FX conversion (see §4.4) · password reset by email · social login · multi-user/family sharing · mobile native apps · AI features · uploaded logo images.

> **Known limitation — no password reset in v1.** It needs a working email provider, which is optional. Documented in README; a user who forgets their password must create a new account. Revisit in v1.1.

## 3. Personas & core questions

A single persona: *an individual with 5–40 recurring charges.* The product must answer:

| Question | Where answered |
|---|---|
| What do I spend monthly / yearly? | Dashboard KPIs, Analytics |
| What renews soon? | Dashboard list, Calendar |
| What am I paying for? | Subscriptions library |
| What do I barely use? | Only if the user set a usage level (§4.9) |
| What could I save? | Analytics "what-if cancel" |
| When did I last pay? | Subscription detail → Payments |

## 4. Domain rules

### 4.1 Money
- Stored as **integer minor units** (`amount_minor`) + ISO-4217 `currency` (3 uppercase letters). Never floats in DB, API, or logic.
- Minor-unit exponent comes from a static currency table (INR 2, USD 2, EUR 2, GBP 2, JPY 0, …). Unsupported codes are rejected. The API accepts and returns **minor units**; formatting happens only in the UI via `Intl.NumberFormat`.
- Default currency: **INR**. Each user has a preferred display currency.
- Amount constraint: `0 < amount_minor ≤ 10^12`. (Free tiers are not subscriptions; a 0-cost trial is expressed via `status = trial`.)

### 4.2 Billing frequency and recurrence
Frequencies: `weekly`, `monthly`, `quarterly`, `yearly`.

Each subscription stores an explicit **`anchor_date`** (the original billing date, a calendar date) plus `billing_frequency`, and a derived-but-stored **`next_billing_date`**.

Occurrence *n* (n ≥ 0) is computed **from the anchor, never from the previous result**:

| Frequency | Occurrence *n* |
|---|---|
| weekly | `anchor + 7n days` |
| monthly | `addMonths(anchor, n)` |
| quarterly | `addMonths(anchor, 3n)` |
| yearly | `addMonths(anchor, 12n)` |

`addMonths(d, k)`: target year/month = d's month + k; day = `min(anchor.day, daysInMonth(target))`.

Consequences (all covered by unit tests):
- Anchor Jan 31 monthly → Jan 31, Feb 28 (29 leap), Mar 31, Apr 30, May 31 … (**no drift** to the 28th).
- Anchor Feb 29 yearly → Feb 28 in common years, Feb 29 in leap years.
- Anchor Aug 30 quarterly → Aug 30, Nov 30, Feb 28/29, May 30.

`next_billing_date` = the first occurrence ≥ today (user's local date). Rules:
- It is **stored** (explicit, per requirements). **Reads never write.** A stale stored date is handled in two separate ways:
  1. *On read, computed:* every subscription response carries `effectiveNextBillingDate`: for `active`, the stored date rolled forward along the anchor's schedule to the first occurrence on/after today; for `trial`, the stored date (a trial is never auto-converted, so an ended trial keeps its past date); `null` for paused/cancelled/archived. Nothing is written.
  2. *Persisted, by a background job* (`rollForwardStale`, a task of the Stage 7 scheduler: at start-up and every `SCHEDULER_INTERVAL_SECONDS`, default 300): `active` subscriptions whose stored date is before the owner's "today" (their own time zone) are moved to the first occurrence on/after today. It never moves a date backwards, never changes the anchor, updates a row only if it still holds the value that was read (a concurrent user edit wins), and **never creates payment records**. Trials, paused, cancelled and archived rows are not touched.
  Until the job runs, list filters/sorts that use the stored column (`renewsWithinDays`, `sort=nextRenewal`) see the stale value for at most the job interval; the per-row `effectiveNextBillingDate` is always exact.
- If the user manually edits `next_billing_date`, the new date becomes the new `anchor_date` (the user is telling us the true schedule).
- Dates are calendar dates (`date`), with **no time zone**. Time zones matter only for (a) deciding "today" and (b) scheduling reminder instants (§4.7).

### 4.3 Normalization (monthly equivalent)
Monthly equivalent = `amount × k` with exact rational factors:

| Frequency | Factor |
|---|---|
| weekly | 52/12 |
| monthly | 1 |
| quarterly | 1/3 |
| yearly | 1/12 |

Computed with integer arithmetic (BigInt or scaled) on **sums**, rounded **once** half-up at the end, so totals do not accumulate per-row rounding error. Original `amount_minor` and `billing_frequency` are always preserved and shown.

### 4.4 Currencies and aggregation
SubCycle does **no FX conversion** in v1 (any rate would be invented data). Therefore:
- Totals are computed **per currency**. KPIs show the user's preferred currency prominently; if other currencies exist, they appear as additional lines ("+ USD 24.99/mo"), never silently summed or dropped.
- Charts that need one axis (category, trend) are drawn for the **selected currency** with a currency switcher shown only when the user has more than one.

### 4.5 Spending figures (always labelled)

| Label in UI | Definition | Kind |
|---|---|---|
| **Monthly (equivalent)** | Σ monthly equivalent of `active` subscriptions | Estimate (from current prices) |
| **Annualized estimate** | Monthly equivalent × 12, i.e. Σ yearly cost of `active` subscriptions | Projection |
| **Recorded spending (last 12 months)** | Σ `paid` payments (minus `refunded`) with `paid_on` in the trailing 12 months | Actual, only what the user recorded |
| **Recorded this month / by month** | Same, grouped by calendar month in the user's time zone | Actual |
| **Upcoming (7/30/90 days)** | Σ amounts of occurrences in window (weekly subs can occur several times) | Projection |

Statuses and totals:
- `active` → counted in monthly/annualized totals and renewals.
- `trial` → **not** in totals; shown in renewals as "Trial ends — starts at ₹X/mo" on `trial_end_date`.
- `paused`, `cancelled`, `archived` → excluded from totals and renewals.

The trend chart plots **recorded** payments only, titled "Recorded payments by month". Months without records show 0 with a note — *never back-filled from current subscriptions.* If there are no payments, the chart shows an empty state that explains this and offers "Record a payment".

### 4.6 Status lifecycle

```
            ┌──────── resume ────────┐
trial ──convert──▶ active ──pause──▶ paused
  │                  │  ▲               │
  └────cancel────────┼──┼────cancel─────┘
                     ▼  │ restore*
                 cancelled ──archive──▶ archived ──restore──▶ (status_before_archive)
```
- Allowed transitions are enforced server-side by a small state machine; invalid ones return `409 INVALID_TRANSITION`.
- **Cancel** = the user records that they cancelled externally: sets `status='cancelled'`, `cancelled_on` (user-entered date, default today, not in the far future). UI copy always says *"Record cancellation"* and shows the official cancellation link first. No wording implies SubCycle cancelled anything.
- **Restore** of a `cancelled` subscription → `active` requires the user to confirm a new future `next_billing_date`; clears `cancelled_on`. Restoring `archived` returns to `status_before_archive`.
- **Trial**: `trial_end_date` required when `status='trial'`. SubCycle never auto-converts; after the date passes, the UI shows "Trial ended — still subscribed? Convert or record cancellation". `next_billing_date` defaults to `trial_end_date`.
- **Paused**: reminders suppressed; `next_billing_date` kept but not rolled into totals.
- **Delete** (`DELETE /subscriptions/:id`) = permanent removal of the subscription and its payments/price history/reminders, after an explicit confirmation. Archive is the soft option.

### 4.7 Reminders
- Per-subscription: `reminder_lead_days` (nullable → inherit user default; allowed 0–60). User defaults: `reminder_lead_days` (default 3), `reminder_hour` (default 09:00 local), `email_reminders_enabled` (default off), in-app reminders always on.
- Kinds: `renewal` (target = next occurrence date) and `trial_end` (target = `trial_end_date`).
- A reminder is uniquely identified by `(subscription_id, kind, target_date, lead_days, channel)`. The DB unique constraint (`reminders_unique_per_renewal`) is the duplicate guard, and creation uses `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE status='superseded'` (a superseded row is revived; any other row is left alone).
- `remind_at` = (`target_date - lead_days`) at `reminder_hour` in the user's IANA zone, converted to UTC with `zonedInstant` (DST-correct, no library: a nonexistent local time in a spring-forward gap resolves forward; an ambiguous fall-back time resolves to the first occurrence). An unknown zone is not guessed: the reminder is `skipped` with `invalid_time_zone`.
- **What is planned** (`planReminders`, pure): for active subscriptions the renewal(s) within `today + lead + 30 days` at or after `max(today, saved next billing date)` (so a renewal already paid ahead gets none); for trials the trial end date; paused/cancelled/archived: nothing. Per-subscription `reminders_enabled=false` disables; `reminder_lead_days` overrides the user default; trial reminders follow `trial_reminders_enabled`. One row per enabled channel. A renewal already **sent** on a channel is not planned again if the lead time is later changed.
- **Scheduler tasks** (one cycle, in order, each isolated so one failing task does not stop the others): purge expired sessions, roll stale active billing dates forward, reconcile reminders, deliver due reminders. Cycles are serialized by a Postgres advisory lock; see `docs/OPERATIONS.md`.
  - *Reconcile* (per user, under a per-user transaction advisory lock): pending rows whose target date has passed become `skipped(delivery_window_missed)` first; missing rows are inserted; rows whose `remind_at` moved are rescheduled; rows no longer wanted become `superseded`; email rows skipped because email was unavailable are revived once it is deliverable.
  - *Deliver*: due `pending` rows are claimed with `FOR UPDATE SKIP LOCKED` and a lease (`next_attempt_at = now + 10 min`, `attempts + 1`).
- **Channels**
  - `in_app`: delivered = marked `sent` (visible in the inbox, with unread/dismissed state).
  - `email`: planned whenever the user enabled it, but **sent only when SMTP is configured and the address is verified**. Otherwise the row is `skipped` with the specific reason (`email_disabled`, `smtp_not_configured`, `email_not_verified`) and is **never marked sent**. SMTP 5xx: `failed` (no retry). Temporary errors (4xx, timeouts, connection errors): stay `pending` and retry after 5, 30, 120 and 360 minutes; the 5th failure is `failed`. A reminder is never delivered after its renewal date: it becomes `skipped(delivery_window_missed)`. `last_error` stores only a short safe label (`SMTP 421`, `SMTP ETIMEDOUT`, `SMTP error`).
  - Email delivery is **at-least-once** in one narrow window (the provider accepted the message but the row could not be marked sent before the lease expired): the message may then be sent a second time. This is accepted and tested; exactly-once is impossible without provider support.
- Delivery status is visible to the user in the reminders page (inbox and delivery log).
- **Offline behaviour:** reminders are only delivered while the API process runs. After downtime the first cycle catches up: reminders whose renewal has not yet passed are delivered late (still before the renewal date); those whose date has passed are skipped with `delivery_window_missed`. SubCycle never treats a missed renewal as paid.

> **Email verification (flagged addition).** Sending reminders to an unverified address could mail a third party. Email channel therefore requires `email_verified_at`; verification is available only when SMTP is configured. Without SMTP, the UI says so plainly and email reminders stay unavailable. Account use does not require verification.

### 4.8 Payments
- A payment is a **user-recorded** fact: `amount_minor`, `currency`, `paid_on` (date), `status ∈ paid | failed | refunded`, optional `for_billing_date` (which renewal it covers), optional `note`. SubCycle does **not** verify charges with any provider or bank; every payment response carries `source: "user_entered"`.
- Creating or editing a subscription creates **no** payments. Ever. Rolling dates forward and projecting occurrences create none either.
- `amountMinor` is required (never guessed from the current price). `currency` defaults to the subscription's; a different currency is allowed (e.g. a card-converted charge) and is reported as entered. `paid_on` defaults to the user's today and may not be in the future; it may precede the subscription's `start_date` (the start date often just means "when I added it").
- `for_billing_date`, when given, must be a date on the subscription's anchor schedule (§4.2). It is what the **duplicate guard** keys on: at most one `paid` payment per `(subscription, for_billing_date)`, enforced by a partial unique index (concurrent identical requests: one wins, the rest get `409 DUPLICATE_PAYMENT_PERIOD`). The guard never looks at amounts or dates paid, so legitimate separate payments are not rejected: two same-amount payments with no period named, same amount for different periods, a failed attempt followed by a paid retry, or a refund after a payment are all fine. Without a `for_billing_date` there is no period to guard, and none is inferred.
- **Advancing** (`advanceNextBillingDate: true`) moves the stored `next_billing_date` in the **same transaction** as the insert. Requirements: payment `paid`, subscription `active`, `for_billing_date` given, on the schedule, and not later than the upcoming renewal (a renewal cannot be skipped by paying ahead). Result: the first occurrence on/after `max(stored date, the occurrence after for_billing_date, today)`: always on the same anchor schedule (the anchor is never rewritten), never backwards, never in the past. If that equals the stored date nothing changes and the response says `nextBillingDateAdvanced: false`.
- **Deleting** a payment removes only that record; it does **not** move `next_billing_date` back. Schedule changes are made by editing the subscription.
- A subscription's currency cannot change while it has any payment or price-history row (§4.9).

### 4.9 Price history & usage
- When a PATCH changes `amount_minor` (same currency), a `subscription_price_history` row `(old, new, effective_on, note)` is written in the **same transaction**. History records **changes only** — no synthetic initial row. `effective_on` defaults to today and may be backdated by the user.
- Currency is immutable once a subscription has payments or price history (avoids ambiguous history); the user can archive and re-create instead.
- `usage_level` (nullable: `often | sometimes | rarely`) is **only ever user-entered**. "Barely used" views filter on `rarely`; if nobody has entered usage, the UI says "Rate how often you use each subscription to see this."
- **What-if savings:** selected subscription ids → Σ monthly equivalent and Σ annualized for those ids (`active` only). Labelled "Estimated savings if you cancel these".

### 4.10 Categories
Fixed enum for v1 (enables stable charts/colours): `entertainment`, `music`, `video`, `gaming`, `productivity`, `cloud_storage`, `ai_tools`, `news_reading`, `fitness_health`, `education`, `shopping`, `utilities`, `finance`, `other`. (User-defined categories deferred.)

### 4.11 Icons / logos
- No scraped or unofficial brand logos. v1 icon options: (a) built-in generic glyph set (lucide, ISC-licensed) chosen by category, (b) user-picked emoji, (c) deterministic **letter avatar** fallback (first letter on a category-tinted tile).
- Stored as `icon_kind ∈ glyph | emoji | none` + `icon_value`. URL/uploaded logos are deferred because they leak the viewer's IP to third parties and need content validation. Brand logos may be added later only from sources with verified usage rights.

### 4.12 Payment method label
Free-text label ≤ 40 chars ("HDFC card ••12"). The API rejects values that look like a PAN (13–19 digits after stripping separators, Luhn-valid) or a CVV pattern, and the UI hint says "Don't enter card numbers".

## 5. Features by screen

| Route | Content |
|---|---|
| `/login`, `/register` | Validated forms, loading/error states, link between them |
| `/` Dashboard | Greeting; KPI cards (monthly equivalent, annualized estimate, active count, renewals in 7 days); trend chart (recorded); category breakdown; upcoming list; recent payments; recently added; "+ Add subscription" CTA |
| `/subscriptions` | Search; filters (status, category, frequency, upcoming renewal window, price range); sort (price, next renewal, name, recently added); paginated list; empty states |
| `/subscriptions/new`, `/:id/edit` | Form with all fields (§ DATA_MODEL), live monthly-equivalent preview |
| `/subscriptions/:id` | Header (icon, name, status, category), price & frequency, next billing, payments, price history, notes, cancellation link, actions (edit, pause/resume, record cancellation, archive/restore, delete) |
| `/calendar` | Month grid + 7/30/90-day timeline toggle; per-day renewals; totals for the window |
| `/analytics` | Monthly equivalent, annualized, recorded last-12-months, by category, monthly history, most expensive, upcoming totals, price changes, what-if savings |
| `/settings` | Profile, currency, theme, timezone, reminder preferences, email-verification status, export CSV, change password, delete account |
| Reminder tray (header) | Unread in-app reminders; delivery state in settings |

Navigation: bottom bar < 1024px (Home, Subscriptions, Calendar, Analytics, Profile); left sidebar ≥ 1024px.

## 6. API

### 6.1 Conventions
- Base path `/api`, JSON, UTF-8. Amounts are minor-unit integers; dates are `YYYY-MM-DD`; instants are RFC 3339 UTC.
- Success: `{ "data": <payload>, "meta"?: { … } }`. Lists: `meta: { page, pageSize, total }`.
- Error: `{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details"?: [{ "path": "amountMinor", "message": "…" }] } }`. Messages are safe for end users; no stack traces, SQL, or internals. A request id is returned in `X-Request-Id`.
- Status codes: 200, 201, 204, 400 (malformed JSON), 401 (no/expired session), 403 (CSRF/origin), 404 (not found **or not yours**), 409 (conflict/invalid transition), 413, 422 (validation), 429, 500.
- **Cross-user access returns 404**, never 403, so resource existence is not revealed.
- **Pagination:** `page` (≥1) and `pageSize` (1–100, default 25); stable sort with `id` tiebreaker. Applies to subscriptions, payments, reminders.
- Validation: Zod `.strict()` on every body/query/param; unknown keys are rejected. The user id is **never** read from the request; it comes from the session.

### 6.2 Endpoints

| Method & path | Purpose |
|---|---|
| `POST /api/auth/register` | Create account (+ default preferences) and session |
| `POST /api/auth/login` | Create session |
| `POST /api/auth/logout` | Delete current session |
| `GET /api/auth/me` | Current user + preferences |
| `GET /api/dashboard` | KPIs, trend, categories, upcoming, recent payments, recent subscriptions |
| `GET /api/subscriptions` | List (filters/sort/pagination) |
| `POST /api/subscriptions` | Create |
| `GET /api/subscriptions/:id` | Detail |
| `PATCH /api/subscriptions/:id` | Edit (price change writes price history in-transaction) |
| `DELETE /api/subscriptions/:id` | Permanent delete |
| `POST /api/subscriptions/:id/status` | State-machine transition (`pause`, `resume`, `convert`, `cancel`, `archive`, `restore`) *(addition)* |
| `GET /api/subscriptions/:id/payments` | Payment history (paginated) |
| `POST /api/subscriptions/:id/payments` | Record payment |
| `DELETE /api/subscriptions/:id/payments/:paymentId` | Remove a payment *(addition)* |
| `GET /api/subscriptions/:id/price-history` | Price changes, newest effective date first *(addition)* |
| `GET /api/subscriptions/:id/upcoming` | Read-only projection of the next billing dates at the current price *(addition)* |
| `GET /api/calendar/renewals?from&to` | Occurrences in range (max 366 days) |
| `GET /api/analytics/spending?from&to&bucket` | Estimate vs recorded vs projection, per currency *(the what-if `cancelIds` idea is not implemented)* |
| `GET /api/reminders`, `POST /api/reminders/:id/dismiss` | In-app tray and delivery status *(addition)* |
| `GET /api/export/csv?type=subscriptions\|payments` | CSV download |
| `GET /api/preferences`, `PATCH /api/preferences` | Preferences (reminder fields in Stage 7; the rest in Stage 8) |
| `PATCH /api/account`, `POST /api/account/password`, `DELETE /api/account` | Profile name, change password (current password required; revokes all sessions and issues a new one), delete account (password re-entry plus typed email) *(addition; implemented in Stage 8)* |
| `POST /api/account/email-verification`, `POST /api/account/email-verification/confirm` | Only if SMTP configured *(addition)* |
| `GET /api/health` | Liveness (no data) |

Items marked *(addition)* extend the endpoint list in the brief to support stated requirements.

## 7. Security & privacy

### 7.1 Authentication & sessions
- **Passwords:** argon2id (`argon2` package; memory ≥ 19 MiB, t ≥ 2, p = 1 baseline — tuned and recorded in code). Min length 10, max 128; no composition rules; check against a small bundled common-password list. Constant-time verification; a dummy hash is verified for unknown emails to blunt timing differences.
- **Sessions:** server-side rows in Postgres. Token = 32 random bytes (base64url); **only SHA-256 of the token is stored**.
  - Cookie `sc_sid` (prod: `__Host-sc_sid`): `HttpOnly; SameSite=Lax; Secure` (prod); `Path=/`.
  - **Sliding idle expiry:** 14 days since last use (`last_seen_at` refreshed at most every 5 min to limit writes).
  - **Absolute expiry:** 30 days from creation, regardless of activity.
  - Logout deletes the row. Password change deletes **all** of the user's sessions (including the current one) and issues a fresh session in the same transaction; account deletion deletes all of them. Session id is rotated on login, registration and password change.
  - Expired sessions are purged by the scheduler.
- **Storage trade-offs (documented in SECURITY section of README):** httpOnly cookies are not readable by injected scripts (unlike localStorage tokens), but cookie-bearing requests are CSRF-prone → mitigated below. A successful XSS can still make same-origin requests as the user, so XSS prevention (CSP, no unsafe HTML) remains required.
- **CSRF:** SameSite=Lax; all state-changing routes are non-GET and additionally require `Content-Type: application/json` or a custom header `X-SubCycle-Client: web`, plus an `Origin` header check against the allowlist. GET routes never mutate.
- **Account enumeration:** login returns one generic error. Registration reveals an existing email (`409`) — accepted v1 trade-off (no email verification gate), mitigated by rate limits; documented.

### 7.2 Hardening
- `helmet` headers; strict CSP for the SPA (no inline script, `img-src 'self' data:`, `connect-src 'self'`); `Referrer-Policy: no-referrer`; HSTS in prod.
- CORS: explicit allowlist from `CORS_ORIGINS`, `credentials: true`; no wildcard. In dev, Vite proxy makes it same-origin.
- Body limit 100 kB JSON; query/param length limits.
- Rate limits: auth routes (e.g. 10 attempts / 15 min per IP, plus per-email-hash bucket on login); general API (e.g. 300/min per session/IP). In-memory store in v1 → **limitation:** limits are per instance; documented, with a Postgres-backed store as the multi-instance path.
- Logging: `pino` with redaction for `authorization`, `cookie`, `password*`, tokens; request logs never include bodies. No PII in error logs beyond user id.
- Secrets only via environment (`.env` ignored; `.env.example` committed). Nothing secret reaches the Vite bundle (only `VITE_`-prefixed non-secret values).
- No unsafe HTML: React escaping only; no `dangerouslySetInnerHTML`; user-supplied URLs (`website_url`) must be `http(s)`, rendered as `<a rel="noopener noreferrer nofollow" target="_blank">` and never auto-fetched.
- SQL: `pg` parameterized queries only; ownership enforced by `WHERE user_id = $n` in **every** subscription/payment/reminder/price-history query (joins re-check ownership via the subscription). A lint rule/test greps for string-concatenated SQL.
- CSV export neutralizes **formula injection** (cells starting with `= + - @ \t \r` are prefixed with `'`) and quotes per RFC 4180.
- No development-only endpoints exist; the demo seeder is a CLI script that refuses to run when `NODE_ENV=production`.

### 7.3 Data lifecycle
- **Export:** CSV of the user's subscriptions and, separately, payments (§ DATA_MODEL for columns). UTF-8 with BOM for Excel compatibility.
- **Account deletion:** requires password re-entry **and** the account email typed as an explicit confirmation; wrong attempts count against a per-user limit shared with password change. In one transaction deletes the sessions and hard-deletes the user row, and `ON DELETE CASCADE` removes preferences, sessions, subscriptions, payments, price history, reminders, and verification tokens. No data is retained or anonymized-and-kept. Server logs contain no personal data (user id only) and rotate per host policy. Backups are outside application control and are **not** purged by deletion: any backup taken before the deletion still contains the data until the operator's retention schedule expires it, and restoring such a backup would bring the account back (the operator must re-apply deletions). SubCycle ships no backup tooling and states no retention period. The web UI says this before the user confirms.
- **Demo/sample data:** *planned, not implemented* (there is no `seed:demo` script). The intended design: only through a CLI script that refuses to run in production and creates a single, clearly named demo account (`demo@subcycle.local`, display name "Demo (sample data)") and marks rows via that account only; never mixed with real user data and never run automatically.

## 8. Quality bar

### 8.1 Test plan (maps to brief §8)

| Area | Level | Tooling |
|---|---|---|
| Recurrence: weekly/monthly/quarterly/yearly, month-end, leap years | Unit | Vitest, table-driven |
| Normalization & totals, rounding-once | Unit | Vitest |
| Timezone/DST: "today" boundaries, reminder `remind_at` across spring-forward/fall-back | Unit | Vitest + fake `Clock` |
| Reminder scheduling, trial-end, duplicate prevention (re-run idempotent), supersession, SMTP-unconfigured → `skipped` | Integration | Vitest + real Postgres |
| Auth: register/login/logout, cookie flags, idle & absolute expiry (clock-controlled), rotation, revocation | Integration | Supertest |
| **User isolation** — table-driven test hitting *every* route as user B against user A's ids → 404 | Integration | Supertest |
| Subscription create/edit/pause/archive/cancel/restore + invalid transitions | Integration | Supertest |
| Payments, advance-next-date transaction, duplicate guard, price-history in-transaction | Integration | Supertest |
| Malformed/unauthorized requests, unknown keys, oversize body, CSRF/origin | Integration | Supertest |
| CSV correctness, quoting, formula injection | Integration | Supertest |
| Components: forms, empty/loading/error + retry states | Component | Vitest + RTL |
| E2E happy path, mobile viewport layout, keyboard-only flow, axe a11y scan | E2E | Playwright (+ `@axe-core/playwright`) |

- **Determinism:** all time-dependent code takes a `Clock` (`now(): Date`); tests use a fixed/advanceable clock. No `sleep`-based waits; Playwright uses web-first assertions.
- **DB tests:** each test file runs in a fresh schema/transaction against the Docker Postgres; migrations are applied from the real SQL files.
- CI (GitHub Actions): install → lint → typecheck → unit/integration (Postgres service) → build → Playwright.

### 8.2 Non-functional targets
- Dashboard API p95 < 300 ms at 200 subscriptions / 5k payments (single indexed queries per widget).
- No horizontal overflow ≥ 320 px width. WCAG 2.2 AA contrast and keyboard operability.

## 9. Open items (need your call, none block Stage 3)
1. **FX:** v1 shows per-currency totals, no conversion. OK?
2. **Email verification** gating email reminders (§4.7) — accepted as proposed?
3. **No password reset in v1** (§2) — acceptable?
4. **Icons:** glyph/emoji/letter only (no URL/uploaded logos) in v1 (§4.11) — acceptable?
