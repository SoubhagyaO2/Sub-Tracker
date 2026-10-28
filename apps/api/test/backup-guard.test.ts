import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const guardUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/backup-guard.mjs')).href;

describe('backup/restore verification script: which databases it may touch', () => {
  it('accepts only the throwaway names it generates itself', async () => {
    const { safeDatabaseName, dumpPathFor } = (await import(guardUrl)) as { safeDatabaseName: (n: unknown) => string; dumpPathFor: (n: string) => string };
    expect(safeDatabaseName('restore_check_src_0123abcd')).toBe('restore_check_src_0123abcd');
    expect(safeDatabaseName('restore_check_dst_deadbeef')).toBe('restore_check_dst_deadbeef');
    expect(dumpPathFor('restore_check_src_0123abcd')).toBe('/tmp/restore_check_src_0123abcd.dump');
    for (const bad of ['subcycle', 'subcycle_test', 'subcycle_e2e', 'postgres', 'template1', 'restore_check', 'restore_check_src_', 'restore_check_src_0123abcg', 'restore_check_src_0123abcd; DROP DATABASE subcycle', 'restore_check_src_0123abcd"', 'RESTORE_CHECK_SRC_0123ABCD', '../restore_check_src_0123abcd', '', undefined, null, 42]) {
      expect(() => safeDatabaseName(bad), String(bad)).toThrow(/refusing to touch/);
    }
    expect(() => dumpPathFor('subcycle')).toThrow(/refusing/);
  });
});
