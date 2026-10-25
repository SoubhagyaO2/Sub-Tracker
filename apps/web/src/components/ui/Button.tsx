import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'sm';

const BASE =
  'inline-flex select-none items-center justify-center gap-2 rounded-control font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95',
  secondary: 'border border-strong bg-raised text-fg hover:bg-line',
  ghost: 'text-fg hover:bg-raised',
  danger: 'border border-danger bg-transparent text-danger hover:bg-danger-soft',
};
const SIZE: Record<Size, string> = { md: 'min-h-11 px-4 text-sm', sm: 'min-h-9 px-3 text-sm' };

export const buttonClass = (variant: Variant = 'secondary', size: Size = 'md', extra = '') => `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${extra}`;

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and blocks further clicks (prevents duplicate submissions). */
  loading?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', loading = false, disabled, className = '', children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)} {...rest}>
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ variant = 'secondary', size = 'md', className = '', children, ...rest }: LinkProps & { variant?: Variant; size?: Size; children: ReactNode }) {
  return (
    <Link className={`${buttonClass(variant, size, className)} no-underline ${variant === 'primary' ? '!text-accent-fg' : '!text-fg'}`} {...rest}>
      {children}
    </Link>
  );
}
