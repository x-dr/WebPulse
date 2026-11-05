import pg from 'pg';
import type { AppConfig } from '../config/env.js';
import { validateMigrationHistory, type Migration, type SqlConnection } from './migrations.js';
import { checkRecoveryGate } from './recovery-gate.js';

export function createPool(config: AppConfig['database']): pg.Pool {
  const pool = new pg.Pool(config);
  // pg emits idle connection errors outside request promises. Never log raw driver messages.
  pool.on('error', () => {
    process.stderr.write('Database idle connection unavailable\n');
  });
  return pool;
}

export function migrationConnection(client: pg.PoolClient): SqlConnection {
  return {
    query: (sql, values) => client.query(sql, values),
    exec: async (sql) => {
      await client.query(sql);
    },
  };
}

export async function checkDatabaseReady(pool: pg.Pool, migrations: Migration[]): Promise<void> {
  const result = await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  validateMigrationHistory(result.rows, migrations);
  if (result.rows.length !== migrations.length) throw new Error('Database migrations pending');
  await checkRecoveryGate(pool);
}
