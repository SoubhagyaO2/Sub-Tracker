import { z } from 'zod';
import { isSupportedCurrency } from './currency.js';
import { isValidTimeZone } from './dates.js';
import { displayNameSchema, emailSchema, passwordSchema, PASSWORD_MAX } from './auth.js';

// ───────────── preferences ─────────────

export const themeSchema = z.enum(['dark', 'light', 'system']);

/**
 * Every preference a user can change. Strict: unknown keys are rejected. Changing `currency` only changes the
 * default for new subscriptions and the ordering of per-currency totals: it never converts or rewrites anything.
 * Changing `timezone` changes how "today" and reminder times are worked out, never any stored date or payment.
 */
export const updatePreferencesSchema = z
  .strictObject({
    currency: z.string().refine(isSupportedCurrency, 'Choose a supported currency.').optional(),
    timezone: z.string().refine(isValidTimeZone, 'Choose a valid time zone, such as Asia/Kolkata.').optional(),
    theme: themeSchema.optional(),
    reminderLeadDays: z.number().int().min(0).max(60).optional(),
    reminderHour: z.number().int().min(0).max(23).optional(),
    inAppReminders: z.boolean().optional(),
    emailRemindersEnabled: z.boolean().optional(),
    trialRemindersEnabled: z.boolean().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), { message: 'Provide at least one setting to update.' });
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

// ───────────── account ─────────────

export const updateAccountSchema = z.strictObject({ displayName: displayNameSchema });
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

/** The current password is only compared, never policy-checked (it may predate the policy). */
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Deleting needs the password (re-authentication) AND the account's email typed out (explicit confirmation). */
export const deleteAccountSchema = z.strictObject({
  password: z.string().min(1).max(PASSWORD_MAX),
  confirmEmail: emailSchema,
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
