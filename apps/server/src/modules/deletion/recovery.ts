import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { decryptSelector, type DeletionKey } from './encryption.js';
import { verifyLedger, type JournalHead, type JournalRecord } from './journal.js';
import { maintenanceConnection, maintenanceTransaction } from '../aggregation/connection.js';
import { runDeletionBatch, type DeletionJournal } from './worker.js';
import { localParts, wallClock, addDays } from '../reports/time.js';
import { finishRecoveryJournal, type RecoveryJournal } from './recovery-journal.js';

export async function lockRecovery(pool: pg.Pool) {
  await pool.query(
    "INSERT INTO recovery_state(singleton,state) VALUES(true,'locked') ON CONFLICT(singleton) DO UPDATE SET state='locked',verified_at=NULL",
  );
}

/** Replay every intent, including accepted-but-incomplete work already present in a backup. */
export async function replayRecovery(
  pool: pg.Pool,
  key: DeletionKey,
  journal: RecoveryJournal,
  ledger: { records: JournalRecord[]; head: JournalHead },
  signingKey: Buffer,
) {
  await lockRecovery(pool);
  verifyLedger(ledger.records, signingKey, ledger.head);
  // Validate every envelope before touching facts. Missing key/epoch fails closed.
  const intents = ledger.records
    .filter((r) => r.kind === 'intent')
    .map((r) => {
      const intent = r.intent!;
      const selector = decryptSelector(intent.envelope, intent.keyId, key);
      if (
        !['site', 'visitor'].includes(selector.kind) ||
        !/^site_[a-zA-Z0-9_-]+$/.test(selector.site_public_id) ||
        !Number.isFinite(Date.parse(selector.cutoff_at)) ||
        selector.scope !== 'all_observed_before_cutoff' ||
        (selector.kind === 'visitor' && !selector.visitor_keys.length) ||
        selector.visitor_keys.some(
          (k) => !/^[a-f0-9]{64}$/.test(k.key) || !Number.isSafeInteger(k.epoch) || k.epoch < 1,
        )
      )
        throw new Error('recovery_invalid_selector');
      return { record: r, intent, selector };
    });
  const result = await maintenanceConnection(pool, async (client) => {
    const known = intents.map((i) => i.intent.taskId);
    if (
      (
        await client.query(
          "SELECT 1 FROM deletion_jobs WHERE status<>'succeeded' AND NOT (id=ANY($1::uuid[])) LIMIT 1",
          [known],
        )
      ).rowCount
    )
      throw new Error('recovery_unjournaled_job');
    await client.query('UPDATE sites SET enabled=false');
    for (const { record, intent, selector } of intents) {
      if (
        (await client.query('SELECT 1 FROM recovery_replays WHERE task_id=$1', [intent.taskId]))
          .rowCount
      )
        continue;
      const site = (
        await client.query('SELECT * FROM sites WHERE public_id=$1', [selector.site_public_id])
      ).rows[0];
      if (!site) {
        if (selector.kind === 'site')
          await client.query(
            'INSERT INTO site_tombstones(site_public_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [selector.site_public_id, intent.taskId],
          );
        await client.query(
          'INSERT INTO recovery_replays(task_id,journal_sequence,result) VALUES($1,$2,\'{"target_absent":true}\')',
          [intent.taskId, record.sequence],
        );
        continue;
      }
      const epochs = (site.config.identity_epochs ?? []) as { visitor: number }[];
      if (
        selector.visitor_keys.some(
          (k) => k.epoch !== site.key_version && !epochs.some((e) => e.visitor === k.epoch),
        )
      )
        throw new Error('identity_epoch_key_unavailable');
      const end = wallClock(
        addDays(localParts(new Date(selector.cutoff_at), site.timezone).date, 1),
        site.timezone,
      ).at;
      await maintenanceTransaction(client, async () => {
        // The whole restore remains gated; superseded backup tasks are replayed from the external log below.
        await client.query(
          "UPDATE deletion_jobs SET status='succeeded',phase='complete' WHERE site_public_id=$1 AND status<>'succeeded'",
          [selector.site_public_id],
        );
        await client.query('DELETE FROM deletion_rebuild_buckets WHERE task_id=$1', [
          intent.taskId,
        ]);
        await client.query(
          `INSERT INTO deletion_jobs(id,site_public_id,kind,cutoff_at,idempotency_key,request_hash,selector_ciphertext,encryption_key_id,journal_sequence,journal_ack_at)
          VALUES($1,$2,$3,$4,$1,$5,$6,$7,$8,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET status='queued',phase='journal',cursor='{}',attempts=0,next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_generation=deletion_jobs.lease_generation+1,deleted_counts='{}',result=NULL,completed_at=NULL,completion_sequence=NULL`,
          [
            intent.taskId,
            selector.site_public_id,
            selector.kind,
            selector.cutoff_at,
            createHash('sha256').update(intent.taskId).digest('hex'),
            intent.envelope,
            intent.keyId,
            record.sequence,
          ],
        );
        await client.query(
          `INSERT INTO deletion_outbox(task_id,selector_ciphertext,encryption_key_id) VALUES($1,$2,$3) ON CONFLICT(task_id) DO NOTHING`,
          [intent.taskId, intent.envelope, intent.keyId],
        );
        await client.query(
          "UPDATE sites SET enabled=false,maintenance_state='deleting' WHERE id=$1",
          [site.id],
        );
        if (selector.kind === 'visitor') {
          // Conservative recovery: no old aggregate is declared exact without a reconstruction proof.
          await client.query(
            `INSERT INTO coverage_gaps(site_id,layer,start_utc,end_utc,reason,job_id) SELECT site_id,layer,observed_from,greatest($2,observed_from+interval '1 microsecond'),'privacy_replay_unverifiable',$3 FROM site_data_coverage WHERE site_id=$1`,
            [site.id, end, intent.taskId],
          );
          await client.query('UPDATE site_data_coverage SET revision=revision+1 WHERE site_id=$1', [
            site.id,
          ]);
        }
      });
      const replayJournal: DeletionJournal = {
        persist: async () => ({ sequence: record.sequence }),
      };
      // Bounded batches, persisted cursors; no deadline silently opens an incomplete restore.
      for (;;) {
        const job = (
          await client.query('SELECT status,last_error_code FROM deletion_jobs WHERE id=$1', [
            intent.taskId,
          ])
        ).rows[0];
        if (job.status === 'succeeded') break;
        if (['blocked', 'retry_wait'].includes(job.status))
          throw new Error('recovery_batch_failed');
        if (!(await runDeletionBatch(client, key, replayJournal, { privacyReplay: true })))
          throw new Error('recovery_batch_failed');
      }
      if (selector.kind === 'visitor') {
        const keys = selector.visitor_keys.map((k) => Buffer.from(k.key, 'hex'));
        const remaining = (
          await client.query(
            `SELECT 1 FROM events WHERE site_id=$1 AND visitor_key=ANY($2::bytea[]) AND occurred_at<=$3 LIMIT 1`,
            [site.id, keys, selector.cutoff_at],
          )
        ).rowCount;
        if (remaining) throw new Error('recovery_privacy_failed');
      }
      const summary = {
        verified: true,
        withheld_ranges:
          selector.kind === 'visitor'
            ? [{ end: end.toISOString(), reason: 'privacy_replay_unverifiable' }]
            : [],
      };
      await client.query('UPDATE deletion_jobs SET result=result || $2::jsonb WHERE id=$1', [
        intent.taskId,
        JSON.stringify(summary),
      ]);
      await client.query(
        'INSERT INTO recovery_replays(task_id,journal_sequence,result) VALUES($1,$2,$3)',
        [intent.taskId, record.sequence, summary],
      );
    }
    const completed = (
      await client.query(
        'SELECT task_id AS "taskId",result FROM recovery_replays WHERE task_id=ANY($1::uuid[])',
        [known],
      )
    ).rows;
    const { head, completions } = await finishRecoveryJournal(
      journal,
      ledger,
      signingKey,
      completed,
    );
    for (const completion of completions)
      await client.query('UPDATE deletion_jobs SET completion_sequence=$2 WHERE id=$1', [
        completion.taskId,
        completion.sequence,
      ]);
    if (
      (await client.query("SELECT 1 FROM deletion_jobs WHERE status<>'succeeded' LIMIT 1")).rowCount
    )
      throw new Error('recovery_unjournaled_job');
    await client.query(
      "UPDATE recovery_state SET state='verified',journal_sequence=$1,journal_mac=$2,verified_at=clock_timestamp() WHERE singleton=true",
      [head.sequence, head.mac],
    );
    return { replayed: intents.length, head, sites_paused: true };
  });
  if (!result) throw new Error('maintenance_busy');
  return result;
}

export function readJournalSigningKey(env = process.env) {
  const value = readFileSync(env.JOURNAL_SIGNING_KEY_FILE!, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Invalid journal signing key');
  return Buffer.from(value, 'hex');
}
