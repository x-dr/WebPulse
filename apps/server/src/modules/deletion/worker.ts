import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { lockSite } from '../sites/store.js';
import { rebuildBucket } from '../aggregation/buckets.js';
import { maintenanceTransaction } from '../aggregation/connection.js';
import { decryptSelector, type DeletionKey, type Envelope } from './encryption.js';
import { deleteFactBatch, deleteDerivedBatch, type Job } from './batches.js';

// M4 supplies a durable adapter independent of the database/backup volume.
// The test adapter is injected by tests only; no fallback acknowledges an intent.
export type DeletionJournal = {
  persist(intent: {
    taskId: string;
    keyId: string;
    envelope: Envelope;
    schemaVersion: 1;
  }): Promise<{ sequence: string }>;
};
const workerId = randomUUID();
export async function runDeletionBatch(
  client: pg.PoolClient,
  key?: DeletionKey,
  journal?: DeletionJournal,
  options: { limit?: number; owner?: string; beforeCommit?: () => Promise<void> } = {},
) {
  const owner = options.owner ?? workerId;
  const job = await maintenanceTransaction(client, async () => {
    const row = (
      await client.query<Job>(
        `SELECT * FROM deletion_jobs WHERE status IN ('queued','running','retry_wait') AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp() OR lease_owner=$1) ORDER BY requested_at LIMIT 1 FOR UPDATE`,
        [owner],
      )
    ).rows[0];
    if (!row) return undefined;
    return (
      await client.query<Job>(
        `UPDATE deletion_jobs SET status='running',lease_owner=$2,lease_expires_at=clock_timestamp()+interval '30 seconds',lease_generation=lease_generation+1 WHERE id=$1 RETURNING *`,
        [row.id, owner],
      )
    ).rows[0]!;
  });
  if (!job) return false;
  const fenced = async () => {
    const row = (
      await client.query(
        `SELECT 1 FROM deletion_jobs WHERE id=$1 AND lease_owner=$2 AND lease_generation=$3 AND (lease_expires_at>clock_timestamp() OR status='succeeded') AND status IN ('running','succeeded') FOR UPDATE`,
        [job.id, owner, job.lease_generation],
      )
    ).rows[0];
    if (!row) throw new Error('lease_lost');
  };
  try {
    if (!key) throw new Error('deletion_key_unavailable');
    const selector = decryptSelector(job.selector_ciphertext, job.encryption_key_id, key);
    if (
      selector.site_public_id !== job.site_public_id ||
      selector.kind !== job.kind ||
      Date.parse(selector.cutoff_at) !== job.cutoff_at.getTime() ||
      selector.visitor_keys.some(
        (entry) =>
          !/^[a-f0-9]{64}$/.test(entry.key) ||
          !Number.isSafeInteger(entry.epoch) ||
          entry.epoch < 1,
      )
    )
      throw new Error('deletion_key_unavailable');
    if (job.phase === 'journal') {
      if (!journal) throw new Error('journal_unavailable');
      const ack = await journal.persist({
        taskId: job.id,
        keyId: job.encryption_key_id,
        envelope: job.selector_ciphertext,
        schemaVersion: 1,
      });
      if (!/^[1-9][0-9]*$/.test(ack.sequence)) throw new Error('journal_unavailable');
      await maintenanceTransaction(client, async () => {
        await fenced();
        await client.query(
          'UPDATE deletion_outbox SET journal_sequence=$2,acknowledged_at=clock_timestamp() WHERE task_id=$1',
          [job.id, ack.sequence],
        );
        await client.query(
          "UPDATE deletion_jobs SET journal_sequence=$2,journal_ack_at=clock_timestamp(),phase='facts',last_error_code=NULL WHERE id=$1",
          [job.id, ack.sequence],
        );
        await options.beforeCommit?.();
      });
      return true;
    }
    if (!job.journal_ack_at) throw new Error('journal_unavailable');
    if (job.phase === 'aggregates') {
      const bucket = (
        await client.query(
          'SELECT * FROM deletion_rebuild_buckets WHERE task_id=$1 AND NOT done ORDER BY grain,bucket_start LIMIT 1',
          [job.id],
        )
      ).rows[0];
      if (
        bucket &&
        !(await rebuildBucket(
          client,
          { site: job.site_public_id, grain: bucket.grain, start: bucket.bucket_start },
          { repair: true, beforePublish: fenced },
        ))
      )
        throw new Error('rebuild_unavailable');
      await maintenanceTransaction(client, async () => {
        await fenced();
        if (bucket)
          await client.query(
            'UPDATE deletion_rebuild_buckets SET done=true WHERE task_id=$1 AND grain=$2 AND bucket_start=$3',
            [job.id, bucket.grain, bucket.bucket_start],
          );
        else
          await client.query("UPDATE deletion_jobs SET phase='verify',cursor='{}' WHERE id=$1", [
            job.id,
          ]);
        await options.beforeCommit?.();
      });
      return true;
    }
    await maintenanceTransaction(client, async () => {
      await fenced();
      const site = await lockSite(client, job.site_public_id, 'UPDATE');
      if (['facts', 'sessions', 'visitors'].includes(job.phase)) {
        const next = await deleteFactBatch(client, job, site, selector, options.limit ?? 500);
        await client.query(
          `UPDATE deletion_jobs SET phase=$2,cursor=$3,deleted_counts=jsonb_set(deleted_counts,ARRAY[$4::text],to_jsonb(coalesce((deleted_counts->>$4)::bigint,0)+$5::bigint)),lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
          [job.id, next.phase, next.cursor, next.table, next.deleted],
        );
      } else if (job.phase === 'members') {
        const next = await deleteDerivedBatch(client, job, site, selector, options.limit ?? 500);
        await client.query(
          `UPDATE deletion_jobs SET phase=$2,cursor=$3,deleted_counts=jsonb_set(deleted_counts,ARRAY[$4::text],to_jsonb(coalesce((deleted_counts->>$4)::bigint,0)+$5::bigint)) WHERE id=$1`,
          [job.id, next.phase, next.cursor, next.table, next.deleted],
        );
      } else if (job.phase === 'site') {
        const remaining = (
          await client.query(
            'SELECT (SELECT count(*) FROM events WHERE site_id=$1)+(SELECT count(*) FROM sessions WHERE site_id=$1)+(SELECT count(*) FROM visitors WHERE site_id=$1) AS count',
            [site.id],
          )
        ).rows[0];
        if (Number(remaining.count)) throw new Error('verification_failed');
        await client.query(
          'INSERT INTO site_tombstones(site_public_id,job_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [job.site_public_id, job.id],
        );
        await client.query('DELETE FROM sites WHERE id=$1', [site.id]);
        await client.query(
          `UPDATE deletion_jobs SET status='succeeded',phase='complete',completed_at=clock_timestamp(),result='{"verified":true,"site_removed":true,"verification_version":1}',lease_expires_at=NULL,last_error_code=NULL WHERE id=$1`,
          [job.id],
        );
      } else if (job.phase === 'verify') {
        const keys = selector.visitor_keys.map((k) => Buffer.from(k.key, 'hex'));
        const counts = (
          await client.query(
            `SELECT (SELECT count(*) FROM events WHERE site_id=$1 AND visitor_key=ANY($2::bytea[]))+(SELECT count(*) FROM sessions WHERE site_id=$1 AND visitor_key=ANY($2::bytea[]))+(SELECT count(*) FROM visitor_days WHERE site_id=$1 AND visitor_key=ANY($2::bytea[])) AS count`,
            [site.id, keys],
          )
        ).rows[0];
        if (Number(counts.count)) throw new Error('verification_failed');
        const mismatch = (
          await client.query(
            `SELECT 1 FROM stats_daily d WHERE d.site_id=$1 AND EXISTS(SELECT 1 FROM deletion_rebuild_buckets b WHERE b.task_id=$2 AND b.grain='day' AND (b.bucket_start AT TIME ZONE $3)::date=d.local_date) AND (
          d.pv<>(SELECT coalesce(sum(p.pv),0) FROM stats_pages_daily p WHERE p.site_id=d.site_id AND p.local_date=d.local_date) OR
          d.sessions_total<>(SELECT coalesce(sum(s.sessions_total),0) FROM stats_sources_daily s WHERE s.site_id=d.site_id AND s.local_date=d.local_date) OR
          d.uv<>(SELECT count(*) FROM visitor_days v WHERE v.site_id=d.site_id AND v.local_date=d.local_date) OR
          d.ip<>(SELECT count(*) FROM ip_days i WHERE i.site_id=d.site_id AND i.local_date=d.local_date)) LIMIT 1`,
            [site.id, job.id, site.timezone],
          )
        ).rowCount;
        if (mismatch) throw new Error('verification_failed');
        await client.query(
          "UPDATE coverage_gaps SET resolved_at=clock_timestamp(),revision=revision+1 WHERE job_id=$1 AND reason='deletion_rebuild'",
          [job.id],
        );
        await client.query(
          'UPDATE site_data_coverage SET revision=revision+1,updated_at=clock_timestamp() WHERE site_id=$1',
          [site.id],
        );
        await client.query(
          "UPDATE sites SET maintenance_state='active',enabled=false WHERE id=$1",
          [site.id],
        );
        await client.query(
          `UPDATE deletion_jobs SET status='succeeded',phase='complete',completed_at=clock_timestamp(),result='{"verified":true,"site_removed":false,"withheld_ranges":[],"verification_version":1}',lease_expires_at=NULL,last_error_code=NULL WHERE id=$1`,
          [job.id],
        );
      }
      await fenced();
      await options.beforeCommit?.();
    });
    return true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    const code = [
      'deletion_key_unavailable',
      'journal_unavailable',
      'lease_lost',
      'rebuild_unavailable',
      'verification_failed',
    ].includes(raw)
      ? raw
      : 'batch_failed';
    if (code === 'lease_lost') return false;
    await client.query(
      `UPDATE deletion_jobs SET status=CASE WHEN $4='deletion_key_unavailable' OR attempts>=7 THEN 'blocked' ELSE 'retry_wait' END,attempts=attempts+1,next_attempt_at=clock_timestamp()+least(3600,power(2,least(attempts,10))*5)*interval '1 second',last_error_code=$4,lease_expires_at=NULL WHERE id=$1 AND lease_owner=$2 AND lease_generation=$3`,
      [job.id, owner, job.lease_generation, code],
    );
    return false;
  }
}
