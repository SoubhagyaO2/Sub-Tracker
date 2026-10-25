import { useLocation } from 'react-router';
import { remindersApi } from '../api/endpoints';
import { useApi } from './data';

/**
 * How many delivered in-app reminders the user has not dismissed, or null while unknown or if the request failed
 * (a failing badge must never break navigation). Refetched on every route change and after any mutation.
 */
export function useUnreadReminders(): number | null {
  const { pathname } = useLocation();
  const q = useApi((signal) => remindersApi.list({ channel: 'in_app', status: ['sent'], unread: true, pageSize: 1 }, signal).then((r) => r.meta.unread), [pathname]);
  return q.status === 'ready' ? q.data : null;
}
