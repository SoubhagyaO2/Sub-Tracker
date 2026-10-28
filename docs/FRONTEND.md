# SubCycle frontend (Stage 6, extended in Stage 7)

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
| `/calendar` | Renewal calendar: Month grid (keyboard-navigable) or the next 7/30/90 days; per-currency projected totals |
| `/analytics` | Recorded spending (by month or week), recurring-cost estimate, projection windows; currency switch |
| `/reminders` | Inbox (mark as read), reminder settings, delivery log with skip reasons |
| `/settings` | Theme, preferred currency, time zone; reminder summary (links to `/reminders`); name and email status; change password; delete account |
| `/verify-email?token=` | Landing page for the emailed verification link (public; the token is submitted once) |

Everything except login/register requires a session; unauthenticated visits go to `/login` and return afterwards. Settings is in the account menu and the desktop sidebar; export is a later stage and is **not** linked (no dead navigation). `/verify-email` is public because the emailed token is the credential.

## Authentication and storage
The session is the server's httpOnly cookie. The app never reads, stores or sends a token: nothing is written to `localStorage`/`sessionStorage` (asserted in tests), requests use `credentials: 'same-origin'` and carry `X-SubCycle-Client: web` (the CSRF contract). Any 401 while signed in returns the user to `/login` with a plain "Your session has ended" notice; server error text is never shown for it.

## Product semantics enforced in the UI
- **Three kinds of numbers, always labelled:** *Estimate* (monthly equivalent, category split), *Projection* (annualized cost, upcoming renewals), *Recorded* (payments the user entered). Recorded figures come only from payment records, computed by `GET /api/analytics/spending` (one request; the old per-subscription workaround is gone): no payments means an empty chart that says nothing is estimated.
- **Currencies are never combined.** Totals are per currency (preferred first); charts have a currency switch; every amount shows its code.
- **Upcoming renewals use `effectiveNextBillingDate`** (computed by the API on read) and say "calculated from schedule" when the saved date is behind. Only active subscriptions renew; trials appear as "trial ends"; paused, cancelled and archived never do. The dashboard list shows one row per subscription; the calendar expands weekly subscriptions into every occurrence.
- **Cancellation is the user's own record.** The dialog says SubCycle can't cancel anything, links the provider's page, and only then records the date. Payments are labelled user-entered, never verified.
- **Payments always send `forBillingDate`** (a dropdown of real renewals, defaulting to the upcoming one) so the server's duplicate-period guard works; "move the date forward" is offered only where the API allows it.
- **Edits send only what changed.** An unrelated edit never sends dates, so it cannot reset a month-end anchor schedule.
- **Dates** are calendar dates formatted without time-zone shift; "today", greetings and relative days use the user's saved time zone. Registration sends the browser's zone.

## Accessibility
Labelled controls with `aria-invalid`/`aria-describedby`, an error summary linking to fields and focusing the first error, a skip link, labelled landmarks, `aria-current` navigation, focus moved to the page after navigation, accessible modal dialogs (focus trap, Escape, inert background, focus restore), status shown as icon + text, charts with a text summary and a table view, reduced-motion support. axe-core runs over every screen in the test suite.

## Deliberate deviations from DESIGN_SYSTEM.md
No Radix UI, lucide or Recharts: dialogs are a small custom component, icons are inline SVG, charts are hand-written SVG/CSS. This avoids three dependencies for a handful of simple widgets. The mobile bottom bar has Home, Subscriptions, Calendar, Analytics and Add; Reminders is a bell with an unread badge in the header (sidebar on desktop).

## Stage 7 screens: behaviour worth knowing
- **Calendar** is a `role="grid"` with a single tab stop (roving tabindex): arrow keys move by day/week, Home/End to the week's ends, Page Up/Down change month. Past days and months are not navigable/projected. Every day's accessible name states its renewals and trial endings. A truncation note appears when the API's 1000-entry cap applies (totals still cover everything).
- **Reminders** never claim more than the server knows: email "Sent" reads "accepted by the email server"; skipped rows state the reason; with no SMTP configured the page says so and the email toggle is disabled; the verify button appears only when email is configured and the address is unverified, and 429/503 responses are shown as errors, never as "sent".
- **Analytics** keeps three cards (Recorded / Recurring-cost estimate / Coming up) with their labels; a currency selector appears only when more than one currency exists.
- Every new screen has loading, empty, error-with-retry states and an axe scan in the test suite.

## Stage 8: settings behaviour worth knowing
- **Theme** is stored on the account and applied by one component for every route, including the sign-in pages (which fall back to dark when signed out). Nothing is written to browser storage, so the first paint on a fresh load is dark until the session loads.
- **Currency and time zone** copy says what they do and do not do (no conversion; stored dates and payments are not rewritten). The time-zone list comes from the browser's zone database plus the saved value, so an old alias stays selectable.
- **Password change** keeps the user signed in (the server swaps the session cookie); the result says how many other sessions were signed out.
- **Delete account** is a dialog that states the consequences (including backups and that providers are not cancelled), needs the password and the typed email, cannot be dismissed while running, and on success leaves the app **without any further request**, landing on the sign-in page with a notice.

## Stage 9: verified in a real browser
The production build is exercised by the Playwright suite (see [TESTING.md](TESTING.md)) under a strict Content-Security-Policy, in both themes at 320 / 390 / 820 / 1280 px: no horizontal overflow, axe-core (including colour contrast, which jsdom cannot measure) clean on every page and dialog, keyboard/focus behaviour asserted. Defects it found and that were fixed: links relied on colour alone (links are now underlined unless a component opts out), and the "Mark as read" button's accessible name did not contain its visible text.

## Quick start on the add form
- **Type-ahead** on "Service name" (new subscriptions only): a WAI-ARIA combobox over a built-in list of about 90 well-known services. Arrow keys move, **Enter picks** (and only then does not submit the form), Escape closes, Tab leaves without picking. A pick fills name, category, website and the service's logo (where one is bundled; otherwise a letter tile), and **only into fields the user has not already set**.
- **Paste a link**: "Fill from link" (or Enter in that field). Known services are recognised in the browser with no request; anything else is looked up by the server (`POST /api/link-preview`) and offered as a suggestion that says where the name came from (page title, or the web address when the page could not be read).
- The list holds **no prices, plans, billing dates or cancellation links**, and the lookup never reads them: the price and next billing date are always typed by the user. The edit form is unchanged.

## Brand logos
- 61 of the ~92 listed services have a bundled logo (Netflix, Spotify, YouTube, Apple, GitHub, Dropbox, Uber, Duolingo, NordVPN, Slack, Microsoft, Adobe, OpenAI, LinkedIn, …). The rest, including **Disney+, Hulu, Amazon Prime, Peacock, Canva and Xbox**, are in neither free collection and show a letter tile (or a picture the user uploads); they were **not** drawn or scraped to fill the gap.
- Logos are SVG paths in `apps/web/src/lib/brandIcons.generated.ts` (about 44 KB), generated by `node scripts/generate-brand-icons.mjs` from the `simple-icons` and `@iconify-json/logos` (SVG Logos) dev dependencies (both CC0-1.0); single-colour logos are SVG paths, full-colour ones are SVG data URIs drawn with `<img>`, so a script inside an SVG could never run (the generator also refuses any SVG containing scripts, links or external references). To add or change one, edit the `logo` key in `packages/shared/src/services.ts`, rebuild the shared package and rerun the script; a test fails if a catalogue key has no bundled logo or a bundled logo is unused.
- A logo is drawn on a fixed light tile in the brand's own colour (near-black when that colour is very light), in both themes. It is decorative (`aria-hidden`); the service name is always next to it.
- **Trademarks:** the marks belong to their owners and are shown only to identify the service. Simple Icons is community-maintained, not brand-approved artwork: for a public product, check each owner's brand guidelines; for a private deployment the risk is low. A logo can be removed by setting its catalogue `logo` to `null`.
- The Icon field on the form accepts one emoji or a bundled logo key (e.g. `netflix`); an unknown key is refused.

## Your own picture (optional)
On the add and edit forms, "Your own picture" lets a user choose a PNG, JPEG or WebP. It is cropped to a centred square and shrunk to 128 x 128 in the browser (so a 5 MB photo becomes a few KB), previewed, and uploaded: when creating, right after the subscription exists (if the upload fails the subscription is still added and the user is told); when editing, immediately. "Remove picture" undoes it. A picture takes precedence over a logo or emoji; choosing a logo or emoji replaces it. If a picture cannot load, the letter tile is shown. The control is a labelled native file input with a described hint, a polite status and an alert for errors.

## Known limitations
- List filters/sorts that use the saved billing date lag until the next scheduler cycle rolls them forward (at most `SCHEDULER_INTERVAL_SECONDS`, default 5 minutes, while the API runs); the per-row effective date is always exact.
- Verified in jsdom (unit/component/integration, including a run against the real API and PostgreSQL) and by the Playwright suite in Chromium only. Not tested: Firefox, WebKit, real mobile devices, screen readers (no manual assistive-technology pass has been done).
- Date inputs use the browser's native picker, so their text format follows the browser locale.
