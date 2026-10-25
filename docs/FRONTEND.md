# SubCycle frontend (Stage 6)

React 19 + TypeScript + Vite + React Router + Tailwind CSS 4, in `apps/web`. It talks only to the endpoints documented in [API.md](API.md); shared schemas and domain rules come from `@subcycle/shared`.

## Running it
```
npm run db:up && npm run migrate
npm run dev:api        # API on :3001
npm run dev:web        # Vite on :5173, proxies /api to :3001 (same origin: cookies + CSRF behave as in production)
```

## Routes
| Route | Screen |
|---|---|
| `/login`, `/register` | Auth (signed-in users are redirected on) |
| `/` | Dashboard |
| `/subscriptions` | Library: search, filters, sort, pagination (all state lives in the URL) |
| `/subscriptions/new`, `/subscriptions/:id/edit` | Create / edit form |
| `/subscriptions/:id` | Detail: billing facts, projected renewals, recorded payments, price history, status actions, delete |

Everything except login/register requires a session; unauthenticated visits go to `/login` and return afterwards. Calendar, analytics, reminders and settings are later stages and are **not** linked (no dead navigation).

## Authentication and storage
The session is the server's httpOnly cookie. The app never reads, stores or sends a token: nothing is written to `localStorage`/`sessionStorage` (asserted in tests), requests use `credentials: 'same-origin'` and carry `X-SubCycle-Client: web` (the CSRF contract). Any 401 while signed in returns the user to `/login` with a plain "Your session has ended" notice; server error text is never shown for it.

## Product semantics enforced in the UI
- **Three kinds of numbers, always labelled:** *Estimate* (monthly equivalent, category split), *Projection* (annualized cost, upcoming renewals), *Recorded* (payments the user entered). Recorded figures come only from payment records: no payments means an empty chart that says nothing is estimated.
- **Currencies are never combined.** Totals are per currency (preferred first); charts have a currency switch; every amount shows its code.
- **Upcoming renewals use `effectiveNextBillingDate`** (computed by the API on read) and say "calculated from schedule" when the saved date is behind. Only active subscriptions renew; trials appear as "trial ends"; paused, cancelled and archived never do. Weekly subscriptions appear once (the calendar view is Stage 7).
- **Cancellation is the user's own record.** The dialog says SubCycle can't cancel anything, links the provider's page, and only then records the date. Payments are labelled user-entered, never verified.
- **Payments always send `forBillingDate`** (a dropdown of real renewals, defaulting to the upcoming one) so the server's duplicate-period guard works; "move the date forward" is offered only where the API allows it.
- **Edits send only what changed.** An unrelated edit never sends dates, so it cannot reset a month-end anchor schedule.
- **Dates** are calendar dates formatted without time-zone shift; "today", greetings and relative days use the user's saved time zone. Registration sends the browser's zone.

## Accessibility
Labelled controls with `aria-invalid`/`aria-describedby`, an error summary linking to fields and focusing the first error, a skip link, labelled landmarks, `aria-current` navigation, focus moved to the page after navigation, accessible modal dialogs (focus trap, Escape, inert background, focus restore), status shown as icon + text, charts with a text summary and a table view, reduced-motion support. axe-core runs over every screen in the test suite.

## Deliberate deviations from DESIGN_SYSTEM.md
No Radix UI, lucide or Recharts: dialogs are a small custom component, icons are inline SVG, charts are hand-written SVG/CSS. This avoids three dependencies for a handful of simple widgets. The bottom bar has Home, Subscriptions and Add (account menu lives in the header) because only those sections exist yet.

## Known limitations
- **No cross-subscription payments endpoint yet**, so the dashboard reads each subscription's payments (4 at a time, newest 60 subscriptions at most, with a visible notice when capped). Stage 7's analytics API should replace this.
- List filters/sorts that use the saved billing date lag until the hourly roll-forward job runs; the per-row effective date is always exact.
- Verified in jsdom (unit/component/integration, including a run against the real API and PostgreSQL) and spot-checked in a real Chromium at 320, 390, 820 and 1280 px. **There is no automated real-browser suite yet**; Playwright is planned for Stage 9.
- Theme preference (dark/light/system) is applied but cannot be changed in the UI until the Stage 8 settings page.
- Date inputs use the browser's native picker, so their text format follows the browser locale.
