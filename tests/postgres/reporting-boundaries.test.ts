import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { observe, seed, maintained } from '../support/reporting.js';
import { readCoverage } from '../../apps/server/src/modules/reports/coverage.js';
import { reportRanges } from '../../apps/server/src/modules/reports/time.js';
import { readReport } from '../../apps/server/src/modules/reports/reader.js';
import { readTrend } from '../../apps/server/src/modules/reports/trend.js';
import { lockSite } from '../../apps/server/src/modules/sites/store.js';
import { rebuildBucket } from '../../apps/server/src/modules/aggregation/buckets.js';
import { maintenanceWorker } from '../../apps/server/src/modules/maintenance/worker.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
  await observe(f);
});
afterEach(async () => {
  await f?.close();
});

describe('M2 timezone, identity, coverage and clock boundaries', () => {
  it('clips UTC hour endpoints in a non-hour timezone instead of counting complete-hour members', async () => {
    await f.pool.query("UPDATE sites SET timezone='Asia/Kolkata'");
    await seed(f, [
      {
        visitor: 'before',
        start: '2026-10-31T18:15Z',
        closed: '2026-10-31T19:00Z',
        pages: [{ at: '2026-10-31T18:15Z', path: '/before' }],
      },
      {
        visitor: 'inside-first',
        start: '2026-10-31T18:45Z',
        closed: '2026-10-31T19:30Z',
        pages: [{ at: '2026-10-31T18:45Z', path: '/first' }],
      },
      {
        visitor: 'inside-last',
        start: '2026-11-01T18:15Z',
        closed: '2026-11-01T19:00Z',
        pages: [{ at: '2026-11-01T18:15Z', path: '/last' }],
      },
      {
        visitor: 'after',
        start: '2026-11-01T18:45Z',
        closed: '2026-11-01T19:30Z',
        pages: [{ at: '2026-11-01T18:45Z', path: '/after' }],
      },
    ]);
    const client = await f.pool.connect();
    try {
      const site = await lockSite(client, f.site);
      const coverage = await readCoverage(client, site);
      const range = reportRanges(
        '2026-11-01',
        '2026-11-02',
        site.timezone,
        new Date('2026-11-03Z'),
      ).current;
      const result = await readTrend(client, site, range, coverage, 'hour', 'uv');
      expect(result.points).toHaveLength(25);
      expect(result.points[0]).toMatchObject({
        start: '2026-10-31T18:30:00.000Z',
        value: 1,
        complete: false,
      });
      expect(result.points.at(-1)).toMatchObject({
        end: '2026-11-01T18:30:00.000Z',
        value: 1,
        complete: false,
      });
      expect((await readReport(client, site, range, coverage)).data).toMatchObject({
        pv: 2,
        uv: 2,
      });
    } finally {
      client.release();
    }
  });
  it('keeps daily scalar trends after distinct expiry but never sums them into a range UV', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-11-01T09:00Z',
        closed: '2026-11-01T10:00Z',
        pages: [{ at: '2026-11-01T09:00Z', path: '/a' }],
      },
    ]);
    await maintained(f, (c) =>
      rebuildBucket(
        c,
        { site: f.site, grain: 'day', start: new Date('2026-11-01Z') },
        { finalize: true },
      ),
    );
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from='2026-11-02Z' WHERE layer IN ('day_members','raw_pv')",
    );
    const response = await f.app.inject({
      url: `/api/v1/stats/trend?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-02&granularity=day&metric=uv`,
      headers: f.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.points).toMatchObject([{ value: 1, complete: true }]);
    const overview = await f.app.inject({
      url: `/api/v1/stats/overview?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-02`,
      headers: f.headers,
    });
    expect(overview.json().data.uv).toBeNull();
    expect(overview.json().meta.unavailable_reasons.uv).toBe('distinct_retention_exceeded');
  });
  it('reports missing first-seen and crossed epochs as unavailable instead of guessing new visitors', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-11-01T09:00Z',
        closed: '2026-11-01T10:00Z',
        pages: [{ at: '2026-11-01T09:00Z', path: '/a' }],
      },
    ]);
    await f.pool.query('UPDATE events SET first_seen_pv_at=NULL');
    const client = await f.pool.connect();
    try {
      const site = await lockSite(client, f.site);
      const coverage = await readCoverage(client, site);
      const range = reportRanges(
        '2026-11-01',
        '2026-11-02',
        'UTC',
        new Date('2026-11-01T10:00Z'),
      ).current;
      const result = await readReport(client, site, range, coverage);
      expect(result.data).toMatchObject({ uv: 1, new_visitors: null, returning_visitors: null });
      expect(result.reasons.new_visitors).toBe('identity_history_unavailable');
      site.config.identity_epochs = [
        { visitor: 1, ip: 1, effective_at: '2026-10-30Z' },
        { visitor: 2, ip: 2, effective_at: '2026-11-01T09:30Z' },
      ];
      expect((await readReport(client, site, range, coverage)).reasons.uv).toBe(
        'identity_epoch_boundary',
      );
    } finally {
      client.release();
    }
  });
  it('pauses freezing and cleanup on persisted clock regression, then requires two stable samples', async () => {
    await f.pool.query(
      "INSERT INTO job_state(name,details) VALUES ('maintenance',jsonb_build_object('last_clock',clock_timestamp()+interval '1 hour'))",
    );
    const worker = maintenanceWorker(f.pool);
    expect(await worker.run()).toEqual({ paused: true });
    expect((await f.pool.query('SELECT * FROM freeze_cursors')).rowCount).toBe(0);
    expect(await worker.run()).toEqual({ paused: true });
    await worker.run();
    expect(
      (
        await f.pool.query(
          "SELECT details->>'clock_paused' AS paused FROM job_state WHERE name='maintenance'",
        )
      ).rows[0].paused,
    ).toBe('false');
    const diagnostics = await f.app.inject({
      url: `/api/v1/sites/${f.site}/diagnostics`,
      headers: f.headers,
    });
    expect(diagnostics.statusCode, diagnostics.body).toBe(200);
    expect(diagnostics.json().data).toMatchObject({
      worker: { clock_paused: false },
      rejection_counts: { available: false },
    });
    expect(diagnostics.body).not.toMatch(/visitor_key|ip_key|ciphertext|csrf/);
  });
});
