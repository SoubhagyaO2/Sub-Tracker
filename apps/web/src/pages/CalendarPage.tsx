import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { MAX_CALENDAR_OCCURRENCES, addDays, type CalendarOccurrence, type CalendarResponseMeta, type DateOnly } from '@subcycle/shared';
import { calendarApi } from '../api/endpoints';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, DateText, EmptyState, ErrorState, KindTag, LoadingRegion, Money, ServiceIcon, Skeleton } from '../components/ui/display';
import { Icon } from '../components/ui/Icon';
import { firstOfMonth, formatMonthTitle, lastOfMonth, mondayIndex, monthOf, monthWeeks, shiftMonth, weekdayHeadings } from '../lib/calendarGrid';
import { BRAND_ICONS } from '../lib/brandIcons.generated';
import { formatDate } from '../lib/dates';
import { CATEGORY_SLOT, FREQUENCY_UNIT } from '../lib/labels';
import { useApi } from '../state/data';
import { usePageTitle, useToday } from '../state/ui';

type View = 'month' | 7 | 30 | 90;

function group(items: CalendarOccurrence[]): Map<DateOnly, CalendarOccurrence[]> {
  const byDate = new Map<DateOnly, CalendarOccurrence[]>();
  for (const o of items) byDate.set(o.date, [...(byDate.get(o.date) ?? []), o]);
  return byDate;
}

/** A picture or bundled logo can sit inside a day cell; letters and emoji would add visible text the button's label does not contain, so those get a coloured dot. */
function DayMark({ o }: { o: CalendarOccurrence }) {
  const hasImage = o.icon?.kind === 'image' || (o.icon?.kind === 'glyph' && Boolean(BRAND_ICONS[o.icon.value]));
  if (hasImage) return <ServiceIcon subscription={o} size="xs" />;
  return <span className="block h-2 w-2 rounded-full" style={{ background: `var(--cat-${CATEGORY_SLOT[o.category as keyof typeof CATEGORY_SLOT] ?? 7})` }} />;
}

function OccurrenceRow({ o }: { o: CalendarOccurrence }) {
  return (
    <li>
      <Link to={`/subscriptions/${o.subscriptionId}`} className="flex items-center gap-3 rounded-control py-2.5 !text-fg no-underline hover:bg-raised sm:px-2">
        <ServiceIcon subscription={o} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{o.name}</span>
          <span className="block text-xs text-muted">{o.kind === 'trial_end' ? 'Free trial ends' : 'Renewal'} · {FREQUENCY_UNIT[o.billingFrequency] ? `billed per ${FREQUENCY_UNIT[o.billingFrequency]}` : ''}</span>
        </span>
        <span className="shrink-0 text-right text-sm">
          <Money minor={o.amountMinor} currency={o.currency} />
          {o.kind === 'trial_end' ? <span className="block text-xs text-muted">charged after the trial</span> : null}
        </span>
      </Link>
    </li>
  );
}

/** What the range adds up to, per currency, labelled as a projection. Trial endings carry no charge yet. */
function Totals({ meta }: { meta: CalendarResponseMeta }) {
  return (
    <div className="space-y-1 text-sm">
      {meta.totals.length === 0 ? (
        <p className="text-muted">No renewals in this range.</p>
      ) : (
        meta.totals.map((t) => (
          <p key={t.currency}>
            <span className="tnum">{t.renewalCount}</span> {t.renewalCount === 1 ? 'renewal' : 'renewals'} · <Money minor={t.amountMinor} currency={t.currency} className="font-semibold" />
          </p>
        ))
      )}
      {meta.trialEndCount > 0 ? <p className="text-muted">{meta.trialEndCount} free {meta.trialEndCount === 1 ? 'trial ends' : 'trials end'} (no charge counted yet)</p> : null}
      {meta.truncated ? <p className="text-warn">Showing the first {MAX_CALENDAR_OCCURRENCES} of {meta.total} entries. Narrow the range to see the rest. Totals above include all of them.</p> : null}
    </div>
  );
}

export function CalendarPage() {
  usePageTitle('Calendar');
  const today = useToday();
  const [view, setView] = useState<View>('month');
  const [month, setMonth] = useState(monthOf(today));
  const [selected, setSelected] = useState<DateOnly>(today);
  const currentMonth = monthOf(today);

  const range = view === 'month' ? { from: firstOfMonth(month), to: lastOfMonth(month) } : { from: today, to: addDays(today, view) };
  const q = useApi((signal) => calendarApi.renewals(range, signal), [range.from, range.to]);

  const byDate = useMemo(() => (q.status === 'ready' ? group(q.data.items) : new Map<DateOnly, CalendarOccurrence[]>()), [q]);
  const heads = useMemo(weekdayHeadings, []);
  const weeks = useMemo(() => monthWeeks(month), [month]);

  // Keyboard: a single tab stop on the grid; arrow keys move between days; PageUp/PageDown change month.
  const cells = useRef(new Map<DateOnly, HTMLButtonElement>());
  // The date to focus once it is the rendered selection (a stale passive effect must not consume the request early).
  const focusTarget = useRef<DateOnly | null>(null);
  useEffect(() => {
    if (focusTarget.current === selected) {
      focusTarget.current = null;
      cells.current.get(selected)?.focus();
    }
  });

  const goToMonth = (ym: string, keepFocus = false) => {
    if (ym < currentMonth) return; // nothing is projected for past months
    setMonth(ym);
    const target = ym === currentMonth ? today : firstOfMonth(ym);
    setSelected(target);
    focusTarget.current = keepFocus ? target : null;
  };
  const moveTo = (date: DateOnly) => {
    const ym = monthOf(date);
    if (ym < currentMonth) return;
    if (ym !== month) setMonth(ym);
    setSelected(date);
    focusTarget.current = date;
  };
  const onGridKeyDown = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) {
      e.preventDefault();
      moveTo(addDays(selected, step[e.key]!));
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveTo(addDays(selected, -mondayIndex(selected)));
    } else if (e.key === 'End') {
      e.preventDefault();
      moveTo(addDays(selected, 6 - mondayIndex(selected)));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      goToMonth(shiftMonth(month, 1), true);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      goToMonth(shiftMonth(month, -1), true);
    }
  };

  const dayItems = byDate.get(selected) ?? [];
  const views: { value: View; label: string }[] = [{ value: 'month', label: 'Month' }, { value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl">Calendar</h1>
          <p className="mt-1 text-sm text-muted">Renewals projected from your billing schedules. These are expected dates, not confirmed charges, and past dates aren’t shown.</p>
        </div>
        <div role="group" aria-label="Calendar view" className="flex gap-1 rounded-control border border-strong bg-canvas p-1">
          {views.map((v) => (
            <button key={v.label} type="button" aria-pressed={view === v.value} onClick={() => setView(v.value)} className={`min-h-9 rounded-[0.55rem] px-3 text-sm font-semibold ${view === v.value ? 'bg-accent-grad text-accent-fg' : 'text-muted hover:text-fg'}`}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {q.status === 'error' ? (
        <ErrorState error={q.error} onRetry={q.retry} title="We couldn’t load your calendar" level={2} />
      ) : (
        <>
          <Card aria-labelledby="cal-summary-h">
            <CardHeader id="cal-summary-h" title={view === 'month' ? `Expected in ${formatMonthTitle(month)}` : `Expected in the next ${view} days`} tag={<KindTag kind="projection" />} />
            {q.status !== 'ready' ? <LoadingRegion label="Loading calendar"><Skeleton className="h-12" /></LoadingRegion> : <Totals meta={q.data.meta} />}
          </Card>

          {view === 'month' ? (
            <>
              <Card aria-labelledby="cal-grid-h">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <Button size="sm" onClick={() => goToMonth(shiftMonth(month, -1))} disabled={month <= currentMonth} aria-label="Previous month">
                    <Icon name="chevron-left" className="h-4 w-4" />
                  </Button>
                  <h2 id="cal-grid-h" className="text-base" aria-live="polite">{formatMonthTitle(month)}</h2>
                  <div className="flex gap-2">
                    {month !== currentMonth ? <Button size="sm" onClick={() => goToMonth(currentMonth)}>Today</Button> : null}
                    <Button size="sm" onClick={() => goToMonth(shiftMonth(month, 1))} aria-label="Next month">
                      <Icon name="chevron-right" className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <table role="grid" aria-labelledby="cal-grid-h" onKeyDown={onGridKeyDown} className="w-full table-fixed border-separate border-spacing-1">
                  <thead>
                    <tr>
                      {heads.map((h) => (
                        <th key={h.long} scope="col" className="pb-1 text-center text-xs font-medium text-muted">
                          <abbr title={h.long} className="no-underline">{h.short}</abbr>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {weeks.map((week, wi) => (
                      <tr key={wi}>
                        {week.map((d, di) => {
                          if (!d) return <td key={di} />;
                          const items = byDate.get(d) ?? [];
                          const renewals = items.filter((o) => o.kind === 'renewal').length;
                          const trials = items.length - renewals;
                          const past = d < today;
                          const label = `${formatDate(d)}: ${items.length === 0 ? 'nothing scheduled' : [renewals ? `${renewals} ${renewals === 1 ? 'renewal' : 'renewals'}` : '', trials ? `${trials} trial ${trials === 1 ? 'ending' : 'endings'}` : ''].filter(Boolean).join(', ')}${past ? ' (past: not projected)' : ''}`;
                          const isSelected = d === selected;
                          return (
                            <td key={d} role="gridcell" aria-selected={isSelected} className="p-0">
                              <button
                                ref={(el) => {
                                  if (el) cells.current.set(d, el);
                                  else cells.current.delete(d);
                                }}
                                type="button"
                                tabIndex={isSelected ? 0 : -1}
                                aria-label={label}
                                aria-current={d === today ? 'date' : undefined}
                                onClick={() => setSelected(d)}
                                className={`flex h-16 w-full flex-col items-center justify-center rounded-control text-sm tnum sm:h-[4.5rem] ${isSelected ? 'bg-accent-grad text-accent-fg' : past ? 'text-subtle hover:bg-raised' : 'text-fg hover:bg-raised'} ${d === today && !isSelected ? 'ring-1 ring-accent-text' : ''}`}
                              >
                                <span>{Number(d.slice(8))}</span>
                                {items.length > 0 ? (
                                  <span aria-hidden="true" className="mt-1 flex items-center justify-center -space-x-1.5">
                                    {items.slice(0, 3).map((o, i) => (
                                      <span key={i} className={`rounded-full ${o.kind === 'trial_end' ? 'outline outline-2 outline-dashed outline-accent-text' : 'ring-2 ring-surface'}`}>
                                        <DayMark o={o} />
                                      </span>
                                    ))}
                                  </span>
                                ) : null}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <Card aria-labelledby="cal-day-h">
                <CardHeader id="cal-day-h" title={formatDate(selected)} tag={<KindTag kind="projection" />} />
                {q.status !== 'ready' ? (
                  <LoadingRegion label="Loading day"><Skeleton className="h-16" /></LoadingRegion>
                ) : dayItems.length === 0 ? (
                  <p className="text-sm text-muted">{selected < today ? 'SubCycle projects forward only: it doesn’t show or guess what happened on past dates.' : 'Nothing is scheduled for this day.'}</p>
                ) : (
                  <ul className="divide-y divide-line">{dayItems.map((o) => <OccurrenceRow key={`${o.subscriptionId}-${o.kind}`} o={o} />)}</ul>
                )}
              </Card>
            </>
          ) : (
            <Card aria-labelledby="cal-list-h">
              <CardHeader id="cal-list-h" title="Upcoming" tag={<KindTag kind="projection" />} />
              {q.status !== 'ready' ? (
                <LoadingRegion label="Loading upcoming renewals"><Skeleton className="h-40" /></LoadingRegion>
              ) : q.data.items.length === 0 ? (
                <EmptyState title={`Nothing in the next ${view} days`} icon="clock">
                  Only active subscriptions renew, and free trials appear on the day they end. Paused, cancelled and archived ones don’t.
                </EmptyState>
              ) : (
                <div className="space-y-5">
                  {[...group(q.data.items)].map(([date, items]) => (
                    <section key={date} aria-labelledby={`day-${date}`}>
                      <h3 id={`day-${date}`} className="mb-1 text-sm font-semibold"><DateText date={date} today={today} /></h3>
                      <ul className="divide-y divide-line">{items.map((o) => <OccurrenceRow key={`${o.subscriptionId}-${o.kind}`} o={o} />)}</ul>
                    </section>
                  ))}
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
