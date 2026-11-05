import type pg from 'pg';
import { METRIC_VERSION } from '@webpulse/shared';
import { lockSite } from '../sites/store.js';
import { localParts, wallClock, addDays } from '../reports/time.js';
import { pvFacts, sessionFacts } from './facts.js';
import { replaceRankings } from './rankings.js';
import { maintenanceTransaction } from './connection.js';

export type Bucket = { site: string; grain: 'hour' | 'day'; start: Date };
export async function rebuildBucket(
  client: pg.PoolClient,
  bucket: Bucket,
  options: {
    finalize?: boolean;
    repair?: boolean;
    advanceCursor?: boolean;
    beforePublish?: () => Promise<void>;
  } = {},
) {
  return maintenanceTransaction(client, async () => {
    const site = await lockSite(client, bucket.site);
    if (site.maintenance_state !== 'active' && !options.repair) return false;
    const { grain, start } = bucket;
    const date = localParts(start, site.timezone).date;
    const end =
      grain === 'hour'
        ? new Date(start.getTime() + 3600_000)
        : wallClock(addDays(date, 1), site.timezone).at;
    const table = grain === 'hour' ? 'stats_hourly' : 'stats_daily';
    const column = grain === 'hour' ? 'bucket_start' : 'local_date';
    const key = grain === 'hour' ? start : date;
    const old = (
      await client.query(`SELECT * FROM ${table} WHERE site_id=$1 AND ${column}=$2`, [site.id, key])
    ).rows[0];
    const dirty = (
      await client.query(
        'SELECT version FROM dirty_buckets WHERE site_id=$1 AND grain=$2 AND bucket_start=$3',
        [site.id, grain, start],
      )
    ).rows[0];
    const coverage = (
      await client.query(
        `SELECT * FROM site_data_coverage WHERE site_id=$1 AND layer IN ('raw_pv','sessions')`,
        [site.id],
      )
    ).rows;
    const gap = (
      await client.query(
        `SELECT 1 FROM coverage_gaps WHERE site_id=$1 AND layer IN ('raw_pv','sessions',$4) AND resolved_at IS NULL AND start_utc<$3 AND end_utc>$2 AND NOT ($5::boolean AND reason='deletion_rebuild') LIMIT 1`,
        [site.id, start, end, `${grain}_aggregates`, Boolean(options.repair)],
      )
    ).rowCount;
    if (gap) return false;
    const rawAvailable =
      !gap &&
      coverage.length === 2 &&
      coverage.every(
        (c) => c.available_from.getTime() <= Math.max(start.getTime(), c.observed_from.getTime()),
      );
    const trustworthy = old?.computed_at && old.metric_version === METRIC_VERSION && !dirty;
    if (!rawAvailable && !trustworthy) return false;
    const advance = async () => {
      if (!options.advanceCursor) return;
      const moved = await client.query(
        'UPDATE freeze_cursors SET next_bucket_start=$4,last_scan_at=clock_timestamp() WHERE site_id=$1 AND grain=$2 AND next_bucket_start=$3',
        [site.id, grain, start, end],
      );
      if (moved.rowCount !== 1)
        throw Object.assign(new Error('Freeze cursor changed'), { code: '40001' });
      await client.query(
        `UPDATE site_data_coverage SET available_through=greatest(available_through,$3),aggregated_through=$3,finalized_through=$3,revision=revision+1,updated_at=clock_timestamp() WHERE site_id=$1 AND layer=$2`,
        [site.id, `${grain}_aggregates`, end],
      );
    };
    if (
      old?.is_final &&
      old.metric_version === METRIC_VERSION &&
      old.computed_at &&
      !dirty &&
      !options.repair
    ) {
      await advance();
      return true;
    }
    const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const canFinalize =
      end.getTime() + 45_000_000 <= now.getTime() &&
      !(
        await client.query(
          "SELECT 1 FROM sessions WHERE site_id=$1 AND started_at >= $2 AND started_at < $3 AND status='open' LIMIT 1",
          [site.id, start, end],
        )
      ).rowCount &&
      !gap;
    if (options.finalize && !canFinalize) return false;
    if (
      options.finalize &&
      rawAvailable &&
      (
        await client.query(
          `SELECT 1 FROM (
      SELECT rule_version FROM events WHERE site_id=$1 AND occurred_at >= $2 AND occurred_at < $3
      UNION SELECT rule_version FROM sessions WHERE site_id=$1 AND started_at >= $2 AND started_at < $3
    ) v WHERE NOT EXISTS(SELECT 1 FROM site_rules r WHERE r.site_id=$1 AND r.version=v.rule_version) LIMIT 1`,
          [site.id, start, end],
        )
      ).rowCount
    )
      return false;
    const pv = rawAvailable ? await pvFacts(client, site.id, start, end) : old;
    if (options.finalize && rawAvailable && pv.missing_identity) return false;
    const sessions = rawAvailable
      ? await sessionFacts(client, site.id, start, end)
      : {
          sessions: old.sessions_total,
          closed_sessions: old.closed_sessions,
          bounced_sessions: old.bounced_sessions,
          total_closed_active_ms: old.active_ms,
        };
    await options.beforePublish?.();
    const published = (
      await client.query(
        `INSERT INTO ${table}(site_id,${column},pv,uv,ip,sessions_total,closed_sessions,bounced_sessions,active_ms,is_final,metric_version,revision,computed_at,source_dirty_version,finalized_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,clock_timestamp(),$12,CASE WHEN $10 THEN clock_timestamp() END)
      ON CONFLICT(site_id,${column}) DO UPDATE SET pv=excluded.pv,uv=excluded.uv,ip=excluded.ip,sessions_total=excluded.sessions_total,closed_sessions=excluded.closed_sessions,bounced_sessions=excluded.bounced_sessions,active_ms=excluded.active_ms,is_final=excluded.is_final,metric_version=excluded.metric_version,revision=${table}.revision+1,computed_at=excluded.computed_at,updated_at=clock_timestamp(),source_dirty_version=excluded.source_dirty_version,finalized_at=excluded.finalized_at RETURNING revision`,
        [
          site.id,
          key,
          pv.pv,
          pv.uv,
          pv.ip,
          sessions.sessions,
          sessions.closed_sessions,
          sessions.bounced_sessions,
          sessions.total_closed_active_ms,
          Boolean(options.finalize && canFinalize),
          METRIC_VERSION,
          dirty?.version ?? old?.source_dirty_version ?? 0,
        ],
      )
    ).rows[0];
    if (rawAvailable) {
      if (grain === 'day') {
        await client.query('DELETE FROM visitor_days WHERE site_id=$1 AND local_date=$2', [
          site.id,
          date,
        ]);
        await client.query('DELETE FROM ip_days WHERE site_id=$1 AND local_date=$2', [
          site.id,
          date,
        ]);
        await client.query(
          `INSERT INTO visitor_days SELECT site_id,local_date,visitor_key,min(first_seen_pv_at) FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at >= $2 AND occurred_at < $3 GROUP BY site_id,local_date,visitor_key`,
          [site.id, start, end],
        );
        await client.query(
          `INSERT INTO ip_days SELECT DISTINCT site_id,local_date,ip_key FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at >= $2 AND occurred_at < $3`,
          [site.id, start, end],
        );
        await replaceRankings(client, site.id, date, start, end, published.revision);
      } else {
        await client.query('DELETE FROM distinct_hours WHERE site_id=$1 AND bucket_start=$2', [
          site.id,
          start,
        ]);
        await client.query(
          `INSERT INTO distinct_hours(site_id,bucket_start,kind,member_key,first_seen_pv_at)
          SELECT site_id,$2,1,visitor_key,min(first_seen_pv_at) FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at >= $2 AND occurred_at < $3 GROUP BY site_id,visitor_key
          UNION ALL SELECT DISTINCT site_id,$2,2,ip_key,NULL::timestamptz FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at >= $2 AND occurred_at < $3`,
          [site.id, start, end],
        );
      }
    }
    if (grain === 'day') {
      if (!rawAvailable) {
        await client.query(
          'UPDATE stats_pages_daily SET revision=$3 WHERE site_id=$1 AND local_date=$2',
          [site.id, date, published.revision],
        );
        await client.query(
          'UPDATE stats_sources_daily SET revision=$3 WHERE site_id=$1 AND local_date=$2',
          [site.id, date, published.revision],
        );
      }
      const totals = (
        await client.query(
          `SELECT (SELECT coalesce(sum(pv),0) FROM stats_pages_daily WHERE site_id=$1 AND local_date=$2) AS pv,(SELECT coalesce(sum(sessions_total),0) FROM stats_sources_daily WHERE site_id=$1 AND local_date=$2) AS sessions`,
          [site.id, date],
        )
      ).rows[0];
      if (
        String(totals.pv) !== String(pv.pv) ||
        String(totals.sessions) !== String(sessions.sessions)
      )
        throw new Error('Aggregate reconciliation failed');
    }
    if (dirty) {
      const removed = await client.query(
        'DELETE FROM dirty_buckets WHERE site_id=$1 AND grain=$2 AND bucket_start=$3 AND version=$4',
        [site.id, grain, start, dirty.version],
      );
      if (removed.rowCount !== 1)
        throw Object.assign(new Error('Dirty version changed'), { code: '40001' });
    } else {
      // A concurrent first dirty insertion must also conflict with publication.
      await client.query(
        'INSERT INTO dirty_buckets(site_id,grain,bucket_start) VALUES ($1,$2,$3)',
        [site.id, grain, start],
      );
      await client.query(
        'DELETE FROM dirty_buckets WHERE site_id=$1 AND grain=$2 AND bucket_start=$3',
        [site.id, grain, start],
      );
    }
    await client.query(
      `UPDATE site_data_coverage SET revision=revision+1,updated_at=clock_timestamp() WHERE site_id=$1 AND layer=$2`,
      [site.id, `${grain}_aggregates`],
    );
    await advance();
    return true;
  });
}
