import { createInterface } from 'node:readline';
import { createPool } from '../../apps/server/src/db/database.js';
import { maintenanceConnection } from '../../apps/server/src/modules/aggregation/connection.js';
import { runDeletionBatch } from '../../apps/server/src/modules/deletion/worker.js';
import { rebuildBucket } from '../../apps/server/src/modules/aggregation/buckets.js';

// Configuration (including ephemeral credentials) travels over stdin, never argv or logs.
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const config = JSON.parse(line);
  const pool = createPool(config.database);
  const barrier = async () => {
    process.stdout.write('barrier\n');
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  };
  try {
    await maintenanceConnection(pool, async (client) => {
      if (config.mode === 'aggregate') {
        await rebuildBucket(
          client,
          { site: config.site, grain: 'day', start: new Date('2026-11-01Z') },
          config.boundary === 'before' ? { beforePublish: barrier } : {},
        );
      } else {
        const processed = await runDeletionBatch(
          client,
          { key: Buffer.from(config.key, 'hex'), keyId: 'test-v1' },
          { persist: async () => ({ sequence: '1' }) },
          {
            owner: config.owner,
            limit: 1,
            ...(config.boundary === 'before' ? { beforeCommit: barrier } : {}),
          },
        );
        if (!processed) throw new Error('Crash fixture did not acquire the job');
      }
      if (config.boundary === 'after') await barrier();
    });
  } catch {
    process.stderr.write('Crash fixture failed\n');
    process.exitCode = 1;
  }
  await pool.end();
  break;
}
