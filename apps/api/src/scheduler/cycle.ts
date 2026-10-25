import { purgeExpiredSessions } from '../auth/sessions.js';
import { rollForwardStale } from '../services/recurrence.js';
import { deliverDueReminders, reconcileAllReminders, type DeliveryResult, type ReminderEnv } from '../services/reminders.js';
import { SCHEDULER_LOCK_KEY, withAdvisoryLock } from './lock.js';

export interface CycleResult {
  /** "skipped_locked": another cycle (this or another process) is running, so this one did nothing. */
  status: 'ran' | 'skipped_locked';
  durationMs: number;
  sessionsPurged: number;
  rolledForward: number;
  reminders: { users: number; usersWithInvalidTimeZone: number; created: number; revived: number; rescheduled: number; superseded: number; expiredMissed: number };
  delivery: DeliveryResult;
  /** Names of tasks that threw. A failing task never stops the others. */
  failedTasks: string[];
}

const emptyDelivery = (): DeliveryResult => ({ claimed: 0, inAppSent: 0, emailSent: 0, emailSkipped: 0, emailFailed: 0, retryScheduled: 0, superseded: 0, missed: 0, invalidTimeZone: 0, errors: 0 });
const emptyReminders = () => ({ users: 0, usersWithInvalidTimeZone: 0, created: 0, revived: 0, rescheduled: 0, superseded: 0, expiredMissed: 0 });

/**
 * One scheduler pass. Everything it does is derived from database state and the injected clock, so it is safe to run
 * at any time, repeatedly, after any downtime: missed work is simply caught up (or recorded as missed), never replayed
 * twice. Order matters: roll dates forward, then reconcile reminders (expiring missed ones BEFORE superseding stale ones),
 * then deliver.
 *
 *  - At most one cycle runs at a time across ALL instances sharing the database (advisory lock); a concurrent attempt
 *    returns immediately as "skipped_locked".
 *  - It never creates payment records: a passed renewal date is never treated as a payment.
 *  - Logs contain counts and task names only.
 */
export async function runSchedulerCycle(env: ReminderEnv): Promise<CycleResult> {
  const started = performance.now();
  const { pool, clock, logger } = env;
  const result: CycleResult = {
    status: 'ran', durationMs: 0, sessionsPurged: 0, rolledForward: 0, reminders: emptyReminders(), delivery: emptyDelivery(), failedTasks: [],
  };

  const task = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      result.failedTasks.push(name);
      logger.error({ event: 'scheduler_task_failed', task: name, errorName: (err as Error).name, errorCode: (err as { code?: string }).code }, 'scheduler task failed');
    }
  };

  const lock = await withAdvisoryLock(pool, SCHEDULER_LOCK_KEY, async () => {
    await task('purge_sessions', async () => void (result.sessionsPurged = await purgeExpiredSessions(pool, clock)));
    await task('roll_forward', async () => void (result.rolledForward = await rollForwardStale(pool, clock)));
    await task('reconcile_reminders', async () => void (result.reminders = await reconcileAllReminders(env)));
    await task('deliver_reminders', async () => void (result.delivery = await deliverDueReminders(env)));
  });

  result.durationMs = Math.round(performance.now() - started);
  if (!lock.acquired) {
    result.status = 'skipped_locked';
    logger.info({ event: 'scheduler_cycle_skipped', reason: 'another cycle holds the lock' }, 'scheduler cycle skipped');
    return result;
  }
  logger.info({ event: 'scheduler_cycle', ...result }, 'scheduler cycle finished');
  return result;
}
