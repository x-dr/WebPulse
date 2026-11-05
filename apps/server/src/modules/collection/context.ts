import type pg from 'pg';
import type { CollectionRules } from '@webpulse/shared';
import type { Site } from '../sites/store.js';
import { ApiError } from '../../http/errors.js';
import { visitorLock } from '../identity/keys.js';

export type Visitor = { first_seen_pv_at: Date; last_activity_at: Date; activity_seq: string };
export type CollectionContext = {
  client: pg.PoolClient;
  site: Site;
  key: Buffer;
  ipKey: Buffer;
  now: string;
  rules: CollectionRules;
  visitor: Visitor | undefined;
  dirty: Set<string>;
};
export async function lockVisitor(client: pg.PoolClient, site: Site, key: Buffer) {
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [visitorLock(site.id, key)]);
  return (
    await client.query<Visitor>(
      'SELECT first_seen_pv_at,last_activity_at,activity_seq FROM visitors WHERE site_id=$1 AND visitor_key=$2 FOR UPDATE',
      [site.id, key],
    )
  ).rows[0];
}
export async function advanceActivity(
  ctx: CollectionContext,
  page: string,
  path: string,
): Promise<string> {
  const { client, site, key, now } = ctx;
  const result = await client.query<{ activity_seq: string }>(
    `UPDATE visitors SET last_activity_at=$3,activity_seq=activity_seq+1,latest_path=$4,latest_page_view_id=$5
    WHERE site_id=$1 AND visitor_key=$2 AND last_activity_at<=$3 RETURNING activity_seq`,
    [site.id, key, now, path, page],
  );
  if (!result.rows[0]) throw new ApiError(503, 'clock_regressed');
  return result.rows[0].activity_seq;
}
export async function markDirty(ctx: CollectionContext) {
  if (!ctx.dirty.size) return;
  await ctx.client.query(
    `INSERT INTO dirty_buckets(site_id,grain,bucket_start)
    SELECT $1,grain,bucket FROM (
      SELECT DISTINCT 'hour' AS grain,date_trunc('hour',t) AS bucket FROM unnest($2::timestamptz[]) t
      UNION SELECT DISTINCT 'day',date_trunc('day',t AT TIME ZONE $3) AT TIME ZONE $3 FROM unnest($2::timestamptz[]) t
    ) buckets ORDER BY grain,bucket
    ON CONFLICT(site_id,grain,bucket_start) DO UPDATE SET version=dirty_buckets.version+1,updated_at=clock_timestamp()`,
    [ctx.site.id, [...ctx.dirty], ctx.site.timezone],
  );
}
