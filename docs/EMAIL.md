# Turning on email

SubCycle works fully without email. Email adds three things: reminders by email, verification of your address, and **self-service password reset**. This page is the checklist for switching it on and proving it works.

**Status (2026-10-28): prepared, not verified with a real provider.** Everything below is implemented and tested with an in-process fake mailer, and the "send a test email" command was run against a port where nothing listens (real nodemailer, failure path). **No message has ever been sent through a real SMTP provider.** Do the checklist once, with a throwaway account, before relying on email, and record the result at the end.

## What uses email

| Feature | Needs | Without email |
|---|---|---|
| Email reminders | SMTP configured, the user turned them on, the user verified their address | Recorded as skipped with the reason, never as sent |
| Verify your email | SMTP configured | The button reports email is unavailable |
| Forgot your password | SMTP configured | The page says it is unavailable; the operator runs `npm run admin:reset-link` instead (OPERATIONS.md) |
| "Your password was changed" notice | SMTP configured | Not sent |

Sending is always honest: "sent" means the SMTP server **accepted** the message. Bounces and spam-folder placement are outside what SubCycle can see.

## 1. Choose a provider

Any SMTP service works that accepts connections on port 587 (STARTTLS) or 465 (TLS from the start). Free tiers exist at several providers (for example Brevo, Resend or Mailgun) and a personal Gmail account can send with an app password; **check each provider's current free limits and terms yourself**, they change. SubCycle sends only a handful of messages per user per month. Things to look for:

- an SMTP credential (a username and a password or API key), not just a web API;
- a **verified sending identity**: either your own domain or a single verified sender address;
- if you use your own domain, the provider will ask you to add DNS records (SPF and DKIM, usually also a DMARC policy). Without them, mail often lands in spam or is rejected.

SubCycle requires an encrypted connection and refuses to send over plain text. It never reads incoming mail.

## 2. Configure

These are environment variables (a local `.env`, or the secrets/environment settings of your host). **Never commit them**, and never paste the password into a chat or an issue.

| Variable | Value |
|---|---|
| `SMTP_HOST` | the provider's SMTP host name |
| `SMTP_PORT` | `587` (STARTTLS) or `465` (with `SMTP_SECURE=true`) |
| `SMTP_SECURE` | `false` for 587, `true` for 465 |
| `SMTP_USER`, `SMTP_PASS` | the provider's SMTP credential |
| `SMTP_FROM` | the verified sender, for example `SubCycle <no-reply@your-domain.example>` |
| `APP_URL` | the public address of the web app (emailed links use it; https in production) |

`SMTP_HOST`, `SMTP_PORT` and `SMTP_FROM` must all be set or none (a partial setup stops the API from starting, on purpose). Leave `SMTP_REQUIRE_TLS` at its default: production refuses to turn it off.

## 3. Test the connection (no database, no users involved)

```bash
npm run admin:test-email -- an-address-you-can-read@example.com
```

It uses the same settings as the API, sends one message titled "SubCycle test email", and prints what happened:

- `The SMTP server accepted the message.` Now **check that inbox and the spam folder**. Accepted is not the same as delivered.
- `Failed: <short label>` followed by a plain next step. The label is a code (for example `SMTP 535`); the command never prints the provider's own text, the address or any credential.

| Label | Usually means |
|---|---|
| `SMTP 535`, `SMTP 534`, `SMTP 530`, `SMTP EAUTH` | Wrong username or password. Many providers need an app password or API key |
| `SMTP 550`, `551`, `553`, `554` | The sender or recipient was refused: `SMTP_FROM` is not a verified sender, or the address is wrong |
| `SMTP 4xx` | Temporary refusal (rate limit, greylisting): wait and retry |
| `SMTP ETLS` | The server offers no STARTTLS on that port: use 587, or 465 with `SMTP_SECURE=true` |
| `SMTP ETIMEDOUT` | Timed out: a firewall or host blocks outbound SMTP; try the provider's alternative port |
| `SMTP ESOCKET`, `ECONNREFUSED`, `ENOTFOUND` | Could not connect: check host and port; some hosts block outbound SMTP entirely |
| `Email is not configured` | One of `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` is missing |

## 4. Prove each feature end to end

Use a throwaway account on a non-production database, with an address you control.

1. **Start the API.** The start-up log line says `email: enabled`.
2. **Verify your address.** Reminders page: "Send verification email". Expect: the email arrives; the link opens `APP_URL/verify-email?token=...`; the page says verified; the account shows "Verified". Asking again within a minute shows the cooldown message.
3. **Password reset.** Sign out, "Forgot your password?", enter the address. Expect: the page says a link was sent (it says the same for any address); the email arrives; the link opens `APP_URL/reset-password#token=...` (the token is after `#`, not `?`); choose a new password; every other signed-in browser is signed out; the old password no longer works; a "Your password was changed" email arrives; **the same link no longer works**.
4. **Reminder.** Turn on email reminders, add a subscription renewing in 1 to 2 days, wait one scheduler cycle (`SCHEDULER_INTERVAL_SECONDS`, 300 by default). Expect one email, "Sent" in the delivery list, no duplicate after another cycle.
5. **Negative checks.** Set a wrong `SMTP_PASS`, restart, request a reset: the page must still answer the same neutral message, the API log must show an SMTP code and **no** address or provider text, and no email arrives. Then fix the password and confirm email works again.
6. **Look at the logs once.** No reset token, password or full email address appears anywhere. (Proxy access logs: the reset token is in the URL fragment, which is never sent, so it cannot be there.)

## 5. If something goes wrong

Unset the `SMTP_*` variables and restart. Everything falls back to "unavailable": reminders are recorded as skipped, verification and reset say email is not available, and operators can still issue reset links with `admin:reset-link`. Nothing is lost.

## 6. Record the result

When it works, note the provider, the date, who tested, and which of steps 2 to 5 passed, somewhere durable (for example in `docs/RELEASE.md` under "Verifying a real SMTP provider"). Only then may email be described as verified.

## Known limits

- Bounces, spam complaints and delivery receipts are not read: "accepted" is the strongest claim.
- The email address cannot be changed after sign-up.
- Rate limits for reset requests are in the API's memory (per process): run a single API instance.
- Real delivery has not been exercised yet. See the status line at the top.
