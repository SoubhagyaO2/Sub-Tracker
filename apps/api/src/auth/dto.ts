import type { PreferencesDto, UserDto } from '@subcycle/shared';
import type { Queryable } from '../db/pool.js';

export type { PreferencesDto, UserDto };

export const toUserDto = (u: {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: Date | null;
}): UserDto => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  emailVerified: u.emailVerifiedAt !== null,
});

interface PrefRow {
  currency: string;
  theme: PreferencesDto['theme'];
  timezone: string;
  reminder_lead_days: number;
  reminder_hour: number;
  in_app_reminders: boolean;
  email_reminders_enabled: boolean;
  trial_reminders_enabled: boolean;
}

export async function loadPreferences(db: Queryable, userId: string): Promise<PreferencesDto> {
  const { rows } = await db.query<PrefRow>('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
  const r = rows[0];
  if (!r) throw new Error('user_preferences row missing');
  return {
    currency: r.currency,
    theme: r.theme,
    timezone: r.timezone,
    reminderLeadDays: r.reminder_lead_days,
    reminderHour: r.reminder_hour,
    inAppReminders: r.in_app_reminders,
    emailRemindersEnabled: r.email_reminders_enabled,
    trialRemindersEnabled: r.trial_reminders_enabled,
  };
}
