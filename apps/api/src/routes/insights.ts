import { Router } from 'express';
import { analyticsQuerySchema, calendarQuerySchema, listRemindersQuerySchema, updatePreferencesSchema } from '@subcycle/shared';
import { loadPreferences } from '../auth/dto.js';
import type { AppDeps } from '../deps.js';
import { requireAuth } from '../middleware/session.js';
import { getAnalytics } from '../services/analytics.js';
import { getCalendar } from '../services/calendar.js';
import { updatePreferences } from '../services/preferences.js';
import { dismissReminder, listReminders, reconcileUserReminders } from '../services/reminders.js';
import { todayForUser } from '../today.js';

/**
 * Calendar, analytics, reminders and (reminder) preferences. Every route needs a session and every query is scoped to
 * the session user; no request field can name another user. GET routes never write.
 */
export function insightsRouters(deps: AppDeps) {
  const { pool, clock, mailer } = deps;
  const logger = deps.logger;

  async function zone(userId: string) {
    const prefs = await loadPreferences(pool, userId);
    return { today: todayForUser(clock, prefs.timezone), timeZone: prefs.timezone };
  }

  const calendar = Router();
  calendar.use(requireAuth);
  calendar.get('/renewals', async (req, res) => {
    const q = calendarQuerySchema.parse(req.query);
    const { today, timeZone } = await zone(req.auth!.userId);
    const { occurrences, meta } = await getCalendar(pool, req.auth!.userId, q, today, timeZone);
    res.json({ data: occurrences, meta });
  });

  const analytics = Router();
  analytics.use(requireAuth);
  analytics.get('/spending', async (req, res) => {
    const q = analyticsQuerySchema.parse(req.query);
    const { today, timeZone } = await zone(req.auth!.userId);
    res.json({ data: await getAnalytics(pool, req.auth!.userId, q, today, timeZone) });
  });

  const reminders = Router();
  reminders.use(requireAuth);
  reminders.get('/', async (req, res) => {
    const q = listRemindersQuerySchema.parse(req.query);
    const r = await listReminders(pool, req.auth!.userId, q);
    res.json({ data: r.items, meta: { page: r.page, pageSize: r.pageSize, total: r.total, unread: r.unread } });
  });
  reminders.post('/:id/dismiss', async (req, res) => {
    res.json({ data: await dismissReminder(pool, req.auth!.userId, req.params.id, clock.now()) });
  });

  const preferences = Router();
  preferences.use(requireAuth);
  preferences.get('/', async (req, res) => {
    res.json({ data: await loadPreferences(pool, req.auth!.userId) });
  });
  preferences.patch('/', async (req, res) => {
    const patch = updatePreferencesSchema.parse(req.body ?? {});
    const updated = await updatePreferences(pool, req.auth!.userId, patch);
    // Show the effect straight away instead of at the next scheduler pass. Best effort: the scheduler is the safety net.
    const affectsReminders = ['timezone', 'reminderLeadDays', 'reminderHour', 'inAppReminders', 'emailRemindersEnabled', 'trialRemindersEnabled'].some((k) => k in patch);
    if (affectsReminders) try {
      await reconcileUserReminders({ pool, clock, mailer }, req.auth!.userId);
    } catch (err) {
      logger?.warn({ event: 'reminder_reconcile_after_preferences_failed', errorName: (err as Error).name, errorCode: (err as { code?: string }).code }, 'reconcile failed; the scheduler will retry');
    }
    res.json({ data: updated });
  });

  return { calendar, analytics, reminders, preferences };
}
