import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from '../support/postgres.js';
import { seed, observe, maintained, key } from '../support/reporting.js';
import { FileJournal } from '../../apps/server/src/modules/deletion/journal.js';
import { requestDeletion } from '../../apps/server/src/modules/deletion/jobs.js';
import { replayRecovery } from '../../apps/server/src/modules/deletion/recovery.js';
import { runDeletionBatch } from '../../apps/server/src/modules/deletion/worker.js';
import { maintenanceTransaction } from '../../apps/server/src/modules/aggregation/connection.js';
import { checkDatabaseReady } from '../../apps/server/src/db/database.js';
import { loadMigrations } from '../../apps/server/src/db/migrations.js';
import { maintenanceWorker } from '../../apps/server/src/modules/maintenance/worker.js';

let f: Fixture;
let directory: string;
let journal: FileJournal;
let signing: Buffer;
beforeEach(async () => {
  f = await fixture();
  await observe(f);
  directory = await mkdtemp(join(tmpdir(), 'webpulse-recovery-'));
  signing = randomBytes(32);
  journal = new FileJournal(directory, signing);
  await journal.initialize();
  await seed(f, [
    {
      visitor: 'a',
      start: '2026-11-01T09:00Z',
      closed: '2026-11-01T10:00Z',
      pages: [{ at: '2026-11-01T09:00Z', path: '/delete' }],
    },
    {
      visitor: 'b',
      start: '2026-11-01T09:00Z',
      closed: '2026-11-01T10:00Z',
      pages: [{ at: '2026-11-01T09:00Z', path: '/keep' }],
    },
  ]);
});
afterEach(async () => {
  await f?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function intent(kind: 'site' | 'visitor' = 'visitor', epoch = 1) {
  await maintained(f, (c) =>
    maintenanceTransaction(c, () =>
      requestDeletion(
        c,
        {
          site: f.site,
          kind,
          idempotencyKey: randomUUID(),
          confirmName: 'Test site',
          visitorKeys: kind === 'visitor' ? [{ epoch, key: key('a').toString('hex') }] : [],
        },
        f.deletionKey,
      ),
    ),
  );
  const job = (await f.pool.query('SELECT * FROM deletion_jobs')).rows[0];
  await journal.persist({
    taskId: job.id,
    keyId: job.encryption_key_id,
    envelope: job.selector_ciphertext,
    schemaVersion: 1,
  });
  return job;
}
describe('M4 durable journal recovery gate and privacy replay', () => {
  it('replays accepted incomplete intents, persists withheld coverage, and is idempotent', async () => {
    await intent();
    const ledger = await journal.read();
    await replayRecovery(f.pool, f.deletionKey, journal, ledger, signing);
    expect((await f.pool.query('SELECT path FROM events')).rows).toEqual([{ path: '/keep' }]);
    expect((await f.pool.query('SELECT state FROM recovery_state')).rows[0].state).toBe('verified');
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM coverage_gaps WHERE reason='privacy_replay_unverifiable' AND resolved_at IS NULL",
        )
      ).rows[0].n,
    ).toBe(6);
    const report = await f.app.inject({
      url: `/api/v1/stats/overview?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-02`,
      headers: f.headers,
    });
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json().data.pv).toBeNull();
    expect(report.body).toContain('privacy_replay_unverifiable');
    await replayRecovery(f.pool, f.deletionKey, journal, ledger, signing);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM recovery_replays')).rows[0].n).toBe(
      1,
    );
    expect((await f.pool.query('SELECT enabled FROM sites')).rows[0].enabled).toBe(false);
    expect(
      (await f.pool.query('SELECT completion_sequence FROM deletion_jobs')).rows[0]
        .completion_sequence,
    ).toBe('2');
    await expect(maintenanceWorker(f.pool, f.deletionKey, journal).run()).resolves.toBeDefined();
    expect((await journal.read()).head.sequence).toBe('2');
  });
  it('removes a site from a pre-deletion snapshot and retains its permanent tombstone', async () => {
    await intent('site');
    // Simulates a database backup predating acceptance while the external log survives.
    await f.pool.query('DELETE FROM deletion_outbox');
    await f.pool.query('DELETE FROM deletion_jobs');
    await f.pool.query("UPDATE sites SET enabled=true,maintenance_state='active'");
    await replayRecovery(f.pool, f.deletionKey, journal, await journal.read(), signing);
    expect((await f.pool.query('SELECT * FROM sites')).rowCount).toBe(0);
    expect((await f.pool.query('SELECT * FROM site_tombstones')).rowCount).toBe(1);
  });
  it('keeps all entry points locked on gaps, missing decryption keys or missing epochs', async () => {
    await intent('visitor', 999);
    const ledger = await journal.read();
    await expect(
      replayRecovery(
        f.pool,
        f.deletionKey,
        journal,
        { ...ledger, head: { ...ledger.head, sequence: '2' } },
        signing,
      ),
    ).rejects.toThrow('incomplete');
    await expect(
      replayRecovery(
        f.pool,
        { key: randomBytes(32), keyId: f.deletionKey.keyId },
        journal,
        ledger,
        signing,
      ),
    ).rejects.toThrow();
    await expect(replayRecovery(f.pool, f.deletionKey, journal, ledger, signing)).rejects.toThrow(
      'identity_epoch',
    );
    await expect(checkDatabaseReady(f.pool, await loadMigrations())).rejects.toThrow(
      'recovery_locked',
    );
    expect((await f.app.inject({ url: '/api/v1/sites', headers: f.headers })).statusCode).toBe(503);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(2);
  });
  it('recovers upload-before-ack crashes without duplicate journal records or destructive batches', async () => {
    const job = await intent('site');
    await maintained(f, (c) =>
      runDeletionBatch(c, f.deletionKey, journal, {
        beforeCommit: async () => {
          throw new Error('crash');
        },
      }),
    );
    expect((await f.pool.query('SELECT phase FROM deletion_jobs')).rows[0].phase).toBe('journal');
    expect((await f.pool.query('SELECT * FROM events')).rowCount).toBe(2);
    await f.pool.query('UPDATE deletion_jobs SET next_attempt_at=NULL');
    await maintained(f, (c) => runDeletionBatch(c, f.deletionKey, journal));
    expect((await journal.read()).head.sequence).toBe('1');
    expect(
      (await f.pool.query('SELECT phase,journal_sequence FROM deletion_jobs WHERE id=$1', [job.id]))
        .rows[0],
    ).toMatchObject({ phase: 'facts', journal_sequence: '1' });
  });
});
