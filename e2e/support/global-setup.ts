import { assertE2eDatabase, closeDb, deleteStaleTestUsers } from './env';

export default async function globalSetup(): Promise<void> {
  assertE2eDatabase();
  await deleteStaleTestUsers(); // crashed earlier runs only; never another live run's users
  await closeDb();
}
