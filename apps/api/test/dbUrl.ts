/**
 * The test suite DROPs the whole `public` schema, so it must never run against anything but a database whose name
 * says it is disposable. The check is on the parsed database NAME (not a substring of the URL).
 */
export function assertDisposableDatabase(url: string, suffixes: readonly string[] = ['_test']): void {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('The test database URL is not a valid URL.');
  }
  if (!suffixes.some((s) => name.endsWith(s))) {
    throw new Error(`Refusing to run destructive tests against database "${name}": its name must end with ${suffixes.map((s) => `"${s}"`).join(' or ')}.`);
  }
}

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://subcycle:subcycle@localhost:5434/subcycle_test';
