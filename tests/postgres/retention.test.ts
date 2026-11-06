import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { observe, seed, maintained } from '../support/reporting.js';
import { cleanupSite } from '../../apps/server/src/modules/retention/worker.js';
import { rebuildBucket } from '../../apps/server/src/modules/aggregation/buckets.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
  await observe(f, '2026-09-01Z');
});
afterEach(async () => {
  await f?.close();
});
async function ready() {
  await f.pool.query(
    "UPDATE site_data_coverage SET finalized_through='2026-11-01Z',aggregated_through='2026-11-01Z' WHERE layer IN ('hour_aggregates','day_aggregates')",
  );
  await f.pool.query('UPDATE sites SET raw_retention_days=7');
}
async function cleanup(n = 20) {
  for (let i = 0; i < n; i++) await maintained(f, (c) => cleanupSite(c, f.site, 1));
}

describe('M2 retention coverage and resumable cleanup', () => {
  it('refuses cleanup without continuous freeze watermarks and previews the actual safe target', async () => {
    const response = await f.app.inject({
      url: `/api/v1/sites/${f.site}/retention-preview?raw_retention_days=7`,
      headers: f.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .data.layers.every(
          (r: { safe_target: string; available_from: string }) =>
            r.safe_target === r.available_from,
        ),
    ).toBe(true);
    expect(await maintained(f, (c) => cleanupSite(c, f.site))).toBe(false);
  });
  it('records a gap before a partial batch, keeps it after failure and resumes to a committed boundary', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-09-01T09:00Z',
        closed: '2026-09-01T10:00Z',
        pages: [
          { at: '2026-09-01T09:00Z', path: '/a' },
          { at: '2026-09-01T09:10Z', path: '/b' },
        ],
      },
    ]);
    await ready();
    await f.pool.query("UPDATE events SET client_ip='192.0.2.3'");
    await maintained(f, (c) => cleanupSite(c, f.site, 1));
    expect((await f.pool.query('SELECT count(*)::int AS count FROM events')).rows[0].count).toBe(1);
    expect(
      (
        await f.pool.query(
          "SELECT reason FROM coverage_gaps WHERE layer='raw_pv' AND resolved_at IS NULL",
        )
      ).rows,
    ).toEqual([{ reason: 'retention_cleanup' }]);
    const target = (
      await f.pool.query("SELECT cleanup_target FROM site_data_coverage WHERE layer='raw_pv'")
    ).rows[0].cleanup_target;
    await f.pool.query(
      `CREATE FUNCTION fail_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_cleanup BEFORE DELETE ON events FOR EACH ROW EXECUTE FUNCTION fail_cleanup()`,
    );
    await expect(maintained(f, (c) => cleanupSite(c, f.site, 1))).rejects.toThrow('injected');
    expect(
      (await f.pool.query("SELECT cleanup_target FROM site_data_coverage WHERE layer='raw_pv'"))
        .rows[0].cleanup_target,
    ).toEqual(target);
    await f.pool.query('DROP TRIGGER fail_cleanup ON events');
    await cleanup();
    expect((await f.pool.query('SELECT * FROM events')).rowCount).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT * FROM coverage_gaps WHERE layer='raw_pv' AND resolved_at IS NULL",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await f.pool.query("SELECT available_from FROM site_data_coverage WHERE layer='raw_pv'"))
        .rows[0].available_from,
    ).toEqual(target);
    // Identity metadata survives a shortened raw/member retention policy.
    expect((await f.pool.query('SELECT * FROM visitors')).rowCount).toBe(1);
  });
  it('advances empty-site coverage, requires confirmation/CSRF and never restores an expired window when retention grows', async () => {
    await ready();
    await cleanup();
    const before = (
      await f.pool.query("SELECT available_from FROM site_data_coverage WHERE layer='raw_pv'")
    ).rows[0].available_from;
    const body = {
      raw_retention_days: 30,
      member_retention_days: 90,
      aggregate_retention_days: 365,
      confirm_name: 'Test site',
    };
    const response = await f.app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${f.site}/retention`,
      headers: f.headers,
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json().data.layers.find((r: { layer: string }) => r.layer === 'raw_pv').safe_target,
    ).toBe(before.toISOString());
    expect(
      (await f.pool.query("SELECT available_from FROM site_data_coverage WHERE layer='raw_pv'"))
        .rows[0].available_from,
    ).toEqual(before);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/v1/sites/${f.site}/retention`,
          headers: f.headers,
          payload: { ...body, confirm_name: 'wrong' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/v1/sites/${f.site}/retention`,
          headers: { cookie: f.cookie, origin: f.security.adminOrigin },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('keeps final scalars and rankings queryable after raw cleanup while retaining unavailable distinct semantics', async () => {
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-09-01T09:00Z',
        closed: '2026-09-01T10:00Z',
        pages: [{ at: '2026-09-01T09:00Z', path: '/a' }],
      },
    ]);
    await maintained(f, (c) =>
      rebuildBucket(
        c,
        { site: f.site, grain: 'day', start: new Date('2026-09-01Z') },
        { finalize: true },
      ),
    );
    await ready();
    await cleanup();
    const response = await f.app.inject({
      url: `/api/v1/stats/overview?site_id=${f.site}&start_date=2026-09-01&end_date=2026-09-02`,
      headers: f.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ pv: 1, sessions: 1, bounce_rate: 1 });
    expect(response.json().data.uv).toBe(1);
    const pages = await f.app.inject({
      url: `/api/v1/stats/pages?site_id=${f.site}&start_date=2026-09-01&end_date=2026-09-02`,
      headers: f.headers,
    });
    expect(pages.json().data).toMatchObject({ total: 1, items: [{ path: '/a', count: 1 }] });
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from='2026-10-01Z' WHERE layer='day_members'",
    );
    const expired = await f.app.inject({
      url: `/api/v1/stats/overview?site_id=${f.site}&start_date=2026-09-01&end_date=2026-09-02`,
      headers: f.headers,
    });
    expect(expired.json().data).toMatchObject({ pv: 1, uv: null, ip: null });
    expect(expired.json().meta.unavailable_reasons.uv).toBe('distinct_retention_exceeded');
  });
});
