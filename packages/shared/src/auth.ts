import { z } from 'zod';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());

export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

export const displayNameSchema = z.string().trim().min(1).max(80);

export const registerSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  timezone: z.string().max(64).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

// Login deliberately does not enforce the password policy: it must accept any stored password.
export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailConfirmSchema = z.strictObject({
  token: z.string().min(20).max(200),
});

// ───────────── response shapes (shared by the API and the web client) ─────────────

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export interface PreferencesDto {
  currency: string;
  theme: 'dark' | 'light' | 'system';
  timezone: string;
  reminderLeadDays: number;
  reminderHour: number;
  inAppReminders: boolean;
  emailRemindersEnabled: boolean;
  trialRemindersEnabled: boolean;
}

/** Returned by register, login and GET /auth/me. */
export interface SessionPayload {
  user: UserDto;
  preferences: PreferencesDto;
  features: { emailVerificationAvailable: boolean };
}
