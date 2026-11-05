import { cleanPath, type HeartbeatBody } from '@webpulse/shared';
import { pageSession } from '../sessions/store.js';
import { advanceActivity, type CollectionContext } from './context.js';

export async function acceptHeartbeat(ctx: CollectionContext, body: HeartbeatBody) {
  const { page, session } = await pageSession(ctx, body.page_view_id);
  if (
    cleanPath(page.path, ctx.rules) === null ||
    body.total_visible_ms <= Number(page.total_visible_ms)
  )
    return;
  const seq = await advanceActivity(ctx, page.id, page.path);
  const delta = Math.min(15000, body.total_visible_ms - Number(page.total_visible_ms));
  await ctx.client.query(
    `UPDATE page_views SET total_visible_ms=$3,last_heartbeat_at=$4,activity_seq=$5 WHERE site_id=$1 AND id=$2`,
    [ctx.site.id, page.id, body.total_visible_ms, ctx.now, seq],
  );
  await ctx.client.query(
    `WITH candidate AS (
      SELECT active_ranges + tstzmultirange(tstzrange(GREATEST($3::timestamptz - $4::double precision * interval '1 millisecond',$5::timestamptz,started_at),$3::timestamptz,'[)')) AS ranges
      FROM sessions WHERE site_id=$1 AND id=$2
    ), measured AS (
      SELECT ranges,(SELECT count(*) FROM unnest(ranges)) AS segments,
        COALESCE((SELECT sum(extract(epoch FROM upper(r)-lower(r))*1000) FROM unnest(ranges) r),0)::bigint AS ms FROM candidate
    ) UPDATE sessions s SET last_activity_at=$3,
      active_ranges=CASE WHEN NOT duration_truncated AND m.segments<=512 THEN m.ranges ELSE active_ranges END,
      active_ms=CASE WHEN NOT duration_truncated AND m.segments<=512 THEN LEAST(m.ms,43200000) ELSE active_ms END,
      duration_truncated=duration_truncated OR m.segments>512
    FROM measured m WHERE site_id=$1 AND id=$2`,
    [ctx.site.id, session.id, ctx.now, delta, page.occurred_at],
  );
  // Open-session duration is excluded from published totals. Closing the session
  // marks its start bucket, so heartbeats need no hot-bucket write.
}
