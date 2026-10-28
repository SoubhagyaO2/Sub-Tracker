import {
  MAX_YEAR,
  MIN_YEAR,
  compareDates,
  createSubscriptionSchema,
  isValidDateOnly,
  parseDateOnly,
  updateSubscriptionSchema,
  validateSubscriptionState,
  type BillingFrequency,
  type Category,
  type CreateSubscriptionInput,
  type CurrencyCode,
  type SubscriptionDto,
  type UpdateSubscriptionInput,
  type UsageLevel,
} from '@subcycle/shared';
import { fieldErrorsFromIssues, type FieldErrors } from './forms';
import { minorToInput, parseMoneyInput } from './money';
import { BRAND_ICONS } from './brandIcons.generated';

/** What the form holds: strings exactly as typed (money as decimal text, dates as YYYY-MM-DD or ''). */
export interface SubscriptionFormValues {
  name: string;
  category: Category;
  amountMinor: string;
  currency: CurrencyCode;
  billingFrequency: BillingFrequency;
  status: 'active' | 'trial';
  nextBillingDate: string;
  trialEndDate: string;
  startDate: string;
  anchorDate: string;
  paymentMethodLabel: string;
  websiteUrl: string;
  cancellationUrl: string;
  notes: string;
  usageLevel: '' | UsageLevel;
  icon: string;
  /** Remind me about this subscription at all. */
  remindersEnabled: boolean;
  /** Days before; '' means "use my default". */
  reminderLeadDays: string;
  recordPriceChange: boolean;
  priceChangeEffectiveOn: string;
  priceChangeNote: string;
}

/**
 * The Icon field holds either one emoji or the key of a built-in brand logo ("netflix"). Both are stored in the same icon
 * object the API already had: { kind: 'emoji' } and { kind: 'glyph' }.
 */
export const iconFromText = (t: string): { kind: 'emoji' | 'glyph'; value: string } | null => {
  const value = t.trim();
  if (!value) return null;
  return /^[a-z0-9-]{1,32}$/.test(value) ? { kind: 'glyph', value } : { kind: 'emoji', value };
};
export const textFromIcon = (icon: { kind: string; value: string } | null | undefined): string => icon?.value ?? '';
/** A logo key must be one of the logos that ship with the app, otherwise nothing could be shown for it. */
const iconProblem = (t: string): string | null => {
  const icon = iconFromText(t);
  return icon?.kind === 'glyph' && !(icon.value in BRAND_ICONS) ? 'Use one emoji, or the name of a built-in logo such as “netflix”.' : null;
};

export function emptyValues(currency: CurrencyCode): SubscriptionFormValues {
  return {
    name: '', category: 'other', amountMinor: '', currency, billingFrequency: 'monthly', status: 'active',
    nextBillingDate: '', trialEndDate: '', startDate: '', anchorDate: '', paymentMethodLabel: '', websiteUrl: '',
    cancellationUrl: '', notes: '', usageLevel: '', icon: '', remindersEnabled: true, reminderLeadDays: '', recordPriceChange: true, priceChangeEffectiveOn: '', priceChangeNote: '',
  };
}

/** Edit form starts from the SAVED values (not the computed effective date), so untouched fields send nothing. */
export function valuesFromSubscription(s: SubscriptionDto): SubscriptionFormValues {
  return {
    name: s.name, category: s.category, amountMinor: minorToInput(s.amountMinor, s.currency), currency: s.currency,
    billingFrequency: s.billingFrequency, status: s.status === 'trial' ? 'trial' : 'active', nextBillingDate: s.nextBillingDate,
    trialEndDate: s.trialEndDate ?? '', startDate: s.startDate, anchorDate: s.anchorDate,
    paymentMethodLabel: s.paymentMethodLabel ?? '', websiteUrl: s.websiteUrl ?? '', cancellationUrl: s.cancellationUrl ?? '',
    notes: s.notes ?? '', usageLevel: s.usageLevel ?? '', icon: textFromIcon(s.icon),
    remindersEnabled: s.remindersEnabled, reminderLeadDays: s.reminderLeadDays === null ? '' : String(s.reminderLeadDays),
    recordPriceChange: true, priceChangeEffectiveOn: '', priceChangeNote: '',
  };
}

export type Built<T> = { ok: true; payload: T } | { ok: false; errors: FieldErrors; nothingChanged?: boolean };

const dateProblem = (value: string, label: string): string | null => {
  if (!isValidDateOnly(value)) return `Enter a valid ${label}.`;
  const y = parseDateOnly(value)!.y;
  return y < MIN_YEAR || y > MAX_YEAR ? `Year must be between ${MIN_YEAR} and ${MAX_YEAR}.` : null;
};

const text = (v: string) => v.trim();

/** '' -> null (use the default); otherwise a whole number of days 0..60. */
function parseLead(raw: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const t = raw.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d{1,2}$/.test(t) || Number(t) > 60) return { ok: false, message: 'Enter a whole number of days from 0 to 60, or leave it blank to use your default.' };
  return { ok: true, value: Number(t) };
}

/** Validates the schedule dates the same way the server does (shared rules), so errors appear before submitting. */
function scheduleErrors(
  v: SubscriptionFormValues,
  state: { status: 'active' | 'trial' | 'other'; anchor: string; next: string; start: string; trialEnd: string | null },
  today: string,
  checkNotPast: boolean,
): FieldErrors {
  const errors: FieldErrors = {};
  const issues = validateSubscriptionState(
    {
      status: state.status === 'other' ? 'paused' : state.status,
      billingFrequency: v.billingFrequency,
      anchorDate: state.anchor,
      nextBillingDate: state.next,
      startDate: state.start,
      trialEndDate: state.trialEnd,
    },
    { today, checkNotPast },
  );
  for (const i of issues) errors[i.path === 'nextBillingDate' && v.anchorDate.trim() && /schedule/.test(i.message) ? 'anchorDate' : i.path] ??= i.message;
  return errors;
}

export function buildCreatePayload(v: SubscriptionFormValues, ctx: { today: string }): Built<CreateSubscriptionInput> {
  const errors: FieldErrors = {};
  if (!text(v.name)) errors.name = 'Enter a name.';
  const amount = parseMoneyInput(v.amountMinor, v.currency);
  if (!amount.ok) errors.amountMinor = amount.message;

  const trial = v.status === 'trial';
  for (const [key, label] of [['nextBillingDate', 'next billing date'], ['trialEndDate', 'trial end date'], ['startDate', 'start date'], ['anchorDate', 'original billing date']] as const) {
    if (v[key] && dateProblem(v[key], label)) errors[key] = dateProblem(v[key], label)!;
  }
  if (trial && !v.trialEndDate) errors.trialEndDate ??= 'Enter the day your trial ends.';
  const next = v.nextBillingDate || (trial ? v.trialEndDate : '');
  if (!next) errors.nextBillingDate ??= 'Enter the next billing date.';

  if (next && !errors.nextBillingDate && !errors.anchorDate && !errors.startDate && !errors.trialEndDate) {
    const anchor = v.anchorDate || next;
    const start = v.startDate || (compareDates(anchor, ctx.today) < 0 ? anchor : ctx.today);
    Object.assign(errors, scheduleErrors(v, { status: trial ? 'trial' : 'active', anchor, next, start, trialEnd: v.trialEndDate || null }, ctx.today, true));
  }
  const lead = parseLead(v.reminderLeadDays);
  if (!lead.ok) errors.reminderLeadDays = lead.message;
  const iconErr = iconProblem(v.icon);
  if (iconErr) errors.icon = iconErr;
  if (Object.keys(errors).length) return { ok: false, errors };

  const payload: CreateSubscriptionInput = {
    name: text(v.name),
    amountMinor: (amount as { minor: number }).minor,
    billingFrequency: v.billingFrequency,
    category: v.category,
    currency: v.currency,
    status: v.status,
    nextBillingDate: next,
    ...(v.anchorDate ? { anchorDate: v.anchorDate } : {}),
    ...(v.startDate ? { startDate: v.startDate } : {}),
    ...(v.trialEndDate ? { trialEndDate: v.trialEndDate } : {}),
    ...(text(v.paymentMethodLabel) ? { paymentMethodLabel: text(v.paymentMethodLabel) } : {}),
    ...(text(v.websiteUrl) ? { websiteUrl: text(v.websiteUrl) } : {}),
    ...(text(v.cancellationUrl) ? { cancellationUrl: text(v.cancellationUrl) } : {}),
    ...(text(v.notes) ? { notes: text(v.notes) } : {}),
    ...(v.usageLevel ? { usageLevel: v.usageLevel } : {}),
    ...(iconFromText(v.icon) ? { icon: iconFromText(v.icon)! } : {}),
    ...(!v.remindersEnabled ? { remindersEnabled: false } : {}),
    ...(lead.ok && lead.value !== null ? { reminderLeadDays: lead.value } : {}),
  };
  const parsed = createSubscriptionSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, errors: fieldErrorsFromIssues(parsed.error.issues) };
  return { ok: true, payload: parsed.data };
}

/** Builds a PATCH containing ONLY what changed. Returns nothingChanged when the form matches the saved record. */
export function buildUpdatePayload(v: SubscriptionFormValues, original: SubscriptionDto, ctx: { today: string }): Built<UpdateSubscriptionInput> {
  const errors: FieldErrors = {};
  const patch: UpdateSubscriptionInput = {};

  if (!text(v.name)) errors.name = 'Enter a name.';
  else if (text(v.name) !== original.name) patch.name = text(v.name);
  if (v.category !== original.category) patch.category = v.category;

  const currencyChanged = v.currency !== original.currency;
  if (currencyChanged) patch.currency = v.currency;
  const amount = parseMoneyInput(v.amountMinor, v.currency);
  let amountChanged = false;
  if (!amount.ok) errors.amountMinor = amount.message;
  else if (amount.minor !== original.amountMinor) {
    patch.amountMinor = amount.minor;
    amountChanged = true;
  }

  const frequencyChanged = v.billingFrequency !== original.billingFrequency;
  if (frequencyChanged) patch.billingFrequency = v.billingFrequency;

  for (const [key, label] of [['nextBillingDate', 'next billing date'], ['startDate', 'start date'], ['anchorDate', 'original billing date']] as const) {
    if (!v[key]) errors[key] = `Enter the ${label}.`;
    else if (dateProblem(v[key], label)) errors[key] = dateProblem(v[key], label)!;
  }
  if (v.trialEndDate && dateProblem(v.trialEndDate, 'trial end date')) errors.trialEndDate = dateProblem(v.trialEndDate, 'trial end date')!;
  if (original.status === 'trial' && !v.trialEndDate) errors.trialEndDate ??= 'A trial needs an end date.';

  const nextChanged = v.nextBillingDate !== original.nextBillingDate;
  // Changing the frequency resets the schedule, so the server needs the date to be confirmed in the same request.
  const sendNext = nextChanged || frequencyChanged;
  if (sendNext && v.nextBillingDate) patch.nextBillingDate = v.nextBillingDate;
  if (v.anchorDate !== original.anchorDate && v.anchorDate) patch.anchorDate = v.anchorDate;
  if (v.startDate !== original.startDate && v.startDate) patch.startDate = v.startDate;
  if (v.trialEndDate !== (original.trialEndDate ?? '')) patch.trialEndDate = v.trialEndDate || null;

  const nullable = [
    ['paymentMethodLabel', text(v.paymentMethodLabel), original.paymentMethodLabel],
    ['websiteUrl', text(v.websiteUrl), original.websiteUrl],
    ['cancellationUrl', text(v.cancellationUrl), original.cancellationUrl],
    ['notes', text(v.notes), original.notes],
  ] as const;
  for (const [key, now, was] of nullable) if (now !== (was ?? '')) patch[key] = now || null;
  if ((v.usageLevel || null) !== original.usageLevel) patch.usageLevel = v.usageLevel || null;
  if (text(v.icon) !== textFromIcon(original.icon)) patch.icon = iconFromText(v.icon);

  if (v.remindersEnabled !== original.remindersEnabled) patch.remindersEnabled = v.remindersEnabled;
  const lead = parseLead(v.reminderLeadDays);
  if (!lead.ok) errors.reminderLeadDays = lead.message;
  else if (lead.value !== original.reminderLeadDays) patch.reminderLeadDays = lead.value;
  if (text(v.icon) !== textFromIcon(original.icon)) {
    const iconErr = iconProblem(v.icon);
    if (iconErr) errors.icon = iconErr;
  }

  // Price-change bookkeeping only applies when the amount really changes within the same currency.
  if (amountChanged && !currencyChanged) {
    if (!v.recordPriceChange) patch.recordPriceChange = false;
    else {
      if (v.priceChangeEffectiveOn) {
        const problem = dateProblem(v.priceChangeEffectiveOn, 'effective date');
        if (problem) errors.priceChangeEffectiveOn = problem;
        else if (compareDates(v.priceChangeEffectiveOn, ctx.today) > 0) errors.priceChangeEffectiveOn = 'The effective date can’t be in the future.';
        else patch.priceChangeEffectiveOn = v.priceChangeEffectiveOn;
      }
      if (text(v.priceChangeNote)) patch.priceChangeNote = text(v.priceChangeNote);
    }
  }

  if (!errors.nextBillingDate && !errors.anchorDate && !errors.startDate && !errors.trialEndDate) {
    const anchor = patch.nextBillingDate !== undefined && patch.anchorDate === undefined ? v.nextBillingDate : v.anchorDate;
    Object.assign(
      errors,
      scheduleErrors(
        { ...v, billingFrequency: v.billingFrequency },
        { status: original.status === 'trial' ? 'trial' : original.status === 'active' ? 'active' : 'other', anchor, next: v.nextBillingDate, start: v.startDate, trialEnd: v.trialEndDate || null },
        ctx.today,
        sendNext,
      ),
    );
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  if (Object.keys(patch).length === 0) return { ok: false, errors: {}, nothingChanged: true };
  const parsed = updateSubscriptionSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, errors: fieldErrorsFromIssues(parsed.error.issues) };
  return { ok: true, payload: parsed.data };
}
