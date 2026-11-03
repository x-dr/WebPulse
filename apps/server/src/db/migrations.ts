import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

export interface SqlConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  exec(sql: string): Promise<void>;
}

export async function loadMigrations(
  directory = new URL('../../migrations/', import.meta.url),
): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (names.length === 0 || names.some((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error('Invalid migration file list');
  }
  if (new Set(names.map((name) => name.slice(0, 3))).size !== names.length) {
    throw new Error('Duplicate migration version');
  }
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(new URL(name, directory), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

export function validateMigrationHistory(
  rows: Record<string, unknown>[],
  migrations: Migration[],
): void {
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (!migration || migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error('Migration history does not match this application');
    }
  }
}

export async function migrate(
  connection: SqlConnection,
  migrations: Migration[],
): Promise<string[]> {
  await connection.exec('BEGIN');
  try {
    await connection.exec("SET LOCAL lock_timeout = '5s'");
    // Transaction-level lock serializes migrations and releases on commit/rollback/crash.
    await connection.query('SELECT pg_advisory_xact_lock(1464878405, 1)');
    await connection.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL CHECK (length(checksum) = 64),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await connection.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    validateMigrationHistory(rows, migrations);
    const pending = migrations.slice(rows.length);
    for (const migration of pending) {
      await connection.exec(migration.sql);
      await connection.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    }
    await connection.exec('COMMIT');
    return pending.map(({ name }) => name);
  } catch (error) {
    await connection.exec('ROLLBACK');
    throw error;
  }
}
