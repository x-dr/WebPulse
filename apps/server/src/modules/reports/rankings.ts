import type pg from 'pg';
import type { Site } from '../sites/store.js';
import { safeCount } from '../aggregation/facts.js';
import { daySlices, type TimeRange } from './time.js';
import { unavailable, observedRange, type Coverage } from './coverage.js';

export type RankingOptions = {
  mode: 'view' | 'entry' | 'exit';
  sources: boolean;
  channel?: string;
  referrer_host?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  search?: string;
  page: number;
  page_size: number;
  sort: 'count' | 'name';
  order: 'asc' | 'desc';
};
export async function readRankings(
  client: pg.PoolClient,
  site: Site,
  range: TimeRange,
  coverage: Coverage,
  options: RankingOptions,
) {
  range = observedRange(coverage, range, site.timezone);
  const session = options.sources || options.mode !== 'view';
  const slices = daySlices(range, site.timezone);
  const finalDates = (
    await client.query(
      'SELECT local_date::text AS date FROM stats_daily WHERE site_id=$1 AND local_date >= $2 AND local_date < $3 AND is_final AND metric_version=1 AND computed_at IS NOT NULL',
      [site.id, range.startDate, range.endDate],
    )
  ).rows.map((r) => r.date as string);
  const frozen = slices.filter(
    (s) =>
      s.full &&
      finalDates.includes(s.date) &&
      !(range.partial && session) &&
      !unavailable(coverage, 'day_aggregates', s.start, s.end),
  );
  const raw = slices.filter((s) => !frozen.includes(s));
  const reason =
    raw
      .map((s) => unavailable(coverage, session ? 'sessions' : 'raw_pv', s.start, s.end))
      .find(Boolean) ??
    slices
      .map((s) => (s.start < coverage.rows[0]!.observed_from ? 'before_site_created' : undefined))
      .find(Boolean);
  if (reason)
    return {
      data: {
        unit: session ? 'session' : 'page_view',
        total: null,
        items: [],
        page: options.page,
        page_size: options.page_size,
        total_items: null,
        other_count: null,
      },
      reason,
    };
  const params: unknown[] = [
    site.id,
    frozen.map((s) => s.date),
    JSON.stringify(raw.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }))),
    range.partial ? range.end : null,
  ];
  const within = `EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS r(start timestamptz,"end" timestamptz) WHERE t.${session ? 'started_at' : 'occurred_at'}>=r.start AND t.${session ? 'started_at' : 'occurred_at'}<r."end")`;
  let sql: string;
  if (options.sources) {
    const dims = 'channel,referrer_host,utm_source,utm_medium,utm_campaign';
    sql = `WITH combined AS (SELECT ${dims},sessions_total AS count FROM stats_sources_daily WHERE site_id=$1 AND local_date=ANY($2::date[]) UNION ALL SELECT source_channel,referrer_host,utm_source,utm_medium,utm_campaign,count(*) FROM sessions t WHERE site_id=$1 AND ${within} GROUP BY source_channel,referrer_host,utm_source,utm_medium,utm_campaign), grouped AS (SELECT ${dims},sum(count)::bigint AS count FROM combined GROUP BY ${dims}) SELECT * FROM grouped`;
  } else {
    const column =
      options.mode === 'view'
        ? 'pv'
        : options.mode === 'entry'
          ? 'entry_sessions'
          : 'exit_sessions';
    const path =
      options.mode === 'view' ? 'path' : options.mode === 'entry' ? 'entry_path' : 'exit_path';
    sql = `WITH combined AS (SELECT path,${column} AS count FROM stats_pages_daily WHERE site_id=$1 AND local_date=ANY($2::date[]) UNION ALL SELECT ${path},count(*) FROM ${session ? 'sessions' : 'events'} t WHERE site_id=$1 AND ${within} ${session ? (options.mode === 'exit' ? "AND status='closed' AND ($4::timestamptz IS NULL OR closed_at<=$4)" : '') : "AND event_type='page_view'"} GROUP BY ${path}) SELECT path,sum(count)::bigint AS count FROM combined GROUP BY path HAVING sum(count)>0`;
  }
  // Keep all parameter positions typed, including the unused cutoff in view/source queries.
  sql = `WITH ranked AS (${sql}) SELECT * FROM ranked WHERE ($4::timestamptz IS NULL OR true)`;
  const rows = (await client.query(sql, params)).rows.map((r) => ({
    ...r,
    count: safeCount(r.count),
  }));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const filtered = options.sources
    ? rows.filter((row) =>
        ['channel', 'referrer_host', 'utm_source', 'utm_medium', 'utm_campaign'].every(
          (key) =>
            options[key as keyof RankingOptions] === undefined ||
            row[key] === options[key as keyof RankingOptions],
        ),
      )
    : rows.filter((row) => !options.search || String(row.path).includes(options.search));
  const name = (r: Record<string, unknown>) =>
    String(
      r.path ??
        JSON.stringify([r.channel, r.referrer_host, r.utm_source, r.utm_medium, r.utm_campaign]),
    );
  filtered.sort(
    (a, b) =>
      (options.sort === 'count' ? a.count - b.count : name(a).localeCompare(name(b))) *
        (options.order === 'desc' ? -1 : 1) || name(a).localeCompare(name(b)),
  );
  const items = filtered
    .slice((options.page - 1) * options.page_size, options.page * options.page_size)
    .map((r) => ({
      ...r,
      ...(options.sources ? { sessions: r.count } : {}),
      share: total ? r.count / total : 0,
    }));
  return {
    data: {
      unit: session ? 'session' : 'page_view',
      total,
      items,
      page: options.page,
      page_size: options.page_size,
      total_items: filtered.length,
      other_count: total - items.reduce((sum, r) => sum + r.count, 0),
    },
    reason: undefined,
  };
}
