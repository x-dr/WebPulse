import { createHash } from 'node:crypto';
import type pg from 'pg';

export async function replaceRankings(
  client: pg.PoolClient,
  site: string,
  date: string,
  start: Date,
  end: Date,
  revision: string,
) {
  await client.query('DELETE FROM stats_pages_daily WHERE site_id=$1 AND local_date=$2', [
    site,
    date,
  ]);
  await client.query(
    `INSERT INTO stats_pages_daily(site_id,local_date,path,pv,entry_sessions,exit_sessions,revision)
    SELECT $1,$2,path,sum(pv),sum(entry),sum(exit),$5 FROM (
      SELECT path,count(*) AS pv,0::bigint AS entry,0::bigint AS exit FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at >= $3 AND occurred_at < $4 GROUP BY path
      UNION ALL SELECT entry_path,0,count(*),0 FROM sessions WHERE site_id=$1 AND started_at >= $3 AND started_at < $4 GROUP BY entry_path
      UNION ALL SELECT exit_path,0,0,count(*) FROM sessions WHERE site_id=$1 AND status='closed' AND started_at >= $3 AND started_at < $4 GROUP BY exit_path
    ) p GROUP BY path`,
    [site, date, start, end, revision],
  );
  await client.query('DELETE FROM stats_sources_daily WHERE site_id=$1 AND local_date=$2', [
    site,
    date,
  ]);
  const sources = (
    await client.query(
      `SELECT source_channel AS channel,referrer_host,utm_source,utm_medium,utm_campaign,
    count(*) AS sessions_total,count(*) FILTER(WHERE status='closed') AS closed_sessions,
    count(*) FILTER(WHERE status='closed' AND page_views=1 AND interactions=0) AS bounced_sessions,
    coalesce(sum(active_ms) FILTER(WHERE status='closed'),0) AS active_ms
    FROM sessions WHERE site_id=$1 AND started_at >= $2 AND started_at < $3
    GROUP BY source_channel,referrer_host,utm_source,utm_medium,utm_campaign`,
      [site, start, end],
    )
  ).rows;
  // One bounded SQL statement even for high-cardinality source dimensions.
  const rows = sources.map((s) => ({
    ...s,
    key: createHash('sha256')
      .update(
        JSON.stringify([s.channel, s.referrer_host, s.utm_source, s.utm_medium, s.utm_campaign]),
      )
      .digest('hex'),
  }));
  await client.query(
    `INSERT INTO stats_sources_daily(site_id,local_date,source_key,channel,referrer_host,utm_source,utm_medium,utm_campaign,sessions_total,closed_sessions,bounced_sessions,active_ms,revision)
    SELECT $1,$2,decode(key,'hex'),channel,referrer_host,utm_source,utm_medium,utm_campaign,sessions_total,closed_sessions,bounced_sessions,active_ms,$4
    FROM jsonb_to_recordset($3::jsonb) AS r(key text,channel text,referrer_host text,utm_source text,utm_medium text,utm_campaign text,sessions_total bigint,closed_sessions bigint,bounced_sessions bigint,active_ms bigint)`,
    [site, date, JSON.stringify(rows), revision],
  );
}
