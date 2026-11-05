import type pg from 'pg';
import { localParts, wallClock } from '../reports/time.js';
import { rebuildBucket, type Bucket } from './buckets.js';

export async function aggregateSite(client: pg.PoolClient, publicId: string, limit = 10) {
  const site = (await client.query('SELECT * FROM sites WHERE public_id=$1', [publicId])).rows[0];
  if (!site || site.maintenance_state !== 'active') return { rebuilt: 0, frozen: 0, failed: 0 };
  let rebuilt = 0,
    frozen = 0,
    failed = 0;
  let remaining = limit;
  const dirty = (
    await client.query(
      'SELECT grain,bucket_start FROM dirty_buckets WHERE site_id=$1 ORDER BY grain,bucket_start LIMIT $2',
      [site.id, Math.ceil(limit / 3)],
    )
  ).rows;
  for (const row of dirty) {
    if (remaining-- <= 0) break;
    try {
      if (
        await rebuildBucket(client, { site: publicId, grain: row.grain, start: row.bucket_start })
      )
        rebuilt++;
    } catch {
      failed++;
    }
  }
  // Enumeration is independent of dirty markers and survives process restarts.
  for (const grain of ['hour', 'day'] as const) {
    const first =
      grain === 'hour'
        ? new Date(Math.floor(site.created_at.getTime() / 3600_000) * 3600_000)
        : wallClock(localParts(site.created_at, site.timezone).date, site.timezone).at;
    await client.query(
      'INSERT INTO freeze_cursors(site_id,grain,next_bucket_start) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [site.id, grain, first],
    );
    for (let i = 0; i < Math.ceil(limit / 3) && remaining > 0; i++) {
      const row = (
        await client.query(
          `SELECT next_bucket_start,clock_timestamp() AS now FROM freeze_cursors WHERE site_id=$1 AND grain=$2`,
          [site.id, grain],
        )
      ).rows[0];
      const start = row.next_bucket_start as Date;
      const end =
        grain === 'hour'
          ? new Date(start.getTime() + 3600_000)
          : ((
              await client.query(
                'SELECT (($1::timestamptz AT TIME ZONE $2)::date+1)::timestamp AT TIME ZONE $2 AS end',
                [start, site.timezone],
              )
            ).rows[0].end as Date);
      if (end.getTime() + 45_000_000 > row.now.getTime()) break;
      const bucket: Bucket = { site: publicId, grain, start };
      remaining--;
      try {
        if (!(await rebuildBucket(client, bucket, { finalize: true, advanceCursor: true }))) break;
        frozen++;
      } catch {
        failed++;
        break;
      }
    }
  }
  // Explicitly revisit previously published non-final rows, including ones absent
  // from the dirty queue. A failed row remains non-final and will be retried.
  for (const grain of ['day', 'hour'] as const) {
    const table = grain === 'day' ? 'stats_daily' : 'stats_hourly';
    const startSql = grain === 'day' ? 'local_date::timestamp AT TIME ZONE $2' : 'bucket_start';
    const rows = (
      await client.query(
        `SELECT ${startSql} AS start FROM ${table} WHERE site_id=$1 AND NOT is_final AND $2::text IS NOT NULL ORDER BY 1 LIMIT $3`,
        [site.id, site.timezone, Math.max(0, remaining)],
      )
    ).rows;
    for (const row of rows) {
      if (remaining-- <= 0) break;
      try {
        if (
          await rebuildBucket(
            client,
            { site: publicId, grain, start: row.start },
            { finalize: true },
          )
        )
          frozen++;
      } catch {
        failed++;
      }
    }
  }
  return { rebuilt, frozen, failed };
}
