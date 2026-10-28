import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Tests share one real PostgreSQL database and reset it between cases, so files run serially.
    fileParallelism: false,
    // Worker threads, not child processes: on Windows with Node 24.15.0 the default `forks` pool intermittently lost a worker at
    // start-up (exit code 0xC0000409) in about 5 of 7 full runs, while `threads` never did (0 of 7) and Node 24.13 forks never did.
    // Nothing here depends on process isolation.
    pool: 'threads',
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
