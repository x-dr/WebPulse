import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { seed, observe, maintained, key } from '../support/reporting.js';
import { runDeletionBatch } from '../../apps/server/src/modules/deletion/worker.js';
import { requestDeletion } from '../../apps/server/src/modules/deletion/jobs.js';
import { maintenanceTransaction } from '../../apps/server/src/modules/aggregation/connection.js';
import { aggregateSite } from '../../apps/server/src/modules/aggregation/worker.js';
import { transaction, backgroundBudget } from '../../apps/server/src/db/transaction.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
  await observe(f);
  await seed(f, [
    {
      visitor: 'a',
      start: '2026-11-01T09:00Z',
      closed: '2026-11-01T10:00Z',
      pages: [{ at: '2026-11-01T09:00Z', path: '/delete' }],
    },
    {
      visitor: 'b',
      start: '2026-11-01T09:00Z',
      closed: '2026-11-01T10:00Z',
      pages: [{ at: '2026-11-01T09:00Z', path: '/keep' }],
    },
  ]);
});
afterEach(async () => {
  await f?.close();
});
const journal = { persist: async () => ({ sequence: '1' }) };

async function killAtBoundary(mode: string, boundary: string) {
  const tsx = createRequire(new URL('../../apps/server/package.json', import.meta.url)).resolve(
    'tsx',
  );
  const worker = spawn(
    process.execPath,
    ['--import', tsx, fileURLToPath(new URL('../support/crash-worker.ts', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exit = once(worker, 'exit');
  worker.stderr.resume();
  const timer = setTimeout(() => worker.kill('SIGKILL'), 10000);
  let reached = false;
  try {
    worker.stdout.on('data', (chunk) => {
      if (String(chunk).includes('barrier')) {
        reached = true;
        worker.kill('SIGKILL');
      }
    });
    worker.stdin.end(
      JSON.stringify({
        database: { ...f.pool.options, password: f.pool.options.password },
        key: f.deletionKey.key.toString('hex'),
        owner: randomUUID(),
        site: f.site,
        mode,
        boundary,
      }) + '\n',
    );
    const [code, signal] = await exit;
    expect(reached, `worker did not reach ${mode}/${boundary}; exit ${code}`).toBe(true);
    expect(signal).toBe('SIGKILL');
  } finally {
    clearTimeout(timer);
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
  }
}

it.each(
  ['journal', 'facts', 'sessions', 'visitors', 'members', 'site', 'aggregates', 'verify'].flatMap(
    (phase) => ['before', 'after'].map((boundary) => ({ phase, boundary })),
  ),
)(
  'resumes $phase after SIGKILL $boundary commit with exact counters',
  async ({ phase, boundary }) => {
    const visitor = ['aggregates', 'verify'].includes(phase);
    await maintained(f, (c) =>
      maintenanceTransaction(c, () =>
        requestDeletion(
          c,
          {
            site: f.site,
            kind: visitor ? 'visitor' : 'site',
            idempotencyKey: randomUUID(),
            confirmName: 'Test site',
            visitorKeys: visitor ? [{ epoch: 1, key: key('a').toString('hex') }] : [],
          },
          f.deletionKey,
        ),
      ),
    );
    for (let i = 0; i < 60; i++) {
      const job = (await f.pool.query('SELECT phase,cursor FROM deletion_jobs')).rows[0];
      if (job.phase === phase && (phase !== 'facts' || job.cursor.table === 'page_views')) break;
      expect(
        await maintained(f, (c) => runDeletionBatch(c, f.deletionKey, journal, { limit: 1 })),
      ).toBe(true);
    }
    expect((await f.pool.query('SELECT phase FROM deletion_jobs')).rows[0].phase).toBe(phase);
    await f.pool.query(
      "UPDATE deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    const before = (await f.pool.query('SELECT deleted_counts,cursor FROM deletion_jobs')).rows[0];
    const facts = (await f.pool.query('SELECT count(*)::int n FROM events')).rows[0].n;
    await killAtBoundary('deletion', boundary);
    if (boundary === 'before') {
      expect(
        (await f.pool.query('SELECT deleted_counts,cursor FROM deletion_jobs')).rows[0],
      ).toEqual(before);
      expect((await f.pool.query('SELECT count(*)::int n FROM events')).rows[0].n).toBe(facts);
    }
    // The test advances a real expired lease rather than waiting 30 seconds per matrix cell.
    await f.pool.query(
      "UPDATE deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second',next_attempt_at=NULL",
    );
    for (let i = 0; i < 80; i++) {
      const state = (await f.pool.query('SELECT status FROM deletion_jobs')).rows[0].status;
      if (state === 'succeeded') break;
      expect(
        await maintained(f, (c) => runDeletionBatch(c, f.deletionKey, journal, { limit: 1 })),
      ).toBe(true);
    }
    const job = (await f.pool.query('SELECT status,deleted_counts FROM deletion_jobs')).rows[0];
    expect(job.status).toBe('succeeded');
    expect(job.deleted_counts.events).toBe(visitor ? 1 : 2);
    expect((await f.pool.query('SELECT path FROM events')).rows).toEqual(
      visitor ? [{ path: '/keep' }] : [],
    );
  },
  20000,
);

it.each(['before', 'after'])(
  'replays dirty aggregation after SIGKILL %s publication without double counting',
  async (boundary) => {
    await f.pool.query(
      "INSERT INTO dirty_buckets(site_id,grain,bucket_start) SELECT id,'day','2026-11-01Z' FROM sites",
    );
    await killAtBoundary('aggregate', boundary);
    if (boundary === 'before')
      expect((await f.pool.query('SELECT * FROM dirty_buckets')).rowCount).toBe(1);
    await maintained(f, (c) => aggregateSite(c, f.site, 5));
    expect((await f.pool.query('SELECT sum(pv)::int AS pv FROM stats_daily')).rows).toEqual([
      { pv: 2 },
    ]);
    expect((await f.pool.query('SELECT * FROM dirty_buckets')).rowCount).toBe(0);
  },
);

it('never acknowledges disk-full SQL failures or pool exhaustion and recovers after faults clear', async () => {
  await f.pool
    .query(`CREATE FUNCTION reject_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private disk path' USING ERRCODE='53100'; END $$;
    CREATE TRIGGER m5_disk_full BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_write()`);
  const before = await f.snapshot();
  const failed = await f.collect([f.pv()]);
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toMatch(/private|53100|disk path/);
  expect(await f.snapshot()).toEqual(before);
  await f.pool.query('DROP TRIGGER m5_disk_full ON events');
  const held = await Promise.all(Array.from({ length: 8 }, () => f.pool.connect()));
  try {
    expect((await f.collect([f.pv()])).statusCode).toBe(503);
  } finally {
    for (const client of held) client.release();
  }
  expect((await f.collect([f.pv()])).statusCode).toBe(204);
  expect((await f.pool.query('SELECT count(*)::int n FROM events')).rows[0].n).toBe(3);
});

it('allows the specified three-second read statement budget while keeping writes at 1.5 seconds', async () => {
  await expect(
    transaction(f.pool, backgroundBudget(), (c) => c.query('SELECT pg_sleep(1.6)'), {
      readOnly: true,
    }),
  ).resolves.toBeDefined();
  await expect(
    transaction(f.pool, backgroundBudget(), (c) => c.query('SELECT pg_sleep(1.6)')),
  ).rejects.toThrow('storage_unavailable');
});
