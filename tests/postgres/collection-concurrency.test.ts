import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { identityKey, visitorLock } from '../../apps/server/src/modules/identity/keys.js';
import { transaction } from '../../apps/server/src/db/transaction.js';
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f?.close();
});
async function lockVisitor() {
  const row = (await f.pool.query('SELECT id,key_version FROM sites WHERE public_id=$1', [f.site]))
    .rows[0];
  const key = identityKey(f.security.visitorKey, 'visitor', f.site, row.key_version, f.cid);
  const client = await f.pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [visitorLock(row.id, key)]);
  return client;
}
async function waiting(query: string) {
  await expect
    .poll(
      async () =>
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
            [query],
          )
        ).rows[0].n,
      { timeout: 1500, interval: 10 },
    )
    .toBeGreaterThan(0);
}
describe('M1 API concurrency and transaction deadlines', () => {
  it('drains an in-flight collector before returning successful disable', async () => {
    const lock = await lockVisitor();
    try {
      const collecting = f.collect([f.pv()]).then((r) => r);
      await waiting('SELECT pg_advisory_xact_lock%');
      const disable = f.patch({ enabled: false }).then((r) => r);
      await waiting('SELECT * FROM sites%FOR UPDATE');
      await lock.query('COMMIT');
      expect((await collecting).statusCode).toBe(204);
      expect((await disable).statusCode).toBe(200);
      expect((await f.collect([f.pv()])).json().error.code).toBe('site_disabled');
      expect((await f.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(1);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });
  it('rechecks enabled after waiting for the site row lock', async () => {
    const lock = await f.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT * FROM sites FOR UPDATE');
      const collect = f.collect([f.pv()]).then((r) => r);
      await waiting('SELECT * FROM sites%FOR SHARE');
      await lock.query('UPDATE sites SET enabled=false');
      await lock.query('COMMIT');
      expect((await collect).json().error.code).toBe('site_disabled');
      expect((await f.pool.query('SELECT count(*)::int AS n FROM visitors')).rows[0].n).toBe(0);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });
  it('takes received_at after the visitor lock and uses array order within a timestamp', async () => {
    const lock = await lockVisitor();
    try {
      const a = f.pv('/a'),
        b = f.pv('/b');
      const collecting = f.collect([a, b]).then((r) => r);
      await waiting('SELECT pg_advisory_xact_lock%');
      const releaseAt = (await lock.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
      await lock.query('COMMIT');
      expect((await collecting).statusCode).toBe(204);
      const rows = (
        await f.pool.query(
          'SELECT received_at>=$1::timestamptz AS after,activity_seq FROM events ORDER BY activity_seq',
          [releaseAt],
        )
      ).rows;
      expect(rows).toEqual([
        { after: true, activity_seq: '1' },
        { after: true, activity_seq: '2' },
      ]);
      expect((await f.pool.query('SELECT latest_path FROM visitors')).rows[0].latest_path).toBe(
        '/b',
      );
      expect(
        (await f.pool.query('SELECT count(DISTINCT received_at)::int AS n FROM events')).rows[0].n,
      ).toBe(1);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });
  it('keeps four small sites available while a hot site queues behind a visitor lock', async () => {
    const sites: string[] = [];
    for (let i = 0; i < 4; i++) {
      const created = await f.app.inject({
        method: 'POST',
        url: '/api/v1/sites',
        headers: f.headers,
        payload: {
          name: `Small ${i}`,
          primary_origin: 'https://web.test',
          allowed_origins: ['https://web.test'],
        },
      });
      sites.push(created.json().data.site_id);
    }
    const lock = await lockVisitor();
    try {
      const hot = Array.from({ length: 12 }, () => f.collect([f.pv()]).then((r) => r));
      await waiting('SELECT pg_advisory_xact_lock%');
      const small = await Promise.all(
        sites.map((site) => f.collect([f.pv()], {}, randomUUID(), site)),
      );
      expect(small.map((r) => r.statusCode)).toEqual([204, 204, 204, 204]);
      await lock.query('COMMIT');
      expect((await Promise.all(hot)).every((r) => r.statusCode === 204)).toBe(true);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });
  it('rolls back a disable whose shared-lock drain times out', async () => {
    const lock = await f.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT * FROM sites FOR SHARE');
      const result = await f.patch({ enabled: false });
      expect(result.statusCode).toBe(503);
      await lock.query('COMMIT');
      expect((await f.pool.query('SELECT enabled FROM sites')).rows[0].enabled).toBe(true);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });
  it('destroys a cancelled connection and never commits its partial write', async () => {
    const controller = new AbortController();
    const result = transaction(
      f.pool,
      { signal: controller.signal, deadline: Date.now() + 5000 },
      async (client) => {
        await client.query("UPDATE sites SET name='must-rollback'");
        controller.abort();
        await client.query('SELECT pg_sleep(0.05)');
      },
    );
    await expect(result).rejects.toThrow();
    await expect
      .poll(async () => (await f.pool.query('SELECT name FROM sites')).rows[0].name)
      .toBe('Test site');
  });
  it('bounds total transaction time including time between SQL statements', async () => {
    await expect(
      transaction(
        f.pool,
        { signal: new AbortController().signal, deadline: Date.now() + 60 },
        async (client) => {
          await client.query("UPDATE sites SET name='must-rollback'");
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
      ),
    ).rejects.toThrow('request_timeout');
    expect((await f.pool.query('SELECT name FROM sites')).rows[0].name).toBe('Test site');
  });
  it('has full referencing indexes, including closed sessions and administrator sessions', async () => {
    const expected = [
      'events_page_view_idx',
      'events_visitor_idx',
      'page_views_session_idx',
      'sessions_visitor_idx',
      'admin_sessions_admin_idx',
    ];
    const rows = (
      await f.pool.query(
        'SELECT c.relname AS indexname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND i.indpred IS NULL',
        [f.schema, expected],
      )
    ).rows;
    expect(rows.map((row) => row.indexname).sort()).toEqual(expected.sort());
  });
});

it('uses referencing indexes on a 10,000 visitor/session/page fixture', async () => {
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO visitors(site_id,visitor_key,first_seen_pv_at,last_activity_at,latest_path)
      SELECT s.id,sha256(n::text::bytea),clock_timestamp(),clock_timestamp(),'/fixture' FROM sites s CROSS JOIN generate_series(1,10000) n`);
    await client.query(`INSERT INTO sessions(site_id,id,visitor_key,status,started_at,last_activity_at,ended_at,closed_at,close_reason,entry_path,exit_path,source_channel)
      SELECT s.id,md5(n::text)::uuid,sha256(n::text::bytea),'closed',now(),now(),now(),now(),'timeout','/fixture','/fixture','direct' FROM sites s CROSS JOIN generate_series(1,10000) n`);
    await client.query(`INSERT INTO events(site_id,event_id,session_id,visitor_key,ip_key,event_type,page_view_id,path,occurred_at,received_at,local_date,payload_fingerprint,rule_version)
      SELECT s.id,md5(n::text)::uuid,md5(n::text)::uuid,sha256(n::text::bytea),sha256(n::text::bytea),'page_view',md5(n::text)::uuid,'/fixture',now(),now(),current_date,sha256(n::text::bytea),1 FROM sites s CROSS JOIN generate_series(1,10000) n`);
    await client.query(
      'INSERT INTO page_views(site_id,id,session_id,occurred_at) SELECT site_id,event_id,session_id,occurred_at FROM events',
    );
    await client.query('COMMIT');
    for (const table of ['visitors', 'sessions', 'events', 'page_views'])
      await client.query(`ANALYZE ${table}`);
    const siteId = (await client.query('SELECT id FROM sites')).rows[0].id;
    const probes = [
      ['events', 'page_view_id', "md5('1')::uuid", 'events_page_view_idx'],
      ['events', 'visitor_key', "sha256('1'::bytea)", 'events_visitor_idx'],
      ['page_views', 'session_id', "md5('1')::uuid", 'page_views_session_idx'],
      ['sessions', 'visitor_key', "sha256('1'::bytea)", 'sessions_visitor_idx'],
    ];
    for (const [table, column, value, index] of probes) {
      const plan = (
        await client.query(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM ${table} WHERE site_id=$1 AND ${column}=${value}`,
          [siteId],
        )
      ).rows;
      expect(JSON.stringify(plan)).toContain(index);
    }
    // Exercise the reference-check paths on one test-owned visitor; deferred page/event FK stays valid.
    await client.query('BEGIN');
    await client.query("DELETE FROM events WHERE visitor_key=sha256('1'::bytea)");
    await client.query("DELETE FROM sessions WHERE visitor_key=sha256('1'::bytea)");
    await client.query("DELETE FROM visitors WHERE visitor_key=sha256('1'::bytea)");
    await client.query('COMMIT');
    expect((await client.query('SELECT count(*)::int AS n FROM visitors')).rows[0].n).toBe(9999);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('client HTTP disconnect cancels the collector without delayed commit', async () => {
  const lock = await lockVisitor();
  const endpoint = await f.app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const controller = new AbortController();
    const response = fetch(`${endpoint}/api/v1/collect`, {
      method: 'POST',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify({ site_id: f.site, cid: f.cid, consent: 'granted', events: [f.pv()] }),
      signal: controller.signal,
    }).catch(() => undefined);
    await waiting('SELECT pg_advisory_xact_lock%');
    controller.abort();
    await response;
    await expect
      .poll(
        async () =>
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'",
            )
          ).rows[0].n,
      )
      .toBe(0);
    await lock.query('COMMIT');
    expect((await f.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(0);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
});
