import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { readSecurityConfig } from '../../config/security.js';
import { maintenanceConnection, maintenanceTransaction } from '../aggregation/connection.js';
import { identityKey } from '../identity/keys.js';
import { ApiError } from '../../http/errors.js';
import { requestDeletion, visitorPreflight } from './jobs.js';
import { readDeletionKey } from './encryption.js';

export async function deletionCommand(pool: pg.Pool, command: string, args: string[]) {
  if (command === 'deletion:retry') {
    const id = args[0];
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid job');
    const retried = await maintenanceConnection(pool, async (client) => {
      return await client.query(
        `UPDATE deletion_jobs SET status='queued',attempts=0,next_attempt_at=NULL,last_error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1 WHERE id=$1 AND status IN ('blocked','retry_wait') RETURNING id`,
        [id],
      );
    });
    if (!retried) throw new ApiError(503, 'maintenance_busy');
    if (!retried.rowCount) throw new ApiError(409, 'job_not_retryable');
    process.stdout.write('Deletion retry scheduled; original phase and cutoff retained.\n');
    return;
  }
  const [site, idempotencyKey] = args;
  if (!site || !idempotencyKey || !/^[a-f0-9-]{36}$/i.test(idempotencyKey) || process.stdin.isTTY)
    throw new Error('Use site, idempotency UUID and cid via stdin');
  const cid = readFileSync(0, 'utf8').trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(cid))
    throw new Error('Invalid cid');
  const security = readSecurityConfig();
  const config = readDeletionKey();
  if (!config) throw new ApiError(503, 'deletion_key_unavailable');
  if ([security.visitorKey, security.ipKey, security.csrfKey].some((key) => key.equals(config.key)))
    throw new ApiError(503, 'deletion_key_unavailable');
  const result = await maintenanceConnection(pool, async (client) => {
    const proof = await maintenanceTransaction(client, () => visitorPreflight(client, site));
    if (!proof.exact) throw new ApiError(409, 'deletion_not_exact');
    const history: Record<string, string> = process.env.VISITOR_HMAC_HISTORY_FILE
      ? JSON.parse(readFileSync(process.env.VISITOR_HMAC_HISTORY_FILE, 'utf8'))
      : {};
    const epochs = [
      ...new Set([
        proof.site.key_version,
        ...((proof.site.config.identity_epochs as { visitor: number }[]) ?? []).map(
          (epoch) => epoch.visitor,
        ),
      ]),
    ].sort((a, b) => a - b);
    const visitorKeys = epochs.map((epoch) => {
      const key =
        epoch === proof.site.key_version
          ? security.visitorKey
          : history[epoch] && /^[a-f0-9]{64}$/i.test(history[epoch])
            ? Buffer.from(history[epoch], 'hex')
            : undefined;
      if (!key) throw new ApiError(409, 'identity_epoch_key_unavailable');
      return { epoch, key: identityKey(key, 'visitor', site, epoch, cid).toString('hex') };
    });
    return maintenanceTransaction(client, () =>
      requestDeletion(client, { site, kind: 'visitor', idempotencyKey, visitorKeys }, config),
    );
  });
  if (!result) throw new Error('maintenance_busy');
  process.stdout.write(JSON.stringify(result) + '\n');
}
