import type { PreferencesDto, UpdatePreferencesInput } from '@subcycle/shared';
import { loadPreferences } from '../auth/dto.js';
import type { Queryable } from '../db/pool.js';

/**
 * Updates the caller's own preferences (one row, keyed by the session user). Nothing else is touched: changing the
 * currency or time zone never rewrites subscriptions, payments or price history, and never converts an amount.
 */
export async function updatePreferences(db: Queryable, userId: string, patch: UpdatePreferencesInput): Promise<PreferencesDto> {
  await db.query(
    `UPDATE user_preferences SET
       currency                = COALESCE($2, currency),
       timezone                = COALESCE($3, timezone),
       theme                   = COALESCE($4, theme),
       reminder_lead_days      = COALESCE($5, reminder_lead_days),
       reminder_hour           = COALESCE($6, reminder_hour),
       in_app_reminders        = COALESCE($7, in_app_reminders),
       email_reminders_enabled = COALESCE($8, email_reminders_enabled),
       trial_reminders_enabled = COALESCE($9, trial_reminders_enabled)
     WHERE user_id = $1`,
    [
      userId, patch.currency ?? null, patch.timezone ?? null, patch.theme ?? null, patch.reminderLeadDays ?? null, patch.reminderHour ?? null,
      patch.inAppReminders ?? null, patch.emailRemindersEnabled ?? null, patch.trialRemindersEnabled ?? null,
    ],
  );
  return loadPreferences(db, userId);
}
