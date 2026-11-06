import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { observe, seed } from '../support/reporting.js';
import { readCoverage } from '../../apps/server/src/modules/reports/coverage.js';
import { readReport } from '../../apps/server/src/modules/reports/reader.js';
import { readTrend } from '../../apps/server/src/modules/reports/trend.js';
import { reportRanges } from '../../apps/server/src/modules/reports/time.js';
import { lockSite } from '../../apps/server/src/modules/sites/store.js';

const observed = '2026-10-31T16:15:00.000Z'; // 11/01 00:15 in Asia/Shanghai.
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
  await f.pool.query("UPDATE sites SET timezone='Asia/Shanghai'");
  await observe(f, observed);
  await seed(f, [
    {
      visitor: 'a',
      start: observed,
      closed: '2026-10-31T16:45Z',
      active: 30000,
      pages: [
        { at: observed, path: '/a' },
        { at: '2026-10-31T16:20Z', path: '/b' },
      ],
    },
    {
      visitor: 'b',
      start: '2026-10-31T17:05Z',
      pages: [{ at: '2026-10-31T17:05Z', path: '/b' }],
    },
  ]);
});
afterEach(async () => {
  await f?.close();
});

async function read(start = '2026-11-01', asOf = '2026-10-31T17:30Z') {
  const client = await f.pool.connect();
  try {
    const site = await lockSite(client, f.site);
    const coverage = await readCoverage(client, site);
    const range = reportRanges(start, '2026-11-02', site.timezone, new Date(asOf)).current;
    return {
      report: await readReport(client, site, range, coverage),
      trend: await readTrend(client, site, range, coverage, 'hour', 'pv'),
    };
  } finally {
    client.release();
  }
}
const get = (kind: string, extra = '', start = '2026-11-01') =>
  f.app.inject({
    url: `/api/v1/stats/${kind}?site_id=${f.site}&start_date=${start}&end_date=2026-11-02${extra}`,
    headers: f.headers,
  });

describe('first observed natural day reporting', () => {
  it('counts the observed part of today and starts its first trend bucket at site creation', async () => {
    const { report, trend } = await read();
    expect(report.data).toMatchObject({
      pv: 3,
      uv: 2,
      ip: 1,
      sessions: 2,
      closed_sessions: 1,
      bounce_rate: 0,
      avg_active_ms: 30000,
      new_visitors: 2,
      returning_visitors: 0,
    });
    expect(report.reasons).toEqual({});
    expect(trend.points).toMatchObject([
      { start: observed, end: '2026-10-31T17:00:00.000Z', value: 2, complete: false },
      { start: '2026-10-31T17:00:00.000Z', value: 1, complete: false },
    ]);
  });

  it('serves consistent overview, visitors, rankings and metadata for the historical first day', async () => {
    const overview = await get('overview');
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().data).toMatchObject({ pv: 3, uv: 2, ip: 1, sessions: 2 });
    expect(overview.json().meta).toMatchObject({
      start_utc: '2026-10-31T16:00:00.000Z',
      effective_start_utc: observed,
      unavailable_reasons: {},
    });
    expect(overview.json().data.comparison.pv.reason).toBe('before_site_created');
    expect((await get('visitors')).json().data).toMatchObject({
      uv: 2,
      new_visitors: 2,
      returning_visitors: 0,
      new_share: 1,
    });
    for (const [kind, extra, total] of [
      ['pages', '', 3],
      ['sources', '', 2],
      ['entries', '', 2],
      ['pages', '&mode=exit', 1],
    ] as const) {
      const response = await get(kind, extra);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.total).toBe(total);
      expect(response.json().meta.unavailable_reasons).toEqual({});
    }
  });

  it('includes the metadata required by the dashboard for every trend grain and retains point reasons', async () => {
    for (const grain of ['minute', 'hour', 'day']) {
      const response = await get('trend', `&granularity=${grain}&metric=pv`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().meta.unavailable_reasons).toEqual({});
      expect(response.json().data.points[0].start).toBe(observed);
      expect(
        response.json().data.points.reduce((sum: number, p: { value: number }) => sum + p.value, 0),
      ).toBe(3);
    }
    const response = await get('trend', '&granularity=day&metric=pv', '2026-10-31');
    expect(response.json().data.points).toMatchObject([
      { value: null, reason: 'before_site_created' },
      { value: 3, complete: false },
    ]);
  });

  it('keeps earlier dates, actual gaps and expired facts unavailable', async () => {
    expect((await read('2026-10-31')).report.reasons.pv).toBe('before_site_created');
    await f.pool.query(
      "INSERT INTO coverage_gaps(site_id,layer,start_utc,end_utc,reason) SELECT id,'raw_pv',$1,$2,'deletion_rebuild' FROM sites",
      [observed, '2026-10-31T16:30Z'],
    );
    expect((await read()).report.reasons.pv).toBe('deletion_rebuild');
    await f.pool.query('UPDATE coverage_gaps SET resolved_at=clock_timestamp()');
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from='2026-10-31T16:30Z' WHERE layer='raw_pv'",
    );
    expect((await read()).report.reasons.pv).toBe('partial_range_raw_unavailable');
  });

  it('returns real zero traffic for an observed empty first day without inventing ended-session rates', async () => {
    // A date after the last fact remains on the site's first natural day.
    await observe(f, '2026-11-01T08:00Z');
    const { report } = await read('2026-11-01', '2026-11-01T09:00Z');
    expect(report.data).toMatchObject({ pv: 0, uv: 0, ip: 0, sessions: 0, bounce_rate: null });
    expect(report.reasons).toEqual({});
  });
});
