import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { Icon } from './Icon';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Set false while a request is in flight so the dialog can't vanish under it. */
  dismissable?: boolean;
  size?: 'md' | 'lg';
}

/**
 * Accessible modal: role="dialog" + aria-modal, labelled by its title, focus moves in and is trapped,
 * Escape and the close button dismiss it, the rest of the page is made inert, and focus returns to the
 * element that opened it.
 */
export function Dialog({ open, onClose, title, description, children, dismissable = true, size = 'md' }: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const portal = portalRef.current;

    // Everything outside the dialog becomes inert (unfocusable, hidden from assistive tech).
    const inerted: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el !== portal && el instanceof HTMLElement && !el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        inerted.push(el);
      }
    }
    document.documentElement.classList.add('scroll-lock');

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    return () => {
      inerted.forEach((el) => el.removeAttribute('inert'));
      document.documentElement.classList.remove('scroll-lock');
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && dismissable) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    const activeEl = document.activeElement;
    if (e.shiftKey && (activeEl === firstEl || activeEl === panelRef.current)) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && activeEl === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  return createPortal(
    <div ref={portalRef}>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--scrim)] p-0 sm:items-center sm:p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && dismissable) onClose();
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={`max-h-[92dvh] w-full overflow-y-auto rounded-t-dialog border border-line bg-surface p-5 shadow-pop outline-none sm:rounded-dialog sm:p-6 ${size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-lg">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={!dismissable}
              className="-m-2 rounded-control p-2 text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
              aria-label="Close dialog"
            >
              <Icon name="x" />
            </button>
          </div>
          {description ? (
            <div id={descId} className="mb-4 text-sm text-muted">
              {description}
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  danger?: boolean;
  /** Last error from the confirm action, shown inside the dialog so it can be retried. */
  error?: string | null;
  busy: boolean;
}

/** Confirmation for destructive/irreversible actions: the button names the action and states are visible. */
export function ConfirmDialog({ open, onClose, title, description, confirmLabel, onConfirm, danger = false, error, busy }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} dismissable={!busy}>
      {error ? (
        <p role="alert" className="mb-4 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={onClose} disabled={busy} data-autofocus>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={() => void onConfirm()}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
