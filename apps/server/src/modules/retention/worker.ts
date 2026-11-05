import type pg from 'pg';
import { lockSite } from '../sites/store.js';
import { maintenanceTransaction } from '../aggregation/connection.js';
import { retentionPlan } from './plan.js';

// Each call commits at most one 500-row batch. Coverage is withheld before any
// destructive batch, then advanced only after the entire fixed target is done.
export async function cleanupSite(client: pg.PoolClient, publicId: string, batchSize = 500) {
  const site = (await client.query('SELECT * FROM sites WHERE public_id=$1', [publicId])).rows[0];
  if (!site || site.maintenance_state !== 'active') return false;
  const plan = await retentionPlan(client, site);
  const target = plan.find((p) => p.in_progress || p.safe_target > p.available_from);
  if (!target) return false;
  const layer = target.layer;
  const cutoff = new Date(target.safe_target);
  if (!target.in_progress)
    await maintenanceTransaction(client, async () => {
      const locked = await lockSite(client, publicId);
      if (locked.maintenance_state !== 'active') return;
      await client.query(
        `UPDATE site_data_coverage SET cleanup_target=$3,cleanup_cursor='{"phase":"delete","version":1}'::jsonb,revision=revision+1 WHERE site_id=$1 AND layer=$2`,
        [site.id, layer, cutoff],
      );
      await client.query(
        `INSERT INTO coverage_gaps(site_id,layer,start_utc,end_utc,reason) SELECT site_id,layer,available_from,$3,'retention_cleanup' FROM site_data_coverage WHERE site_id=$1 AND layer=$2`,
        [site.id, layer, cutoff],
      );
    });
  return maintenanceTransaction(client, async () => {
    const locked = await lockSite(client, publicId);
    if (locked.maintenance_state !== 'active') return false;
    const state = (
      await client.query(
        'SELECT * FROM site_data_coverage WHERE site_id=$1 AND layer=$2 FOR UPDATE',
        [site.id, layer],
      )
    ).rows[0];
    if (!state.cleanup_target) return false;
    const localDate = (
      await client.query('SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS date', [
        cutoff,
        site.timezone,
      ])
    ).rows[0].date;
    let batchCursor: Record<string, unknown> = {};
    const remove = async (table: string, condition: string) => {
      const keyColumns =
        table === 'events'
          ? ['event_id']
          : table === 'sessions'
            ? ['id']
            : table === 'distinct_hours'
              ? ['bucket_start', 'kind', "encode(member_key,'hex')"]
              : table === 'stats_hourly'
                ? ['bucket_start']
                : table === 'visitor_days'
                  ? ['local_date', "encode(visitor_key,'hex')"]
                  : table === 'ip_days'
                    ? ['local_date', "encode(ip_key,'hex')"]
                    : table === 'stats_pages_daily'
                      ? ['local_date', 'path']
                      : table === 'stats_sources_daily'
                        ? ['local_date', "encode(source_key,'hex')"]
                        : ['local_date'];
      const result = await client.query(
        `WITH doomed AS (SELECT ctid,jsonb_build_array(${keyColumns.join(',')}) AS key FROM ${table} WHERE site_id=$1 AND ${condition} ORDER BY ${keyColumns.join(',')} LIMIT $3) DELETE FROM ${table} t USING doomed d WHERE t.ctid=d.ctid RETURNING d.key`,
        [
          site.id,
          table.includes('daily') || ['visitor_days', 'ip_days'].includes(table)
            ? localDate
            : cutoff,
          batchSize,
        ],
      );
      if (result.rowCount)
        batchCursor = {
          table,
          last_key: result.rows.at(-1)!.key,
          upper_bound: cutoff.toISOString(),
        };
      return result.rowCount ?? 0;
    };
    let deleted: number;
    if (layer === 'raw_pv') {
      deleted = await remove(
        'events',
        "event_type='interaction' AND (occurred_at<$2 OR page_view_id IN (SELECT id FROM page_views WHERE site_id=$1 AND occurred_at<$2))",
      );
      if (!deleted) deleted = await remove('events', "event_type='page_view' AND occurred_at<$2");
    } else if (layer === 'sessions') {
      deleted = await remove(
        'sessions',
        "status='closed' AND started_at<$2 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.site_id=sessions.site_id AND e.session_id=sessions.id) AND NOT EXISTS(SELECT 1 FROM page_views p WHERE p.site_id=sessions.site_id AND p.session_id=sessions.id)",
      );
    } else if (layer === 'hour_members')
      deleted = await remove('distinct_hours', 'bucket_start<$2');
    else if (layer === 'day_members') {
      deleted = await remove('visitor_days', 'local_date<$2');
      if (!deleted) deleted = await remove('ip_days', 'local_date<$2');
    } else if (layer === 'hour_aggregates')
      deleted = await remove('stats_hourly', 'bucket_start<$2');
    else {
      deleted = await remove('stats_pages_daily', 'local_date<$2');
      if (!deleted) deleted = await remove('stats_sources_daily', 'local_date<$2');
      if (!deleted) deleted = await remove('stats_daily', 'local_date<$2');
    }
    await client.query(
      `UPDATE site_data_coverage SET cleanup_cursor=cleanup_cursor || $3::jsonb || jsonb_build_object('phase','delete','version',1,'batches',coalesce((cleanup_cursor->>'batches')::integer,0)+1),revision=revision+1,updated_at=clock_timestamp() WHERE site_id=$1 AND layer=$2`,
      [site.id, layer, JSON.stringify(batchCursor)],
    );
    if (!deleted) {
      await client.query(
        'UPDATE site_data_coverage SET available_from=$3,available_through=greatest(available_through,$3),cleanup_target=NULL,cleanup_cursor=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE site_id=$1 AND layer=$2',
        [site.id, layer, cutoff],
      );
      await client.query(
        "UPDATE coverage_gaps SET resolved_at=clock_timestamp(),revision=revision+1 WHERE site_id=$1 AND layer=$2 AND reason='retention_cleanup' AND resolved_at IS NULL",
        [site.id, layer],
      );
    }
    return true;
  });
}
export async function cleanupActivity(client: pg.PoolClient) {
  await client.query(
    `WITH batch AS (SELECT site_id,id FROM sessions WHERE status='closed' AND closed_at<clock_timestamp()-interval '24 hours' AND active_ranges<>'{}'::tstzmultirange ORDER BY closed_at LIMIT 500) UPDATE sessions s SET active_ranges='{}'::tstzmultirange FROM batch b WHERE s.site_id=b.site_id AND s.id=b.id`,
  );
  await client.query(
    `WITH batch AS (SELECT site_id,visitor_key FROM visitors v WHERE last_activity_at<clock_timestamp()-interval '90 days' AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.site_id=v.site_id AND s.visitor_key=v.visitor_key) AND NOT EXISTS(SELECT 1 FROM events e WHERE e.site_id=v.site_id AND e.visitor_key=v.visitor_key) ORDER BY last_activity_at LIMIT 500) DELETE FROM visitors v USING batch b WHERE v.site_id=b.site_id AND v.visitor_key=b.visitor_key`,
  );
}
