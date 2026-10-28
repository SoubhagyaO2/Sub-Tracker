import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/** Stable id used by labels, error links and focus-on-first-error. */
export const fieldId = (name: string) => `field-${name}`;

interface BaseProps {
  name: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Optional fields say so in their label; required ones need no marker. */
  optional?: boolean;
}

const CONTROL =
  'block min-h-11 w-full rounded-control border border-strong bg-canvas px-3 py-2.5 text-fg disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

function Wrapper({ name, label, hint, error, optional, children }: BaseProps & { children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId(name)} className="block text-sm font-medium text-fg">
        {label}
        {optional ? <span className="font-normal text-muted"> (optional)</span> : null}
      </label>
      {children}
      {hint ? (
        <p id={`${fieldId(name)}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${fieldId(name)}-error`} className="text-sm text-danger">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const describedBy = (name: string, hint: unknown, error: unknown) =>
  [hint ? `${fieldId(name)}-hint` : null, error ? `${fieldId(name)}-error` : null].filter(Boolean).join(' ') || undefined;

type InputProps = BaseProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'name' | 'id'>;

export function TextField({ name, label, hint, error, optional, className = '', ...input }: InputProps) {
  return (
    <Wrapper {...{ name, label, hint, error, optional }}>
      <input
        id={fieldId(name)}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(name, hint, error)}
        className={`${CONTROL} ${className}`}
        {...input}
      />
    </Wrapper>
  );
}

export function DateField(props: InputProps) {
  return <TextField {...props} type="date" />;
}

/** Decimal text input with the currency code shown as a fixed prefix. Parsing to minor units is the form's job. */
export function MoneyField({ name, label, hint, error, optional, currency, ...input }: InputProps & { currency: string }) {
  return (
    <Wrapper {...{ name, label, hint, error, optional }}>
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted">
          {currency}
        </span>
        <input
          id={fieldId(name)}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(name, hint, error)}
          className={`${CONTROL} pl-14 tnum`}
          {...input}
        />
      </div>
    </Wrapper>
  );
}

export function TextArea({ name, label, hint, error, optional, ...input }: BaseProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'name' | 'id'>) {
  return (
    <Wrapper {...{ name, label, hint, error, optional }}>
      <textarea
        id={fieldId(name)}
        name={name}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(name, hint, error)}
        className={CONTROL}
        {...input}
      />
    </Wrapper>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({ name, label, hint, error, optional, options, ...select }: BaseProps & { options: readonly Option[] } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'name' | 'id'>) {
  return (
    <Wrapper {...{ name, label, hint, error, optional }}>
      <select
        id={fieldId(name)}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(name, hint, error)}
        className={CONTROL}
        {...select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Wrapper>
  );
}

/** Native radio group (arrow keys, one tab stop) styled as a segmented control. */
export function SegmentedField({
  name, legend, value, onChange, options, disabled, hint,
}: {
  name: string;
  legend: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly Option[];
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium text-fg">{legend}</legend>
      <div className="flex flex-wrap gap-1 rounded-control border border-strong bg-canvas p-1">
        {options.map((o) => (
          <label
            key={o.value}
            className="flex min-h-9 flex-1 cursor-pointer items-center justify-center rounded-[0.55rem] px-3 text-sm font-medium text-muted has-[:checked]:bg-accent-grad has-[:checked]:text-accent-fg has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)]"
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </fieldset>
  );
}

export function CheckboxField({ name, label, hint, checked, onChange, disabled }: { name: string; label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={fieldId(name)}
        name={name}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${fieldId(name)}-hint` : undefined}
        className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent-text)]"
      />
      <div>
        <label htmlFor={fieldId(name)} className="text-sm font-medium text-fg">
          {label}
        </label>
        {hint ? (
          <p id={`${fieldId(name)}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Summarises every problem at the top of a form and links each one to its field. */
export function ErrorSummary({ errors, formError }: { errors: Record<string, string>; formError?: string | null }) {
  const entries = Object.entries(errors);
  if (entries.length === 0 && !formError) return null;
  return (
    <div role="alert" tabIndex={-1} id="form-error-summary" className="rounded-control border border-danger bg-danger-soft p-4 text-sm text-danger">
      <p className="font-semibold">{formError ?? 'Please fix the following before continuing:'}</p>
      {entries.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {entries.map(([name, message]) => (
            <li key={name}>
              <a
                href={`#${fieldId(name)}`}
                className="text-danger underline"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(fieldId(name))?.focus();
                }}
              >
                {message}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Moves focus to the first field in error (or the summary if none is addressable). */
export function focusFirstError(errors: Record<string, string>): void {
  const first = Object.keys(errors).map((n) => document.getElementById(fieldId(n))).find(Boolean);
  (first ?? document.getElementById('form-error-summary'))?.focus();
}
