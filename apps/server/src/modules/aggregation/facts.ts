import type pg from 'pg';
import { closedSessionMetrics, type ReportValues } from '@webpulse/shared';

export function safeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Unsafe report count');
  return count;
}
export async function pvFacts(client: pg.PoolClient, site: string, start: Date, end: Date) {
  const row = (
    await client.query(
      `SELECT count(*) AS pv,count(DISTINCT visitor_key) AS uv,count(DISTINCT ip_key) AS ip,
    count(DISTINCT visitor_key) FILTER(WHERE first_seen_pv_at >= $2) AS new_visitors,
    count(DISTINCT visitor_key) FILTER(WHERE first_seen_pv_at < $2) AS returning_visitors,
    count(*) FILTER(WHERE first_seen_pv_at IS NULL) AS missing_identity
    FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at >= $2 AND occurred_at < $3`,
      [site, start, end],
    )
  ).rows[0];
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, safeCount(v)])) as Record<
    'pv' | 'uv' | 'ip' | 'new_visitors' | 'returning_visitors' | 'missing_identity',
    number
  >;
}
export async function sessionFacts(
  client: pg.PoolClient,
  site: string,
  start: Date,
  end: Date,
  cutoff: Date | null = null,
) {
  const row = (
    await client.query(
      `WITH s AS (
    SELECT *,status='closed' AND ($4::timestamptz IS NULL OR closed_at <= $4) AS settled
    FROM sessions WHERE site_id=$1 AND started_at >= $2 AND started_at < $3)
    SELECT count(*) AS sessions,count(*) FILTER(WHERE settled) AS closed_sessions,
    count(*) FILTER(WHERE settled AND page_views=1 AND interactions=0) AS bounced_sessions,
    coalesce(sum(active_ms) FILTER(WHERE settled),0) AS total_closed_active_ms FROM s`,
      [site, start, end, cutoff],
    )
  ).rows[0];
  const counts = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, safeCount(v)])) as Pick<
    ReportValues,
    'sessions' | 'closed_sessions' | 'bounced_sessions' | 'total_closed_active_ms'
  >;
  return {
    ...counts,
    ...closedSessionMetrics({
      closed_sessions: counts.closed_sessions!,
      bounced_sessions: counts.bounced_sessions!,
      active_ms: counts.total_closed_active_ms!,
    }),
  };
}
