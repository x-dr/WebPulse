import type pg from 'pg';
import type { RequestBudget } from '../http/budget.js';
import { ApiError, databaseError } from '../http/errors.js';

export async function transaction<T>(
  pool: pg.Pool,
  budget: RequestBudget,
  work: (client: pg.PoolClient) => Promise<T>,
  options: { snapshot?: boolean; readOnly?: boolean } = {},
): Promise<T> {
  const { signal, deadline } = budget;
  signal.throwIfAborted();
  let expired = false;
  let acquisitionTimer: NodeJS.Timeout | undefined;
  let acquisitionAbort: (() => void) | undefined;
  const connection = pool.connect().then((client) => {
    if (expired) {
      client.release();
      throw new ApiError(503, 'server_busy');
    }
    return client;
  });
  let client: pg.PoolClient;
  try {
    client = await Promise.race([
      connection,
      new Promise<never>((_, reject) => {
        acquisitionAbort = () => {
          expired = true;
          reject(new ApiError(503, 'request_cancelled'));
        };
        signal.addEventListener('abort', acquisitionAbort, { once: true });
        acquisitionTimer = setTimeout(
          () => {
            expired = true;
            reject(new ApiError(503, 'server_busy'));
          },
          Math.max(1, Math.min(750, deadline - Date.now())),
        );
      }),
    ]);
  } catch (error) {
    throw databaseError(error);
  } finally {
    clearTimeout(acquisitionTimer);
    if (acquisitionAbort) signal.removeEventListener('abort', acquisitionAbort);
  }
  let destroyed = false;
  const destroy = () => {
    if (!destroyed) {
      destroyed = true;
      client.release(true);
    }
  };
  const onError = () => {
    destroy();
  };
  client.on('error', onError);
  signal.addEventListener('abort', destroy, { once: true });
  const timer = setTimeout(destroy, Math.max(1, Math.min(4000, deadline - Date.now())));
  try {
    signal.throwIfAborted();
    await client.query(
      `BEGIN ISOLATION LEVEL ${options.snapshot ? 'REPEATABLE READ' : 'READ COMMITTED'}${options.readOnly ? ' READ ONLY' : ''}`,
    );
    await client.query(
      "SET LOCAL lock_timeout = '750ms'; SET LOCAL statement_timeout = '1500ms'; SET LOCAL transaction_timeout = '4s'; SET LOCAL idle_in_transaction_session_timeout = '1500ms'",
    );
    const result = await work(client);
    if (destroyed || signal.aborted || Date.now() >= deadline)
      throw new ApiError(503, 'request_timeout');
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!destroyed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy();
      }
    }
    throw databaseError(error);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', destroy);
    client.off('error', onError);
    if (!destroyed) client.release();
  }
}
export const backgroundBudget = (): RequestBudget => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 4500,
});
