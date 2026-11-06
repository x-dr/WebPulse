import type pg from 'pg';
import type { Site } from '../sites/store.js';
import { safeCount } from '../aggregation/facts.js';
import { observedRange, unavailable, type Coverage } from './coverage.js';
import type { TimeRange } from './time.js';

export async function readVisits(
  client: pg.PoolClient,
  site: Site,
  range: TimeRange,
  coverage: Coverage,
  page: number,
  pageSize: number,
) {
  range = observedRange(coverage, range, site.timezone);
  const reason = unavailable(coverage, 'raw_pv', range.start, range.end);
  const data = {
    page,
    page_size: pageSize,
    total_items: null as number | null,
    items: [] as {
      event_id: string;
      path: string;
      at: string;
      channel: string;
      client_ip: string | null;
    }[],
  };
  if (reason) return { data, reason };
  const params = [site.id, range.start, range.end];
  const count = await client.query(
    `SELECT count(*) AS count FROM events WHERE site_id=$1 AND event_type='page_view' AND occurred_at >= $2 AND occurred_at < $3`,
    params,
  );
  const rows = await client.query<{
    event_id: string;
    path: string;
    at: Date;
    channel: string;
    client_ip: string | null;
  }>(
    `SELECT e.event_id,e.path,e.occurred_at AS at,s.source_channel AS channel,host(e.client_ip) AS client_ip
     FROM events e JOIN sessions s ON s.site_id=e.site_id AND s.id=e.session_id
     WHERE e.site_id=$1 AND e.event_type='page_view' AND e.occurred_at >= $2 AND e.occurred_at < $3
     ORDER BY e.occurred_at DESC,e.event_id DESC LIMIT $4 OFFSET $5`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  data.total_items = safeCount(count.rows[0].count);
  data.items = rows.rows.map((row) => ({ ...row, at: row.at.toISOString() }));
  return { data, reason: undefined };
}
