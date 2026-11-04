import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspaceEnv, readConfig } from '../../apps/server/src/config/env.js';
import { createPool, migrationConnection } from '../../apps/server/src/db/database.js';
import { loadMigrations, migrate } from '../../apps/server/src/db/migrations.js';

// M0 protocol probes against real PostgreSQL, not collection API acceptance tests.
// Only a fresh, test-owned schema is created and removed.
loadWorkspaceEnv();
const config = readConfig();
const migrations = await loadMigrations();
let admin: ReturnType<typeof createPool>;
let pool: ReturnType<typeof createPool>;
let schema: string;
let schemaCreated: boolean;
let clients: Parameters<typeof migrationConnection>[0][];

beforeEach(async () => {
  clients = [];
  schemaCreated = false;
  schema = `webpulse_locks_${randomUUID().replaceAll('-', '')}`;
  admin = createPool(config.database);
  pool = createPool({ ...config.database, options: `-c timezone=UTC -c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  const client = await pool.connect();
  try {
    await migrate(migrationConnection(client), migrations);
    await client.query(`
      INSERT INTO sites(public_id, name, primary_origin, allowed_origins)
      VALUES ('site_lock_probe', 'Lock probe', 'https://example.test', '[]')
    `);
  } finally {
    client.release();
  }
});

afterEach(async () => {
  for (const client of clients) {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
  if (pool) await pool.end();
  if (admin) {
    try {
      if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  }
});

async function connection() {
  const client = await pool.connect();
  clients.push(client);
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  return client;
}

describe('M0 R07 site lock protocol', () => {
  it('allows two collectors to hold FOR SHARE concurrently', async () => {
    const first = await connection();
    const second = await connection();
    await first.query('SELECT enabled FROM sites FOR SHARE');
    const result = await second.query('SELECT enabled FROM sites FOR SHARE NOWAIT');
    expect(result.rows).toEqual([{ enabled: true }]);
  });

  it('demonstrates that FOR KEY SHARE does not protect enabled', async () => {
    const first = await connection();
    const second = await connection();
    await first.query('SELECT enabled FROM sites FOR KEY SHARE');
    await second.query("SET LOCAL lock_timeout = '200ms'");
    // Negative control: the weaker lock would permit disabling during collection.
    await second.query('UPDATE sites SET enabled = false');
    await second.query('COMMIT');
    expect((await first.query('SELECT enabled FROM sites')).rows).toEqual([{ enabled: false }]);
  });

  it('drains a collector before disabling and rechecks a waiting stale precheck', async () => {
    const collector = await connection();
    const operator = await connection();
    const lateCollector = await connection();
    const collectorPid = (await collector.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const operatorPid = (await operator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const latePid = (await lateCollector.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

    expect((await collector.query('SELECT enabled FROM sites FOR SHARE')).rows).toEqual([
      { enabled: true },
    ]);
    expect((await lateCollector.query('SELECT enabled FROM sites')).rows).toEqual([
      { enabled: true },
    ]);
    const disableLock = operator.query('SELECT enabled FROM sites FOR UPDATE').then(
      () => 'locked',
      () => 'failed',
    );
    await expect
      .poll(
        async () =>
          (await pool.query('SELECT pg_blocking_pids($1) AS blockers', [operatorPid])).rows[0]
            .blockers,
        { timeout: 3_000 },
      )
      .toContain(collectorPid);
    await collector.query('COMMIT');
    expect(await disableLock).toBe('locked');
    await operator.query('UPDATE sites SET enabled = false');

    const recheck = lateCollector.query('SELECT enabled FROM sites FOR SHARE').then(
      (result) => result.rows,
      () => null,
    );
    await expect
      .poll(
        async () =>
          (await pool.query('SELECT pg_blocking_pids($1) AS blockers', [latePid])).rows[0].blockers,
        { timeout: 3_000 },
      )
      .toContain(operatorPid);
    await operator.query('COMMIT');
    expect(await recheck).toEqual([{ enabled: false }]);
  });

  it('rolls back a timed-out disable without falsely changing state', async () => {
    const collector = await connection();
    const operator = await connection();
    await collector.query('SELECT enabled FROM sites FOR SHARE');
    await operator.query("SET LOCAL lock_timeout = '100ms'");
    await expect(operator.query('UPDATE sites SET enabled = false')).rejects.toMatchObject({
      code: '55P03',
    });
    await operator.query('ROLLBACK');
    await collector.query('COMMIT');
    expect((await pool.query('SELECT enabled FROM sites')).rows).toEqual([{ enabled: true }]);
  });
});
