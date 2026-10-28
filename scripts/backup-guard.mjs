// The only database names scripts/verify-backup-restore.mjs is allowed to create, fill, dump, restore into or drop.
// Kept in its own file so the rule can be unit-tested (apps/api/test/backup-guard.test.ts).
export const DISPOSABLE = /^restore_check_(src|dst)_[0-9a-f]{8}$/;

export function safeDatabaseName(name) {
  if (typeof name !== 'string' || !DISPOSABLE.test(name)) throw new Error(`refusing to touch database "${String(name).slice(0, 60)}"`);
  return name;
}

/** The dump file lives inside the container and is named after the source database, so it can never be a real path. */
export function dumpPathFor(srcName) {
  return `/tmp/${safeDatabaseName(srcName)}.dump`;
}
