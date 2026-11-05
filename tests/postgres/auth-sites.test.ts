import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f?.close();
});
describe('M1 management authentication and settings', () => {
  it('uses secure HttpOnly cookie, stable CSRF and only token digests in storage', async () => {
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://stats.test' },
      payload: { username: 'admin', password: 'test-password-only' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('__Host-wp_admin=');
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('Secure');
    const session = await f.app.inject({
      url: '/api/v1/auth/session',
      headers: { cookie: f.cookie },
    });
    expect(session.json().data.csrf_token).toBe(f.headers['x-csrf-token']);
    const rows = await f.pool.query('SELECT octet_length(token_hash) AS size FROM admin_sessions');
    expect(rows.rows.every((row) => row.size === 32)).toBe(true);
  });
  it('returns the same invalid-credentials error for unknown user and wrong password', async () => {
    const login = (username: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: 'https://stats.test' },
        payload: { username, password: 'wrong-password' },
      });
    const a = await login('missing'),
      b = await login('admin');
    expect(a.statusCode).toBe(401);
    expect(a.body).toBe(b.body);
  });
  it('requires exact management Origin and CSRF on writes; GET is private', async () => {
    const path = `/api/v1/sites/${f.site}`;
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: path,
          headers: { cookie: f.cookie, origin: 'https://stats.test' },
          payload: { enabled: false },
        })
      ).json().error.code,
    ).toBe('csrf_invalid');
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: path,
          headers: { ...f.headers, origin: 'https://evil.test' },
          payload: { enabled: false },
        })
      ).json().error.code,
    ).toBe('origin_denied');
    const list = await f.app.inject({ url: '/api/v1/sites', headers: { cookie: f.cookie } });
    expect(list.headers['cache-control']).toContain('no-store');
    expect(list.json().data).toHaveLength(1);
    expect((await f.app.inject({ url: '/api/v1/sites' })).statusCode).toBe(401);
  });
  it('revokes on logout and enforces 24h idle plus absolute 7 day expiry', async () => {
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: f.headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await f.app.inject({ url: '/api/v1/auth/session', headers: { cookie: f.cookie } }))
        .statusCode,
    ).toBe(401);
    for (const column of ['last_seen_at', 'expires_at']) {
      const login = await f.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: 'https://stats.test' },
        payload: { username: 'admin', password: 'test-password-only' },
      });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      await f.pool.query(
        `UPDATE admin_sessions SET ${column}=clock_timestamp()-interval '25 hours'`,
      );
      expect(
        (await f.app.inject({ url: '/api/v1/auth/session', headers: { cookie } })).statusCode,
      ).toBe(401);
    }
  });
  it('rejects assignment to internal fields, timezone, unsupported retention edits and wildcard origins', async () => {
    for (const payload of [
      { key_version: 2 },
      { timezone: 'UTC' },
      { id: 9 },
      { member_retention_days: 30 },
      { config: {} },
      { allowed_origins: ['https://*.test'] },
    ])
      expect((await f.patch(payload)).statusCode).toBe(400);
    const result = await f.app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: f.headers,
      payload: {
        name: 'Invalid',
        primary_origin: 'https://web.test',
        allowed_origins: ['https://web.test'],
        timezone: 'Not/AZone',
      },
    });
    expect(result.json().error.code).toBe('invalid_timezone');
  });
  it('serves built tracker and consent-gated configuration with exact CORS', async () => {
    const tracker = await f.app.inject({ url: '/tracker.js' });
    expect(tracker.statusCode).toBe(200);
    expect(tracker.headers['content-type']).toContain('javascript');
    const config = await f.app.inject({
      url: `/api/v1/tracker-config/${f.site}`,
      headers: { origin: 'https://web.test' },
    });
    expect(config.statusCode).toBe(200);
    expect(config.json().data.rules.routing_mode).toBe('history');
    expect(
      (
        await f.app.inject({
          url: `/api/v1/tracker-config/${f.site}`,
          headers: { origin: 'https://web.test', dnt: '1' },
        })
      ).statusCode,
    ).toBe(403);
  });
});
