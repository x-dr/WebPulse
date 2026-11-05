import type pg from 'pg';
import { closedSessionMetrics, type ReportMetric } from '@webpulse/shared';
import type { Site } from '../sites/store.js';
import { ApiError } from '../../http/errors.js';
import { safeCount } from '../aggregation/facts.js';
import { unavailable, epochReason, type Coverage } from './coverage.js';
import { addDays, localParts, wallClock, type TimeRange } from './time.js';
import { readReport } from './reader.js';

function scalar(row: Record<string, unknown>, metric: ReportMetric) {
  const map: Record<string, string> = {
    sessions: 'sessions_total',
    total_closed_active_ms: 'active_ms',
  };
  return metric === 'bounce_rate' || metric === 'avg_active_ms'
    ? closedSessionMetrics({
        closed_sessions: safeCount(row.closed_sessions),
        bounced_sessions: safeCount(row.bounced_sessions),
        active_ms: safeCount(row.active_ms),
      })[metric]
    : safeCount(row[map[metric] ?? metric]);
}
export async function readTrend(
  client: pg.PoolClient,
  site: Site,
  range: TimeRange,
  coverage: Coverage,
  grain: 'minute' | 'hour' | 'day',
  metric: ReportMetric,
) {
  const seconds = grain === 'hour' ? 3600 : 60;
  if (
    grain !== 'day' &&
    Math.ceil((range.end.getTime() - range.start.getTime()) / (seconds * 1000)) + 1 > 1500
  )
    throw new ApiError(400, 'too_many_points');
  const member = ['uv', 'ip', 'new_visitors', 'returning_visitors'].includes(metric);
  const pvMetric = member || metric === 'pv';
  const frozen =
    grain === 'day'
      ? (
          await client.query(
            'SELECT *,local_date::text AS key FROM stats_daily WHERE site_id=$1 AND local_date >= $2 AND local_date < $3 AND is_final AND computed_at IS NOT NULL AND metric_version=1',
            [site.id, range.startDate, range.endDate],
          )
        ).rows
      : (
          await client.query(
            "SELECT * FROM stats_hourly WHERE site_id=$1 AND bucket_start >= date_trunc('hour',$2::timestamptz) AND bucket_start < $3 AND is_final AND computed_at IS NOT NULL AND metric_version=1",
            [site.id, range.start, range.end],
          )
        ).rows;
  const published = new Map(
    frozen.map((row) => [grain === 'day' ? row.key : row.bucket_start.getTime(), row]),
  );
  const raw = new Map<number, Record<string, unknown>>();
  const members = new Map<number, Record<string, unknown>>();
  if (grain !== 'day') {
    const bucket = `to_timestamp(floor(extract(epoch FROM ${pvMetric ? 'occurred_at' : 'started_at'})/$4)*$4)`;
    const sql = pvMetric
      ? `WITH facts AS (SELECT *,${bucket} AS bucket FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at >= $2 AND occurred_at < $3)
      SELECT bucket,count(*) AS pv,count(DISTINCT visitor_key) AS uv,count(DISTINCT ip_key) AS ip,count(DISTINCT visitor_key) FILTER(WHERE first_seen_pv_at >= greatest(bucket,$2::timestamptz)) AS new_visitors,count(DISTINCT visitor_key) FILTER(WHERE first_seen_pv_at < greatest(bucket,$2::timestamptz)) AS returning_visitors,count(*) FILTER(WHERE first_seen_pv_at IS NULL) AS missing FROM facts GROUP BY bucket`
      : `WITH facts AS (SELECT *,${bucket} AS bucket,status='closed' AND ($5::timestamptz IS NULL OR closed_at<=$5) AS settled FROM sessions WHERE site_id=$1 AND started_at >= $2 AND started_at < $3)
      SELECT bucket,count(*) AS sessions_total,count(*) FILTER(WHERE settled) AS closed_sessions,count(*) FILTER(WHERE settled AND page_views=1 AND interactions=0) AS bounced_sessions,coalesce(sum(active_ms) FILTER(WHERE settled),0) AS active_ms FROM facts GROUP BY bucket`;
    const params = [
      site.id,
      range.start,
      range.end,
      seconds,
      ...(pvMetric ? [] : [range.partial ? range.end : null]),
    ];
    for (const row of (await client.query(sql, params)).rows) raw.set(row.bucket.getTime(), row);
    if (grain === 'hour' && member) {
      const rows = (
        await client.query(
          `SELECT bucket_start,count(*) FILTER(WHERE kind=1) AS uv,count(*) FILTER(WHERE kind=2) AS ip,count(*) FILTER(WHERE kind=1 AND first_seen_pv_at>=bucket_start) AS new_visitors,count(*) FILTER(WHERE kind=1 AND first_seen_pv_at<bucket_start) AS returning_visitors FROM distinct_hours WHERE site_id=$1 AND bucket_start>=date_trunc('hour',$2::timestamptz) AND bucket_start<$3 GROUP BY bucket_start`,
          [site.id, range.start, range.end],
        )
      ).rows;
      for (const row of rows) members.set(row.bucket_start.getTime(), row);
    }
  }
  const points: {
    start: string;
    end: string;
    value: number | null;
    complete: boolean;
    reason?: string;
  }[] = [];
  let cursor = range.start;
  while (cursor < range.end) {
    const date = localParts(cursor, site.timezone).date;
    const aligned =
      grain === 'day'
        ? wallClock(date, site.timezone).at.getTime()
        : Math.floor(cursor.getTime() / (seconds * 1000)) * seconds * 1000;
    const next =
      grain === 'day'
        ? wallClock(addDays(date, 1), site.timezone).at
        : new Date(aligned + seconds * 1000);
    const end = new Date(Math.min(next.getTime(), range.end.getTime()));
    const complete = cursor.getTime() === aligned && end.getTime() === next.getTime();
    const stored = published.get(grain === 'day' ? date : aligned);
    let value: number | null = null;
    let reason: string | undefined;
    if (grain === 'day') {
      reason =
        unavailable(coverage, 'day_aggregates', cursor, end) ??
        (member ? epochReason(site, cursor, end) : undefined);
      if (complete && stored && !reason && !['new_visitors', 'returning_visitors'].includes(metric))
        value = scalar(stored, metric);
      else {
        const result = await readReport(
          client,
          site,
          { ...range, start: cursor, end, partial: false },
          coverage,
        );
        value = result.data[metric];
        reason = result.reasons[metric];
      }
    } else {
      const layer =
        complete && grain === 'hour'
          ? member
            ? 'hour_members'
            : stored
              ? 'hour_aggregates'
              : pvMetric
                ? 'raw_pv'
                : 'sessions'
          : pvMetric
            ? 'raw_pv'
            : 'sessions';
      reason =
        unavailable(coverage, layer, cursor, end) ??
        (member ? epochReason(site, cursor, end) : undefined);
      if (!reason) {
        const row =
          complete && grain === 'hour' && member
            ? members.get(aligned)
            : complete && grain === 'hour' && stored
              ? stored
              : raw.get(aligned);
        if (
          row &&
          (metric === 'new_visitors' || metric === 'returning_visitors') &&
          Number(row.missing) > 0
        )
          reason = 'identity_history_unavailable';
        else
          value = row
            ? scalar(row, metric)
            : ['bounce_rate', 'avg_active_ms'].includes(metric)
              ? null
              : 0;
      }
    }
    points.push({
      start: cursor.toISOString(),
      end: end.toISOString(),
      value,
      complete,
      ...(reason ? { reason } : {}),
    });
    cursor = end;
  }
  return {
    metric,
    granularity: grain,
    unit:
      metric === 'pv'
        ? 'page_view'
        : metric.endsWith('_ms')
          ? 'millisecond'
          : metric === 'bounce_rate'
            ? 'ratio'
            : 'count',
    points,
  };
}
