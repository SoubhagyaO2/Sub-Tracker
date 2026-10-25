# SubCycle API reference (implemented so far, through Stage 7)

Conventions are in [SPEC.md §6.1](SPEC.md). This file records the **implemented contracts**; it grows each stage.
Stage 3: auth (`/api/auth/*`, `/api/account/email-verification*`, `/api/health`; response shapes below). Stage 4: subscriptions. Stage 5: payments, price history, recurrence (all below).

All `/api/subscriptions*` routes require a session cookie, and state-changing calls require `X-SubCycle-Client: web`.
The owner is always the session user; no field, query parameter or header can name another user.
**A subscription that is not yours is indistinguishable from one that does not exist (404, identical body).**

## Auth response shape
`POST /api/auth/register` (201), `POST /api/auth/login` (200) and `GET /api/auth/me` (200) return `{ data: SessionPayload }` (type in `packages/shared/src/auth.ts`):
```jsonc
{ "user": { "id": "uuid", "email": "…", "displayName": "…", "emailVerified": false },
  "preferences": { "currency": "INR", "theme": "dark", "timezone": "Asia/Kolkata", "reminderLeadDays": 3, "reminderHour": 9,
                   "inAppReminders": true, "emailRemindersEnabled": false, "trialRemindersEnabled": true },
  "features": { "emailVerificationAvailable": false } }
```
The session itself is only the httpOnly cookie; no token appears in any body. `POST /api/auth/logout` returns 204 and clears the cookie.

## Data shape: `Subscription`
```jsonc
{
  "id": "uuid",
  "name": "Netflix",
  "category": "video",                 // see SPEC §4.10
  "amountMinor": 64900,                // integer minor units (paise/cents/yen); never a float
  "currency": "INR",                   // supported ISO-4217 code (packages/shared/src/currency.ts)
  "billingFrequency": "monthly",       // weekly | monthly | quarterly | yearly
  "monthlyEquivalentMinor": 64900,     // ESTIMATE: per-row, rounded half-up, integer arithmetic
  "anchorDate": "2030-01-31",          // original billing date; the schedule is computed from this
  "nextBillingDate": "2030-02-28",     // STORED; always a date ON the anchor's schedule; may be stale (see below)
  "effectiveNextBillingDate": "2030-02-28", // computed on read as of today: active -> rolled forward; trial -> stored; else null
  "startDate": "2030-01-15",
  "trialEndDate": null,
  "status": "active",                  // active | trial | paused | cancelled | archived
  "cancelledOn": null,                 // set only by "cancel": a date the USER reports
  "paymentMethodLabel": null,          // label only; card-number-like text is rejected
  "websiteUrl": null, "cancellationUrl": null,   // http(s) only, no credentials
  "notes": null,
  "usageLevel": null,                  // often | sometimes | rarely: only ever user-entered
  "reminderLeadDays": null,            // 0-60, null = inherit preference
  "remindersEnabled": true,
  "icon": null,                        // { kind: "glyph"|"emoji", value } | null
  "allowedActions": ["pause","cancel","archive"],   // what the state machine permits right now
  "createdAt": "…Z", "updatedAt": "…Z"
}
```
Dates are `YYYY-MM-DD` calendar dates (years 1990-2100), never timestamps; no time zone is applied to them.

## Endpoints

### `GET /api/subscriptions`
Query (all optional; unknown parameters, repeated scalar parameters, and empty values are rejected with 422):

| Param | Values | Notes |
|---|---|---|
| `page` | integer 1-100000 | default 1 |
| `pageSize` | integer 1-100 | default 25 |
| `q` | 1-80 chars | case-insensitive substring of the name; `%`, `_`, `\` are literal |
| `status` | comma list or repeated: `active,trial,paused,cancelled,archived` | **archived is hidden unless requested** |
| `category`, `frequency` | comma list from the enums | |
| `currency` | supported code | |
| `minPrice`, `maxPrice` | integer minor units | compared to the **monthly equivalent**, exactly (integer cross-multiplication, inclusive); **requires `currency`** |
| `renewsWithinDays` | integer 1-366 | active/trial whose next billing date is within N days of **today in the user's time zone**, inclusive |
| `sort` | `name` \| `nextRenewal` \| `price` \| `created` | default `created`; `price` sorts by monthly equivalent (unconverted: combine with `currency`) |
| `order` | `asc` \| `desc` | defaults: name/nextRenewal asc, price/created desc |

Response `200`: `{ "data": Subscription[], "meta": { "page", "pageSize", "total" } }`. Sorting always ends with an `id` tiebreaker, so pages never skip or repeat rows. A page past the end returns `data: []` with the real `total`.

### `POST /api/subscriptions` → `201 { data: Subscription }`
Required: `name` (1-80, no control chars), `amountMinor` (integer 1…10^12), `billingFrequency`, and `nextBillingDate` (optional only for a trial with `trialEndDate`, where it defaults to that date).
Optional: `category` (default `other`), `currency` (default: the user's preferred currency, INR unless changed), `status` (**`active` or `trial` only**), `anchorDate` (default: `nextBillingDate`), `startDate` (default: today, or the anchor if that is earlier), `trialEndDate` (required when `status=trial`), `paymentMethodLabel` (≤40), `websiteUrl`, `cancellationUrl`, `notes` (≤2000), `usageLevel`, `reminderLeadDays`, `remindersEnabled` (default true), `icon`.
Unknown keys (`userId`, `id`, `createdAt`, `cancelledOn`, …) → 422.
Rules: `nextBillingDate` must be on the schedule of `anchorDate` + frequency, not before `startDate`, and not before **today in the user's time zone** (for active/trial). Creation never writes payment, price-history or reminder rows. Maximum **500** subscriptions per user (`409 SUBSCRIPTION_LIMIT_REACHED`).

### `GET /api/subscriptions/:id` → `200 { data }` · `404`
### `PATCH /api/subscriptions/:id` → `200 { data }`
Any subset of the create fields (nullable text/URL/enum fields accept `null` or `""` to clear), **excluding `status`** (use the status endpoint). At least one field is required.
- **Schedule:** setting `nextBillingDate` declares a new schedule: it becomes the new `anchorDate` unless `anchorDate` is also given (then it must be on that schedule). Changing `billingFrequency` **requires** `nextBillingDate`. The "not in the past" rule is applied only when `nextBillingDate` is being set, so editing other fields of an old record never fails because time has passed. (Rolling a stale date forward is a later stage.)
- **Price changes:** when `amountMinor` changes (same currency) a `subscription_price_history` row `{old, new, currency, effectiveOn, note}` is written **in the same transaction**. Extras: `priceChangeEffectiveOn` (default today, not in the future), `priceChangeNote`, `recordPriceChange: false` (fix a typo without recording history). These three are rejected when the amount does not actually change.
- **Currency** can change only while the subscription has no payments and no price history (`409 CURRENCY_LOCKED`); no history row is written for such a correction.

### `POST /api/subscriptions/:id/status` → `200 { data }` · `409 INVALID_TRANSITION`
Body `{ "action": …, "nextBillingDate"?: date, "cancelledOn"?: date }`. This endpoint is the only way to change status.

| Action | From | To | Parameters / effects |
|---|---|---|---|
| `pause` | active | paused | none |
| `resume` | paused | active | `nextBillingDate` optional; **required if the stored date has passed** |
| `convert` | trial | active | same as resume; `trialEndDate` is kept as history |
| `cancel` | active, trial, paused | cancelled | `cancelledOn` default today (user's zone); not in the future, not before `startDate`. **Records a cancellation the user completed with the provider; nothing is inferred or sent externally.** |
| `archive` | active, trial, paused, cancelled | archived | stores the previous status |
| `restore` | archived | the stored previous status | if that was active/trial, a passed date requires `nextBillingDate`; for paused/cancelled a date is rejected |
| `restore` | cancelled | active | **`nextBillingDate` required** (today or later); clears `cancelledOn` |

Any other (status, action) pair → `409 INVALID_TRANSITION`. Parameters that do not belong to the action → 422. A supplied `nextBillingDate` becomes the new anchor. Transitions run under a row lock, so concurrent requests cannot both succeed.

### `DELETE /api/subscriptions/:id` → `204` · `404`
Permanent. Payments, price history and reminders are removed by `ON DELETE CASCADE`. Use `archive` for the reversible option.

## Payments (Stage 5)
A payment is **something the user records**. SubCycle never verifies it with a provider or bank, and every payment carries `source: "user_entered"`.

```jsonc
{ "id": "uuid", "subscriptionId": "uuid", "amountMinor": 64900, "currency": "INR",
  "paidOn": "2030-01-14", "status": "paid",        // paid | failed | refunded
  "forBillingDate": "2030-02-01",                  // which renewal it covers (optional)
  "note": null, "source": "user_entered", "createdAt": "…Z" }
```

### `POST /api/subscriptions/:id/payments` → `201 { data: { payment, subscription, nextBillingDateAdvanced } }`
| Field | Rules |
|---|---|
| `amountMinor` | **required**, integer 1…10^12 |
| `currency` | optional, supported code, default = the subscription's; a different currency is allowed and stored as entered |
| `paidOn` | optional, default today (owner's zone); **not in the future**; may precede the subscription's start date |
| `status` | optional, default `paid` |
| `forBillingDate` | optional; must be on the subscription's anchor schedule (not before the anchor; clamped month-end dates are valid) |
| `note` | optional, ≤500, no control characters, card-number-like text rejected |
| `advanceNextBillingDate` | optional boolean, default `false` |

Unknown fields (`userId`, `source`, `verified`, …) → 422. Works for any subscription status (history), but advancing needs an **active** one.
- **Duplicate guard:** a second `paid` payment for the same `forBillingDate` → `409 DUPLICATE_PAYMENT_PERIOD`, whatever the amount or date. Amount/date never trigger it; payments with no `forBillingDate`, different periods, failed/refunded rows, or after deleting the first are accepted. Concurrent identical requests: exactly one succeeds.
- **Advance** (`advanceNextBillingDate: true`) requires: `status=paid`, subscription active, `forBillingDate` given and on schedule, and not later than the upcoming renewal (`422` otherwise, nothing recorded). New date = first occurrence on/after `max(stored, occurrence after forBillingDate, today)`: same anchor schedule (**anchor unchanged**), never backwards, never past. `nextBillingDateAdvanced` is `false` when nothing needed to move.
- **Atomic:** subscription locked → payment inserted → date advanced, in one transaction. Any failure leaves neither change (tested with injected database failures). No other payment rows are ever created.

### `GET /api/subscriptions/:id/payments` → `200 { data: Payment[], meta: { page, pageSize, total } }`
`page` (default 1), `pageSize` (1–100, default 25); anything else → 422. Order: `paidOn` desc, then newest-recorded first, then `id`. Fully deterministic; pages never skip or repeat.

### `DELETE /api/subscriptions/:id/payments/:paymentId` → `204` · `404`
Removes that record only. **The next billing date is not moved back** (edit the subscription to change the schedule). The subscription's currency unlocks when its last payment and price change are gone.

## Price history (Stage 5)
### `GET /api/subscriptions/:id/price-history` → `200 { data: PriceChange[], meta }`
```jsonc
{ "id": "uuid", "subscriptionId": "uuid", "oldAmountMinor": 64900, "newAmountMinor": 79900,
  "currency": "INR", "effectiveOn": "2030-01-15", "note": "Annual price rise", "createdAt": "…Z" }
```
Records **changes only** (no synthetic initial row), written by `PATCH /subscriptions/:id` in the same transaction as the amount change (a failure in either rolls back both). Order: `effectiveOn` desc (so back-dated entries sort by their date), then newest-recorded, then `id`. Same pagination as payments.

## Recurrence (Stage 5)
Billing dates are computed from the **anchor** (`addMonths(anchor, n)` etc.), never from a previous result, so a 31st anchor yields Feb 28/29, Mar 31, Apr 30, … and a Feb 29 yearly anchor yields Feb 28 in common years and Feb 29 in leap years. The engine is pure (`packages/shared/src/recurrence.ts`) and takes "today" as an argument; the API derives it from the injected clock and the user's time zone.

- **Reads never write.** `effectiveNextBillingDate` is computed on read. Reading one subscription (or a list) cannot modify any row.
- **Persisted roll-forward** is a task of the Stage 7 scheduler (`rollForwardStale`, see `docs/OPERATIONS.md`; runs at start-up and every `SCHEDULER_INTERVAL_SECONDS`): moves stale `active` dates to the first occurrence on/after the owner's today, never backwards, anchor unchanged, no payments, optimistic per-row update. Trials, paused, cancelled and archived rows are not touched.
### `GET /api/subscriptions/:id/upcoming?count=6` → `200 { data: [{ date, amountMinor, currency }], meta: { kind: "projection", note } }`
`count` 1–24 (default 6). A **projection** at the current price, not a record of charges. Active: from the upcoming date; trial: only while its end date hasn't passed; paused/cancelled/archived: `[]`. Read-only.

## Calendar (Stage 7)
### `GET /api/calendar/renewals?from=YYYY-MM-DD&to=YYYY-MM-DD` → `200 { data: Occurrence[], meta }`
Read-only (never writes), scoped to the session user. Both ends inclusive. Defaults: `from` = the owner's today, `to` = `from` + 29 days. `from` earlier than today is **raised to today** (SubCycle projects forward only; `meta.from` says what was evaluated). A range longer than **366 days** is `422`. At most **1000** occurrences are returned (earliest first); `meta.truncated` is true when more existed and `meta.total` is the full count. Totals include every occurrence, not just the returned ones.

`Occurrence = { date, kind: "renewal" | "trial_end", subscriptionId, name, category, icon, amountMinor, currency, billingFrequency, status }`.
- `active`: every billing date on the anchor schedule from `max(from, today, saved next date)`; a weekly subscription yields several per range. A renewal already paid ahead (saved next date later) is not shown again.
- `trial`: one `trial_end` event on the trial end date if it has not passed. It carries no charge.
- `paused`, `cancelled`, `archived`: nothing.

`meta = { from, to, today, timeZone, kind: "projection", total, truncated, totals: [{ currency, renewalCount, amountMinor }], trialEndCount }`. Totals are per currency and never combined. Everything is a **projection**, not a record that a charge happens.

## Analytics (Stage 7)
### `GET /api/analytics/spending?from&to&bucket=month|week` → `200 { data }`
Read-only. `bucket` defaults to `month`; `from` defaults to the first of the month 11 months back; `to` defaults to today and is **clamped to today** (recorded spending cannot be in the future). Ranges are capped (month: 1830 days, week: 372 days) → `422`. Dates are the owner's local calendar dates; buckets start on the 1st (month) or Monday (ISO week); empty buckets are returned as zeros.

`data = { timeZone, today, estimate, recorded, projection }`: three separately labelled sections.
- **`estimate`** (`kind: "estimate"`): active subscriptions only, current prices, per currency: monthly equivalent, annualized, `byCategory` (exact yearly shares) and the top 5. It is not money paid.
- **`recorded`** (`kind: "recorded"`): computed from the `payments` table only. Per currency: `paidMinor`, `refundedMinor`, `netMinor` (paid minus refunded), `paymentCount`, `failedCount` (failed payments are counted separately and never added to spend), `buckets[]`. Payments of cancelled/archived subscriptions are included. Also `recentPayments` (5, newest first). A passed renewal date never produces a recorded amount. Not verified against any bank or provider.
- **`projection`** (`kind: "projection"`): windows of 7, 30 and 90 days from today, per currency `{ renewalCount, amountMinor }` plus `trialEndCount`, using the same occurrence rules as the calendar.

## Reminders (Stage 7)
### `GET /api/reminders?page&pageSize&channel=in_app|email&status=sent,skipped,...&unread=true` → `200 { data: Reminder[], meta: { page, pageSize, total, unread } }`
`Reminder = { id, subscriptionId, subscriptionName, kind: "renewal"|"trial_end", channel, targetDate, leadDays, remindAt, status: "pending"|"sent"|"skipped"|"failed"|"superseded", skipReason, attempts, sentAt, readAt, lastError }`.
`skipReason` is one of `smtp_not_configured`, `email_not_verified`, `email_disabled`, `subscription_inactive`, `delivery_window_missed`, `invalid_time_zone`. `lastError` is a short safe label such as `SMTP 421`, never provider output. `meta.unread` counts delivered, undismissed in-app reminders. For email, `sent` means **the SMTP server accepted the message**; SubCycle cannot see whether it reached an inbox.
### `POST /api/reminders/:id/dismiss` → `200 { data: Reminder }` · `404`
Marks a delivered in-app reminder read. Idempotent. Any other reminder (pending, skipped, failed, email, or another user's) is `404`.

## Preferences (Stage 7: reminder fields only)
### `GET /api/preferences` → `200 { data: Preferences }`
### `PATCH /api/preferences` → `200 { data: Preferences }`
Strict body with at least one of `reminderLeadDays` (0-60), `reminderHour` (0-23), `inAppReminders`, `emailRemindersEnabled`, `trialRemindersEnabled`. `currency`, `theme` and `timezone` are rejected (`422`) until the Stage 8 settings page. A successful change immediately reconciles that user's planned reminders (best effort; the scheduler would do it anyway).

## Scheduler (Stage 7)
There is no HTTP surface. The scheduler runs inside the API process; see `docs/OPERATIONS.md` for tasks, locking, retries and guarantees.

## Account email verification
`POST /api/account/email-verification` (session; `503` when no SMTP is configured, `429` inside the resend cooldown, `409` already verified) and `POST /api/account/email-verification/confirm` (`{ token }`, single use, no session needed).

## Errors specific to these stages
`422 VALIDATION_ERROR` (with `details[{path,message}]`) · `404 NOT_FOUND` · `409 INVALID_TRANSITION` · `409 CURRENCY_LOCKED` · `409 SUBSCRIPTION_LIMIT_REACHED` · `409 DUPLICATE_PAYMENT_PERIOD`.

## Implementation notes worth knowing
- **pg type parsers:** `DATE` is returned as the raw `YYYY-MM-DD` string (the default JS `Date` would shift across time zones) and `BIGINT` as a safe integer (guarded).
- **Dynamic SQL:** only the subscription list query builds SQL text, from constants, an `ORDER BY` allowlist and numbered placeholders; every value is a bound parameter. A test pins the exact set of interpolated expressions permitted per file.
- **Heuristic limits:** the card-number guard rejects any 13-19 digit run (separators allowed) or "CVV/CVC/security code + 3-4 digits" in `paymentMethodLabel` and `notes`. It is conservative by design (a non-Luhn 16-digit number is also refused) and cannot catch every disguise.
