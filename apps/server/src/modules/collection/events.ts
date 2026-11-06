import {
  cleanPath,
  sourceChannel,
  type CollectionEvent,
  type PageViewEvent,
} from '@webpulse/shared';
import { ApiError } from '../../http/errors.js';
import { rulesFor } from '../sites/store.js';
import { closeSession, pageSession, type Session } from '../sessions/store.js';
import { advanceActivity, type CollectionContext } from './context.js';
import { normalizedEvent } from './normalize.js';

type Normalized = ReturnType<typeof normalizedEvent>;
async function insertEvent(
  ctx: CollectionContext,
  event: CollectionEvent,
  normalized: Normalized,
  session: string,
  path: string,
  seq: string,
) {
  await ctx.client.query(
    `INSERT INTO events(site_id,event_id,session_id,visitor_key,ip_key,event_type,page_view_id,path,occurred_at,received_at,local_date,payload_fingerprint,rule_version,activity_seq,key_version,first_seen_pv_at,origin,interaction_kind,reason,client_ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,($9::timestamptz AT TIME ZONE $10)::date,$11,$12,$13,$14,
      (SELECT first_seen_pv_at FROM visitors WHERE site_id=$1 AND visitor_key=$4),$15,$16,$17,$18)`,
    [
      ctx.site.id,
      event.event_id,
      session,
      ctx.key,
      ctx.ipKey,
      event.type,
      event.page_view_id,
      path,
      ctx.now,
      ctx.site.timezone,
      normalized.fingerprint,
      ctx.site.rule_version,
      seq,
      ctx.site.key_version,
      event.type === 'page_view' ? event.page.origin : '',
      event.type === 'interaction' ? event.interaction_kind : null,
      event.type === 'page_view' ? event.reason : null,
      ctx.clientIp,
    ],
  );
}
async function pageView(ctx: CollectionContext, event: PageViewEvent, normalized: Normalized) {
  const { client, site, key, now } = ctx;
  await client.query(
    `INSERT INTO visitors(site_id,visitor_key,first_seen_pv_at,last_activity_at,latest_path,key_version)
    VALUES ($1,$2,$3,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [site.id, key, now, normalized.path, site.key_version],
  );
  let session = (
    await client.query<Session>(
      `SELECT *, $3::timestamptz<last_activity_at+interval '30 minutes' AND $3::timestamptz<started_at+interval '12 hours' AS valid
    FROM sessions WHERE site_id=$1 AND visitor_key=$2 AND status='open' FOR UPDATE`,
      [site.id, key, now],
    )
  ).rows[0];
  if (session && !session.valid) {
    await closeSession(ctx, session);
    session = undefined;
  }
  if (!session) {
    session = (
      await client.query<Session>(
        `INSERT INTO sessions(site_id,visitor_key,started_at,last_activity_at,entry_path,exit_path,source_channel,referrer_host,utm_source,utm_medium,utm_campaign,rule_version)
      VALUES ($1,$2,$3,$3,$4,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          site.id,
          key,
          now,
          normalized.path,
          sourceChannel(normalized.host, new URL(event.page.origin).hostname, normalized.utm),
          normalized.host === '!invalid' ? '' : normalized.host,
          ...normalized.utm,
          site.rule_version,
        ],
      )
    ).rows[0]!;
  } else {
    await client.query(
      'UPDATE sessions SET page_views=page_views+1,last_activity_at=$3,exit_path=$4 WHERE site_id=$1 AND id=$2',
      [site.id, session.id, now, normalized.path],
    );
  }
  const seq = await advanceActivity(ctx, event.page_view_id, normalized.path);
  await insertEvent(ctx, event, normalized, session.id, normalized.path, seq);
  await client.query(
    'INSERT INTO page_views(site_id,id,session_id,occurred_at,activity_seq) VALUES ($1,$2,$3,$4,$5)',
    [site.id, event.page_view_id, session.id, now, seq],
  );
  await client.query(
    `INSERT INTO visitor_days(site_id,local_date,visitor_key,first_seen_pv_at)
    SELECT $1,($3::timestamptz AT TIME ZONE $4)::date,$2,first_seen_pv_at FROM visitors WHERE site_id=$1 AND visitor_key=$2 ON CONFLICT DO NOTHING`,
    [site.id, key, now, site.timezone],
  );
  await client.query(
    `INSERT INTO ip_days VALUES ($1,($3::timestamptz AT TIME ZONE $4)::date,$2) ON CONFLICT DO NOTHING`,
    [site.id, ctx.ipKey, now, site.timezone],
  );
  await client.query(
    `INSERT INTO distinct_hours(site_id,bucket_start,kind,member_key,first_seen_pv_at)
    SELECT $1::bigint,date_trunc('hour',$3::timestamptz),1::smallint,$2::bytea,first_seen_pv_at FROM visitors WHERE site_id=$1 AND visitor_key=$2
    UNION ALL SELECT $1::bigint,date_trunc('hour',$3::timestamptz),2::smallint,$4::bytea,NULL::timestamptz ON CONFLICT DO NOTHING`,
    [site.id, key, now, ctx.ipKey],
  );
  ctx.dirty.add(now);
  ctx.dirty.add(session.started_at.toISOString());
}
export async function acceptEvents(ctx: CollectionContext, events: CollectionEvent[]) {
  for (const event of events) {
    const current = normalizedEvent(event, ctx.rules, ctx.key, ctx.site.key_version);
    if (event.type === 'page_view' && !current.path) continue;
    const existing = (
      await ctx.client.query<{
        payload_fingerprint: Buffer;
        rule_version: number;
        key_version: number;
        path: string;
      }>(
        'SELECT payload_fingerprint,rule_version,key_version,path FROM events WHERE site_id=$1 AND event_id=$2',
        [ctx.site.id, event.event_id],
      )
    ).rows[0];
    if (existing) {
      if (cleanPath(existing.path, ctx.rules) === null) continue;
      const storedRules = (
        await ctx.client.query('SELECT config FROM site_rules WHERE site_id=$1 AND version=$2', [
          ctx.site.id,
          existing.rule_version,
        ])
      ).rows[0];
      if (!storedRules) throw new ApiError(503, 'rule_history_unavailable');
      const normalized = normalizedEvent(
        event,
        rulesFor(storedRules.config),
        ctx.key,
        existing.key_version,
      );
      if (!existing.payload_fingerprint.equals(normalized.fingerprint))
        throw new ApiError(409, 'event_conflict');
      continue;
    }
    if (event.type === 'page_view') await pageView(ctx, event, current);
    else {
      const { page, session } = await pageSession(ctx, event.page_view_id);
      if (cleanPath(page.path, ctx.rules) === null || page.interacted) continue;
      const seq = await advanceActivity(ctx, page.id, page.path);
      await insertEvent(ctx, event, current, session.id, page.path, seq);
      await ctx.client.query(
        'UPDATE page_views SET interacted=true,activity_seq=$3 WHERE site_id=$1 AND id=$2',
        [ctx.site.id, page.id, seq],
      );
      await ctx.client.query(
        'UPDATE sessions SET interactions=interactions+1,last_activity_at=$3 WHERE site_id=$1 AND id=$2',
        [ctx.site.id, session.id, ctx.now],
      );
      // The closed-session denominator changes only when this session closes.
    }
  }
}
