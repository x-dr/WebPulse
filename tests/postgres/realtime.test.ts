import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fixture, type Fixture } from '../support/postgres.js';
import { readRealtime } from '../../apps/server/src/modules/realtime/snapshot.js';
import { transaction, backgroundBudget } from '../../apps/server/src/db/transaction.js';

let f: Fixture;
const aborts: AbortController[] = [];
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  aborts.splice(0).forEach((a) => a.abort());
  await f?.close();
});
async function stream(endpoint: string, cookie = f.cookie, last?: string) {
  const abort = new AbortController();
  aborts.push(abort);
  return fetch(`${endpoint}/api/v1/realtime?site_id=${f.site}`, {
    headers: { cookie, ...(last ? { 'Last-Event-ID': last } : {}) },
    signal: abort.signal,
  });
}
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>, until: string) {
  let text = '';
  const timeout = AbortSignal.timeout(10000);
  while (!text.includes(until)) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        timeout.addEventListener('abort', () => reject(new Error('stream timeout')), {
          once: true,
        }),
      ),
    ]);
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text;
}
describe('M4 authenticated shared SSE over real HTTP', () => {
  it('reads durable PV/heartbeats with one current page per visitor and no identifiers', async () => {
    const a = f.pv('/a');
    const b = f.pv('/b');
    await f.collect([a, b]);
    await f.heartbeat(a.page_view_id, 1000);
    await f.collect([f.pv('/other')], {}, randomUUID());
    const snapshot = await transaction(f.pool, backgroundBudget(), (c) => readRealtime(c, f.site));
    expect(snapshot.active_visitors_15m).toBe(2);
    expect(snapshot.pv_last_minute).toBe(3);
    expect(snapshot.active_pages).toContainEqual({ path: '/a', visitors: 1 });
    expect(snapshot.minutes).toHaveLength(15);
    expect(snapshot.minutes.reduce((n, m) => n + m.pv, 0)).toBe(3);
    expect(JSON.stringify(snapshot)).not.toMatch(/visitor_key|ip_key|session_id|cid/);
  });
  it('rejects anonymous/extra-date queries, resets reconnections, closes immediately on logout', async () => {
    const endpoint = await f.app.listen({ host: '127.0.0.1', port: 0 });
    expect((await fetch(`${endpoint}/api/v1/realtime?site_id=${f.site}`)).status).toBe(401);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/realtime?site_id=${f.site}&start_date=2026-01-01`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(400);
    const response = await stream(endpoint, f.cookie, 'old-boot:7');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    expect(await frame(reader, 'event: reset')).toContain('event: reset');
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: f.headers }))
        .statusCode,
    ).toBe(204);
    expect(await frame(reader, 'auth_expired')).toContain('auth_expired');
  });
  it('caps 20 streams globally and 3 per admin, releases pool connections and drains shutdown', async () => {
    const endpoint = await f.app.listen({ host: '127.0.0.1', port: 0 });
    for (let i = 0; i < 3; i++) expect((await stream(endpoint)).status).toBe(200);
    expect((await stream(endpoint)).status).toBe(429);
    for (let i = 3; i < 20; i++) {
      const admin = (
        await f.pool.query(
          "INSERT INTO admins(username,password_hash) VALUES($1,'unused') RETURNING id",
          [`stream${i}`],
        )
      ).rows[0].id;
      const token = randomBytes(32).toString('base64url');
      const digest = createHash('sha256').update(token).digest();
      await f.pool.query(
        "INSERT INTO admin_sessions(token_hash,admin_id,csrf_hash,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 day')",
        [digest, admin],
      );
      expect((await stream(endpoint, `__Host-wp_admin=${token}`)).status).toBe(200);
    }
    expect((await stream(endpoint)).status).toBe(429);
    expect(f.pool.totalCount - f.pool.idleCount).toBe(0);
    const started = Date.now();
    await f.app.close();
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('invalidates a stream when the site is paused and gates restored databases', async () => {
    const endpoint = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await stream(endpoint);
    const reader = response.body!.getReader();
    await frame(reader, 'snapshot');
    await f.patch({ enabled: false });
    expect(await frame(reader, 'site_unavailable')).toContain('site_unavailable');
    expect((await stream(endpoint)).status).toBe(409);
    await f.pool.query("UPDATE recovery_state SET state='locked'");
    expect(
      (await f.app.inject({ url: '/api/v1/sites', headers: f.headers })).json().error.code,
    ).toBe('recovery_locked');
    expect((await f.collect([f.pv()])).statusCode).toBe(503);
  });
});
