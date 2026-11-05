import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  ReportQuerySchema,
  reportMetrics,
  compareMetric,
  type ReportQuery,
  type ReportMetric,
} from '@webpulse/shared';
import { transaction } from '../../db/transaction.js';
import { requestBudget, FairGate } from '../../http/budget.js';
import { ApiError } from '../../http/errors.js';
import type { AuthService } from '../auth/routes.js';
import type { Site } from '../sites/store.js';
import { readCoverage, epochReason } from './coverage.js';
import { reportRanges, localParts, wallClock, addDays } from './time.js';
import { readReport } from './reader.js';
import { readRankings } from './rankings.js';
import { readTrend } from './trend.js';

type Query = ReportQuery & {
  granularity?: 'minute' | 'hour' | 'day';
  metric?: ReportMetric;
  mode?: 'view' | 'entry' | 'exit';
  page?: string;
  page_size?: string;
  sort?: 'count' | 'name';
  order?: 'asc' | 'desc';
  channel?: string;
  referrer_host?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  search?: string;
};
const enumString = (values: readonly string[]) => ({ type: 'string', enum: values });
const extra = {
  granularity: enumString(['minute', 'hour', 'day']),
  metric: enumString(reportMetrics),
  mode: enumString(['view', 'entry', 'exit']),
  page: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' },
  page_size: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' },
  sort: enumString(['count', 'name']),
  order: enumString(['asc', 'desc']),
  channel: enumString(['direct', 'organic', 'referral', 'campaign', 'unknown']),
  referrer_host: { type: 'string', maxLength: 253 },
  utm_source: { type: 'string', maxLength: 64 },
  utm_medium: { type: 'string', maxLength: 64 },
  utm_campaign: { type: 'string', maxLength: 64 },
  search: { type: 'string', maxLength: 128 },
};
export function registerReports(app: FastifyInstance, pool: pg.Pool, auth: AuthService) {
  const gate = new FairGate(2, 1, 16, 8);
  for (const kind of ['overview', 'visitors', 'trend', 'sources', 'pages', 'entries'] as const) {
    const keys =
      kind === 'trend'
        ? ['granularity', 'metric']
        : ['sources', 'pages', 'entries'].includes(kind)
          ? [
              'page',
              'page_size',
              'sort',
              'order',
              ...(kind === 'sources'
                ? ['channel', 'referrer_host', 'utm_source', 'utm_medium', 'utm_campaign']
                : kind === 'pages'
                  ? ['mode', 'search']
                  : ['search']),
            ]
          : [];
    const querystring = {
      ...ReportQuerySchema,
      properties: {
        ...ReportQuerySchema.properties,
        ...Object.fromEntries(keys.map((k) => [k, extra[k as keyof typeof extra]])),
      },
    };
    app.get<{ Querystring: Query }>(
      `/api/v1/stats/${kind}`,
      { schema: { querystring } },
      async (request, reply) => {
        reply.header('cache-control', 'private, no-store');
        await auth.managed(request, (client) => auth.authenticate(client, request, false));
        const release = await gate.acquire(request.query.site_id, requestBudget(request).signal);
        try {
          return await transaction(
            pool,
            requestBudget(request),
            async (client) => {
              const site = (
                await client.query<Site>('SELECT * FROM sites WHERE public_id=$1', [
                  request.query.site_id,
                ])
              ).rows[0];
              if (!site) throw new ApiError(404, 'site_not_found');
              if (site.maintenance_state !== 'active') throw new ApiError(409, 'site_maintenance');
              if (request.query.timezone && request.query.timezone !== site.timezone)
                throw new ApiError(400, 'timezone_mismatch');
              const asOf = (await client.query('SELECT clock_timestamp() AS now')).rows[0]
                .now as Date;
              const ranges = reportRanges(
                request.query.start_date,
                request.query.end_date,
                site.timezone,
                asOf,
              );
              const coverage = await readCoverage(client, site);
              const earliest = coverage.rows.find(
                (row) => row.layer === 'day_members',
              )?.available_from;
              const earliestDate = earliest ? localParts(earliest, site.timezone).date : undefined;
              const meta = {
                site_id: site.public_id,
                timezone: site.timezone,
                metric_version: 1,
                as_of: asOf.toISOString(),
                start_utc: ranges.current.start.toISOString(),
                requested_end_utc: ranges.current.requestedEnd.toISOString(),
                effective_end_utc: ranges.current.end.toISOString(),
                is_provisional: ranges.current.partial,
                session_basis: 'started_in_range_closed_only_for_rates',
                duration_method: 'foreground_interval_union_estimate',
                coverage_revision: coverage.rows.map((r) => `${r.layer}:${r.revision}`).join(','),
                earliest_exact_distinct_date:
                  earliest && earliestDate
                    ? earliest.getTime() === wallClock(earliestDate, site.timezone).at.getTime()
                      ? earliestDate
                      : addDays(earliestDate, 1)
                    : null,
                data_coverage: coverage.rows.map((row) => ({
                  layer: row.layer,
                  observed_from: row.observed_from.toISOString(),
                  available_from: row.available_from.toISOString(),
                  available_through: row.layer.endsWith('aggregates')
                    ? row.available_through.toISOString()
                    : asOf.toISOString(),
                  finalized_through: row.finalized_through?.toISOString() ?? null,
                  revision: row.revision,
                })),
                comparison: ranges.comparison,
              };
              if (kind === 'trend')
                return {
                  data: await readTrend(
                    client,
                    site,
                    ranges.current,
                    coverage,
                    request.query.granularity ?? 'day',
                    request.query.metric ?? 'pv',
                  ),
                  meta,
                };
              if (['sources', 'pages', 'entries'].includes(kind)) {
                const result = await readRankings(client, site, ranges.current, coverage, {
                  ...request.query,
                  mode: kind === 'entries' ? 'entry' : (request.query.mode ?? 'view'),
                  sources: kind === 'sources',
                  page: Number(request.query.page ?? 1),
                  page_size: Number(request.query.page_size ?? 20),
                  sort: request.query.sort ?? 'count',
                  order: request.query.order ?? 'desc',
                });
                return {
                  data: result.data,
                  meta: {
                    ...meta,
                    coverage: { ranking: result.reason ? 'unavailable' : 'exact' },
                    unavailable_reasons: result.reason ? { ranking: result.reason } : {},
                  },
                };
              }
              const current = await readReport(client, site, ranges.current, coverage);
              if (kind === 'visitors')
                return {
                  data: {
                    uv: current.data.uv,
                    new_visitors: current.data.new_visitors,
                    returning_visitors: current.data.returning_visitors,
                    new_share:
                      current.data.uv && current.data.new_visitors !== null
                        ? current.data.new_visitors / current.data.uv
                        : null,
                    returning_share:
                      current.data.uv && current.data.returning_visitors !== null
                        ? current.data.returning_visitors / current.data.uv
                        : null,
                  },
                  meta: {
                    ...meta,
                    is_provisional: current.provisional,
                    coverage: Object.fromEntries(
                      ['uv', 'new_visitors', 'returning_visitors'].map((m) => [
                        m,
                        current.reasons[m as ReportMetric] ? 'unavailable' : 'exact',
                      ]),
                    ),
                    unavailable_reasons: current.reasons,
                  },
                };
              const previous = await readReport(client, site, ranges.previous, coverage);
              const acrossEpoch = epochReason(site, ranges.previous.start, ranges.current.end);
              const comparison = Object.fromEntries(
                reportMetrics.map((metric) => [
                  metric,
                  compareMetric(
                    current.data[metric],
                    previous.data[metric],
                    current.reasons[metric] ??
                      previous.reasons[metric] ??
                      (['uv', 'ip', 'new_visitors', 'returning_visitors'].includes(metric)
                        ? acrossEpoch
                        : undefined),
                    metric === 'bounce_rate',
                  ),
                ]),
              );
              const active = (
                await client.query(
                  "SELECT count(*) AS count FROM visitors WHERE site_id=$1 AND last_activity_at>$2::timestamptz-interval '15 minutes' AND last_activity_at<=$2",
                  [site.id, asOf],
                )
              ).rows[0];
              const lag = (
                await client.query(
                  'SELECT extract(epoch FROM ($2::timestamptz-min(updated_at))) AS lag FROM dirty_buckets WHERE site_id=$1',
                  [site.id, asOf],
                )
              ).rows[0];
              return {
                data: { ...current.data, active_visitors_15m: Number(active.count), comparison },
                meta: {
                  ...meta,
                  is_provisional: current.provisional,
                  aggregation_lag_seconds: lag.lag === null ? 0 : Number(lag.lag),
                  coverage: Object.fromEntries(
                    reportMetrics.map((m) => [
                      m,
                      current.reasons[m]
                        ? 'unavailable'
                        : m.includes('active_ms')
                          ? 'estimated'
                          : 'exact',
                    ]),
                  ),
                  unavailable_reasons: current.reasons,
                },
              };
            },
            { snapshot: true, readOnly: true },
          );
        } finally {
          release();
        }
      },
    );
  }
}
