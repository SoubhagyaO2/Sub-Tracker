# SubCycle — Design System

A calm, dark, numeric **financial utility**: pure-black canvas, dark-grey rounded cards with a title row and divider, large coloured figures, and a coral → pink gradient accent. The look was reworked after Stage 10 from two user-supplied reference screenshots (a fitness app, then Apple's Health/Fitness "Summary"): soft rounded cards, glowing gradient accent, ring chart, a date overline above a big page title, floating bottom navigation with a central "+" button.

The source of truth for every value is [`apps/web/src/index.css`](../apps/web/src/index.css); this document explains the intent. Companion: [SPEC.md](SPEC.md), [FRONTEND.md](FRONTEND.md).

**Decisions that changed over time** (kept so nobody re-litigates them):
- *Stage 2–6:* dark charcoal with a soft-lime accent, plus a user-selectable light theme and system theme.
- *After Stage 10:* coral/pink accent and the Apple-Health-style card layout (user request).
- **The app is dark only.** There is no theme setting and no light theme. The `theme` field still exists in the API for old accounts but is ignored by the web app ([API.md](API.md)).
- **The Estimate / Projection / Recorded badges are not drawn on screen** (user request). Each figure still carries that label as screen-reader-only text (`KindTag`), so the three kinds of number are still distinguishable without sight. Plain-text notes such as "Next 12 months if nothing changes. Not what you paid." remain visible.

## 1. Principles
1. **Numbers are the hero.** Large tabular figures in colour; labels small and muted.
2. **One accent.** The coral → pink gradient marks primary actions, the selected navigation item and selected segments. Per-metric colours (from the chart palette) are decoration only: the label and the figure always carry the meaning.
3. **Label the truth.** Recorded, calculated and forward-looking figures are kept apart in the data and in the accessibility tree (§6.4), even though the badges are not drawn.
4. **Restraint.** Rounded cards, no borders, no card shadow, generous spacing; glow only on the primary action and charts.
5. **Accessible by construction.** Contrast-checked tokens, visible focus, no colour-only meaning, reduced motion respected.

## 2. Colour tokens (dark only)

| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#000000` | App background |
| `--surface` | `#1c1c1e` | Cards, panels |
| `--raised` | `#2c2c2e` | Rows inside cards, hovered rows, popovers, secondary buttons |
| `--line` | `#38383a` | Hairlines: the divider under card titles, list dividers (decorative) |
| `--line-strong` | `#707080` | Input borders and other control boundaries |
| `--fg` | `#f6f6f8` | Primary text |
| `--muted` | `#a1a1a8` | Secondary text |
| `--subtle` | `#9090a0` | Placeholders, captions |
| `--accent` | `#ff6a5c` | Flat accent (focus tints, chart series 1) |
| `--accent-grad` | `#ff8a5c → #ff4d7a` (135°) | Primary buttons, selected nav / segment / calendar day, centre "+" |
| `--accent-fg` | `#1a0b0d` | Text on the accent fill |
| `--accent-text` | `#ff9a8d` | Accent-coloured text and links on dark surfaces |
| `--lime` | `#b6ff2b` | "View all" style links (the reference's green chevrons) |
| `--danger` / `--warn` / `--info` | `#ff8fa0` / `#f0c566` / `#86bdf0` | Destructive and failed, trial ending, neutral info (each with a `-soft` tint) |
| `--focus` | `#ff9a8d` | 2 px focus ring, 2 px offset |

**Measured contrast** (WCAG relative luminance, computed from the token values above):

| Pair | Ratio | Requirement |
|---|---|---|
| `--fg` on canvas / surface / raised | 19.5 / 15.8 / 12.9 | 4.5 ✅ |
| `--muted` on canvas / surface / raised | 8.2 / 6.6 / 5.4 | 4.5 ✅ |
| `--subtle` on canvas / surface | 6.7 / 5.4 | 4.5 ✅ (do not use on raised) |
| `--accent-text` on canvas / surface / raised | 10.3 / 8.3 / 6.8 | 4.5 ✅ |
| `--accent-fg` on the gradient (`#ff8a5c` / `#ff4d7a`) | 8.2 / 6.0 | 4.5 ✅ |
| `--danger` / `--warn` / `--info` on surface | 7.8 / 10.4 / 8.5 | 4.5 ✅ |
| `--lime` on surface | 14.0 | 4.5 ✅ |
| `--line-strong` on canvas / surface | 4.3 / 3.5 | 3.0 (UI components) ✅ |
| `--line` | decorative only | never the sole indicator of a control |

These are also enforced continuously: the Playwright suite runs axe (including colour contrast) on every page and dialog at 320, 390, 820 and 1280 px ([TESTING.md](TESTING.md)).

### 2.1 Category & chart palette
Seven slots, each ≥ 5:1 on `--surface` (measured): `--cat-1` coral `#ff6a5c` (6.1), `--cat-2` sky `#7fb7e6` (8.0), `--cat-3` amber `#f0b35c` (9.2), `--cat-4` violet `#b69cf0` (7.3), `--cat-5` teal `#6fd3c0` (9.5), `--cat-6` pink `#f28db2` (7.5), `--cat-7` neutral `#9090a0` (5.4, "Other" and overflow).
- There are more categories than colours, so **several categories share a slot**. Anywhere two series must be told apart by colour (the three rings on Home), colours are assigned **by rank** (`--cat-1`, `--cat-5`, `--cat-2`), not by category.
- **Colour is never the only encoding:** every series has a text label with its amount and percentage.
- Dashboard stat figures use `--cat-4` (annualized), `--cat-5` (active), `--cat-2` (renewing soon) and `--cat-1` (monthly total) purely as decoration.

## 3. Typography
- **Family:** Inter Variable, self-hosted via `@fontsource-variable/inter` (no third-party font requests; CSP `font-src 'self'`). Fallback `ui-sans-serif, system-ui`.
- **Numerals:** tabular figures for all money and dates (`tnum`) so columns align.
- Scale: page title (H1) is large and bold (`text-4xl` → `text-5xl` on the dashboard, `text-2xl` elsewhere); a small uppercase **date overline** sits above the dashboard title; card titles (H2) are `text-lg` semibold; body 15 px; captions 12–13 px; stat figures `text-3xl`/`text-4xl` semibold.
- Minimum body text 15 px, minimum caption 12 px. Rem-based, so browser font scaling and zoom work; layouts are tested for overflow at 320 px.

## 4. Spacing, shape, elevation, layout
- **Spacing:** 4-pt base. Card padding 16 px (mobile) / 24 px (≥ `sm`). Grid gaps 16 / 24.
- **Radius:** controls `0.9rem`, cards `1.6rem`, dialogs `1.75rem`, pills and avatars fully round.
- **Elevation:** cards are flat (no border, no shadow, `--surface` on black). Glow (`--shadow-glow`) only on primary buttons and chart bars; popovers and dialogs use `--shadow-pop`; the mobile bar uses `--shadow-nav`.
- **Card anatomy:** title row (H2, optional action) with a `--line` divider spanning the full card width, then the content.
- **Breakpoints:** Tailwind defaults (`sm 640`, `md 768`, `lg 1024`, `xl 1280`).
- **Navigation:** `≥ lg` left sidebar with wordmark, the destinations (Home, Subscriptions, Calendar, Analytics, Reminders, Settings), an "Add subscription" button and the account block. `< lg` a floating translucent bar: two destinations, a raised circular gradient **"+"** button (`aria-label="Add subscription"`), then the remaining destinations; the header carries the wordmark, the reminder tray and the account menu. `aria-current="page"` marks the active item.
- **Touch targets:** ≥ 44 px on touch; dense rows ≥ 24 px (WCAG 2.2 target size).
- **No horizontal overflow:** `min-width: 0` on flex/grid children and truncation with a text fallback; verified at 320 px in Playwright.

## 5. Motion
Subtle only (hover/press transitions, loading pulse). Everything is disabled under `prefers-reduced-motion: reduce`. Charts do not animate.

## 6. Components
Implemented locally in `apps/web/src/components/` (custom accessible dialog and menus, inline SVG icons, hand-written SVG/CSS charts — no Radix, lucide or Recharts).

### 6.1 Inventory

| Component | Notes |
|---|---|
| **Button / LinkButton** | `primary` (gradient + glow), `secondary` (raised fill), `ghost`, `danger`; sizes `md`, `sm`; loading state keeps width and sets `aria-busy` |
| **Fields** | Visible `<label>`, hint, error linked by `aria-describedby`, `aria-invalid`; border `--line-strong`; money input parses to integer minor units |
| **SegmentedField / pill toggles** | Native radio group styled as a pill control; selected segment uses the gradient |
| **Card / CardHeader** | See card anatomy (§4) |
| **Stat tile (`Kpi`)** | Title row + divider, then a large coloured figure and a one-line note |
| **Rings** | Up to three concentric rounded rings (top categories of the preferred currency, by rank colour); decorative, with the same numbers written beside it |
| **Donut** | Single ring split by category; decorative |
| **BucketBars** | Gradient bars with dashed gridlines, text summary (`role="img"`) and a "View as table" toggle |
| **CategoryBars** | List first (dot, name, amount, %), proportional bar under each |
| **Status badges** | active / trial / paused / cancelled / archived, **always icon + text** |
| **ServiceIcon** | Sizes `xs` (calendar), `md`, `lg`: bundled brand logo (light tile, brand colour) / emoji / uploaded picture / category-tinted letter tile; always `aria-hidden` with the name adjacent as text |
| **Calendar** | Month grid of day buttons; renewal days show up to three logos or pictures (a coloured dot where a subscription has only a letter or emoji, so the visible text always matches the button's label); trial endings get a dashed outline; the selected day's items are listed below, and the whole range is also a text list |
| **Dialog / ConfirmDialog** | Focus trap, Escape closes and restores focus; destructive confirms state the consequence |
| **Toast** | `role="status"`, auto-dismiss with pause on hover/focus |
| **Skeleton / EmptyState / ErrorState** | Skeletons match final dimensions; error state has a safe message and Retry |
| **KindTag** | Screen-reader-only label (§6.4) |

### 6.2 Focus & keyboard
- `:focus-visible` ring: 2 px `--focus`, 2 px offset; never removed. A skip link is first in tab order.
- Menus, segmented controls and the calendar grid follow the WAI-ARIA keyboard patterns (the calendar's arrow / Page Up / Page Down / Home / End keys work; the instructions are no longer printed on screen). Dialogs trap focus.

### 6.3 Forms
- Validation uses the same Zod schemas as the API; errors on blur and submit; the first invalid field is focused; an error summary (`role="alert"`) appears for multi-field failures.
- Submit buttons show a loading state and are disabled during the request; server errors are mapped to fields, otherwise shown as a form-level message.
- The subscription form offers type-ahead suggestions and a "paste a link" lookup (never filling price or date), a live monthly-equivalent preview, and an optional picture upload.
- The payment-method field says: "Label only — never enter card numbers."

### 6.4 Truth labels (`KindTag` semantics)
| Kind | Meaning (screen-reader text) |
|---|---|
| **Recorded** | "Based on payments you recorded. SubCycle does not verify them with your bank or the provider." |
| **Estimate** | "Calculated from current prices; may differ from what you were actually charged." |
| **Projection** | "Looking forward from today, assuming nothing changes." |

Attached to: stat tiles, chart and list cards, analytics sections, calendar ranges. Not drawn visually. Exports document `monthly_equivalent` as an estimate.

## 7. Charts
| Chart | Type | Rules |
|---|---|---|
| **Recorded payments by month** (Home) | Bars, last 12 months | Starts at zero; **the card is hidden until at least one payment is recorded** (an empty chart says nothing; the Recent-payments card and Analytics explain how to record one) |
| **Recorded spending** (Analytics) | Bars by month or week, with totals | Shows an explanatory empty state when nothing is recorded; never zero-fills to imply data |
| **Monthly equivalent** (Home) | Concentric rings + labelled figures | Top three categories by share, in the preferred currency; per-category amounts are shown only when there are two or more |
| **Spending by category** | Ranked list with bars | List is the accessible primary form |

Every chart has a `role="img"` summary sentence and a table alternative. Currencies are never combined: each currency is its own series, picked with a Currency select when there is more than one.

## 8. Page layouts
- **Home:** greeting block (date overline, large title, one-line note, "Add subscription" button hidden on phones because of the central "+"); full-width **Monthly equivalent** card (rings + category figures); a row of three stat tiles (Annualized cost, Active subscriptions, Renewing in 7 days); Recorded payments (only when there are any) beside Spending by category; Upcoming renewals (7/30/90-day pills) beside Recent payments and Recently added.
- **Subscriptions:** filter card (search, status, category, frequency, currency, renewal window, price range, sort) above rounded list rows; pagination footer.
- **Detail:** header card (logo, name, status, price, actions), Billing, Projected renewals, Recorded payments with "Record payment", Price history, and a destructive Delete section.
- **Calendar:** range pills (Month / 7 / 30 / 90 days), range summary, month grid with logos, selected-day list.
- **Analytics, Reminders, Settings:** stacked cards with title rows; Settings holds Region (currency, time zone), Reminders summary, Account, Change password, Delete account.
- **Sign-in / Register:** centred wordmark and a single card.

## 9. Content & tone
- Plain, calm, specific. No exclamation marks, no gamification, no fear copy.
- The greeting uses the user's time zone (morning / afternoon / evening).
- Money always shows its currency code and cadence ("₹649.00 INR / month").
- Cancellation copy never implies SubCycle acted externally ("Record cancellation", "You marked this cancelled on …").

**Empty states**

| Where | Message |
|---|---|
| Home, no subscriptions | "Nothing tracked yet…" with an Add subscription button |
| Home, no recorded payments | The Recorded-payments card is hidden; Recent payments says "Nothing recorded yet. Only payments you record appear here." |
| Analytics, no payments | "No payments recorded yet" with how to record one |
| Upcoming, none in the window | "No renewals in the next N days." |
| Subscriptions, no matches | "No subscriptions match these filters." with Clear filters |
| Reminders inbox, none | "No reminders yet…" |

## 10. Iconography & imagery
Icons are small inline SVGs (`components/ui/Icon.tsx`), `aria-hidden` next to text. Brand logos are bundled (Simple Icons and SVG Logos, CC0; trademarks of their owners) and never fetched; users may upload their own picture (≤ 40 KB, PNG/JPEG/WebP). Wordmark: "SubCycle" in Inter semibold with an in-house circular-arrow mark.

## 11. Implementation notes
- Tokens are CSS variables in `index.css`, exposed to Tailwind through `@theme inline`; the gradient is the `bg-accent-grad` utility. `index.html` sets `data-theme="dark"`; nothing switches it.
- Components are unit-tested with RTL (roles, states) and the whole app is exercised in a real browser with axe by Playwright. Visual-regression testing is out of scope.
- There is no `/dev/design` route; the system is documented here and exercised through the real pages.
