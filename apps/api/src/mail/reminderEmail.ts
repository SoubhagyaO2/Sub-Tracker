import { diffDays, formatMinorPlain, type CurrencyCode, type DateOnly, type ReminderKind } from '@subcycle/shared';

export interface ReminderEmailInput {
  kind: ReminderKind;
  name: string;
  targetDate: DateOnly;
  today: DateOnly;
  amountMinor: number;
  currency: CurrencyCode;
  appUrl: string;
  subscriptionId: string;
}

function when(target: DateOnly, today: DateOnly): string {
  const n = diffDays(target, today);
  return n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
}

/**
 * Plain-text reminder. It contains ONLY what the schedule says (service name, date, amount) and a link back to the app.
 * It deliberately never includes notes, payment-method labels or anything else the user typed, and it never claims a
 * charge happened or that SubCycle can cancel anything.
 */
export function buildReminderEmail(i: ReminderEmailInput): { subject: string; text: string } {
  const amount = formatMinorPlain(i.amountMinor, i.currency);
  const link = `${i.appUrl}/subscriptions/${i.subscriptionId}`;
  if (i.kind === 'trial_end') {
    return {
      subject: `SubCycle: your ${i.name} trial ends ${when(i.targetDate, i.today)}`,
      text:
        `Your free trial of ${i.name} is due to end on ${i.targetDate} (${when(i.targetDate, i.today)}).\n\n` +
        `According to what you entered, the plan then costs ${amount} per billing period.\n` +
        `SubCycle can't cancel or convert anything for you. To stop it, cancel on ${i.name}'s own site, then record that in SubCycle.\n\n` +
        `Open it in SubCycle: ${link}\n`,
    };
  }
  return {
    subject: `SubCycle: ${i.name} renews ${when(i.targetDate, i.today)}`,
    text:
      `${i.name} is scheduled to renew on ${i.targetDate} (${when(i.targetDate, i.today)}) for ${amount}.\n\n` +
      `This is a reminder from the schedule you entered. SubCycle can't see your bank or the provider, so it doesn't know if a charge will happen.\n` +
      `If you no longer want it, cancel on ${i.name}'s own site (SubCycle can't do that for you), then record it in SubCycle.\n\n` +
      `Open it in SubCycle: ${link}\n`,
  };
}
