# SubCycle — Design System

A premium **financial utility** feel: calm, dark, numeric, precise. Not a generic admin dashboard. Primary visual direction: dark charcoal surfaces with a single soft-lime accent. (The dashboard reference image was not attached; this system is derived from the specified palette and layout description. Share the image and I'll reconcile differences in Stage 6.)

Companion: [SPEC.md](SPEC.md). Implemented in Stage 6 as Tailwind theme tokens (CSS variables) + local components in `apps/web/src/components/ui/`.

> **Implementation note (Stage 6):** the components below are implemented in `apps/web` without Radix UI, lucide or Recharts (custom accessible dialog, inline SVG icons, hand-written SVG/CSS charts). See [FRONTEND.md](FRONTEND.md).

## 1. Principles
1. **Numbers are the hero.** Large tabular figures in lime; labels small and muted.
2. **One accent.** Lime = primary action, selected nav, key numbers, progress. Everything else is neutral.
3. **Label the truth.** Every figure carries a kind tag: *Estimate*, *Projection*, or *Recorded* (§6.4).
4. **Restraint.** Rounded cards, hairline borders, minimal shadow, generous spacing.
5. **Accessible by construction.** Contrast-checked tokens, visible focus, no colour-only meaning.

## 2. Colour tokens

All ratios below were **computed** (WCAG relative luminance) during Stage 2.

### 2.1 Dark theme (default)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#111310` | App background |
| `--surface` | `#20231D` | Cards, panels |
| `--surface-raised` | `#292D25` | Popovers, menus, hovered rows, dialogs |
| `--border` | `#363B31` | Decorative hairlines (cards, dividers) |
| `--border-strong` | `#6B7566` | Input borders, interactive boundaries (≥ 3:1 on surface) |
| `--text` | `#F3F4EE` | Primary text |
| `--text-muted` | `#A3AB9C` | Secondary text (grey-green) |
| `--text-subtle` | `#8A9384` | Placeholders, captions (use on `--bg`/`--surface` only) |
| `--accent` | `#C4E66A` | Primary fill, key numbers, selected nav, focus ring |
| `--accent-fg` | `#111310` | Text/icons on accent fill |
| `--accent-soft` | `rgba(196,230,106,.14)` | Selected-item tint, chart area fill |
| `--danger` | `#F2877E` | Destructive, failed, errors |
| `--danger-soft` | `#2B1F1D` | Danger tint background |
| `--warning` | `#E9C46A` | Trial ending, attention |
| `--info` | `#7FB7E6` | Neutral info, estimates tag |
| `--focus` | `#C4E66A` | 2 px focus ring, 2 px offset on `--bg` |

**Measured contrast (dark):**

| Pair | Ratio | Requirement |
|---|---|---|
| `--text` on bg / surface / raised | 16.9 / 14.4 / 12.7 | 4.5 ✅ |
| `--text-muted` on bg / surface / raised | 7.9 / 6.7 / 5.9 | 4.5 ✅ |
| `--text-subtle` on bg / surface | 5.9 / 5.0 | 4.5 ✅ (**not** on raised: 4.4 → use `--text-muted` there) |
| `--accent` on bg / surface | 13.2 / 11.3 | 4.5 ✅ |
| `--accent-fg` on `--accent` | 13.2 | 4.5 ✅ |
| `--danger` on surface | 6.5 | 4.5 ✅ · `--warning` 9.5 ✅ · `--info` 7.4 ✅ |
| `--border-strong` on surface | 3.3 | 3.0 (UI components) ✅ |
| `--border` on surface | 1.4 | decorative only — never the sole indicator of a control |

*Fixed during design:* an initial `#7C8576` subtle text measured 4.15 on cards and failed; replaced with `#8A9384`.

### 2.2 Light theme (user preference: dark / light / system)

| Token | Hex | Contrast |
|---|---|---|
| `--bg` | `#F6F7F2` | — |
| `--surface` | `#FFFFFF` | — |
| `--surface-raised` | `#FFFFFF` + shadow | — |
| `--border` | `#E1E4DA` | decorative |
| `--border-strong` | `#8A9384` | 3.2 on surface ✅ |
| `--text` | `#161912` | 17.8 / 16.5 on surface / bg ✅ |
| `--text-muted` | `#5B6455` | 6.2 / 5.7 ✅ |
| `--text-subtle` | `#6B7566` | 4.8 on surface ✅ |
| `--accent` (fills) | `#C4E66A` | button text `#111310` 13.2 ✅ |
| `--accent-text` (numbers/links on light) | `#3F5F0A` | 7.4 / 6.8 ✅ — lime itself is too light for text on white, so numbers use this |
| `--danger` | `#B3261E` | 6.5 ✅ · `--warning` `#8A5A00` 5.9 ✅ |

Dark is the designed-first experience; light is a faithful inversion of the same roles.

### 2.3 Category & chart palette
Categorical (dark theme, each ≥ 5:1 on `--surface`): lime `#C4E66A`, sky `#7FB7E6`, amber `#E9A46A`, violet `#B69CF0`, teal `#6FD3C0`, pink `#F28DB2`, neutral `#8E9788` (for "Other" and overflow).
- Max **6 distinct slices** + "Other" aggregation; categories map to a stable colour via a fixed table so colours never reshuffle between renders.
- **Colour is never the only encoding:** every series has direct labels or a legend with values; slices have percentage + amount text.
- Light theme uses darker equivalents (same hues, ≥ 4.5:1 on white) — derived and verified in Stage 6.

## 3. Typography

- **Family:** Inter Variable, self-hosted via `@fontsource-variable/inter` (no third-party font requests; privacy + CSP `font-src 'self'`). Fallback `ui-sans-serif, system-ui`.
- **Numerals:** `font-variant-numeric: tabular-nums` for all money and dates so columns align; large KPI numbers use `font-feature-settings: "ss01"` off, weight 600, letter-spacing −0.02em.
- Scale (rem, line-height): 

| Role | Size / LH | Weight | Notes |
|---|---|---|---|
| Display (KPI figure) | 2.25 / 1.1 (mobile) → 2.75 / 1.05 (≥ md) | 600 | lime |
| H1 page title | 1.75 / 1.2 | 600 | one per page |
| H2 section | 1.125 / 1.3 | 600 | card titles |
| H3 | 1 / 1.4 | 600 | |
| Body | 0.9375 / 1.5 | 400 | default |
| Small / caption | 0.8125 / 1.4 | 500 | labels, kind tags |
| Overline | 0.75 / 1.2, uppercase +0.06em | 600 | KPI labels |

- Minimum body text 15 px; minimum caption 13 px. Respects user font scaling (rem-based; layouts tested at 200% zoom).

## 4. Spacing, shape, elevation, layout

- **Spacing:** 4-pt base: 4, 8, 12, 16, 20, 24, 32, 40, 56. Card padding 16 (mobile) / 24 (≥ md). Grid gap 12 / 16 / 24.
- **Radius:** controls 12, cards 20, chips/pills 999, dialogs 24, avatars/icon tiles 12.
- **Elevation:** cards are flat (`1px solid --border`), no shadow. Popovers/dialogs: `0 8px 24px rgba(0,0,0,.45)` on dark; `0 8px 24px rgba(22,25,18,.12)` on light. Scrim `rgba(0,0,0,.6)`.
- **Breakpoints:** `sm 640`, `md 768`, `lg 1024`, `xl 1280`. Content max-width 1200 px, centered.
- **Navigation:** `< lg` fixed bottom bar (5 items: Home, Subscriptions, Calendar, Analytics, Profile; 64 px + safe-area inset; lime pill + label on active; `aria-current="page"`); `≥ lg` left sidebar (240 px) with wordmark, nav, and "+ Add subscription"; top header carries page title, reminder tray, profile menu. Mobile header: wordmark + reminder tray + profile; a floating-free layout (CTA lives in page header and bottom-nav-adjacent action row, avoiding content overlap).
- **Touch targets:** ≥ 44×44 px on touch; ≥ 36 px on pointer devices for dense rows.
- **No horizontal overflow:** `min-width: 0` on flex/grid children, text truncation with `title`/`aria-label` fallback, tables become stacked cards `< md`. Verified at 320 px in Playwright (Stage 9).

## 5. Motion
Subtle only: 150 ms ease-out for hover/press/popover; 250 ms number count/chart draw (disabled). All motion disabled under `prefers-reduced-motion: reduce`. Skeletons use a static shimmer-free pulse that also stops under reduced motion.

## 6. Components

All local, composed from Radix UI primitives where behaviour is non-trivial (Dialog, Dropdown Menu, Select, Tabs, Toast, Tooltip, Popover) for correct focus management and ARIA; styled with Tailwind. (Radix is MIT-licensed, unstyled, widely audited.)

### 6.1 Inventory & states

| Component | Variants / notes |
|---|---|
| **Button** | `primary` (lime fill, `--accent-fg`), `secondary` (surface-raised + border-strong), `ghost`, `danger`; sizes `md` (44), `sm` (36); states: hover, active, focus-visible ring, disabled, **loading** (spinner, width preserved, `aria-busy`) |
| **IconButton** | Requires `aria-label`; 44 px hit area |
| **Input / Textarea / Select / DatePicker / MoneyInput** | Visible `<label>`, optional hint, error text linked via `aria-describedby`, `aria-invalid`; border `--border-strong`; **MoneyInput** parses decimals → minor units using the currency exponent, shows currency adornment |
| **SegmentedControl** | Frequency, theme, range (7/30/90) — roving tabindex radio-group semantics |
| **Chip / Badge** | Status badges: active (lime-soft), trial (warning), paused (info), cancelled (danger-soft), archived (neutral). **Always icon + text**, never colour alone |
| **KindTag** | `Estimate` / `Projection` / `Recorded` — tiny pill with tooltip definition (§6.4) |
| **Card** | `surface`, radius 20, optional header (H2 + action) |
| **KPICard** | Overline label, display figure (lime), sub-line (e.g. "≈ ₹X /yr"), `KindTag` |
| **ServiceIcon** | 40 px tile radius 12: **bundled brand logo** (glyph key; light `#F3F4EE` tile, brand colour, near-black when the brand colour is very light) / emoji / **letter-avatar fallback** (category-tinted background; initial; `aria-hidden`, name always adjacent as text) |
| **SubscriptionRow** | Icon · name · category · amount + `/mo` etc. · next date · status badge; whole row is one link; keyboard-focusable |
| **RenewalItem** | Icon · name · amount · "in 3 days — Sat 25 Oct" · frequency chip; trial items show "Trial ends" in warning with icon |
| **Dialog / ConfirmDialog** | Focus trap, ESC closes, returns focus; destructive confirm requires explicit verb button ("Delete permanently") and states consequence |
| **Toast** | Live region (`role=status`), 5 s, action slot ("Undo" where reversible), pause on hover/focus |
| **Skeleton** | Matches final layout dims to prevent layout shift |
| **EmptyState** | Icon, title, one-line explanation, primary CTA (copy in §8) |
| **ErrorState** | Safe message, request id (small), **Retry** button |
| **Tabs / Pagination / FilterBar / SearchField** | FilterBar collapses into a bottom-sheet dialog `< md` |
| **Calendar (month grid)** | Grid with day buttons; dots + count per day; each day's renewals listed below grid on select (mobile) / in side panel (desktop); also exposed as a text list for screen readers |
| **ReminderTray** | Popover from bell; unread count badge with `aria-label="3 unread reminders"` |

### 6.2 Focus & keyboard
- `:focus-visible` ring: 2 px `--focus`, 2 px offset; never removed. Skip-link ("Skip to content") first in tab order.
- Menus/tabs/segmented controls follow WAI-ARIA APG keys. Dialogs trap focus. Every action reachable and operable by keyboard (verified with Playwright keyboard-only flow + axe in Stage 9).

### 6.3 Forms
- Validation: Zod schema shared with API; errors on blur and on submit; first invalid field focused on submit; an error summary region (`role=alert`) for multi-field failures.
- Submit button shows loading and is disabled during request; server errors map to fields via `details[].path`, otherwise a form-level message.
- Subscription form shows a **live monthly-equivalent preview** labelled *Estimate*.
- Payment-method field has helper text: "Label only — never enter card numbers."

### 6.4 Truth labels (KindTag semantics)
| Tag | Colour | Tooltip text |
|---|---|---|
| **Recorded** | lime-soft | "Based on payments you recorded." |
| **Estimate** | info | "Calculated from current prices; may differ from what you were charged." |
| **Projection** | info | "Looking forward from today assuming nothing changes." |
Appears on: KPI cards, chart titles, analytics rows, export column headers (`monthly_equivalent` is documented as an estimate).

## 7. Charts (Recharts, themed with tokens)

| Chart | Type | Rules |
|---|---|---|
| **Recorded payments by month** | Bar (not smoothed line — discrete monthly totals), last 12 months | Single lime series; y-axis starts at 0; value label on hover/focus and for the latest bar; title carries `Recorded` tag; empty state if no payments (never zero-filled to imply data) |
| **Spending by category** | Horizontal bar list **or** donut + list (donut only ≤ 6 slices) | Each row: colour dot, name, amount, % — list is the primary accessible form |
| **Upcoming totals** | Stacked mini-bars for 7/30/90 | `Projection` tag |
| **What-if savings** | Summary stat + checklist | No chart needed |

Accessibility for every chart: `role="img"` + `aria-label` summary sentence ("Recorded spending over the last 12 months totals ₹X; highest month March at ₹Y"), plus a **"View as table"** toggle exposing the same data in a `<table>`. Axis text ≥ 12 px, `--text-muted`; gridlines `--border`; tooltips `--surface-raised`. Responsive container; chart height 200 (mobile) / 280 (desktop); axis ticks thin out on narrow widths to avoid overlap.

## 8. Page layouts

### 8.1 Dashboard — mobile (< lg)
```
┌────────────────────────────┐
│ SubCycle            🔔  (A)│  header
│ Good evening, Asha         │  H1 greeting
│ Here's your subscription   │
│ picture.                   │
│ [ + Add subscription ]     │  primary CTA
│ ┌────────────────────────┐ │
│ │ MONTHLY (EQUIVALENT)   │ │  KPI (hero, lime figure)
│ │ ₹4,280        Estimate │ │
│ │ ≈ ₹51,360 / yr  Proj.  │ │
│ └────────────────────────┘ │
│ ┌──────────┐ ┌───────────┐ │
│ │ ACTIVE   │ │ RENEWING  │ │  2-up KPIs
│ │ 12       │ │ IN 7 DAYS │ │
│ │          │ │ 3 · ₹899  │ │
│ └──────────┘ └───────────┘ │
│ Upcoming renewals   View all│
│  ▢ Netflix  ₹649  Sat 25   │
│  ▢ Spotify  ₹119  Mon 27   │
│ Recorded payments by month  │  chart
│ Spending by category        │
│ Recent payments             │
│ Recently added              │
├────────────────────────────┤
│ Home Subs Cal Analytics Me │  bottom nav
└────────────────────────────┘
```

### 8.2 Dashboard — desktop (≥ lg)
```
┌─────────┬──────────────────────────────────────────────────┐
│ SubCycle│ Good evening, Asha              🔔  (A) ▾         │
│  Home   │ [+ Add subscription]                              │
│  Subs   │ ┌──────────┬──────────┬──────────┬──────────┐    │
│  Cal    │ │ Monthly  │ Annualized│ Active   │ Next 7 d │    │  4 KPIs
│  Analyt.│ └──────────┴──────────┴──────────┴──────────┘    │
│  Profile│ ┌───────────────────────────┬─────────────────┐  │
│         │ │ Recorded payments / month │ Upcoming        │  │
│         │ │ (bars, 8 cols)            │ renewals (4 col)│  │
│         │ ├──────────────┬────────────┤                 │  │
│         │ │ By category  │ Recent     ├─────────────────┤  │
│         │ │              │ payments   │ Recently added  │  │
│         │ └──────────────┴────────────┴─────────────────┘  │
└─────────┴──────────────────────────────────────────────────┘
```
12-column grid, `gap-6`; widgets reflow to 2 columns at `md`, 1 at `< md`.

### 8.3 Other pages (patterns)
- **Library:** sticky search + filter bar; rows (desktop table-like grid, mobile cards); filter chips show active filters with clear-all; sort in a select; pagination footer; skeleton rows while loading.
- **Detail:** header card (icon, name, badges, price/frequency, next billing + "in N days"); action bar (Edit · Pause/Resume · Record cancellation · Archive/Restore · Delete in a menu, destructive last); sections: Payments (table → cards), Price history, Notes & cancellation link ("Open official cancellation page ↗" — copy: "Cancelling happens on their site. Come back and record it once done.").
- **Calendar:** segmented `Month | 7d | 30d | 90d`; totals header per window labelled `Projection`.
- **Settings:** grouped cards (Profile, Preferences, Reminders, Data & privacy, Danger zone). Reminder section states whether email is configured: "Email reminders aren't available on this server (no email provider configured). You'll still get in-app reminders."

## 9. Content & tone
- Plain, calm, specific. No exclamation marks, no gamification, no fear copy.
- Greeting uses the user's timezone for morning/afternoon/evening.
- Money copy always includes the cadence ("₹649 / month"); the monthly equivalent is a secondary line when cadence differs.
- Cancellation copy never implies SubCycle acted externally ("Record cancellation", "You marked this cancelled on …").

**Empty states**

| Where | Message | CTA |
|---|---|---|
| Dashboard, no subscriptions | "Nothing tracked yet. Add your first subscription to see your monthly picture." | + Add subscription |
| Trend chart, no payments | "No payments recorded yet. This chart shows only payments you record — nothing is estimated." | Record a payment |
| Upcoming, none in 7 days | "No renewals in the next 7 days." | View calendar |
| Library, no results | "No subscriptions match these filters." | Clear filters |
| Payments, none | "No payments recorded for this subscription." | Record payment |
| Usage insight, none entered | "Rate how often you use each subscription to see which ones you barely use." | Review subscriptions |

## 10. Iconography & imagery
`lucide-react` (ISC) for UI icons, 20 px default, 1.75 stroke, `aria-hidden` when adjacent to text. Brand logos are bundled Simple Icons artwork for services in the built-in list (§SPEC 4.11), never fetched. Wordmark: "SubCycle" set in Inter 600 with a lime cycle glyph (circular arrow in a ring) — simple SVG authored in-house.

## 11. Implementation notes (Stage 6)
- Tailwind theme extends colours with CSS variables (`rgb(var(--…) / <alpha>)` pattern), so dark/light/system switch by `data-theme` on `<html>` plus `prefers-color-scheme` for `system`; initial theme applied by a tiny inline-free script alternative (cookie/`localStorage` read before paint via an external `/theme-init.js` to satisfy strict CSP).
- Components are unit-tested with RTL (states, a11y roles); visual regressions are out of v1 scope.
- A `/dev/design` route is **not** shipped; the system is documented here and exercised through real pages.
