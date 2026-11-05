import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterEach, it, expect } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { maintained } from '../support/reporting.js';
import { aggregateSite } from '../../apps/server/src/modules/aggregation/worker.js';
import { maintenanceCounters } from '../../apps/server/src/modules/aggregation/connection.js';

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

it('keeps cold sites available during hot-bucket recomputation, then converges without losing writes', async () => {
  f = await fixture();
  const sites = [f.site];
  for (let i = 0; i < 4; i++) {
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: f.headers,
      payload: {
        name: `Cold ${i}`,
        primary_origin: 'https://web.test',
        allowed_origins: ['https://web.test'],
        timezone: 'UTC',
      },
    });
    expect(created.statusCode).toBe(201);
    sites.push(created.json().data.site_id);
  }
  const pids = new Set<number>();
  f.pool.on('acquire', (client) =>
    pids.add((client as unknown as { processID: number }).processID),
  );
  let waiting = 0,
    samples = 0,
    peakConnections = 0;
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void f.admin
      .query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'",
        [[...pids]],
      )
      .then((result) => {
        waiting += result.rows[0].waiting;
        samples++;
      })
      .finally(() => {
        sampling = false;
      });
  }, 5);
  const latencies: number[] = [];
  const coldLatencies: number[] = [];
  let writing = true;
  let retryCount = 0,
    maxTransaction = 0,
    rounds = 0,
    oldestBacklogSeconds = 0;
  let failure: unknown;
  const writes = (async () => {
    try {
      for (let round = 0; round < 8; round++) {
        await Promise.all(
          [0, 0, 0, 0, 1, 2, 3, 4].map(async (siteIndex) => {
            const start = performance.now();
            const response = await f.collect(
              [f.pv(`/round/${round}`)],
              {},
              randomUUID(),
              sites[siteIndex],
            );
            const duration = performance.now() - start;
            latencies.push(duration);
            if (siteIndex) coldLatencies.push(duration);
            expect(response.statusCode, response.body).toBe(204);
          }),
        );
      }
    } finally {
      writing = false;
    }
  })();
  const recompute = (async () => {
    const previous = new Map<string, number>();
    while (writing && rounds < 30) {
      await maintained(f, async (client) => {
        for (const site of sites) await aggregateSite(client, site, 2);
        const stats = maintenanceCounters(client);
        retryCount += stats.retries;
        maxTransaction = Math.max(maxTransaction, stats.max_transaction_ms);
      });
      const totals = (
        await f.pool.query('SELECT site_id,sum(pv)::int AS pv FROM stats_daily GROUP BY site_id')
      ).rows;
      for (const row of totals) {
        expect(row.pv).toBeGreaterThanOrEqual(previous.get(row.site_id) ?? 0);
        previous.set(row.site_id, row.pv);
      }
      const backlog = (
        await f.pool.query(
          'SELECT coalesce(extract(epoch FROM clock_timestamp()-min(updated_at)),0) AS seconds FROM dirty_buckets',
        )
      ).rows[0];
      oldestBacklogSeconds = Math.max(oldestBacklogSeconds, Number(backlog.seconds));
      peakConnections = Math.max(peakConnections, f.pool.totalCount - f.pool.idleCount);
      rounds++;
    }
  })();
  try {
    await Promise.all([writes, recompute]);
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(sampler);
    await Promise.allSettled([writes, recompute]);
  }
  if (failure) throw failure;
  for (const site of sites) await maintained(f, (client) => aggregateSite(client, site, 5));
  expect((await f.pool.query('SELECT * FROM dirty_buckets')).rowCount).toBe(0);
  const mismatch = (
    await f.pool.query(
      `SELECT s.id FROM sites s WHERE (SELECT coalesce(sum(pv),0) FROM stats_daily d WHERE d.site_id=s.id)<>(SELECT count(*) FROM events e WHERE e.site_id=s.id AND e.event_type='page_view')`,
    )
  ).rows;
  expect(mismatch).toEqual([]);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(64);
  const percentile = (values: number[], p: number) =>
    [...values].sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
    ]!;
  const evidence = {
    scope: 'local PostgreSQL smoke; not M5 sustained capacity',
    requests: latencies.length,
    sites: sites.length,
    collection_p95_ms: percentile(latencies, 0.95),
    collection_p99_ms: percentile(latencies, 0.99),
    cold_site_p95_ms: percentile(coldLatencies, 0.95),
    lock_wait_observations: waiting,
    lock_samples: samples,
    aggregate_retries: retryCount,
    max_transaction_ms: maxTransaction,
    oldest_backlog_seconds: oldestBacklogSeconds,
    remaining_dirty_buckets: 0,
    peak_observed_active_pool_connections: peakConnections,
    pool_limit: f.pool.options.max,
    rounds,
  };
  expect(Math.max(...latencies)).toBeLessThan(5000);
  expect(f.pool.totalCount).toBeLessThanOrEqual(8);
  await writeFile('/tmp/webpulse-m2-load.json', JSON.stringify(evidence, null, 2) + '\n');
});

it('does not mark published closed-session totals dirty for an open heartbeat or interaction', async () => {
  f = await fixture();
  const event = f.pv();
  expect((await f.collect([event])).statusCode).toBe(204);
  await maintained(f, (client) => aggregateSite(client, f.site, 5));
  expect((await f.pool.query('SELECT * FROM dirty_buckets')).rowCount).toBe(0);
  expect((await f.heartbeat(event.page_view_id, 100)).statusCode).toBe(204);
  expect(
    (
      await f.collect([
        {
          type: 'interaction',
          event_id: randomUUID(),
          page_view_id: event.page_view_id,
          interaction_kind: 'click',
        },
      ])
    ).statusCode,
  ).toBe(204);
  expect((await f.pool.query('SELECT * FROM dirty_buckets')).rowCount).toBe(0);
});
