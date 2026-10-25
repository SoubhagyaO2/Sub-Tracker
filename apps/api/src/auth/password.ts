import argon2 from 'argon2';
import { AppError } from '../errors.js';
import { COMMON_PASSWORDS } from './commonPasswords.js';

// OWASP baseline for argon2id: >= 19 MiB memory, t >= 2, p = 1.
const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, ARGON_OPTIONS);

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed hash must not crash or leak
  }
}

export const needsRehash = (hash: string): boolean => argon2.needsRehash(hash, ARGON_OPTIONS);

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a throwaway hash so that "unknown email" costs about the same
 * as "wrong password", blunting timing-based account enumeration.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('subcycle-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

/** Policy beyond length (length is enforced by the shared schema). Throws a 422 AppError. */
export function assertPasswordAcceptable(password: string, email: string): void {
  const lower = password.toLowerCase();
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (COMMON_PASSWORDS.has(lower)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [
      { path: 'password', message: 'This password is too common. Choose something less guessable.' },
    ]);
  }
  if (lower === email.toLowerCase() || (local.length >= 6 && lower.includes(local))) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [
      { path: 'password', message: 'Password must not contain your email address.' },
    ]);
  }
}
