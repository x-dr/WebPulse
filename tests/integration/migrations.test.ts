import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  loadMigrations,
  migrate,
  type SqlConnection,
} from '../../apps/server/src/db/migrations.js';

let database: PGlite;
let connection: SqlConnection;
const migrations = await loadMigrations();

beforeEach(async () => {
  database = new PGlite();
  await database.waitReady;
  connection = {
    query: (sql, values) => database.query<Record<string, unknown>>(sql, values),
    exec: async (sql) => {
      await database.exec(sql);
    },
  };
});
afterEach(async () => {
  await database.close();
});

describe('migration lifecycle on PGlite (not real PostgreSQL concurrency)', () => {
  it('creates reference tables, rule snapshots and migration history and can be rerun', async () => {
    expect(await migrate(connection, migrations)).toEqual(migrations.map((item) => item.name));
    expect(await migrate(connection, migrations)).toEqual([]);
    const result = await database.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(result.rows[0]?.count).toBe(18);
  });

  it('rejects changed SQL and unknown or missing migration history', async () => {
    await migrate(connection, migrations);
    await expect(
      migrate(connection, [{ ...migrations[0]!, checksum: '0'.repeat(64) }]),
    ).rejects.toThrow('Migration history');
    await expect(migrate(connection, [])).rejects.toThrow('Migration history');
    expect(await migrate(connection, migrations)).toEqual([]);
  });

  it('rolls back the entire batch and its history on SQL failure', async () => {
    await expect(
      migrate(connection, [
        ...migrations,
        {
          name: '003_failure.sql',
          checksum: 'a'.repeat(64),
          sql: 'CREATE TABLE partial_work(id integer); SELECT missing_column;',
        },
      ]),
    ).rejects.toThrow();
    const result = await database.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.admins')::text AS table_name UNION ALL SELECT to_regclass('public.partial_work')::text UNION ALL SELECT to_regclass('public.schema_migrations')::text",
    );
    expect(result.rows.every((row) => row.table_name === null)).toBe(true);
    expect(await migrate(connection, migrations)).toEqual(migrations.map((item) => item.name));
  });

  it('enforces reference constraints and preserves data across reruns', async () => {
    await migrate(connection, migrations);
    await database.query(
      "INSERT INTO admins(username,password_hash) VALUES ('admin','test-only-hash')",
    );
    await expect(
      database.query(
        "INSERT INTO admins(username,password_hash) VALUES ('Admin','test-only-hash')",
      ),
    ).rejects.toThrow();
    await expect(
      database.query(
        "INSERT INTO admins(username,password_hash) VALUES ('admin','test-only-hash')",
      ),
    ).rejects.toThrow();
    await migrate(connection, migrations);
    const result = await database.query('SELECT username FROM admins');
    expect(result.rows).toEqual([{ username: 'admin' }]);
  });
});
