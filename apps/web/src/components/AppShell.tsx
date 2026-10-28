import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth, useSession } from '../state/auth';
import { useUnreadReminders } from '../state/reminders';
import { LinkButton } from './ui/Button';
import { Icon, LogoMark, type IconName } from './ui/Icon';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/subscriptions', label: 'Subscriptions', icon: 'list' },
  { to: '/calendar', label: 'Calendar', icon: 'calendar' },
  { to: '/analytics', label: 'Analytics', icon: 'chart' },
];
/** On phones these four sit in the bottom bar with "Add"; Reminders live behind the bell in the header. */
const REMINDERS = { to: '/reminders', label: 'Reminders', icon: 'bell' as IconName };

function UnreadBadge({ count }: { count: number | null }) {
  if (!count) return null;
  return (
    <span className="ml-auto min-w-5 rounded-full bg-accent-grad px-1.5 text-center text-xs font-semibold text-accent-fg tnum">
      {count > 99 ? '99+' : count}
      <span className="sr-only"> unread</span>
    </span>
  );
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-lg font-semibold tracking-tight text-fg">
      <LogoMark />
      SubCycle
    </span>
  );
}

const desktopLink = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-medium no-underline ${isActive ? 'bg-accent-soft text-accent-text shadow-[inset_3px_0_0_var(--accent)]' : 'text-muted hover:bg-raised hover:text-fg'}`;
const mobileLink = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-xs font-medium no-underline ${isActive ? 'text-accent-text' : 'text-muted'}`;

/** Disclosure menu for the signed-in account. Escape and outside clicks close it; focus returns to the button. */
function AccountMenu() {
  const { user } = useSession();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 items-center gap-2 rounded-control px-2 text-sm font-medium text-fg hover:bg-raised"
      >
        <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-grad text-sm font-bold text-accent-fg shadow-glow">
          {user.displayName.charAt(0).toUpperCase()}
        </span>
        <span className="sr-only">Account menu for {user.displayName}</span>
        <Icon name="chevron-down" className="h-4 w-4 text-muted" />
      </button>
      {open ? (
        <div id="account-menu" className="absolute right-0 top-full z-40 mt-2 w-64 rounded-card border border-line bg-raised p-3 shadow-pop">
          <p className="truncate text-sm font-semibold">{user.displayName}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
          <Link
            to="/settings"
            onClick={() => setOpen(false)}
            className="mt-3 flex min-h-11 w-full items-center gap-2 rounded-control px-3 text-sm font-medium !text-fg no-underline hover:bg-line"
          >
            <Icon name="settings" />
            Settings
          </Link>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await logout();
            }}
            className="flex min-h-11 w-full items-center gap-2 rounded-control px-3 text-sm font-medium text-fg hover:bg-line disabled:opacity-60"
          >
            <Icon name="logout" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell() {
  const { user } = useSession();
  const { logout } = useAuth();
  const location = useLocation();
  const unread = useUnreadReminders();
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);

  // After client-side navigation, move focus to the page so keyboard and screen-reader users start at the top.
  useEffect(() => {
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-accent-grad focus:px-4 focus:py-2 focus:font-semibold focus:!text-accent-fg">
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line px-4 py-6 lg:flex">
        <div className="px-3">
          <Wordmark />
        </div>
        <nav aria-label="Primary" className="mt-8 flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={desktopLink}>
              <Icon name={n.icon} />
              {n.label}
            </NavLink>
          ))}
          <NavLink to={REMINDERS.to} className={desktopLink}>
            <Icon name={REMINDERS.icon} />
            {REMINDERS.label}
            <UnreadBadge count={unread} />
          </NavLink>
          <NavLink to="/settings" className={desktopLink}>
            <Icon name="settings" />
            Settings
          </NavLink>
        </nav>
        <div className="mt-6 px-1">
          <LinkButton to="/subscriptions/new" variant="primary" className="w-full">
            <Icon name="plus" className="h-4 w-4" />
            Add subscription
          </LinkButton>
        </div>
        <div className="mt-auto rounded-card border border-line p-3">
          <p className="truncate text-sm font-semibold">{user.displayName}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
          <button type="button" onClick={() => void logout()} className="mt-2 flex min-h-9 w-full items-center gap-2 rounded-control px-2 text-sm font-medium text-muted hover:bg-raised hover:text-fg">
            <Icon name="logout" className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="surface-glass sticky top-0 z-30 flex items-center justify-between border-b border-line px-4 py-2 lg:hidden">
          <Wordmark />
          <div className="flex items-center gap-1">
            <NavLink to={REMINDERS.to} className="relative flex min-h-11 min-w-11 items-center justify-center rounded-control text-muted hover:bg-raised hover:text-fg aria-[current=page]:text-accent-text" aria-label={unread ? `Reminders, ${unread} unread` : 'Reminders'}>
              <Icon name="bell" />
              {unread ? <span aria-hidden="true" className="absolute right-1 top-1 min-w-4 rounded-full bg-accent-grad px-1 text-center text-[10px] font-semibold leading-4 text-accent-fg tnum">{unread > 99 ? '99+' : unread}</span> : null}
            </NavLink>
            <AccountMenu />
          </div>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 pb-32 pt-6 outline-none lg:px-8 lg:pb-12 lg:pt-10">
          <Outlet />
        </main>
      </div>

      <nav aria-label="Primary, mobile" className="fixed inset-x-3 bottom-3 z-30 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <div className="surface-glass relative flex items-center rounded-[1.75rem] border border-line px-2 shadow-nav">
          {NAV.slice(0, 2).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={mobileLink}>
              <Icon name={n.icon} />
              {n.label}
            </NavLink>
          ))}
          <div className="flex w-20 shrink-0 justify-center">
            <NavLink
              to="/subscriptions/new"
              aria-label="Add subscription"
              className="-mt-9 flex h-14 w-14 items-center justify-center rounded-full bg-accent-grad text-accent-fg shadow-glow ring-4 ring-canvas no-underline transition active:scale-95"
            >
              <Icon name="plus" className="h-7 w-7" />
            </NavLink>
          </div>
          {NAV.slice(2).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={mobileLink}>
              <Icon name={n.icon} />
              {n.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
