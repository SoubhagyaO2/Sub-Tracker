import type { UpdateReminderPreferencesInput, PreferencesDto } from '@subcycle/shared';
import { loadPreferences } from '../auth/dto.js';
import type { Queryable } from '../db/pool.js';

/**
 * Updates the reminder settings only (currency, theme and time zone arrive with the Stage 8 settings page, and the strict
 * request schema rejects them until then). Always scoped to the session user's own row.
 */
export async function updateReminderPreferences(db: Queryable, userId: string, patch: UpdateReminderPreferencesInput): Promise<PreferencesDto> {
  await db.query(
    `UPDATE user_preferences SET
       reminder_lead_days      = COALESCE($2, reminder_lead_days),
       reminder_hour           = COALESCE($3, reminder_hour),
       in_app_reminders        = COALESCE($4, in_app_reminders),
       email_reminders_enabled = COALESCE($5, email_reminders_enabled),
       trial_reminders_enabled = COALESCE($6, trial_reminders_enabled)
     WHERE user_id = $1`,
    [userId, patch.reminderLeadDays ?? null, patch.reminderHour ?? null, patch.inAppReminders ?? null, patch.emailRemindersEnabled ?? null, patch.trialRemindersEnabled ?? null],
  );
  return loadPreferences(db, userId);
}
