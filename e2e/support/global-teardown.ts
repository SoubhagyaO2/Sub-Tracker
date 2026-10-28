import { assertE2eDatabase, closeDb, deleteTestUsers } from './env';

/** Runs after the whole run, pass or fail: no test user survives. */
export default async function globalTeardown(): Promise<void> {
  assertE2eDatabase();
  await deleteTestUsers();
  await closeDb();
}
