import { readFileSync } from 'node:fs';
import { loadWorkspaceEnv, readConfig } from './config/env.js';
import { createPool, migrationConnection } from './db/database.js';
import { loadMigrations, migrate } from './db/migrations.js';
import { hashPassword } from './modules/auth/password.js';
import { deletionCommand } from './modules/deletion/cli.js';
import { maintenanceWorker } from './modules/maintenance/worker.js';
import { readDeletionKey } from './modules/deletion/encryption.js';
import { ApiError } from './http/errors.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (
    ![
      'database:migrate',
      'admin:create',
      'maintenance:run',
      'visitor:delete',
      'deletion:retry',
    ].includes(command ?? '')
  )
    throw new Error('Invalid command');
  loadWorkspaceEnv();
  const config = readConfig();
  const pool = createPool({ ...config.database, max: 1, statement_timeout: 60_000 });
  try {
    if (command === 'maintenance:run') {
      const result = await maintenanceWorker(pool, readDeletionKey()).run();
      if (!result) throw new ApiError(503, 'maintenance_busy');
      if ('paused' in result) throw new ApiError(503, 'clock_unstable');
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (command === 'visitor:delete' || command === 'deletion:retry') {
      await deletionCommand(
        pool,
        command,
        process.argv.slice(3).filter((arg) => arg !== '--'),
      );
    } else if (command === 'admin:create') {
      const username = process.argv.slice(3).filter((arg) => arg !== '--')[0];
      if (!username || !/^[a-z0-9_.-]{1,64}$/.test(username)) throw new Error('Invalid username');
      if (!process.env.ADMIN_PASSWORD_FILE && process.stdin.isTTY)
        throw new Error('Use password file or stdin');
      const password = readFileSync(process.env.ADMIN_PASSWORD_FILE ?? 0, 'utf8').replace(
        /\r?\n$/,
        '',
      );
      const hash = await hashPassword(password);
      await pool.query('INSERT INTO admins(username,password_hash) VALUES ($1,$2)', [
        username,
        hash,
      ]);
      process.stdout.write('Administrator created.\n');
    } else {
      const client = await pool.connect();
      try {
        const applied = await migrate(migrationConnection(client), await loadMigrations());
        process.stdout.write(`Database migrations complete: ${applied.length} applied.\n`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[a-z_]+$/.test(error.code)
  )
    process.stderr.write(`Command rejected: ${error.code}\n`);
  process.stderr.write(
    'Command failed; check configuration, migrations and unique username. Password: 12-256 bytes via stdin or ADMIN_PASSWORD_FILE.\n',
  );
  process.exitCode = 1;
});
