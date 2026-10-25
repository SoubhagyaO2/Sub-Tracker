import type { ReminderEnv } from '../services/reminders.js';
import { runSchedulerCycle, type CycleResult } from './cycle.js';

export interface SchedulerHandle {
  /** Runs one cycle now (e.g. from tests). A concurrent run is rejected by the lock, not queued. */
  runNow(): Promise<CycleResult>;
  /** Stops scheduling and waits for an in-flight cycle to finish, so shutdown never abandons half-done work. */
  stop(): Promise<void>;
}

/**
 * Starts the periodic scheduler. A new cycle is scheduled only AFTER the previous one finishes (no setInterval),
 * so cycles in this process can never overlap even if one runs long. The first cycle runs immediately: after a restart
 * it catches up on whatever was missed while the process was down.
 */
export function startScheduler(env: ReminderEnv, opts: { intervalMs: number; runOnStart?: boolean }): SchedulerHandle {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const run = async (): Promise<CycleResult> => {
    const p = runSchedulerCycle(env);
    inFlight = p.catch(() => undefined);
    return p;
  };
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => void loop(), opts.intervalMs);
    timer.unref();
  };
  const loop = async () => {
    try {
      await run();
    } catch (err) {
      env.logger.error({ event: 'scheduler_cycle_crashed', errorName: (err as Error).name, errorCode: (err as { code?: string }).code }, 'scheduler cycle crashed');
    }
    arm();
  };

  if (opts.runOnStart ?? true) void loop();
  else arm();

  env.logger.info({ event: 'scheduler_started', intervalSeconds: opts.intervalMs / 1000 }, 'scheduler started');
  return {
    runNow: run,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      env.logger.info({ event: 'scheduler_stopped' }, 'scheduler stopped');
    },
  };
}
