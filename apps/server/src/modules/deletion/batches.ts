import type pg from 'pg';
import type { Selector } from './encryption.js';

export type Job = {
  id: string;
  site_public_id: string;
  phase: string;
  kind: string;
  lease_generation: string;
  cursor: Record<string, unknown>;
  selector_ciphertext: import('./encryption.js').Envelope;
  encryption_key_id: string;
  journal_ack_at: Date | null;
  attempts: number;
  cutoff_at: Date;
};
export async function rememberBuckets(
  client: pg.PoolClient,
  job: Job,
  site: { id: string; timezone: string },
  times: Date[],
) {
  if (!times.length || job.kind === 'site') return;
  await client.query(
    `INSERT INTO deletion_rebuild_buckets(task_id,grain,bucket_start)
    SELECT $1,grain,start FROM (
      SELECT 'hour' AS grain,date_trunc('hour',at) AS start FROM unnest($2::timestamptz[]) at
      UNION SELECT 'day',date_trunc('day',at AT TIME ZONE $3) AT TIME ZONE $3 FROM unnest($2::timestamptz[]) at
    ) b ON CONFLICT DO NOTHING`,
    [job.id, times, site.timezone],
  );
  await client.query(
    `UPDATE freeze_cursors c SET next_bucket_start=least(c.next_bucket_start,b.start) FROM (SELECT grain,min(bucket_start) AS start FROM deletion_rebuild_buckets WHERE task_id=$2 GROUP BY grain) b WHERE c.site_id=$1 AND c.grain=b.grain`,
    [site.id, job.id],
  );
  await client.query(
    `UPDATE site_data_coverage c SET finalized_through=least(c.finalized_through,b.start),aggregated_through=least(c.aggregated_through,b.start),revision=c.revision+1 FROM (SELECT grain,min(bucket_start) AS start FROM deletion_rebuild_buckets WHERE task_id=$2 GROUP BY grain) b WHERE c.site_id=$1 AND c.layer=b.grain || '_aggregates'`,
    [site.id, job.id],
  );
}
export async function deleteFactBatch(
  client: pg.PoolClient,
  job: Job,
  site: { id: string; timezone: string },
  selector: Selector,
  limit: number,
) {
  const table = String(job.cursor.table ?? 'interactions');
  const actual = job.phase === 'facts' ? 'events' : job.phase;
  const keys = selector.visitor_keys.map((k) => Buffer.from(k.key, 'hex'));
  const filter = job.kind === 'site' ? 'true' : 'visitor_key=ANY($2::bytea[])';
  const eventFilter =
    job.phase === 'facts'
      ? `AND event_type='${table === 'interactions' ? 'interaction' : 'page_view'}'`
      : '';
  const primary =
    actual === 'events' ? 'event_id' : actual === 'sessions' ? 'id' : "encode(visitor_key,'hex')";
  const column = actual === 'events' ? 'event_id' : actual === 'sessions' ? 'id' : 'visitor_key';
  const lowerBound =
    actual === 'visitors'
      ? "visitor_key>decode($3,'hex')"
      : `($3='' OR ${column}>nullif($3,'')::uuid)`;
  const last = String(job.cursor.last_key ?? '');
  const rows = (
    await client.query(
      `SELECT *,${primary}::text AS primary_key FROM ${actual} WHERE site_id=$1 AND (${filter}) AND ($2::bytea[] IS NOT NULL) ${eventFilter} AND ${lowerBound} AND ($4::timestamptz IS NOT NULL) ORDER BY ${column} LIMIT $5`,
      [site.id, keys, last, job.cutoff_at, limit],
    )
  ).rows;
  await rememberBuckets(
    client,
    job,
    site,
    rows.map((row) => row.occurred_at ?? row.started_at).filter(Boolean),
  );
  if (rows.length) {
    await client.query(
      `DELETE FROM ${actual} WHERE site_id=$1 AND ${column} IN (${actual === 'visitors' ? "SELECT decode(k,'hex') FROM unnest($2::text[]) k" : 'SELECT unnest($2::uuid[])'})`,
      [site.id, rows.map((r) => r.primary_key)],
    );
    return {
      phase: job.phase,
      cursor: {
        version: 1,
        phase: job.phase,
        table,
        last_key: rows.at(-1)!.primary_key,
        upper_bound: job.cutoff_at.toISOString(),
      },
      deleted: rows.length,
      table: actual,
    };
  }
  if (job.phase === 'facts' && table === 'interactions')
    return {
      phase: 'facts',
      cursor: {
        version: 1,
        phase: 'facts',
        table: 'page_views',
        last_key: '',
        upper_bound: job.cutoff_at.toISOString(),
      },
      deleted: 0,
      table: actual,
    };
  return {
    phase: job.phase === 'facts' ? 'sessions' : job.phase === 'sessions' ? 'visitors' : 'members',
    cursor: {},
    deleted: 0,
    table: actual,
  };
}
export async function deleteDerivedBatch(
  client: pg.PoolClient,
  job: Job,
  site: { id: string },
  selector: Selector,
  limit: number,
) {
  const tables =
    job.kind === 'site'
      ? [
          'visitor_days',
          'ip_days',
          'distinct_hours',
          'stats_pages_daily',
          'stats_sources_daily',
          'stats_daily',
          'stats_hourly',
          'dirty_buckets',
        ]
      : ['visitor_days', 'distinct_hours'];
  const index = Number(job.cursor.table_index ?? 0);
  const table = tables[index];
  if (!table)
    return {
      phase: job.kind === 'site' ? 'site' : 'aggregates',
      cursor: {},
      deleted: 0,
      table: 'members',
    };
  const keys = selector.visitor_keys.map((k) => Buffer.from(k.key, 'hex'));
  const filter =
    job.kind === 'site'
      ? 'true'
      : table === 'visitor_days'
        ? 'visitor_key=ANY($2::bytea[])'
        : 'kind=1 AND member_key=ANY($2::bytea[])';
  const order =
    table === 'distinct_hours'
      ? 'bucket_start,kind,member_key'
      : table === 'stats_hourly'
        ? 'bucket_start'
        : table === 'dirty_buckets'
          ? 'grain,bucket_start'
          : table === 'stats_pages_daily'
            ? 'local_date,path'
            : table === 'stats_sources_daily'
              ? 'local_date,source_key'
              : table === 'visitor_days'
                ? 'local_date,visitor_key'
                : table === 'ip_days'
                  ? 'local_date,ip_key'
                  : 'local_date';
  const removed = await client.query(
    `WITH doomed AS (SELECT ctid FROM ${table} WHERE site_id=$1 AND (${filter}) AND ($2::bytea[] IS NOT NULL) ORDER BY ${order} LIMIT $3) DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM doomed)`,
    [site.id, keys, limit],
  );
  return {
    phase: 'members',
    cursor: {
      version: 1,
      phase: 'members',
      table,
      table_index: index + (removed.rowCount ? 0 : 1),
      upper_bound: job.cutoff_at.toISOString(),
    },
    deleted: removed.rowCount ?? 0,
    table,
  };
}
