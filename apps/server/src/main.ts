import { buildApp } from './app.js';
import { loadWorkspaceEnv, readConfig } from './config/env.js';
import { checkDatabaseReady, createPool } from './db/database.js';
import { loadMigrations } from './db/migrations.js';

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const config = readConfig();
  const migrations = await loadMigrations();
  const pool = createPool(config.database);
  const app = buildApp({
    ready: () => checkDatabaseReady(pool, migrations),
    logLevel: config.logLevel,
  });
  app.addHook('onClose', () => pool.end());
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000).unref();
    try {
      await app.close();
    } finally {
      clearTimeout(deadline);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch(() => {
  // Driver/config errors can contain addresses or credentials. Keep startup output bounded.
  process.stderr.write('WebPulse startup failed; check environment, port and migration files.\n');
  process.exitCode = 1;
});
