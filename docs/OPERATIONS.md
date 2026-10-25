# SubCycle operations: scheduler, reminders and delivery guarantees (Stage 7)

This page states exactly what the background scheduler guarantees, what it does **not**, and which guarantees depend on running a single API instance. Where a statement is "tested", a test in `apps/api/test` exercises it against a real PostgreSQL; where it is "not tested", nothing in this repository exercises it.

## What runs

The scheduler lives inside the API process (`apps/api/src/scheduler`). It replaces the Stage 5 hourly timer.

| Setting | Default | Meaning |
|---|---|---|
| `SCHEDULER_ENABLED` | `true` | `false` runs the API with no background work |
| `SCHEDULER_INTERVAL_SECONDS` | `300` (30-3600) | pause between the end of one cycle and the start of the next |

One **cycle** runs four tasks in order. Each task is isolated: if one throws, the error is logged (task name, error name/code only) and the next still runs.

1. `purge_sessions`: deletes expired sessions.
2. `roll_forward`: moves stale `active` billing dates to the first anchor occurrence on or after the owner's today (owner's stored time zone; invalid zone falls back to UTC). Optimistic per-row `UPDATE`, never backwards, anchor untouched. **Never creates a payment.** A renewal date that passes without a recorded payment stays an unpaid, unrecorded date: SubCycle never treats it as paid.
3. `reconcile_reminders`: plans, reschedules, revives, expires and supersedes reminder rows per user (see `docs/SPEC.md` §4.7).
4. `deliver_reminders`: claims due rows and delivers them.

All time decisions use the injected `Clock` (tests control it) and the stored per-user time zone. The clock and `Date.now()` are never mixed.

## Restarts and downtime

A cycle runs immediately on start-up, so after downtime the first cycle catches up. Everything is derived from database state, so work is neither lost nor replayed:

- stale billing dates are rolled forward;
- reminders still before their renewal date are delivered late (never after the renewal date);
- reminders whose renewal date has passed become `skipped` with `delivery_window_missed`; they are not sent late and not shown as sent;
- shutdown waits for the in-flight cycle (`stop()`), then exits.

Tested: restart catch-up, stale reminders, missed windows, and that no payment rows exist after any cycle (`scheduler.test.ts`, `reminders-service.test.ts`).

**Offline means no reminders.** If the API is not running at the planned time nothing is sent until it runs again. There is no external queue, push service or fallback.

## Concurrency and locking

| Mechanism | Protects | Scope |
|---|---|---|
| Session advisory lock `pg_try_advisory_lock(727002)` on a dedicated connection | only one cycle at a time | **all instances sharing the database** |
| Chained `setTimeout` (next cycle is scheduled after the previous finishes) | no overlapping cycles inside one process | one process |
| Per-user transaction advisory lock (`hashtextextended('reminders:'||userId, 7)`) | concurrent reconcile for the same user (cycle vs. the immediate reconcile after `PATCH /api/preferences`) | all instances |
| `INSERT ... ON CONFLICT` on `reminders_unique_per_renewal` | duplicate reminder rows | all instances |
| `FOR UPDATE SKIP LOCKED` + lease column (`next_attempt_at = now + 10 min`) | the same reminder claimed twice | all instances |
| Optimistic `UPDATE ... WHERE next_billing_date = <value read>` | roll-forward vs. a user edit (the user wins) | all instances |

If the process dies, the advisory lock is released with its connection. If the unlock call itself fails, the connection is destroyed so the lock cannot leak.

Tested: two overlapping cycles (second returns `skipped_locked` while the first is held inside an email send), concurrent reconcile, concurrent delivery workers claiming disjoint rows, lock release after a failing cycle.

## Known limitation: planning is not instant for new subscriptions

Reminders are planned by the scheduler (and immediately after `PATCH /api/preferences`), **not** at the moment a subscription is created or edited. A new subscription's reminders therefore appear in the delivery log after the next cycle (at most `SCHEDULER_INTERVAL_SECONDS`, default 5 minutes, while the API runs). This delays only the log: a reminder is never due sooner than its lead time. Subscription status changes and payments supersede stale reminders at the next cycle as well.

## Reminder delivery semantics

- **In-app**: delivered means the row is `sent` and shows in the inbox. It is read state (`read_at`) that the user changes with "Mark as read".
- **Email** is sent only when **all** hold: the user enabled it, SMTP is configured, and the recipient's address is verified. Otherwise the row is `skipped` with `email_disabled`, `smtp_not_configured` or `email_not_verified`. It is never marked `sent`. When the condition later becomes true (provider configured, address verified, setting turned on) reconcile revives the row to `pending` if its renewal date has not passed.
- **`sent` for email means the SMTP server accepted the message.** SubCycle cannot know whether it reached the inbox.
- **Failures**: SMTP 5xx marks `failed`. Temporary failures (4xx, timeouts, connection errors) leave the row `pending` with `attempts + 1` and the next attempt after 5, 30, 120, then 360 minutes; the 5th failure is `failed`. A retry that would land after the renewal date becomes `skipped(delivery_window_missed)`.
- **Stale reminders**: if the subscription was paused, cancelled, archived, deleted or its date moved, pending reminders are superseded (or the claim finds the subscription no longer applicable and supersedes it).
- **Invalid stored time zone**: skipped with `invalid_time_zone`; never guessed.
- **Idempotence**: re-running reconcile or delivery changes nothing that is already settled; a sent reminder is not planned again even if the lead time changes.
- **Logging**: structured pino logs carry counts, task names, reminder ids and short error classes only. Redaction covers cookies, authorization, passwords, tokens, email addresses, notes, subjects and recipients. Verification tokens, session tokens, message bodies and provider error text are never logged (tested by capturing logs during failing sends). `reminders.last_error` stores a safe label (`SMTP 421`, `SMTP ETIMEDOUT`, `SMTP error`), not provider text.

### Email is at-least-once in one window

Delivery I/O happens outside any lock. If the SMTP server accepts a message and the process crashes (or the database update fails) before the row is marked `sent`, the lease expires after 10 minutes and the row is sent **again**. A duplicate email is possible in that window. This is accepted: exactly-once delivery would need provider-side idempotency keys. Tested by blocking the `sent` update with a trigger and asserting the retry. Mailer timeouts (10 s connect/greeting, 30 s socket) are shorter than the lease so a slow send cannot normally outlive its own claim.

## Guarantees that depend on running ONE API instance

| Area | Holds with one instance | With several instances sharing one database |
|---|---|---|
| Scheduler cycles, reminder reconcile, delivery claims, duplicate reminders, roll-forward | yes | **still hold**: they are enforced by Postgres (advisory locks, unique constraint, row locks, optimistic updates). Not exercised by a multi-process test; two overlapping cycles and concurrent workers are tested in one process against one database |
| Login and registration rate limits (per IP, per email) | yes | **do not hold**: counters are in process memory, so the effective limit is multiplied by the number of instances and resets on restart |
| Advisory lock safety behind a pooler | n/a | **not safe behind PgBouncer in transaction-pooling mode** (the lock is tied to a session; the pool may hand the cycle a different connection). Use direct connections or session pooling |
| Clock skew | n/a | the database clock is not used for decisions; each instance uses its own clock. Instances with materially different clocks could plan/deliver at slightly different times |
| Graceful shutdown | in-flight cycle is awaited | per instance; a killed instance releases its lock when its connection drops, and another instance takes over at its next interval |

Running more than one instance is therefore *safe for data* but the in-memory rate limiter would need a shared store first.

## Tested vs. not tested with a real SMTP provider

**Tested** (against real PostgreSQL, with a fake mailer that implements the mailer interface):
- all skip reasons, including `smtp_not_configured` when the mailer reports unconfigured, and that nothing is sent;
- success, 5xx, 4xx, timeout and connection-error classification, backoff schedule, attempt cap, window-missed on retry;
- the at-least-once crash window; concurrent workers; idempotent retries; no secrets in logs.

**Not tested with a real provider** (nothing in the repository does this):
- real SMTP authentication, TLS/STARTTLS negotiation, port and `SMTP_SECURE` combinations;
- real provider error codes and wording (classification relies on the Nodemailer `responseCode` / `code` fields and the documented 4xx/5xx convention);
- rate limits, greylisting, bounces and spam placement;
- the real timeout behaviour of the Nodemailer transport against a slow server (the timeout values are set but only the classification of a timeout error is tested);
- HTML/text rendering of the reminder email in real mail clients.

Before relying on email reminders, configure SMTP, verify an address, and send one reminder end to end.
