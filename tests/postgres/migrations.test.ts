import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { loadWorkspaceEnv, readConfig } from '../../apps/server/src/config/env.js';
import {
  createPool,
  checkDatabaseReady,
  migrationConnection,
} from '../../apps/server/src/db/database.js';
import { loadMigrations, migrate } from '../../apps/server/src/db/migrations.js';

// Explicitly invoked development check. All DDL lives in a fresh test-owned schema.
loadWorkspaceEnv();
const config = readConfig();
const migrations = await loadMigrations();
let admin: ReturnType<typeof createPool>;
let pool: ReturnType<typeof createPool>;
let schema: string;

beforeEach(async () => {
  schema = `webpulse_test_${randomUUID().replaceAll('-', '')}`;
  admin = createPool(config.database);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool({ ...config.database, options: `-c timezone=UTC -c search_path=${schema}` });
});
afterEach(async () => {
  if (pool) await pool.end();
  if (admin) {
    try {
      if (schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  }
});

describe('real PostgreSQL migration and readiness', () => {
  it('serializes two concurrent migrations without duplicate execution', async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      const results = await Promise.all([
        migrate(migrationConnection(first), migrations),
        migrate(migrationConnection(second), migrations),
      ]);
      expect(results.map((result) => result.length).sort()).toEqual([0, migrations.length]);
      await expect(checkDatabaseReady(pool, migrations)).resolves.toBeUndefined();
    } finally {
      first.release();
      second.release();
    }
  });

  it('readiness rejects absent, pending, tampered and unknown migration histories', async () => {
    await expect(checkDatabaseReady(pool, migrations)).rejects.toThrow();
    const client = await pool.connect();
    try {
      await migrate(migrationConnection(client), migrations);
    } finally {
      client.release();
    }
    await expect(
      checkDatabaseReady(pool, [
        ...migrations,
        {
          name: '003_pending.sql',
          checksum: 'b'.repeat(64),
          sql: '',
        },
      ]),
    ).rejects.toThrow('pending');
    await pool.query("UPDATE schema_migrations SET checksum = repeat('0',64)");
    await expect(checkDatabaseReady(pool, migrations)).rejects.toThrow('history');
    for (const migration of migrations)
      await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE name=$2', [
        migration.checksum,
        migration.name,
      ]);
    await expect(checkDatabaseReady(pool, [])).rejects.toThrow('history');
    await expect(checkDatabaseReady(pool, migrations)).resolves.toBeUndefined();
  });

  it('releases the migration lock after a failed transaction and rolls back DDL', async () => {
    const client = await pool.connect();
    try {
      await expect(
        migrate(migrationConnection(client), [
          ...migrations,
          {
            name: '003_fail.sql',
            checksum: 'c'.repeat(64),
            sql: 'CREATE TABLE partial_work(id integer); SELECT missing_column;',
          },
        ]),
      ).rejects.toThrow();
      expect((await client.query("SELECT to_regclass('admins') AS name")).rows[0].name).toBeNull();
    } finally {
      client.release();
    }
    const retry = await pool.connect();
    try {
      expect(await migrate(migrationConnection(retry), migrations)).toEqual(
        migrations.map((item) => item.name),
      );
    } finally {
      retry.release();
    }
  });
});
