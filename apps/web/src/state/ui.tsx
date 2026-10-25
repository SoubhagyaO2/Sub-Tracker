import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DateOnly } from '@subcycle/shared';
import { todayIn } from '../lib/dates';
import { useSession } from './auth';

// ───────────── toasts ─────────────

export interface ToastInput {
  kind: 'success' | 'error' | 'info';
  message: string;
}
interface Toast extends ToastInput {
  id: number;
}
const ToastContext = createContext<(t: ToastInput) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setToasts((all) => [...all.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.kind === 'error' ? 9000 : 5000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* Two live regions (always present, so additions are announced): polite for confirmations, assertive for errors.
          They carry no role of their own, so they never show up as empty alerts. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        <div aria-live="polite" aria-atomic="false" className="flex w-full flex-col items-center gap-2">
          {toasts.filter((t) => t.kind !== 'error').map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>
        <div aria-live="assertive" aria-atomic="false" className="flex w-full flex-col items-center gap-2">
          {toasts.filter((t) => t.kind === 'error').map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const tone = toast.kind === 'error' ? 'border-danger text-danger' : toast.kind === 'success' ? 'border-accent-text text-fg' : 'border-info text-fg';
  return (
    <div className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-control border bg-raised px-4 py-3 shadow-pop ${tone}`}>
      <p className="flex-1 text-sm text-fg">{toast.message}</p>
      <button type="button" onClick={() => onDismiss(toast.id)} className="-m-1 rounded p-1 text-muted hover:text-fg" aria-label="Dismiss notification">
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

// ───────────── "today" in the user's own time zone ─────────────

/** The user's current calendar date; rechecked every minute so a page left open rolls over at local midnight. */
export function useToday(): DateOnly {
  const { preferences } = useSession();
  const [today, setToday] = useState(() => todayIn(preferences.timezone));
  useEffect(() => {
    setToday(todayIn(preferences.timezone));
    const timer = window.setInterval(() => setToday(todayIn(preferences.timezone)), 60_000);
    return () => window.clearInterval(timer);
  }, [preferences.timezone]);
  return today;
}

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · SubCycle`;
  }, [title]);
}
