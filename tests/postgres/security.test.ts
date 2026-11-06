import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f?.close();
});

it('requires administrator authentication for all management, reporting, diagnostics and SSE reads', async () => {
  for (const url of [
    '/api/v1/sites',
    '/api/v1/auth/session',
    `/api/v1/sites/${f.site}/diagnostics`,
    `/api/v1/jobs/${randomUUID()}`,
    `/api/v1/realtime?site_id=${f.site}`,
    ...['overview', 'visitors', 'visits', 'pages', 'sources', 'entries', 'trend'].map(
      (kind) => `/api/v1/stats/${kind}?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-02`,
    ),
  ]) {
    const response = await f.app.inject(url);
    expect(response.statusCode, url).toBe(401);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  }
});

it('rejects null/foreign Origin, cookie-only writes, forged opt-in and forwarded identity', async () => {
  for (const origin of ['null', 'https://evil.test', 'https://web.test.evil.test']) {
    expect((await f.collect([f.pv()], { headers: { origin } })).statusCode).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/v1/sites/${f.site}`,
          headers: { ...f.headers, origin },
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(403);
  }
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url: `/api/v1/sites/${f.site}`,
        headers: { cookie: f.cookie, origin: f.security.adminOrigin },
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.collect([f.pv()], {
        payload: { site_id: f.site, cid: f.cid, consent: 'denied', events: [f.pv()] },
      })
    ).statusCode,
  ).toBe(400);
  expect((await f.pool.query('SELECT count(*)::int n FROM events')).rows[0].n).toBe(0);
  expect(
    (
      await f.collect([f.pv()], {
        remoteAddress: '192.0.2.1',
        headers: { 'x-forwarded-for': '203.0.113.5', forwarded: 'for=203.0.113.5' },
      })
    ).statusCode,
  ).toBe(204);
  expect((await f.pool.query('SELECT host(client_ip) AS ip FROM events')).rows[0].ip).toBe(
    '192.0.2.1',
  );
});

it('treats injection payloads as text and never stores raw cid, query, user-agent or authorization', async () => {
  const marker = 'm5-sensitive-canary';
  const event = f.pv(`/a@example.com/123?token=${marker}`);
  expect(
    (
      await f.collect([event], {
        headers: { authorization: `Bearer ${marker}`, 'user-agent': marker },
      })
    ).statusCode,
  ).toBe(204);
  const stored = JSON.stringify(await f.snapshot());
  expect(stored).not.toContain(f.cid);
  expect(stored).not.toContain(marker);
  expect(stored).not.toContain('a@example.com');
  for (const input of ['count; DROP TABLE sites', '(SELECT pg_sleep(10))', "' OR 1=1 --"]) {
    const response = await f.app.inject({
      url: `/api/v1/stats/pages?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-02&sort=${encodeURIComponent(input)}`,
      headers: f.headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toMatch(/SELECT|DROP|password|stack|\/root/);
  }
  expect((await f.pool.query('SELECT count(*)::int n FROM sites')).rows[0].n).toBe(1);
});

it('bounds parser input and diagnostics labels and keeps errors private', async () => {
  const oversized = await f.app.inject({
    method: 'POST',
    url: '/api/v1/collect',
    headers: { 'content-type': 'text/plain' },
    payload: 'x'.repeat(16385),
  });
  expect(oversized.statusCode).toBe(413);
  const malformed = await f.app.inject({
    method: 'POST',
    url: '/api/v1/collect',
    headers: { 'content-type': 'text/plain' },
    payload: '{"secret":"m5-sensitive-canary"',
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('canary');
  const diagnostics = await f.app.inject({
    url: `/api/v1/sites/${f.site}/diagnostics`,
    headers: f.headers,
  });
  expect(diagnostics.statusCode, diagnostics.body).toBe(200);
  expect(diagnostics.json().data.runtime).toMatchObject({
    capacity: 64,
    database_pool: { limit: 8 },
  });
  expect(diagnostics.body).not.toMatch(
    /m5-sensitive-canary|token_hash|csrf_hash|visitor_key|password_hash/,
  );
});
