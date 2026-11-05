import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { observe, seed, maintained, key } from '../support/reporting.js';
import { rebuildBucket } from '../../apps/server/src/modules/aggregation/buckets.js';
import { aggregateSite } from '../../apps/server/src/modules/aggregation/worker.js';
import { maintenanceConnection } from '../../apps/server/src/modules/aggregation/connection.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
  await observe(f, '2026-11-01Z');
});
afterEach(async () => {
  await f?.close();
});
const bucket = () => ({ site: f.site, grain: 'day' as const, start: new Date('2026-11-01Z') });
async function sample() {
  await seed(f, [
    {
      visitor: 'a',
      start: '2026-11-01T09:00Z',
      closed: '2026-11-01T10:00Z',
      source: 'organic',
      active: 30000,
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

describe('M2 replacement publication and independent freezing', () => {
  it('replaces disappeared page/source/member groups, keeps a shared IP and a covered zero bucket', async () => {
    await sample();
    await maintained(f, (c) => rebuildBucket(c, bucket()));
    expect((await f.pool.query('SELECT pv::int,uv::int,ip::int FROM stats_daily')).rows).toEqual([
      { pv: 2, uv: 2, ip: 1 },
    ]);
    await f.pool.query('DELETE FROM events WHERE visitor_key=$1', [key('a')]);
    await f.pool.query('DELETE FROM sessions WHERE visitor_key=$1', [key('a')]);
    await maintained(f, (c) => rebuildBucket(c, bucket()));
    expect((await f.pool.query('SELECT path FROM stats_pages_daily')).rows).toEqual([
      { path: '/b' },
    ]);
    expect((await f.pool.query('SELECT channel FROM stats_sources_daily')).rows).toEqual([
      { channel: 'direct' },
    ]);
    expect((await f.pool.query('SELECT pv::int,uv::int,ip::int FROM stats_daily')).rows).toEqual([
      { pv: 1, uv: 1, ip: 1 },
    ]);
    await f.pool.query('DELETE FROM events');
    await f.pool.query('DELETE FROM sessions');
    await maintained(f, (c) => rebuildBucket(c, bucket()));
    await maintained(f, (c) => rebuildBucket(c, bucket()));
    expect((await f.pool.query('SELECT pv::int FROM stats_daily')).rows).toEqual([{ pv: 0 }]);
    expect((await f.pool.query('SELECT * FROM stats_pages_daily')).rowCount).toBe(0);
    expect((await f.pool.query('SELECT * FROM ip_days')).rowCount).toBe(0);
  });
  it('publishes totals and all rankings under one revision and rolls back a failed replacement', async () => {
    await sample();
    await maintained(f, (c) => rebuildBucket(c, bucket()));
    const prior = (
      await f.pool.query('SELECT to_jsonb(t) AS data FROM stats_pages_daily t ORDER BY path')
    ).rows;
    await f.pool.query(
      `CREATE FUNCTION reject_rank() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER reject_rank BEFORE INSERT ON stats_pages_daily FOR EACH ROW EXECUTE FUNCTION reject_rank()`,
    );
    await expect(maintained(f, (c) => rebuildBucket(c, bucket()))).rejects.toThrow();
    expect(
      (await f.pool.query('SELECT to_jsonb(t) AS data FROM stats_pages_daily t ORDER BY path'))
        .rows,
    ).toEqual(prior);
    await f.pool.query('DROP TRIGGER reject_rank ON stats_pages_daily');
    await maintained(f, (c) => rebuildBucket(c, bucket()));
    const revisions = (
      await f.pool.query(
        'SELECT revision FROM stats_daily UNION SELECT revision FROM stats_pages_daily UNION SELECT revision FROM stats_sources_daily',
      )
    ).rows;
    expect(revisions).toHaveLength(1);
  });
  it('retries the whole snapshot when a dirty version changes during publication', async () => {
    await sample();
    await f.pool.query(
      "INSERT INTO dirty_buckets(site_id,grain,bucket_start) SELECT id,'day','2026-11-01Z' FROM sites",
    );
    let attempts = 0;
    await maintained(f, (c) =>
      rebuildBucket(c, bucket(), {
        beforePublish: async () => {
          attempts++;
          if (attempts === 1) await f.pool.query('UPDATE dirty_buckets SET version=version+1');
        },
      }),
    );
    expect(attempts).toBe(2);
    expect((await f.pool.query('SELECT * FROM dirty_buckets')).rowCount).toBe(0);
    expect(
      (
        await f.pool.query(
          'SELECT source_dirty_version::int AS version,revision::int FROM stats_daily',
        )
      ).rows,
    ).toEqual([{ version: 2, revision: 1 }]);
  });
  it('freezes without a dirty queue, enumerates zero days and resumes persisted cursors', async () => {
    await sample();
    await maintained(f, (c) => rebuildBucket(c, bucket()));
    expect((await f.pool.query('SELECT * FROM dirty_buckets')).rowCount).toBe(0);
    for (let i = 0; i < 3; i++) await maintained(f, (c) => aggregateSite(c, f.site, 4));
    const days = (
      await f.pool.query(
        'SELECT local_date::text,pv::int,is_final FROM stats_daily ORDER BY local_date LIMIT 2',
      )
    ).rows;
    expect(days).toEqual([
      { local_date: '2026-11-01', pv: 2, is_final: true },
      { local_date: '2026-11-02', pv: 0, is_final: true },
    ]);
    const cursor = (
      await f.pool.query("SELECT next_bucket_start FROM freeze_cursors WHERE grain='hour'")
    ).rows[0].next_bucket_start;
    await maintained(f, (c) => aggregateSite(c, f.site, 4));
    expect(
      (
        await f.pool.query("SELECT next_bucket_start FROM freeze_cursors WHERE grain='hour'")
      ).rows[0].next_bucket_start.getTime(),
    ).toBeGreaterThan(cursor.getTime());
  });
  it('refuses to freeze open sessions, coverage gaps and expired raw facts, with no false zero or watermark', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-11-01T09:00Z',
        pages: [{ at: '2026-11-01T09:00Z', path: '/a' }],
      },
    ]);
    expect(await maintained(f, (c) => rebuildBucket(c, bucket(), { finalize: true }))).toBe(false);
    await f.pool.query(
      "UPDATE sessions SET status='closed',ended_at=last_activity_at,closed_at=clock_timestamp(),close_reason='timeout'",
    );
    await f.pool.query(
      "INSERT INTO coverage_gaps(site_id,layer,start_utc,end_utc,reason) SELECT id,'raw_pv','2026-11-01Z','2026-11-02Z','test_gap' FROM sites",
    );
    expect(await maintained(f, (c) => rebuildBucket(c, bucket(), { finalize: true }))).toBe(false);
    await f.pool.query('DELETE FROM coverage_gaps');
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from='2026-11-02Z' WHERE layer='raw_pv'",
    );
    expect(await maintained(f, (c) => rebuildBucket(c, bucket(), { finalize: true }))).toBe(false);
    expect((await f.pool.query('SELECT * FROM stats_daily')).rowCount).toBe(0);
  });
  it('serializes maintenance connections across workers and releases the lock after errors', async () => {
    await maintained(f, async () => {
      expect(await maintenanceConnection(f.pool, async () => 'unexpected')).toBeUndefined();
    });
    await expect(
      maintained(f, async () => {
        throw new Error('injected');
      }),
    ).rejects.toThrow('injected');
    expect(await maintained(f, async () => true)).toBe(true);
  });
});
