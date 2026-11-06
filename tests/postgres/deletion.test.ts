import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { observe, seed, maintained, key } from '../support/reporting.js';
import {
  runDeletionBatch,
  type DeletionJournal,
} from '../../apps/server/src/modules/deletion/worker.js';
import { requestDeletion, visitorPreflight } from '../../apps/server/src/modules/deletion/jobs.js';
import { maintenanceTransaction } from '../../apps/server/src/modules/aggregation/connection.js';
import { rebuildBucket } from '../../apps/server/src/modules/aggregation/buckets.js';

let f: Fixture;
const intents = new Map<string, string>();
const journal: DeletionJournal = {
  persist: async (intent) => {
    if (!intents.has(intent.taskId)) intents.set(intent.taskId, String(intents.size + 1));
    return { sequence: intents.get(intent.taskId)! };
  },
};
beforeEach(async () => {
  f = await fixture();
  await observe(f);
  intents.clear();
});
afterEach(async () => {
  await f?.close();
});
async function sample() {
  await seed(f, [
    {
      visitor: 'a',
      start: '2026-11-01T09:00Z',
      closed: '2026-11-01T10:00Z',
      source: 'organic',
      pages: [{ at: '2026-11-01T09:00Z', path: '/a' }],
    },
    {
      visitor: 'b',
      start: '2026-11-01T09:00Z',
      closed: '2026-11-01T10:00Z',
      pages: [{ at: '2026-11-01T09:00Z', path: '/b' }],
    },
  ]);
}
async function siteDelete(id = randomUUID(), confirm_name = 'Test site') {
  return f.app.inject({
    method: 'DELETE',
    url: `/api/v1/sites/${f.site}`,
    headers: { ...f.headers, 'idempotency-key': id },
    payload: { confirm_name },
  });
}
async function runUntilDone() {
  for (let i = 0; i < 70; i++) {
    await maintained(f, (c) => runDeletionBatch(c, f.deletionKey, journal, { limit: 1 }));
    const state = (await f.pool.query('SELECT status,last_error_code,phase FROM deletion_jobs'))
      .rows[0];
    if (state.status === 'succeeded') return;
    expect(state, JSON.stringify(state)).toMatchObject({ status: 'running' });
  }
  throw new Error('Job did not finish');
}

describe('M2 journal-gated deletion, recovery and reconciliation', () => {
  it('requires CSRF, name and idempotency; journal outage cannot delete or expose partial reports', async () => {
    await sample();
    expect((await siteDelete(randomUUID(), 'wrong')).statusCode).toBe(400);
    const id = randomUUID();
    const request = await siteDelete(id);
    expect(request.statusCode, request.body).toBe(202);
    expect((await siteDelete(id)).json().data.job_id).toBe(request.json().data.job_id);
    expect((await siteDelete(id, 'wrong')).statusCode).toBe(409);
    await maintained(f, (c) => runDeletionBatch(c, f.deletionKey));
    expect((await f.pool.query('SELECT count(*)::int AS count FROM events')).rows[0].count).toBe(2);
    const status = await f.app.inject({
      url: `/api/v1/jobs/${request.json().data.job_id}`,
      headers: f.headers,
    });
    expect(status.json().data).toMatchObject({
      status: 'retry_wait',
      phase: 'journal',
      last_error_code: 'journal_unavailable',
    });
    expect(status.body).not.toMatch(/ciphertext|visitor_keys|lease_owner|cursor/);
    expect((await f.patch({ enabled: true })).statusCode).toBe(409);
    expect((await f.collect([f.pv()])).statusCode).toBe(409);
    const report = await f.app.inject({
      url: `/api/v1/stats/overview?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-02`,
      headers: f.headers,
    });
    expect(report.json().error.code).toBe('site_maintenance');
  });
  it('finishes site deletion in bounded batches and preserves task/outbox/tombstone for retries', async () => {
    await sample();
    const id = randomUUID();
    const job = (await siteDelete(id)).json().data.job_id;
    await runUntilDone();
    expect((await f.pool.query('SELECT * FROM sites')).rowCount).toBe(0);
    expect((await f.pool.query('SELECT * FROM deletion_outbox')).rowCount).toBe(1);
    expect((await f.pool.query('SELECT * FROM site_tombstones')).rowCount).toBe(1);
    expect((await siteDelete(id)).json().data).toMatchObject({ job_id: job, status: 'succeeded' });
    expect(
      (await f.app.inject({ url: `/api/v1/jobs/${job}`, headers: f.headers })).json().data.result,
    ).toMatchObject({ verified: true, site_removed: true });
    await expect(
      f.pool.query(
        `INSERT INTO sites(public_id,name,primary_origin,allowed_origins) VALUES ($1,'Reuse','https://test','[]')`,
        [f.site],
      ),
    ).rejects.toThrow('retired');
  });
  it('deletes precise visitor epochs, replaces ranks and preserves another visitor sharing an IP', async () => {
    await sample();
    await f.pool.query(
      "UPDATE events SET client_ip=CASE WHEN path='/a' THEN '192.0.2.1'::inet ELSE '192.0.2.2'::inet END",
    );
    await seed(f, [
      {
        visitor: 'a-epoch2',
        epoch: 2,
        start: '2026-11-01T11:00Z',
        closed: '2026-11-01T12:00Z',
        source: 'organic',
        pages: [{ at: '2026-11-01T11:00Z', path: '/a2' }],
      },
    ]);
    await maintained(f, (c) =>
      rebuildBucket(
        c,
        { site: f.site, grain: 'day', start: new Date('2026-11-01Z') },
        { finalize: true },
      ),
    );
    await maintained(f, (c) =>
      maintenanceTransaction(c, () =>
        requestDeletion(
          c,
          {
            site: f.site,
            kind: 'visitor',
            idempotencyKey: randomUUID(),
            visitorKeys: [
              { epoch: 1, key: key('a').toString('hex') },
              { epoch: 2, key: key('a-epoch2').toString('hex') },
            ],
          },
          f.deletionKey,
        ),
      ),
    );
    await runUntilDone();
    expect((await f.pool.query('SELECT host(client_ip) AS ip FROM events')).rows).toEqual([
      { ip: '192.0.2.2' },
    ]);
    expect((await f.pool.query('SELECT path FROM stats_pages_daily')).rows).toEqual([
      { path: '/b' },
    ]);
    expect((await f.pool.query('SELECT channel FROM stats_sources_daily')).rows).toEqual([
      { channel: 'direct' },
    ]);
    expect((await f.pool.query('SELECT pv::int,uv::int,ip::int FROM stats_daily')).rows).toEqual([
      { pv: 1, uv: 1, ip: 1 },
    ]);
    expect((await f.pool.query('SELECT * FROM ip_days')).rowCount).toBe(1);
    expect((await f.pool.query('SELECT enabled,maintenance_state FROM sites')).rows).toEqual([
      { enabled: false, maintenance_state: 'active' },
    ]);
    expect(
      (await f.pool.query('SELECT * FROM coverage_gaps WHERE resolved_at IS NULL')).rowCount,
    ).toBe(0);
  });
  it('rolls back an interrupted batch, persists cursors and rejects a worker without the current lease', async () => {
    await sample();
    await siteDelete();
    await maintained(f, (c) => runDeletionBatch(c, f.deletionKey, journal));
    // Empty interaction phase advances to page views.
    await maintained(f, (c) => runDeletionBatch(c, f.deletionKey, journal));
    await maintained(f, (c) =>
      runDeletionBatch(c, f.deletionKey, journal, {
        limit: 1,
        beforeCommit: async () => {
          throw new Error('crash');
        },
      }),
    );
    expect((await f.pool.query('SELECT count(*)::int AS count FROM events')).rows[0].count).toBe(2);
    expect(
      (await f.pool.query('SELECT deleted_counts FROM deletion_jobs')).rows[0].deleted_counts
        .events ?? 0,
    ).toBe(0);
    await f.pool.query(
      "UPDATE deletion_jobs SET status='running',next_attempt_at=NULL,lease_owner=$1,lease_expires_at=clock_timestamp()+interval '1 hour'",
      [randomUUID()],
    );
    expect(
      await maintained(f, (c) =>
        runDeletionBatch(c, f.deletionKey, journal, { owner: randomUUID() }),
      ),
    ).toBe(false);
    await f.pool.query(
      "UPDATE deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    await runUntilDone();
    expect(
      (await f.pool.query('SELECT deleted_counts FROM deletion_jobs')).rows[0].deleted_counts
        .events,
    ).toBe(2);
  });
  it('rejects exact visitor deletion when reconstruction facts have expired, leaving the site paused', async () => {
    await sample();
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from='2026-11-01Z' WHERE layer='raw_pv'",
    );
    const proof = await maintained(f, (c) =>
      maintenanceTransaction(c, () => visitorPreflight(c, f.site)),
    );
    expect(proof.exact).toBe(false);
    expect((await f.pool.query('SELECT enabled FROM sites')).rows[0].enabled).toBe(false);
    expect((await f.pool.query('SELECT count(*)::int AS count FROM events')).rows[0].count).toBe(2);
  });
});
