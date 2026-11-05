import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../../http/errors.js';
import { lockSite } from '../sites/store.js';
import { encryptSelector, type DeletionKey, type Selector } from './encryption.js';

export type DeletionRequest = {
  site: string;
  kind: 'site' | 'visitor';
  idempotencyKey: string;
  confirmName?: string;
  visitorKeys?: Selector['visitor_keys'];
};
export async function requestDeletion(
  client: pg.PoolClient,
  input: DeletionRequest,
  key: DeletionKey | undefined,
) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([input.site, input.kind, input.confirmName ?? '', input.visitorKeys ?? []]),
    )
    .digest('hex');
  // Serialize a key even when two requests refer to different sites.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `deletion:${input.idempotencyKey}`,
  ]);
  const existing = (
    await client.query('SELECT * FROM deletion_jobs WHERE idempotency_key=$1', [
      input.idempotencyKey,
    ])
  ).rows[0];
  if (existing) {
    if (existing.request_hash !== hash) throw new ApiError(409, 'idempotency_conflict');
    return publicJob(existing);
  }
  if (!key) throw new ApiError(503, 'deletion_key_unavailable');
  const site = await lockSite(client, input.site, 'UPDATE');
  if (input.kind === 'site' && input.confirmName !== site.name)
    throw new ApiError(400, 'confirmation_mismatch');
  const active = (
    await client.query(
      "SELECT * FROM deletion_jobs WHERE site_public_id=$1 AND status<>'succeeded'",
      [input.site],
    )
  ).rows[0];
  if (active) {
    if (active.request_hash !== hash) throw new ApiError(409, 'maintenance_in_progress');
    return publicJob(active);
  }
  if (site.maintenance_state !== 'active') throw new ApiError(409, 'maintenance_in_progress');
  const cutoff = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const selector: Selector = {
    site_public_id: input.site,
    kind: input.kind,
    cutoff_at: cutoff.toISOString(),
    visitor_keys: input.visitorKeys ?? [],
    scope: 'all_observed_before_cutoff',
  };
  const envelope = encryptSelector(selector, key);
  const job = (
    await client.query(
      `INSERT INTO deletion_jobs(site_public_id,kind,cutoff_at,idempotency_key,request_hash,selector_ciphertext,encryption_key_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.site, input.kind, cutoff, input.idempotencyKey, hash, envelope, key.keyId],
    )
  ).rows[0];
  await client.query(
    `INSERT INTO deletion_outbox(task_id,selector_ciphertext,encryption_key_id) VALUES ($1,$2,$3)`,
    [job.id, envelope, key.keyId],
  );
  await client.query(
    "UPDATE sites SET enabled=false,maintenance_state='deleting',rule_version=rule_version+1 WHERE id=$1",
    [site.id],
  );
  await client.query(
    `INSERT INTO coverage_gaps(site_id,layer,start_utc,end_utc,reason,job_id) SELECT site_id,layer,observed_from,greatest($2,observed_from+interval '1 microsecond'),'deletion_rebuild',$3 FROM site_data_coverage WHERE site_id=$1`,
    [site.id, cutoff, job.id],
  );
  return publicJob(job);
}
export function publicJob(job: Record<string, unknown>) {
  return {
    job_id: job.id,
    site_id: job.site_public_id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    attempts: job.attempts,
    requested_at: job.requested_at,
    completed_at: job.completed_at,
    next_attempt_at: job.next_attempt_at,
    last_error_code: job.last_error_code,
    deleted_counts: job.deleted_counts,
    result: job.result,
  };
}
export async function visitorPreflight(client: pg.PoolClient, publicId: string) {
  const site = await lockSite(client, publicId, 'UPDATE');
  await client.query('UPDATE sites SET enabled=false WHERE id=$1', [site.id]);
  const rows = (await client.query('SELECT * FROM site_data_coverage WHERE site_id=$1', [site.id]))
    .rows;
  const raw = rows.find((r) => r.layer === 'raw_pv');
  const sessions = rows.find((r) => r.layer === 'sessions');
  // Conservative proof: all observed facts must remain. Otherwise an old,
  // unlinked aggregate could contain this visitor even if no membership remains.
  const exact =
    raw &&
    sessions &&
    raw.available_from.getTime() === raw.observed_from.getTime() &&
    sessions.available_from.getTime() === sessions.observed_from.getTime() &&
    !(
      await client.query(
        'SELECT 1 FROM coverage_gaps WHERE site_id=$1 AND resolved_at IS NULL LIMIT 1',
        [site.id],
      )
    ).rowCount;
  return { site, exact: Boolean(exact) };
}
