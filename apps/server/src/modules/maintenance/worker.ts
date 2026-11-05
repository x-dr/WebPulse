import type pg from 'pg';
import { sessionCloser } from '../sessions/worker.js';
import { maintenanceConnection, maintenanceCounters } from '../aggregation/connection.js';
import { aggregateSite } from '../aggregation/worker.js';
import { cleanupSite, cleanupActivity } from '../retention/worker.js';
import { runDeletionBatch, type DeletionJournal } from '../deletion/worker.js';
import type { DeletionKey } from '../deletion/encryption.js';
import { checkRecoveryGate } from '../../db/recovery-gate.js';

export function maintenanceWorker(pool: pg.Pool, key?: DeletionKey, journal?: DeletionJournal) {
  const closer = sessionCloser(pool);
  let pending: Promise<unknown> | undefined;
  let running = false;
  let stopped = false;
  let lastClock: { db: number; mono: number } | undefined;
  let stableSamples = 0;
  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      await checkRecoveryGate(pool);
      // These phases never overlap, keeping the total background occupancy at
      // one connection even while visitor locks are used by the session closer.
      await closer.run();
      return await maintenanceConnection(pool, async (client) => {
        const state = (await client.query("SELECT details FROM job_state WHERE name='maintenance'"))
          .rows[0]?.details;
        const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
        const mono = performance.now();
        const regressed = state?.last_clock && Date.parse(state.last_clock) > now.getTime();
        const jumped =
          lastClock && Math.abs(now.getTime() - lastClock.db - (mono - lastClock.mono)) > 120_000;
        const unstable = regressed || jumped;
        stableSamples = unstable ? 0 : stableSamples + 1;
        const paused = unstable || Boolean(state?.clock_paused && stableSamples < 2);
        lastClock = { db: now.getTime(), mono };
        await client.query(
          `INSERT INTO job_state(name,last_started_at,last_error_code,details) VALUES ('maintenance',$1,$2,$3)
          ON CONFLICT(name) DO UPDATE SET last_started_at=excluded.last_started_at,last_error_code=excluded.last_error_code,details=job_state.details || excluded.details`,
          [
            now,
            paused ? 'clock_unstable' : null,
            { last_clock: now.toISOString(), clock_paused: paused },
          ],
        );
        if (paused) return { paused: true };
        const cursor = String(state?.site_cursor ?? '0');
        let sites = (
          await client.query('SELECT id,public_id FROM sites WHERE id>$1 ORDER BY id LIMIT 5', [
            cursor,
          ])
        ).rows;
        if (!sites.length)
          sites = (await client.query('SELECT id,public_id FROM sites ORDER BY id LIMIT 5')).rows;
        const stats = [];
        for (const site of sites) {
          let result = { rebuilt: 0, frozen: 0, failed: 0 };
          try {
            result = await aggregateSite(client, site.public_id, 5);
            await cleanupSite(client, site.public_id);
          } catch {
            result.failed++;
          }
          stats.push(result);
          await client.query(
            "UPDATE job_state SET details=details || jsonb_build_object('site_cursor',$1::text) WHERE name='maintenance'",
            [site.id],
          );
        }
        for (let batch = 0; batch < 10; batch++)
          if (!(await runDeletionBatch(client, key, journal))) break;
        if (journal?.complete) {
          const jobs = (
            await client.query(
              "SELECT id,result FROM deletion_jobs WHERE status='succeeded' AND completion_sequence IS NULL ORDER BY completed_at LIMIT 10",
            )
          ).rows;
          for (const job of jobs) {
            const ack = await journal.complete(job.id, job.result);
            await client.query('UPDATE deletion_jobs SET completion_sequence=$2 WHERE id=$1', [
              job.id,
              ack.sequence,
            ]);
          }
        }
        await cleanupActivity(client);
        await client.query(
          "UPDATE job_state SET last_succeeded_at=clock_timestamp(),last_error_code=$2,details=details || $1::jsonb WHERE name='maintenance'",
          [
            JSON.stringify({ sites: stats, counters: maintenanceCounters(client) }),
            stats.some((entry) => entry.failed) ? 'bucket_retry_pending' : null,
          ],
        );
        return { sites: stats };
      });
    } finally {
      running = false;
    }
  }
  return {
    run,
    start() {
      const tick = () => {
        pending = run();
        void pending.catch(() => process.stderr.write('Maintenance cycle unavailable\n'));
      };
      const timer = setInterval(tick, 60_000).unref();
      tick();
      return async () => {
        stopped = true;
        clearInterval(timer);
        await pending?.catch(() => undefined);
      };
    },
  };
}
