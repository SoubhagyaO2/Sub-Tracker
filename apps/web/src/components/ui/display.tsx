import { BRAND_ICONS } from '../../lib/brandIcons.generated';
import type { ReactNode } from 'react';
import type { Category, DateOnly, SubscriptionDto, SubscriptionStatus } from '@subcycle/shared';
import { ApiError } from '../../api/client';
import { formatDate, relativeDay } from '../../lib/dates';
import { CATEGORY_LABEL, CATEGORY_SLOT, STATUS_LABEL } from '../../lib/labels';
import { formatMoney } from '../../lib/money';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export function Card({ children, className = '', as: Tag = 'section', ...rest }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'li'; 'aria-labelledby'?: string }) {
  return (
    <Tag className={`min-w-0 rounded-card border border-line bg-surface p-4 sm:p-6 ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ id, title, tag, action }: { id: string; title: string; tag?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={id} className="text-base">
          {title}
        </h2>
        {tag}
      </div>
      {action}
    </div>
  );
}

// ───────────── truth labels ─────────────

const KIND_STYLE = {
  recorded: 'border-accent-text/50 bg-accent-soft text-accent-text',
  estimate: 'border-info/50 bg-info-soft text-info',
  projection: 'border-info/50 bg-info-soft text-info',
} as const;
const KIND_HELP = {
  recorded: 'Based on payments you recorded. SubCycle does not verify them with your bank or the provider.',
  estimate: 'Calculated from current prices; may differ from what you were actually charged.',
  projection: 'Looking forward from today, assuming nothing changes.',
} as const;
export type Kind = keyof typeof KIND_STYLE;

/** Marks every figure as Recorded, Estimate or Projection so the three are never confused. */
export function KindTag({ kind }: { kind: Kind }) {
  return (
    <span title={KIND_HELP[kind]} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${KIND_STYLE[kind]}`}>
      {kind === 'recorded' ? 'Recorded' : kind === 'estimate' ? 'Estimate' : 'Projection'}
      <span className="sr-only">. {KIND_HELP[kind]}</span>
    </span>
  );
}

/** Amount with its currency code always visible, so currencies are never ambiguous. */
export function Money({ minor, currency, className = '', sign = false }: { minor: number; currency: string; className?: string; sign?: boolean }) {
  const { amount, code } = formatMoney(Math.abs(minor), currency);
  const prefix = minor < 0 ? '−' : sign && minor > 0 ? '+' : '';
  return (
    <span className={`tnum whitespace-nowrap ${className}`}>
      {prefix}
      {amount} <span className="text-[0.7em] font-medium uppercase tracking-wide text-muted">{code}</span>
    </span>
  );
}

export function DateText({ date, today, relative = true }: { date: DateOnly; today: DateOnly; relative?: boolean }) {
  return (
    <span className="tnum">
      <time dateTime={date}>{formatDate(date)}</time>
      {relative ? <span className="text-muted"> · {relativeDay(date, today)}</span> : null}
    </span>
  );
}

const STATUS_STYLE: Record<SubscriptionStatus, { cls: string; icon: IconName }> = {
  active: { cls: 'border-accent-text/50 bg-accent-soft text-accent-text', icon: 'check' },
  trial: { cls: 'border-warn/50 bg-warn-soft text-warn', icon: 'clock' },
  paused: { cls: 'border-info/50 bg-info-soft text-info', icon: 'pause' },
  cancelled: { cls: 'border-danger/50 bg-danger-soft text-danger', icon: 'ban' },
  archived: { cls: 'border-strong bg-raised text-muted', icon: 'archive' },
};

/** Status is always icon + text, never colour alone. */
export function StatusBadge({ status }: { status: SubscriptionStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${s.cls}`}>
      <Icon name={s.icon} className="h-3.5 w-3.5" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Brand logos shown on a light tile in the logo's own colour (very light brand colours fall back to near-black for contrast). */
const readableFill = (hex: string): string => {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.75 ? '#111310' : `#${hex}`;
};

/**
 * Service icon: a built-in brand logo (icon kind "glyph", bundled with the app: nothing is fetched from anywhere), an emoji,
 * or a letter tile. Always decorative: the service name is shown next to it.
 */
export function ServiceIcon({ subscription, size = 'md' }: { subscription: Pick<SubscriptionDto, 'name' | 'icon' | 'category'>; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-14 w-14 text-2xl' : 'h-10 w-10 text-lg';
  const brand = subscription.icon?.kind === 'glyph' ? BRAND_ICONS[subscription.icon.value] : undefined;
  if (brand) {
    return (
      <span aria-hidden="true" data-logo={subscription.icon!.value} className={`flex ${box} shrink-0 items-center justify-center rounded-control bg-[#F3F4EE] ring-1 ring-black/10`}>
        <svg viewBox="0 0 24 24" className="h-[58%] w-[58%]" fill={readableFill(brand.hex)} focusable="false">
          <path d={brand.path} />
        </svg>
      </span>
    );
  }
  if (subscription.icon?.kind === 'emoji') {
    return (
      <span aria-hidden="true" className={`flex ${box} shrink-0 items-center justify-center rounded-control bg-raised`}>
        {subscription.icon.value}
      </span>
    );
  }
  const slot = CATEGORY_SLOT[subscription.category as Category] ?? 7;
  return (
    <span
      aria-hidden="true"
      className={`flex ${box} shrink-0 items-center justify-center rounded-control font-semibold`}
      style={{ background: `color-mix(in srgb, var(--cat-${slot}) 20%, var(--raised))`, color: `var(--cat-${slot})` }}
    >
      {subscription.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

// ───────────── states ─────────────

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

/** Wraps skeletons so assistive tech hears one "Loading" instead of many empty boxes. */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      {children}
      <span className="sr-only">{label}</span>
    </div>
  );
}

type Level = 1 | 2 | 3;
const heading = (level: Level): 'h1' | 'h2' | 'h3' => (level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3');

/** `level` keeps the document outline correct: 1 when the state IS the page, 2 right under a page title, 3 inside a card. */
export function EmptyState({ title, children, action, icon = 'info', level = 3 }: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName; level?: Level }) {
  const H = heading(level);
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-strong px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-raised text-muted">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <H className="text-base">{title}</H>
      {children ? <p className="max-w-md text-sm text-muted">{children}</p> : null}
      {action}
    </div>
  );
}

/** A safe, actionable error with Retry. Server messages are already safe to show (no internals). */
export function ErrorState({ error, onRetry, title = 'Something went wrong', level = 3 }: { error: ApiError; onRetry?: () => void; title?: string; level?: Level }) {
  const H = heading(level);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-card border border-danger bg-danger-soft p-5">
      <div className="flex items-center gap-2 text-danger">
        <Icon name="alert" />
        <H className="text-base">{title}</H>
      </div>
      <p className="text-sm text-fg">{error.message}</p>
      {error.requestId ? <p className="text-xs text-muted">Reference: {error.requestId}</p> : null}
      {onRetry ? (
        <Button onClick={onRetry} size="sm">
          <Icon name="refresh" className="h-4 w-4" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage, label = 'Pagination' }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; label?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <nav aria-label={label} className="flex items-center justify-between gap-3 pt-4">
      <Button size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        <Icon name="chevron-left" className="h-4 w-4" />
        Previous
      </Button>
      <p className="text-sm text-muted" aria-live="polite">
        Page {page} of {pages} <span className="hidden sm:inline">· {total} results</span>
      </p>
      <Button size="sm" onClick={() => onPage(page + 1)} disabled={page >= pages}>
        Next
        <Icon name="chevron-right" className="h-4 w-4" />
      </Button>
    </nav>
  );
}

export { CATEGORY_LABEL };
