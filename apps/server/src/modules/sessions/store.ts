import type { CollectionContext } from '../collection/context.js';
import { ApiError } from '../../http/errors.js';

export type Session = {
  id: string;
  started_at: Date;
  last_activity_at: Date;
  status: string;
  valid: boolean;
};
export async function pageSession(ctx: CollectionContext, pageId: string) {
  const page = (
    await ctx.client.query<{
      id: string;
      session_id: string;
      path: string;
      interacted: boolean;
      total_visible_ms: string;
      occurred_at: Date;
    }>(
      `SELECT p.*,e.path FROM page_views p JOIN events e ON e.site_id=p.site_id AND e.event_id=p.id
     WHERE p.site_id=$1 AND p.id=$2 AND e.visitor_key=$3`,
      [ctx.site.id, pageId, ctx.key],
    )
  ).rows[0];
  if (!page) throw new ApiError(409, 'page_view_missing');
  const session = (
    await ctx.client.query<Session>(
      `SELECT *,status='open' AND $3::timestamptz<last_activity_at+interval '30 minutes' AND $3::timestamptz<started_at+interval '12 hours' AS valid
    FROM sessions WHERE site_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.site.id, page.session_id, ctx.now],
    )
  ).rows[0]!;
  if (!session.valid) throw new ApiError(409, 'session_expired');
  return { page, session };
}
export async function closeSession(ctx: CollectionContext, session: Session) {
  await ctx.client.query(
    `UPDATE sessions SET status='closed',ended_at=last_activity_at,closed_at=$3,
    close_reason=CASE WHEN $3::timestamptz>=started_at+interval '12 hours' THEN 'max_duration' ELSE 'timeout' END
    WHERE site_id=$1 AND id=$2 AND status='open'`,
    [ctx.site.id, session.id, ctx.now],
  );
  ctx.dirty.add(session.started_at.toISOString());
}
