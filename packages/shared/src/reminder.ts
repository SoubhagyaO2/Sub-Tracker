import { z } from 'zod';
import { addDays, compareDates, zonedInstant, type DateOnly, type BillingFrequency } from './dates.js';
import { maxDate, occurrencesBetween } from './recurrence.js';
import { intParam, MAX_PAGE_SIZE } from './subscription.js';
import type { SubscriptionStatus } from './status.js';

export const REMINDER_KINDS = ['renewal', 'trial_end'] as const;
export const REMINDER_CHANNELS = ['in_app', 'email'] as const;
export const REMINDER_STATUSES = ['pending', 'sent', 'failed', 'skipped', 'superseded'] as const;
export const SKIP_REASONS = [
  'smtp_not_configured',
  'email_not_verified',
  'email_disabled',
  'subscription_inactive',
  'delivery_window_missed',
  'invalid_time_zone',
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Reminders are materialised this many days ahead of "today + lead", so users can see what is scheduled. */
export const REMINDER_HORIZON_DAYS = 30;
export const MAX_REMINDER_ATTEMPTS = 5;
/** Minutes to wait after the Nth failed attempt before the next one. */
export const RETRY_BACKOFF_MINUTES = [5, 30, 120, 360] as const;

// ───────────── list query ─────────────

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .preprocess(
      (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
      z.array(z.enum(values)).min(1, 'Provide at least one value.').max(values.length),
    )
    .optional();

export const listRemindersQuerySchema = z.strictObject({
  page: intParam(1, 100_000),
  pageSize: intParam(1, MAX_PAGE_SIZE),
  channel: z.enum(REMINDER_CHANNELS).optional(),
  status: csv(REMINDER_STATUSES),
  /** "true": only in-app reminders that were delivered and not yet dismissed. */
  unread: z.enum(['true']).optional(),
});

export type ListRemindersQuery = z.infer<typeof listRemindersQuerySchema>;

export interface ReminderDto {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  kind: ReminderKind;
  channel: ReminderChannel;
  targetDate: DateOnly;
  leadDays: number;
  remindAt: string;
  status: ReminderStatus;
  skipReason: SkipReason | null;
  attempts: number;
  sentAt: string | null;
  readAt: string | null;
  /** A short category such as "SMTP 421", never raw provider output. */
  lastError: string | null;
}

// ───────────── the planner (pure) ─────────────

export interface ReminderPrefs {
  timeZone: string;
  leadDays: number;
  hour: number;
  inApp: boolean;
  email: boolean;
  trial: boolean;
}

export interface ReminderSub {
  id: string;
  status: SubscriptionStatus;
  billingFrequency: BillingFrequency;
  anchorDate: DateOnly;
  nextBillingDate: DateOnly;
  trialEndDate: DateOnly | null;
  reminderLeadDays: number | null;
  remindersEnabled: boolean;
}

export interface PlannedReminder {
  subscriptionId: string;
  kind: ReminderKind;
  channel: ReminderChannel;
  targetDate: DateOnly;
  leadDays: number;
  remindAt: Date;
}

export const reminderKey = (r: Pick<PlannedReminder, 'subscriptionId' | 'kind' | 'targetDate' | 'leadDays' | 'channel'>) =>
  `${r.subscriptionId}|${r.kind}|${r.targetDate}|${r.leadDays}|${r.channel}`;

/**
 * The reminders that SHOULD exist right now for one user, given their settings and "today" in their own zone.
 *  - only active subscriptions (renewals) and trials (their end date); paused/cancelled/archived and disabled ones: none;
 *  - targets start no earlier than today and no earlier than the saved next billing date, so a renewal that was paid
 *    ahead (the date advanced past it) gets no reminder;
 *  - lead = the subscription's own override, else the user's default;
 *  - remind_at = (target - lead days) at the user's reminder hour in their zone (DST-correct);
 *  - one row per enabled channel (in-app / email); email rows exist even if email can't be delivered, so the delivery
 *    step can record a truthful "skipped" with its reason.
 * Throws RangeError for an unknown time zone: the caller decides how to report that user.
 */
export function planReminders(subs: readonly ReminderSub[], prefs: ReminderPrefs, today: DateOnly): PlannedReminder[] {
  const channels: ReminderChannel[] = [...(prefs.inApp ? (['in_app'] as const) : []), ...(prefs.email ? (['email'] as const) : [])];
  zonedInstant(today, prefs.hour, prefs.timeZone); // validates the zone up front, even if nothing is planned
  const out: PlannedReminder[] = [];
  if (channels.length === 0) return out;

  for (const s of subs) {
    if (!s.remindersEnabled) continue;
    const lead = s.reminderLeadDays ?? prefs.leadDays;
    let targets: { date: DateOnly; kind: ReminderKind }[] = [];
    if (s.status === 'active') {
      const start = maxDate(today, s.nextBillingDate);
      targets = occurrencesBetween(s.anchorDate, s.billingFrequency, start, addDays(today, lead + REMINDER_HORIZON_DAYS), 60).map((date) => ({ date, kind: 'renewal' as const }));
    } else if (s.status === 'trial' && prefs.trial) {
      const date = s.trialEndDate ?? s.nextBillingDate;
      if (compareDates(date, today) >= 0 && compareDates(date, addDays(today, lead + REMINDER_HORIZON_DAYS)) <= 0) targets = [{ date, kind: 'trial_end' }];
    }
    for (const t of targets) {
      const remindAt = zonedInstant(addDays(t.date, -lead), prefs.hour, prefs.timeZone);
      for (const channel of channels) out.push({ subscriptionId: s.id, kind: t.kind, channel, targetDate: t.date, leadDays: lead, remindAt });
    }
  }
  return out;
}
