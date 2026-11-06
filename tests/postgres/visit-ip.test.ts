import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture, type Fixture } from '../support/postgres.js';
import { observe, seed } from '../support/reporting.js';
import { loadMigrations, migrate } from '../../apps/server/src/db/migrations.js';
import { migrationConnection } from '../../apps/server/src/db/database.js';
import { readRealtime } from '../../apps/server/src/modules/realtime/snapshot.js';
import { backgroundBudget, transaction } from '../../apps/server/src/db/transaction.js';

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const ipRows = async () =>
  (await f.pool.query('SELECT host(client_ip) AS ip FROM events ORDER BY ingest_seq')).rows;
const visits = (extra = '', site = f.site, headers: Record<string, string> = f.headers) =>
  f.app.inject({
    url: `/api/v1/stats/visits?site_id=${site}&start_date=2026-11-01&end_date=2026-11-02${extra}`,
    headers,
  });

describe('recording and viewing request IPs', () => {
  it('ignores forged forwarding headers from untrusted sockets and records interactions', async () => {
    f = await fixture();
    const pv = f.pv();
    const response = await f.collect(
      [
        pv,
        {
          event_id: randomUUID(),
          type: 'interaction',
          page_view_id: pv.page_view_id,
          interaction_kind: 'click',
        },
      ],
      {
        remoteAddress: '::ffff:192.0.2.8',
        headers: { 'x-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.99' },
      },
    );
    expect(response.statusCode, response.body).toBe(204);
    expect(await ipRows()).toEqual([{ ip: '192.0.2.8' }, { ip: '192.0.2.8' }]);
    const snapshot = await transaction(f.pool, backgroundBudget(), (c) => readRealtime(c, f.site));
    expect(snapshot.recent_pages).toMatchObject([{ client_ip: '192.0.2.8', path: '/guide' }]);
  });
  it('follows only configured proxies and normalizes IPv6 and mapped IPv4', async () => {
    f = await fixture({ trustedProxy: ['10.20.0.10/32'] });
    const event = f.pv('/ipv6');
    const first = await f.collect([event], {
      remoteAddress: '10.20.0.10',
      headers: { 'x-forwarded-for': '2001:0DB8:0000:0000:0000:0000:0000:0001' },
    });
    expect(first.statusCode, first.body).toBe(204);
    expect((await f.collect([event], { remoteAddress: '198.51.100.10' })).statusCode).toBe(204);
    expect(
      (
        await f.collect([f.pv('/mapped')], {
          remoteAddress: '10.20.0.10',
          headers: { 'x-forwarded-for': '::ffff:192.0.2.9' },
        })
      ).statusCode,
    ).toBe(204);
    // The first untrusted hop stops the walk; the claimed leftmost address is ignored.
    expect(
      (
        await f.collect([f.pv('/chain')], {
          remoteAddress: '10.20.0.10',
          headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.7' },
        })
      ).statusCode,
    ).toBe(204);
    expect(await ipRows()).toEqual([
      { ip: '2001:db8::1' },
      { ip: '192.0.2.9' },
      { ip: '198.51.100.7' },
    ]);
  });
  it('upgrades existing facts with null IP without changing their identity and is repeatable', async () => {
    f = await fixture();
    await f.collect([f.pv('/old')]);
    await f.pool.query('ALTER TABLE events DROP COLUMN client_ip');
    await f.pool.query("DELETE FROM schema_migrations WHERE name='005_visit_ip.sql'");
    const before = await f.snapshot();
    const client = await f.pool.connect();
    try {
      const migrations = await loadMigrations();
      expect(await migrate(migrationConnection(client), migrations)).toEqual(['005_visit_ip.sql']);
      expect(await migrate(migrationConnection(client), migrations)).toEqual([]);
    } finally {
      client.release();
    }
    expect(await ipRows()).toEqual([{ ip: null }]);
    const oldEvents = before.events as { data: Record<string, unknown> }[];
    expect(await f.snapshot()).toEqual({
      ...before,
      events: oldEvents.map((row) => ({ data: { ...row.data, client_ip: null } })),
    });
  });
  it('serves authenticated, site-isolated, stable pages in the requested local-day range', async () => {
    f = await fixture();
    await observe(f, '2026-10-30Z');
    await f.pool.query("UPDATE sites SET timezone='Asia/Shanghai'");
    await seed(f, [
      {
        visitor: 'legacy',
        start: '2026-10-31T16:00Z',
        pages: [
          { at: '2026-10-31T16:00Z', path: '/old' },
          { at: '2026-11-01T15:59:59Z', path: '/new' },
          { at: '2026-11-01T16:00Z', path: '/outside' },
        ],
      },
    ]);
    await f.pool.query("UPDATE events SET client_ip='2001:db8::2' WHERE path='/new'");
    const other = await f.app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: f.headers,
      payload: {
        name: 'Other',
        primary_origin: 'https://other.test',
        allowed_origins: ['https://other.test'],
        timezone: 'UTC',
      },
    });
    expect(other.statusCode, other.body).toBe(201);
    const otherSite = other.json().data.site_id as string;
    await seed({ ...f, site: otherSite }, [
      {
        visitor: 'other',
        start: '2026-11-01T10:00Z',
        pages: [{ at: '2026-11-01T10:00Z', path: '/other-site' }],
      },
    ]);
    const first = await visits('&page_size=1');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json().data).toMatchObject({
      total_items: 2,
      page: 1,
      items: [{ path: '/new', client_ip: '2001:db8::2' }],
    });
    const second = await visits('&page_size=1&page=2');
    expect(second.json().data.items).toMatchObject([{ path: '/old', client_ip: null }]);
    expect((await visits('&page_size=1&page=3')).json().data.items).toEqual([]);
    expect((await visits('', f.site, {})).statusCode).toBe(401);
    expect((await visits('', otherSite)).body).not.toContain('/new');
    expect((await visits('', 'site_missing')).statusCode).toBe(404);
    expect((await visits('&page_size=101')).statusCode).toBe(400);
    expect(first.body).not.toMatch(/visitor_key|ip_key|session_id/);
  });
  it('does not present expired or gapped raw records as a complete list', async () => {
    f = await fixture();
    await observe(f, '2026-10-30Z');
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from='2026-11-01T12:00Z' WHERE layer='raw_pv'",
    );
    const expired = (await visits()).json();
    expect(expired.data).toMatchObject({ total_items: null, items: [] });
    expect(expired.meta.unavailable_reasons.visits).toBe('partial_range_raw_unavailable');
    await f.pool.query(
      "UPDATE site_data_coverage SET available_from=observed_from WHERE layer='raw_pv'",
    );
    await f.pool.query(
      "INSERT INTO coverage_gaps(site_id,layer,start_utc,end_utc,reason) SELECT id,'raw_pv','2026-11-01Z','2026-11-02Z','retention_cleanup' FROM sites",
    );
    expect((await visits()).json().meta.unavailable_reasons.visits).toBe('retention_cleanup');
  });
});
