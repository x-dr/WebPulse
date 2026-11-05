import { loadWorkspaceEnv, readConfig } from '../../config/env.js';
import { createPool } from '../../db/database.js';
import { readDeletionKey } from '../deletion/encryption.js';
import { readJournalClient } from '../deletion/journal-client.js';
import { maintenanceWorker } from './worker.js';

export function startMaintenance() {
  loadWorkspaceEnv();
  const config = readConfig();
  const key = readDeletionKey();
  const journal = readJournalClient();
  if (process.env.NODE_ENV === 'production' && (!key?.privateKey || !journal))
    throw new Error('Production worker requires private key and independent journal');
  const pool = createPool({ ...config.database, max: 1 });
  const stop = maintenanceWorker(pool, key, journal).start();
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      void stop()
        .then(() => pool.end())
        .catch(() => {
          process.exitCode = 1;
        });
    });
  // Keep the process alive independently of unref'ed maintenance timers.
  const alive = setInterval(() => {}, 60000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => clearInterval(alive));
}
