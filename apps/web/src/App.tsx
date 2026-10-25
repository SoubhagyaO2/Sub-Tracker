import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { AppShell } from './components/AppShell';
import { Button, LinkButton, Spinner } from './components/ui/Button';
import { EmptyState, ErrorState } from './components/ui/display';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { CalendarPage } from './pages/CalendarPage';
import { DashboardPage } from './pages/Dashboard';
import { RemindersPage } from './pages/RemindersPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { EditSubscriptionPage, NewSubscriptionPage } from './pages/SubscriptionFormPages';
import { SubscriptionDetailPage } from './pages/SubscriptionDetail';
import { SubscriptionListPage } from './pages/SubscriptionList';
import { AuthProvider, useApplyTheme, useAuth } from './state/auth';
import { DataProvider } from './state/data';
import { ToastProvider, usePageTitle } from './state/ui';

function FullPage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center p-6">{children}</div>;
}

/** Everything under here needs a signed-in session; otherwise go to /login and come back afterwards. */
function RequireAuth() {
  const { state, retry } = useAuth();
  const location = useLocation();
  useApplyTheme(state.status === 'authed' ? state.preferences.theme : 'dark');

  if (state.status === 'loading') {
    return (
      <FullPage>
        <div role="status" className="flex items-center gap-3 text-muted">
          <Spinner className="h-5 w-5" />
          Loading SubCycle…
        </div>
      </FullPage>
    );
  }
  if (state.status === 'error') {
    return (
      <FullPage>
        <div className="w-full max-w-md">
          <ErrorState error={state.error} onRetry={retry} title="We couldn’t start SubCycle" level={1} />
        </div>
      </FullPage>
    );
  }
  if (state.status === 'anon') return <Navigate to="/login" replace state={{ from: location }} />;
  // Data state lives inside the signed-in tree, so signing out discards everything that was loaded.
  return (
    <DataProvider>
      <AppShell />
    </DataProvider>
  );
}

/** Login/register: signed-in users are sent on to the app. */
function PublicOnly() {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'authed') {
    const from = (location.state as { from?: { pathname: string; search?: string } } | null)?.from;
    return <Navigate to={from ? `${from.pathname}${from.search ?? ''}` : '/'} replace />;
  }
  if (state.status === 'loading') {
    return (
      <FullPage>
        <div role="status" className="flex items-center gap-3 text-muted">
          <Spinner className="h-5 w-5" />
          Loading SubCycle…
        </div>
      </FullPage>
    );
  }
  return <Outlet />;
}

function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <FullPage>
      <EmptyState title="Page not found" icon="search" level={1} action={<LinkButton to="/" variant="primary">Go to Home</LinkButton>}>
        That page doesn’t exist.
      </EmptyState>
    </FullPage>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      {/* The emailed link works with or without a session: the token is the credential. */}
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<DashboardPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/reminders" element={<RemindersPage />} />
        <Route path="/subscriptions" element={<SubscriptionListPage />} />
        <Route path="/subscriptions/new" element={<NewSubscriptionPage />} />
        <Route path="/subscriptions/:id" element={<SubscriptionDetailPage />} />
        <Route path="/subscriptions/:id/edit" element={<EditSubscriptionPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

interface BoundaryState {
  failed: boolean;
}
/** Last-resort guard: a rendering bug shows a calm message instead of a blank page, and never leaks internals. */
class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error.message, info.componentStack?.split('\n')[1]?.trim());
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <FullPage>
        <div role="alert" className="max-w-md rounded-card border border-danger bg-danger-soft p-6">
          <h1 className="text-lg">Something went wrong</h1>
          <p className="mt-2 text-sm">The page hit an unexpected problem. Reloading usually fixes it.</p>
          <Button className="mt-4" variant="primary" onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </FullPage>
    );
  }
}

/** Providers shared by the real app and the tests (the test supplies its own router). */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export function App() {
  return (
    <Providers>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </Providers>
  );
}
