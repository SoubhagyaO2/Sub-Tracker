import { useState } from 'react';
import type { Category } from '@subcycle/shared';
import type { CategoryShare } from '../lib/dashboard';
import { CATEGORY_LABEL, CATEGORY_SLOT } from '../lib/labels';
import { moneyText } from '../lib/money';
import { Money } from './ui/display';

export interface BarDatum {
  key: string;
  /** Full label for tables, tooltips and the text summary. */
  label: string;
  /** Compact label under the bar. */
  short: string;
  netMinor: number;
}

/**
 * Bars (monthly or weekly) with a text summary (role="img") and a table alternative, so the numbers are available
 * without relying on sight or colour. Bars start at zero; a bucket without records is an honest zero.
 */
export function BucketBars({ data, currency, subject, unit }: { data: BarDatum[]; currency: string; subject: string; unit: 'month' | 'week' }) {
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(1, ...data.map((d) => d.netMinor));
  const total = data.reduce((n, d) => n + d.netMinor, 0);
  const peak = data.reduce((best, d) => (d.netMinor > best.netMinor ? d : best), data[0]!);
  const summary =
    total === 0 && peak.netMinor === 0
      ? `${subject}: nothing recorded in these ${data.length} ${unit}s.`
      : `${subject}, ${data.length} ${unit}s in ${currency}: ${moneyText(total, currency)} in total; highest ${unit} ${peak.label} at ${moneyText(peak.netMinor, currency)}.`;
  const every = data.length > 16 ? 4 : data.length > 8 ? 2 : 1; // thin the labels so they never collide

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button type="button" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)} className="rounded-control px-2 py-1 text-xs font-medium text-accent-text underline">
          {asTable ? 'View as chart' : 'View as table'}
        </button>
      </div>
      {asTable ? (
        <table className="w-full text-sm">
          <caption className="sr-only">{summary}</caption>
          <thead>
            <tr className="text-left text-muted">
              <th scope="col" className="py-1 font-medium">{unit === 'week' ? 'Week starting' : 'Month'}</th>
              <th scope="col" className="py-1 text-right font-medium">Recorded ({currency})</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.key} className="border-t border-line">
                <th scope="row" className="py-1.5 text-left font-normal">{d.label}</th>
                <td className="py-1.5 text-right"><Money minor={d.netMinor} currency={currency} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div role="img" aria-label={summary}>
          <div className="flex h-40 items-end gap-1 border-b border-line" aria-hidden="true">
            {data.map((d) => (
              <div key={d.key} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.label}: ${moneyText(d.netMinor, currency)}`}>
                <div
                  className={d.netMinor < 0 ? 'rounded-t bg-danger' : 'rounded-t bg-accent-text'}
                  style={{ height: d.netMinor === 0 ? 0 : `${Math.max(3, (Math.max(0, d.netMinor) / max) * 100)}%`, minHeight: d.netMinor < 0 ? 3 : undefined }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-1" aria-hidden="true">
            {data.map((d, i) => (
              <span key={d.key} className={`min-w-0 flex-1 truncate text-center text-xs text-muted ${(data.length - 1 - i) % every === 0 ? '' : 'invisible'}`}>
                {d.short}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">Net of refunds. Failed payments are not counted.</p>
    </div>
  );
}

/** Category split as a list (the accessible form) with proportional bars. Figures are estimates. */
export function CategoryBars({ shares, currency }: { shares: CategoryShare[]; currency: string }) {
  const shown = shares.slice(0, 6);
  const rest = shares.slice(6);
  const restMinor = rest.reduce((n, s) => n + s.monthlyEquivalentMinor, 0);
  const restPct = rest.reduce((n, s) => n + s.percent, 0);
  return (
    <ul className="space-y-3">
      {shown.map((s) => (
        <Row key={s.category} slot={CATEGORY_SLOT[s.category as Category]} label={CATEGORY_LABEL[s.category]} minor={s.monthlyEquivalentMinor} percent={s.percent} currency={currency} />
      ))}
      {rest.length > 0 ? <Row slot={7} label="Other categories" minor={restMinor} percent={restPct} currency={currency} /> : null}
    </ul>
  );
}

function Row({ slot, label, minor, percent, currency }: { slot: number; label: string; minor: number; percent: number; currency: string }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--cat-${slot})` }} />
          {label}
        </span>
        <span>
          <Money minor={minor} currency={currency} />
          <span className="ml-2 text-muted tnum">{Math.round(percent)}%</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, percent)}%`, background: `var(--cat-${slot})` }} />
      </div>
    </li>
  );
}
