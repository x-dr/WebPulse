import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { defaultRules, type CollectionEvent } from '../../packages/shared/src/index.js';
import { fixture, type Fixture } from '../support/postgres.js';
import { sessionCloser } from '../../apps/server/src/modules/sessions/worker.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f?.close();
});
const interaction = (page: string): CollectionEvent => ({
  event_id: randomUUID(),
  type: 'interaction',
  page_view_id: page,
  interaction_kind: 'click',
});

describe('M1 collection on real PostgreSQL', () => {
  it('persists the canonical request IP with cleaned facts without raw URL or cid', async () => {
    const event = f.pv('/product/123?token=never-save-this#private');
    if (event.type === 'page_view') event.referrer = 'https://google.com/private?secret=x';
    const response = await f.collect([event], { remoteAddress: '192.0.2.1' });
    expect(response.statusCode, response.body).toBe(204);
    const dump = JSON.stringify(await f.snapshot());
    for (const secret of ['never-save-this', '/product/123', f.cid, '?secret'])
      expect(dump).not.toContain(secret);
    const row = (
      await f.pool.query(
        'SELECT path,occurred_at=received_at AS same,host(client_ip) AS ip FROM events',
      )
    ).rows[0];
    expect(row).toEqual({ path: '/product/:id', same: true, ip: '192.0.2.1' });
    expect((await f.pool.query('SELECT page_views,source_channel FROM sessions')).rows).toEqual([
      { page_views: 1, source_channel: 'organic' },
    ]);
  });
  it('serializes simultaneous first PVs into one visitor and open session', async () => {
    const responses = await Promise.all([f.collect([f.pv('/a')]), f.collect([f.pv('/b')])]);
    expect(responses.map((r) => r.statusCode)).toEqual([204, 204]);
    expect((await f.pool.query('SELECT page_views FROM sessions')).rows).toEqual([
      { page_views: 2 },
    ]);
    expect((await f.pool.query('SELECT activity_seq FROM visitors')).rows).toEqual([
      { activity_seq: '2' },
    ]);
  });
  it('deduplicates retries across IP changes without touching any facts or activity', async () => {
    const event = f.pv();
    expect((await f.collect([event])).statusCode).toBe(204);
    const before = await f.snapshot();
    expect((await f.collect([event], { remoteAddress: '198.51.100.9' })).statusCode).toBe(204);
    expect(await f.snapshot()).toEqual(before);
  });
  it('normalizes confirmed retries with their stored rule version', async () => {
    const event = f.pv('/product/123');
    expect((await f.collect([event])).statusCode).toBe(204);
    expect(
      (await f.patch({ rules: { ...defaultRules, redact_identifiers: false } })).statusCode,
    ).toBe(200);
    const before = await f.snapshot();
    expect((await f.collect([event])).statusCode).toBe(204);
    expect(await f.snapshot()).toEqual(before);
  });
  it('rolls back a new event when a later event ID conflicts', async () => {
    const event = f.pv();
    expect((await f.collect([event])).statusCode).toBe(204);
    const conflict = { ...event, reason: 'navigation' } as CollectionEvent;
    const before = await f.snapshot();
    const response = await f.collect([f.pv('/other'), conflict]);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('event_conflict');
    expect(await f.snapshot()).toEqual(before);
  });
  it('accepts only one interaction per page and does not renew on another ID', async () => {
    const page = f.pv();
    expect((await f.collect([page])).statusCode).toBe(204);
    expect((await f.collect([interaction(page.page_view_id)])).statusCode).toBe(204);
    const before = await f.snapshot();
    expect((await f.collect([interaction(page.page_view_id)])).statusCode).toBe(204);
    expect(await f.snapshot()).toEqual(before);
  });
  it('keeps confirmed interaction retry idempotent after closure, rejects fresh interaction atomically', async () => {
    const page = f.pv(),
      event = interaction(page.page_view_id);
    expect((await f.collect([page, event])).statusCode).toBe(204);
    await f.pool.query(
      "UPDATE sessions SET status='closed',ended_at=last_activity_at,closed_at=clock_timestamp(),close_reason='timeout'",
    );
    const before = await f.snapshot();
    expect((await f.collect([event])).statusCode).toBe(204);
    expect(
      (await f.collect([{ ...event, interaction_kind: 'key' } as CollectionEvent])).json().error
        .code,
    ).toBe('event_conflict');
    expect((await f.collect([page, interaction(page.page_view_id)])).json().error.code).toBe(
      'session_expired',
    );
    expect(await f.snapshot()).toEqual(before);
  });
  it.each([
    ['29 minutes 59 seconds', 204],
    ['30 minutes', 409],
    ['12 hours', 409],
  ] as const)('applies exact idle/max duration boundary %s', async (age, status) => {
    const page = f.pv();
    expect((await f.collect([page])).statusCode).toBe(204);
    await f.pool.query(
      `UPDATE sessions SET started_at=clock_timestamp()-$1::interval,last_activity_at=clock_timestamp()-$2::interval`,
      [age, age === '12 hours' ? '1 second' : age],
    );
    const before = await f.snapshot();
    const result = await f.collect([interaction(page.page_view_id)]);
    expect(result.statusCode, result.body).toBe(status);
    if (status === 409) expect(await f.snapshot()).toEqual(before);
  });
  it('rejects unknown and foreign pages without exposing ownership', async () => {
    const page = f.pv();
    expect((await f.collect([page])).statusCode).toBe(204);
    expect(
      (await f.collect([interaction(page.page_view_id)], {}, randomUUID())).json().error.code,
    ).toBe('page_view_missing');
    expect((await f.heartbeat(randomUUID(), 1)).json().error.code).toBe('page_view_missing');
  });
  it('merges overlapping tabs, deduplicates cumulative heartbeat and rejects closed heartbeat', async () => {
    const a = f.pv('/a'),
      b = f.pv('/b');
    expect((await f.collect([a, b])).statusCode).toBe(204);
    await f.pool.query("UPDATE page_views SET occurred_at=occurred_at-interval '20 seconds'");
    await f.pool.query("UPDATE sessions SET started_at=started_at-interval '20 seconds'");
    expect((await f.heartbeat(a.page_view_id, 15000)).statusCode).toBe(204);
    expect((await f.heartbeat(b.page_view_id, 15000)).statusCode).toBe(204);
    const ms = Number((await f.pool.query('SELECT active_ms FROM sessions')).rows[0].active_ms);
    expect(ms).toBeGreaterThanOrEqual(15000);
    expect(ms).toBeLessThan(16000);
    const before = await f.snapshot();
    expect((await f.heartbeat(a.page_view_id, 1000)).statusCode).toBe(204);
    expect(await f.snapshot()).toEqual(before);
    expect((await f.pool.query('SELECT latest_path,activity_seq FROM visitors')).rows[0]).toEqual({
      latest_path: '/b',
      activity_seq: '4',
    });
    await f.pool.query(
      "UPDATE sessions SET status='closed',ended_at=last_activity_at,closed_at=clock_timestamp(),close_reason='timeout'",
    );
    expect((await f.heartbeat(a.page_view_id, 1000)).json().error.code).toBe('session_expired');
  });
  it('closes timed-out sessions separately then resumes with a fresh PV', async () => {
    expect((await f.collect([f.pv()])).statusCode).toBe(204);
    await f.pool.query(
      "UPDATE sessions SET started_at=started_at-interval '31 minutes',last_activity_at=last_activity_at-interval '31 minutes'",
    );
    expect(await sessionCloser(f.pool).run()).toBe(1);
    expect((await f.collect([f.pv('/resume')])).statusCode).toBe(204);
    expect(
      (await f.pool.query('SELECT status,page_views FROM sessions ORDER BY started_at')).rows,
    ).toEqual([
      { status: 'closed', page_views: 1 },
      { status: 'open', page_views: 1 },
    ]);
  });
  it('rejects clock regression and rolls back a newly attempted page', async () => {
    expect((await f.collect([f.pv()])).statusCode).toBe(204);
    await f.pool.query("UPDATE visitors SET last_activity_at=clock_timestamp()+interval '1 hour'");
    const before = await f.snapshot();
    const response = await f.collect([f.pv('/later')]);
    expect(response.json().error.code).toBe('clock_regressed');
    expect(await f.snapshot()).toEqual(before);
  });
  it('counts two visitors sharing an IP as two UV members and one IP member', async () => {
    expect((await f.collect([f.pv()])).statusCode).toBe(204);
    expect((await f.collect([f.pv()], {}, randomUUID())).statusCode).toBe(204);
    expect(
      (
        await f.pool.query(
          'SELECT (SELECT count(*)::int FROM visitor_days) AS uv,(SELECT count(*)::int FROM ip_days) AS ip',
        )
      ).rows[0],
    ).toEqual({ uv: 2, ip: 1 });
  });
  it('honors opt-out, bot and excluded path without creating visitors', async () => {
    const event = f.pv();
    expect(
      (await f.collect([event], { headers: { origin: 'https://web.test', dnt: '1' } })).statusCode,
    ).toBe(403);
    expect(
      (await f.collect([event], { headers: { origin: 'https://web.test', 'sec-gpc': '1' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await f.collect([event], {
          headers: { origin: 'https://web.test', 'user-agent': 'ExampleBot' },
        })
      ).statusCode,
    ).toBe(204);
    expect((await f.collect([f.pv('/reset-password/secret')])).statusCode).toBe(204);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM visitors')).rows[0].n).toBe(0);
  });
  it('validates strict schemas, sizes, exact Origin and precise CORS preflight', async () => {
    const event = f.pv();
    expect(
      (await f.collect([event], { headers: { origin: 'https://web.test.evil' } })).statusCode,
    ).toBe(403);
    expect((await f.collect([event], { headers: { origin: 'null' } })).statusCode).toBe(403);
    expect(
      (
        await f.collect([event], {
          payload: {
            site_id: f.site,
            cid: f.cid,
            consent: 'granted',
            events: [event],
            ip: '127.0.0.1',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect((await f.collect(Array.from({ length: 21 }, () => f.pv()))).statusCode).toBe(400);
    expect((await f.collect([event], { payload: 'x'.repeat(17000) })).statusCode).toBe(413);
    const cors = await f.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/collect',
      headers: {
        origin: 'https://web.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(cors.statusCode).toBe(204);
    expect(cors.headers['access-control-allow-origin']).toBe('https://web.test');
    expect(cors.headers['access-control-allow-credentials']).toBeUndefined();
  });
  it('rejects paused and maintained sites even for confirmed retries', async () => {
    const event = f.pv();
    expect((await f.collect([event])).statusCode).toBe(204);
    expect((await f.patch({ enabled: false })).statusCode).toBe(200);
    expect((await f.collect([event])).json().error.code).toBe('site_disabled');
    await f.pool.query("UPDATE sites SET maintenance_state='deleting'");
    expect((await f.patch({ enabled: true })).json().error.code).toBe('maintenance_in_progress');
    expect((await f.collect([event])).json().error.code).toBe('site_deleting');
  });
});
