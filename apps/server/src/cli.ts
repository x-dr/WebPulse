import { readFileSync } from 'node:fs';
import { loadWorkspaceEnv, readConfig } from './config/env.js';
import { createPool, migrationConnection } from './db/database.js';
import { loadMigrations, migrate } from './db/migrations.js';
import { hashPassword } from './modules/auth/password.js';
import { deletionCommand } from './modules/deletion/cli.js';
import { maintenanceWorker } from './modules/maintenance/worker.js';
import { readDeletionKey } from './modules/deletion/encryption.js';
import { ApiError } from './http/errors.js';
import { prepareRoles } from './db/roles.js';
import { readJournalClient } from './modules/deletion/journal-client.js';
import { FileJournal } from './modules/deletion/journal.js';
import { serveJournal } from './modules/deletion/journal-server.js';
import {
  lockRecovery,
  replayRecovery,
  readJournalSigningKey,
} from './modules/deletion/recovery.js';
import { startMaintenance } from './modules/maintenance/main.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  loadWorkspaceEnv();
  if (command === 'worker:start') {
    startMaintenance();
    return;
  }
  if (command === 'journal:serve') {
    await serveJournal();
    return;
  }
  if (command === 'journal:init') {
    await new FileJournal(process.env.JOURNAL_DIR!, readJournalSigningKey()).initialize();
    process.stdout.write('Independent journal initialized.\n');
    return;
  }
  if (
    ![
      'database:migrate',
      'admin:create',
      'maintenance:run',
      'visitor:delete',
      'deletion:retry',
      'database:prepare',
      'recovery:lock',
      'recovery:replay',
      'backup:register',
      'backup:metadata',
      'backup:mark-destroyed',
    ].includes(command ?? '')
  )
    throw new Error('Invalid command');
  const config = readConfig();
  const pool = createPool({ ...config.database, max: 1, statement_timeout: 60_000 });
  try {
    if (command === 'recovery:lock') {
      await lockRecovery(pool);
      process.stdout.write('Recovery locked.\n');
    } else if (command === 'recovery:replay') {
      const key = readDeletionKey();
      const journal = readJournalClient();
      if (!key || !journal) throw new Error('Recovery keys and journal required');
      const result = await replayRecovery(
        pool,
        key,
        journal,
        await journal.read(),
        readJournalSigningKey(),
      );
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (command === 'backup:metadata') {
      const journal = readJournalClient();
      if (!journal) throw new Error('Journal required');
      const head = (await journal.read()).head;
      const now = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      const identities = (
        await pool.query(
          "SELECT public_id,key_version,config->'identity_epochs' AS epochs FROM sites ORDER BY id",
        )
      ).rows;
      process.stdout.write(
        JSON.stringify({
          snapshot_at: now.toISOString(),
          journal: head,
          key_versions: { deletion: process.env.DELETION_KEY_ID ?? 'v1', identities },
        }) + '\n',
      );
    } else if (command === 'backup:mark-destroyed') {
      const value = JSON.parse(readFileSync(0, 'utf8'));
      if (!/^[a-f0-9-]{36}$/.test(value.id) || value.all_copies_destroyed !== true)
        throw new Error('Explicit all-copies confirmation required');
      const changed = await pool.query(
        'UPDATE backup_inventory SET destroyed_at=clock_timestamp() WHERE id=$1 AND destroyed_at IS NULL RETURNING id',
        [value.id],
      );
      if (!changed.rowCount) throw new Error('Backup absent or already marked');
      process.stdout.write(
        'Destruction confirmation recorded; journal and keys remain retained.\n',
      );
    } else if (command === 'backup:register') {
      const value = JSON.parse(readFileSync(0, 'utf8'));
      if (
        !/^[a-f0-9-]{36}$/.test(value.id) ||
        !/^[a-f0-9]{64}$/.test(value.checksum) ||
        !/^[a-f0-9]{64}$/.test(value.journal.mac) ||
        !/^\d+$/.test(value.journal.sequence) ||
        !value.location ||
        !value.key_versions
      )
        throw new Error('Invalid backup manifest');
      await pool.query(
        'INSERT INTO backup_inventory(id,snapshot_at,completed_at,checksum,key_versions,location,journal_sequence,journal_mac) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          value.id,
          value.snapshot_at,
          value.completed_at,
          value.checksum,
          value.key_versions,
          value.location,
          value.journal.sequence,
          value.journal.mac,
        ],
      );
      process.stdout.write('Backup registered; remote verification required before rotation.\n');
    } else if (command === 'maintenance:run') {
      const result = await maintenanceWorker(pool, readDeletionKey(), readJournalClient()).run();
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
        if (command === 'database:prepare') await prepareRoles(client);
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
