import { loadWorkspaceEnv, readConfig } from './config/env.js';
import { createPool, migrationConnection } from './db/database.js';
import { loadMigrations, migrate } from './db/migrations.js';

async function main(): Promise<void> {
  if (process.argv[2] !== 'database:migrate' || process.argv.length !== 3) {
    throw new Error('Use database:migrate');
  }
  loadWorkspaceEnv();
  const config = readConfig();
  const migrations = await loadMigrations();
  const pool = createPool({ ...config.database, max: 1, statement_timeout: 60_000 });
  try {
    const client = await pool.connect();
    try {
      const applied = await migrate(migrationConnection(client), migrations);
      process.stdout.write(`Database migrations complete: ${applied.length} applied.\n`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write(
    'Migration failed; check database access and migration history. Use: database:migrate\n',
  );
  process.exitCode = 1;
});
