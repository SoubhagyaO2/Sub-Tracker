import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertE2eDatabase, EMAIL_PREFIX, RUN_ID } from '../../../e2e/support/env.js';

const root = path.resolve(import.meta.dirname, '../../..');

describe('the browser suite only touches databases named *_e2e', () => {
  it('assertE2eDatabase accepts *_e2e and rejects everything else', () => {
    expect(assertE2eDatabase('postgres://u:p@h:5432/subcycle_e2e')).toBe('subcycle_e2e');
    for (const bad of ['postgres://u:p@h/subcycle', 'postgres://u:p@h/subcycle_test', 'postgres://u:p@h/production', 'postgres://u:p@h/e2e', 'postgres://u:p@h/x_e2e_backup', 'postgres://u:p@h/Subcycle_E2E', 'postgres://u:p@h/subcycle_e2e;DROP', 'nonsense']) {
      expect(() => assertE2eDatabase(bad), bad).toThrow();
    }
  });

  it('the API launcher refuses a non-e2e database before connecting to anything', () => {
    const run = spawnSync(process.execPath, ['e2e/support/start-api.mjs'], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, DATABASE_URL: 'postgres://u:p@127.0.0.1:1/subcycle' } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/Refusing to start: database "subcycle" does not end with "_e2e"/);
    expect(run.stderr).not.toMatch(/ECONNREFUSED/); // it never even tried to connect
  });

  it('every run has its own namespace, and test users can only be on the reserved domain', () => {
    expect(RUN_ID).toMatch(/^[0-9a-f]{8}$/);
    expect(EMAIL_PREFIX).toBe(`e2e-${RUN_ID}-`);
  });
});
