import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { API_PORT, RUN_ID, E2E_DATABASE_URL, WEB_ORIGIN, WEB_PORT, assertE2eDatabase } from './support/env';

assertE2eDatabase(); // fail before any server starts

const root = path.resolve(import.meta.dirname, '..');
const ci = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  outputDir: `./test-results/${RUN_ID}`, // per run: Playwright empties its output directory at start, which would wipe a concurrent run's traces
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: ci ? 2 : 3,
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  reporter: ci ? [['list'], ['html', { open: 'never', outputFolder: `playwright-report/${RUN_ID}` }]] : [['list']],
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  use: {
    baseURL: WEB_ORIGIN,
    timezoneId: 'UTC',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: [
    {
      // The real, built API + real PostgreSQL. No SMTP is configured, so email is genuinely "unavailable".
      command: 'node e2e/support/start-api.mjs',
      cwd: root,
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        CORS_ORIGINS: WEB_ORIGIN,
        APP_URL: WEB_ORIGIN,
        TRUST_PROXY: '1', // lets each test present its own client IP, so rate limits never couple unrelated tests
        LOG_LEVEL: 'silent',
        SCHEDULER_ENABLED: 'true',
        SCHEDULER_INTERVAL_SECONDS: '30',
        SMTP_HOST: '',
        SMTP_PORT: '',
        SMTP_FROM: '',
      },
    },
    {
      // The production build of the web app, serving /api through the same proxy as development.
      command: `npm run preview -w @subcycle/web -- --port ${WEB_PORT} --strictPort --host localhost`,
      cwd: root,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
