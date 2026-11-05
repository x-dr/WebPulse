import type pg from 'pg';

const MAINTENANCE_LOCK = 'webpulse:maintenance:v1:';
const counters = new WeakMap<
  pg.PoolClient,
  { transactions: number; retries: number; max_transaction_ms: number }
>();
export function maintenanceCounters(client: pg.PoolClient) {
  return { ...(counters.get(client) ?? { transactions: 0, retries: 0, max_transaction_ms: 0 }) };
}
export async function maintenanceConnection<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T | undefined> {
  const client = await pool.connect();
  counters.set(client, { transactions: 0, retries: 0, max_transaction_ms: 0 });
  let locked = false;
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on('error', onError);
  try {
    locked = (
      await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1 || current_schema(),0)) AS locked',
        [MAINTENANCE_LOCK],
      )
    ).rows[0].locked;
    return locked ? await work(client) : undefined;
  } finally {
    if (locked && !broken) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1 || current_schema(),0))',
          [MAINTENANCE_LOCK],
        );
      } catch {
        broken = true;
      }
    }
    client.off('error', onError);
    client.release(broken);
  }
}
export async function maintenanceTransaction<T>(
  client: pg.PoolClient,
  work: () => Promise<T>,
  retries = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const stats = counters.get(client);
    if (stats) stats.transactions++;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query(
        "SET LOCAL lock_timeout='200ms'; SET LOCAL statement_timeout='1500ms'; SET LOCAL transaction_timeout='4s'; SET LOCAL idle_in_transaction_session_timeout='1500ms'",
      );
      const value = await work();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      const code = (error as { code?: string }).code;
      if (!['40001', '40P01', '55P03', '23505'].includes(code ?? '') || attempt >= retries - 1)
        throw error;
      if (stats) stats.retries++;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    } finally {
      if (stats)
        stats.max_transaction_ms = Math.max(stats.max_transaction_ms, performance.now() - started);
    }
  }
}
