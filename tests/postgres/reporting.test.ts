import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { observe, seed } from '../support/reporting.js';
import { readCoverage } from '../../apps/server/src/modules/reports/coverage.js';
import { reportRanges } from '../../apps/server/src/modules/reports/time.js';
import { readReport } from '../../apps/server/src/modules/reports/reader.js';
import { lockSite } from '../../apps/server/src/modules/sites/store.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
  await observe(f);
});
afterEach(async () => {
  await f?.close();
});
async function read(start: string, end: string, asOf = '2026-11-03T10:00Z') {
  const client = await f.pool.connect();
  try {
    const site = await lockSite(client, f.site);
    const coverage = await readCoverage(client, site);
    return readReport(
      client,
      site,
      reportRanges(start, end, 'UTC', new Date(asOf)).current,
      coverage,
    );
  } finally {
    client.release();
  }
}
const get = (kind: string, extra = '') =>
  f.app.inject({
    url: `/api/v1/stats/${kind}?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-03${extra}`,
    headers: f.headers,
  });

describe('M2 exact reports and partial-day comparison on PostgreSQL', () => {
  it('unions full-day membership and partial PVs, excludes the exact end, preserves first-seen classification', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-11-01T09:00Z',
        closed: '2026-11-01T10:00Z',
        pages: [{ at: '2026-11-01T09:00Z', path: '/a' }],
      },
      {
        visitor: 'a',
        start: '2026-11-02T09:00Z',
        closed: '2026-11-02T11:30Z',
        pages: [{ at: '2026-11-02T09:00Z', path: '/a' }],
      },
      {
        visitor: 'b',
        start: '2026-11-02T15:00Z',
        closed: '2026-11-02T16:00Z',
        pages: [{ at: '2026-11-02T15:00Z', path: '/b' }],
      },
      {
        visitor: 'c',
        start: '2026-11-02T10:00Z',
        closed: '2026-11-02T10:40Z',
        pages: [{ at: '2026-11-02T10:00Z', path: '/c' }],
      },
    ]);
    const result = await read('2026-11-01', '2026-11-03', '2026-11-02T10:00Z');
    expect(result.data).toMatchObject({
      pv: 2,
      uv: 1,
      ip: 1,
      new_visitors: 1,
      returning_visitors: 0,
      sessions: 2,
      closed_sessions: 1,
    });
    const single = await read('2026-11-02', '2026-11-03', '2026-11-02T10:00Z');
    expect(single.data).toMatchObject({
      pv: 1,
      uv: 1,
      new_visitors: 0,
      returning_visitors: 1,
      sessions: 1,
      closed_sessions: 0,
      bounce_rate: null,
    });
  });
  it('includes closed_at at the cutoff and attributes a cross-midnight session to its start', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-11-01T23:55Z',
        closed: '2026-11-02T00:40Z',
        active: 30000,
        pages: [
          { at: '2026-11-01T23:55Z', path: '/a' },
          { at: '2026-11-02T00:10Z', path: '/b' },
        ],
      },
      {
        visitor: 'b',
        start: '2026-11-02T09:00Z',
        closed: '2026-11-02T10:00Z',
        pages: [{ at: '2026-11-02T09:00Z', path: '/b' }],
      },
    ]);
    expect((await read('2026-11-02', '2026-11-03', '2026-11-02T10:00Z')).data).toMatchObject({
      pv: 2,
      uv: 2,
      ip: 1,
      sessions: 1,
      closed_sessions: 1,
      bounce_rate: 1,
    });
    expect((await read('2026-11-01', '2026-11-02')).data).toMatchObject({
      pv: 1,
      sessions: 1,
      closed_sessions: 1,
      total_closed_active_ms: 30000,
      bounce_rate: 0,
    });
  });
  it('serves authenticated overview/trend/visitors and stable paginated rankings with a whole-range denominator', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-11-01T09:00Z',
        closed: '2026-11-01T10:00Z',
        active: 30000,
        pages: [
          { at: '2026-11-01T09:00Z', path: '/a' },
          { at: '2026-11-01T09:10Z', path: '/b' },
        ],
      },
      {
        visitor: 'b',
        start: '2026-11-02T09:00Z',
        closed: '2026-11-02T10:00Z',
        source: 'referral',
        pages: [{ at: '2026-11-02T09:00Z', path: '/b' }],
      },
    ]);
    const overview = await get('overview');
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().data).toMatchObject({
      pv: 3,
      uv: 2,
      ip: 1,
      sessions: 2,
      bounce_rate: 0.5,
      avg_active_ms: 15000,
      new_visitors: 2,
    });
    expect(overview.headers['cache-control']).toBe('private, no-store');
    const pages = await get('pages', '&page_size=1');
    expect(pages.statusCode, pages.body).toBe(200);
    expect(pages.json().data).toMatchObject({
      total: 3,
      total_items: 2,
      other_count: 1,
      items: [{ path: '/b', count: 2, share: 2 / 3 }],
    });
    expect((await get('entries')).json().data.total).toBe(2);
    expect((await get('pages', '&mode=exit')).json().data.total).toBe(2);
    const sources = await get('sources', '&channel=direct&page_size=1');
    expect(sources.statusCode, sources.body).toBe(200);
    expect(sources.json().data).toMatchObject({
      total: 2,
      items: [{ channel: 'direct', sessions: 1, share: 0.5 }],
    });
    expect((await get('visitors')).json().data).toMatchObject({
      uv: 2,
      new_visitors: 2,
      returning_visitors: 0,
    });
    const trend = await get('trend', '&granularity=day&metric=uv');
    expect(trend.statusCode, trend.body).toBe(200);
    expect(trend.json().data.points.map((p: { value: number }) => p.value)).toEqual([1, 1]);
  });
  it('returns precise unavailable reasons for gaps, raw retention, missing identity and before creation', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-11-02T09:00Z',
        closed: '2026-11-02T11:30Z',
        pages: [{ at: '2026-11-02T09:00Z', path: '/a' }],
      },
    ]);
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from='2026-11-03Z' WHERE layer='raw_pv'",
    );
    const partial = await read('2026-11-02', '2026-11-03', '2026-11-02T10:00Z');
    expect(partial.data.pv).toBeNull();
    expect(partial.reasons.uv).toBe('partial_range_raw_unavailable');
    const full = await read('2026-11-02', '2026-11-03');
    expect(full.data.uv).toBe(1);
    await f.pool.query('UPDATE visitor_days SET first_seen_pv_at=first_seen_pv_at');
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from='2026-11-03Z' WHERE layer='day_members'",
    );
    expect((await read('2026-11-02', '2026-11-03')).reasons.uv).toBe('distinct_retention_exceeded');
    await f.pool.query(
      "INSERT INTO coverage_gaps(site_id,layer,start_utc,end_utc,reason) SELECT id,'day_members','2026-11-02Z','2026-11-03Z','privacy_replay_unverifiable' FROM sites",
    );
    expect((await read('2026-11-02', '2026-11-03')).reasons.uv).toBe('privacy_replay_unverifiable');
    expect((await read('2026-10-29', '2026-10-30')).reasons.pv).toBe('before_site_created');
  });
  it('rejects unauthenticated, unknown, mismatched timezone, malformed and future/oversized queries', async () => {
    expect(
      (
        await f.app.inject({
          url: `/api/v1/stats/overview?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-03`,
        })
      ).statusCode,
    ).toBe(401);
    for (const extra of ['&timezone=Asia/Shanghai', '&extra=1', '&page=0'])
      expect((await get('pages', extra)).statusCode).toBe(400);
    expect((await get('trend', '&metric=sql')).statusCode).toBe(400);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/stats/overview?site_id=${f.site}&start_date=2026-02-30&end_date=2026-11-03`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(400);
    await f.pool.query('UPDATE sites SET enabled=false');
    expect((await get('overview')).statusCode).toBe(200);
    await f.pool.query("UPDATE sites SET maintenance_state='deleting'");
    expect((await get('overview')).json().error.code).toBe('site_maintenance');
  });
});
