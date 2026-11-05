import type pg from 'pg';
import type { RealtimeSnapshot } from '@webpulse/shared';
import { ApiError } from '../../http/errors.js';
import { checkRecoveryGate } from '../../db/recovery-gate.js';

export async function readRealtime(
  client: pg.PoolClient,
  publicId: string,
): Promise<RealtimeSnapshot> {
  await checkRecoveryGate(client);
  const site = (
    await client.query(
      'SELECT id,enabled,maintenance_state FROM sites WHERE public_id=$1 FOR SHARE',
      [publicId],
    )
  ).rows[0];
  if (!site) throw new ApiError(404, 'site_not_found');
  if (!site.enabled || site.maintenance_state !== 'active')
    throw new ApiError(409, 'site_unavailable');
  const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const active = (
    await client.query(
      `SELECT latest_path AS path,count(*)::int AS visitors FROM visitors WHERE site_id=$1 AND last_activity_at>$2::timestamptz-interval '15 minutes' AND last_activity_at<=$2 GROUP BY latest_path ORDER BY visitors DESC,latest_path LIMIT 10`,
      [site.id, now],
    )
  ).rows;
  const total = (
    await client.query(
      `SELECT count(*)::int AS count FROM visitors WHERE site_id=$1 AND last_activity_at>$2::timestamptz-interval '15 minutes' AND last_activity_at<=$2`,
      [site.id, now],
    )
  ).rows[0].count as number;
  const pv = (
    await client.query(
      `SELECT count(*)::int AS count FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at>$2::timestamptz-interval '1 minute' AND occurred_at<=$2`,
      [site.id, now],
    )
  ).rows[0].count as number;
  const minutes = (
    await client.query<{ start: Date; pv: number }>(
      `SELECT m AS start,count(e.event_id)::int AS pv FROM generate_series(date_trunc('minute',$2::timestamptz)-interval '14 minutes',date_trunc('minute',$2::timestamptz),interval '1 minute') m
    LEFT JOIN events e ON e.site_id=$1 AND e.event_type='page_view' AND e.occurred_at>=m AND e.occurred_at<m+interval '1 minute' AND e.occurred_at<=$2 GROUP BY m ORDER BY m`,
      [site.id, now],
    )
  ).rows;
  const recent = (
    await client.query<{ path: string; at: Date; channel: string }>(
      `SELECT e.path,e.occurred_at AS at,s.source_channel AS channel FROM events e JOIN sessions s ON s.site_id=e.site_id AND s.id=e.session_id WHERE e.site_id=$1 AND e.event_type='page_view' AND e.occurred_at>$2::timestamptz-interval '15 minutes' AND e.occurred_at<=$2 ORDER BY e.occurred_at DESC,e.activity_seq DESC LIMIT 20`,
      [site.id, now],
    )
  ).rows;
  return {
    site_id: publicId,
    as_of: now.toISOString(),
    active_visitors_15m: total,
    pv_last_minute: pv,
    minutes: minutes.map((r) => ({ start: r.start.toISOString(), pv: r.pv })),
    active_pages: active,
    recent_pages: recent.map((r) => ({ ...r, at: r.at.toISOString() })),
  };
}
