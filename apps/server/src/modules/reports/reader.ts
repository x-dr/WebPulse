import type pg from 'pg';
import {
  reportMetrics,
  closedSessionMetrics,
  type ReportValues,
  type UnavailableReasons,
} from '@webpulse/shared';
import type { Site } from '../sites/store.js';
import { safeCount, pvFacts, sessionFacts } from '../aggregation/facts.js';
import { daySlices, type TimeRange } from './time.js';
import { unavailable, epochReason, observedRange, type Coverage } from './coverage.js';

export async function readReport(
  client: pg.PoolClient,
  site: Site,
  range: TimeRange,
  coverage: Coverage,
) {
  range = observedRange(coverage, range, site.timezone);
  const data = Object.fromEntries(reportMetrics.map((m) => [m, 0])) as ReportValues;
  const reasons: UnavailableReasons = {};
  const slices = daySlices(range, site.timezone);
  const daily = (
    await client.query(
      `SELECT *,local_date::text AS date FROM stats_daily WHERE site_id=$1 AND local_date >= $2 AND local_date < $3 AND is_final AND metric_version=1 AND computed_at IS NOT NULL`,
      [site.id, range.startDate, range.endDate],
    )
  ).rows;
  const nullify = (keys: (keyof ReportValues)[], reason: string) => {
    for (const key of keys) {
      data[key] = null;
      reasons[key] ??= reason;
    }
  };
  const pvKeys = ['pv', 'uv', 'ip', 'new_visitors', 'returning_visitors'] as const;
  const sessionKeys = [
    'sessions',
    'closed_sessions',
    'bounced_sessions',
    'total_closed_active_ms',
    'bounce_rate',
    'avg_active_ms',
  ] as const;
  let provisional = false;
  for (const slice of slices) {
    const aggregateReason = unavailable(coverage, 'day_aggregates', slice.start, slice.end);
    const final =
      slice.full && !aggregateReason ? daily.find((d) => d.date === slice.date) : undefined;
    const rawReason = unavailable(coverage, 'raw_pv', slice.start, slice.end);
    provisional ||= !final;
    if (final && data.pv !== null) data.pv += safeCount(final.pv);
    else if (rawReason) nullify(['pv'], rawReason);
    else if (data.pv !== null)
      data.pv += (await pvFacts(client, site.id, slice.start, slice.end)).pv;
    if (!range.partial) {
      if (final) {
        for (const [metric, column] of [
          ['sessions', 'sessions_total'],
          ['closed_sessions', 'closed_sessions'],
          ['bounced_sessions', 'bounced_sessions'],
          ['total_closed_active_ms', 'active_ms'],
        ] as const)
          if (data[metric] !== null) data[metric] += safeCount(final[column]);
      } else {
        const reason = unavailable(coverage, 'sessions', slice.start, slice.end);
        if (reason) nullify([...sessionKeys], reason);
        else {
          const counts = await sessionFacts(client, site.id, slice.start, slice.end);
          for (const metric of [
            'sessions',
            'closed_sessions',
            'bounced_sessions',
            'total_closed_active_ms',
          ] as const)
            if (data[metric] !== null) data[metric] += counts[metric]!;
        }
      }
    }
  }
  if (range.partial) {
    const reason = unavailable(coverage, 'sessions', range.start, range.end);
    if (reason) nullify([...sessionKeys], reason);
    else
      Object.assign(data, await sessionFacts(client, site.id, range.start, range.end, range.end));
  }
  if (data.closed_sessions !== null)
    Object.assign(
      data,
      closedSessionMetrics({
        closed_sessions: data.closed_sessions,
        bounced_sessions: data.bounced_sessions!,
        active_ms: data.total_closed_active_ms!,
      }),
    );
  const full = slices.filter((s) => s.full);
  const partial = slices.filter((s) => !s.full);
  const distinctReason =
    slices
      .map((s) => unavailable(coverage, s.full ? 'day_members' : 'raw_pv', s.start, s.end))
      .find(Boolean) ?? epochReason(site, range.start, range.end);
  if (distinctReason) nullify(['uv', 'ip', 'new_visitors', 'returning_visitors'], distinctReason);
  else {
    const bounds = partial.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }));
    const row = (
      await client.query(
        `WITH people AS (
      SELECT visitor_key,first_seen_pv_at FROM visitor_days WHERE site_id=$1 AND local_date=ANY($2::date[])
      UNION ALL SELECT e.visitor_key,e.first_seen_pv_at FROM events e WHERE e.site_id=$1 AND e.event_type='page_view' AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS r(start timestamptz,"end" timestamptz) WHERE e.occurred_at>=r.start AND e.occurred_at<r."end")
    ), people_distinct AS (SELECT visitor_key,min(first_seen_pv_at) AS first_seen,bool_or(first_seen_pv_at IS NULL) AS missing FROM people GROUP BY visitor_key), ips AS (
      SELECT ip_key FROM ip_days WHERE site_id=$1 AND local_date=ANY($2::date[])
      UNION SELECT e.ip_key FROM events e WHERE e.site_id=$1 AND e.event_type='page_view' AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS r(start timestamptz,"end" timestamptz) WHERE e.occurred_at>=r.start AND e.occurred_at<r."end")
    ) SELECT count(*) AS uv,count(*) FILTER(WHERE first_seen >= $4) AS new_visitors,count(*) FILTER(WHERE first_seen < $4) AS returning_visitors,count(*) FILTER(WHERE missing) AS missing,(SELECT count(*) FROM ips) AS ip FROM people_distinct`,
        [site.id, full.map((s) => s.date), JSON.stringify(bounds), range.start],
      )
    ).rows[0];
    for (const metric of ['uv', 'ip', 'new_visitors', 'returning_visitors'] as const)
      data[metric] = safeCount(row[metric]);
    if (safeCount(row.missing))
      nullify(['new_visitors', 'returning_visitors'], 'identity_history_unavailable');
  }
  // Gaps and observation boundaries always take precedence over apparent zero traffic.
  for (const slice of slices) {
    const before = coverage.rows[0] && slice.start < coverage.rows[0].observed_from;
    if (before) {
      nullify([...pvKeys, ...sessionKeys], 'before_site_created');
      break;
    }
  }
  return { data, reasons, provisional };
}
