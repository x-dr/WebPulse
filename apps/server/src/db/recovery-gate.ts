import type pg from 'pg';
import { ApiError } from '../http/errors.js';

export async function checkRecoveryGate(client: Pick<pg.PoolClient, 'query'>) {
  const row = (await client.query('SELECT state FROM recovery_state WHERE singleton=true')).rows[0];
  if (!row || !['open', 'verified'].includes(row.state)) throw new ApiError(503, 'recovery_locked');
}
