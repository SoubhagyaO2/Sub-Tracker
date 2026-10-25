import { ApiError } from '../api/client';

export type FieldErrors = Record<string, string>;

export interface MappedError {
  fields: FieldErrors;
  /** Anything that can't be pinned to a field on this form. */
  form: string | null;
}

/** Server error codes that belong to one specific field. */
const CODE_TO_FIELD: Record<string, string> = {
  EMAIL_TAKEN: 'email',
  DUPLICATE_PAYMENT_PERIOD: 'forBillingDate',
  CURRENCY_LOCKED: 'currency',
};

/**
 * Turns an API failure into field-level messages plus an optional form-level message.
 * `known` lists the field names this form actually renders; problems about other fields are shown at form level
 * rather than being silently dropped.
 */
export function mapApiError(err: unknown, known: readonly string[]): MappedError {
  if (!(err instanceof ApiError)) return { fields: {}, form: 'Something unexpected went wrong. Please try again.' };
  const fields: FieldErrors = {};
  const leftovers: string[] = [];
  for (const d of err.details) {
    const top = d.path.split('.')[0] ?? '';
    if (known.includes(top)) fields[top] ??= d.message;
    else leftovers.push(top ? `${top}: ${d.message}` : d.message);
  }
  const codeField = CODE_TO_FIELD[err.code];
  if (codeField && known.includes(codeField)) fields[codeField] = err.message;

  if (Object.keys(fields).length > 0 && leftovers.length === 0) return { fields, form: null };
  if (err.status === 422 && leftovers.length === 0) return { fields, form: err.message };
  if (leftovers.length > 0) return { fields, form: leftovers.join(' ') };
  return { fields, form: err.message };
}

/** Turns zod issues into friendly per-field messages (first message per field wins). */
export function fieldErrorsFromIssues(issues: readonly { path: PropertyKey[]; message: string }[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const key = String(i.path[0] ?? '');
    if (key && !(key in out)) out[key] = i.message;
  }
  return out;
}
