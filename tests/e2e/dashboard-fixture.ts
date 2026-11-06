import type { Page, Route } from '@playwright/test';
import { defaultRules } from '../../packages/shared/src/rules.js';

export const site = {
  site_id: 'site_dashboard_test',
  name: 'WebPulse 文档站',
  primary_origin: 'https://docs.example.com',
  allowed_origins: ['https://docs.example.com'],
  timezone: 'Asia/Shanghai',
  enabled: true,
  maintenance_state: 'active',
  rules: defaultRules,
  rule_version: 1,
  tracker_url: 'https://stats.example.com/tracker.js',
  raw_retention_days: 30,
  member_retention_days: 90,
  aggregate_retention_days: 365,
};
export const session = {
  username: 'admin',
  csrf_token: 'test-csrf-in-memory',
  expires_at: '2099-01-01T00:00:00Z',
};
export const meta = {
  timezone: 'Asia/Shanghai',
  as_of: '2026-11-05T10:00:00Z',
  effective_end_utc: '2026-11-05T10:00:00Z',
  is_provisional: true,
  aggregation_lag_seconds: 12,
  earliest_exact_distinct_date: '2026-10-01',
  unavailable_reasons: {},
  data_coverage: [{ layer: 'day_aggregates', finalized_through: '2026-11-04T16:00:00Z' }],
};
export const overview = {
  pv: 23456,
  uv: 2549,
  ip: 2738,
  sessions: 2332,
  closed_sessions: 2300,
  bounced_sessions: 150,
  total_closed_active_ms: 834900000,
  bounce_rate: 0.065,
  avg_active_ms: 7263000,
  new_visitors: 1233,
  returning_visitors: 1316,
  active_visitors_15m: 254,
  comparison: Object.fromEntries(
    ['pv', 'uv', 'ip', 'sessions', 'bounce_rate', 'avg_active_ms'].map((key) => [
      key,
      {
        previous: 100,
        relative_change: -0.249,
        ...(key === 'bounce_rate' ? { percentage_point_change: -5 } : {}),
      },
    ]),
  ),
};
export async function mockDashboard(
  page: Page,
  options: { authenticated?: boolean; empty?: boolean } = {},
) {
  const state = {
    authenticated: options.authenticated ?? true,
    failOverview: false,
    unavailable: false,
    malformed: false,
    expired: false,
    failDelete: false,
    requests: [] as {
      path: string;
      method: string;
      headers: Record<string, string>;
      body: unknown;
    }[],
    sites: options.empty
      ? []
      : [
          structuredClone(site),
          {
            ...structuredClone(site),
            site_id: 'site_second_test',
            name: '第二个站点',
            timezone: 'UTC',
          },
        ],
  };
  await page.route('**/api/v1/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.slice(7);
    const method = req.method();
    state.requests.push({
      path: url.pathname + url.search,
      method,
      headers: req.headers(),
      body: req.postData() ? req.postDataJSON() : null,
    });
    const send = (data: unknown, status = 200) => route.fulfill({ status, json: { data } });
    const fail = (code: string, status = 503) =>
      route.fulfill({ status, json: { error: { code } } });
    if (path === '/auth/login') {
      const body = req.postDataJSON() as { password: string };
      if (body.password === 'wrong') return fail('invalid_credentials', 401);
      state.authenticated = true;
      state.expired = false;
      return send(session);
    }
    if (path === '/auth/session')
      return state.authenticated ? send(session) : fail('auth_required', 401);
    if (state.expired || !state.authenticated) return fail('auth_required', 401);
    if (path === '/auth/logout') {
      state.authenticated = false;
      return route.fulfill({ status: 204 });
    }
    if (path === '/sites') {
      if (method === 'POST') {
        const created = {
          ...structuredClone(site),
          ...req.postDataJSON(),
          site_id: `site_created_${state.sites.length + 1}`,
        };
        state.sites.push(created);
        return send(created, 201);
      }
      return send(state.sites);
    }
    if (path.endsWith('/diagnostics'))
      return send({
        last_accepted_at: '2026-11-05T09:00:00Z',
        pending_buckets: 2,
        jobs: [],
        worker: null,
        rejection_counts: { available: false, reason: 'not_persisted' },
      });
    if (path.includes('retention-preview'))
      return send({
        settings: {
          raw_retention_days: Number(url.searchParams.get('raw_retention_days')),
          member_retention_days: 90,
          aggregate_retention_days: 365,
        },
        layers: [
          {
            layer: 'raw_pv',
            available_from: '2026-10-01T00:00:00Z',
            safe_target: '2026-10-20T00:00:00Z',
            capability_loss: 'partial_range_raw',
          },
        ],
      });
    if (path.endsWith('/retention')) return send({ layers: [] });
    if (path.startsWith('/sites/') && method === 'PATCH') {
      const s = state.sites.find((s) => path.includes(s.site_id))!;
      Object.assign(s, req.postDataJSON());
      return send(s);
    }
    if (path.startsWith('/sites/') && method === 'DELETE') {
      if (state.failDelete) return fail('request_failed');
      return send(
        { job_id: '11111111-1111-4111-8111-111111111111', status: 'queued', phase: 'journal' },
        202,
      );
    }
    if (path.startsWith('/jobs/'))
      return send({
        job_id: '11111111-1111-4111-8111-111111111111',
        status: 'queued',
        phase: 'journal',
      });
    if (path.startsWith('/stats/')) {
      const kind = path.split('/').at(-1);
      if (kind === 'overview' && state.failOverview) return fail('request_failed');
      if (kind === 'overview' && state.malformed)
        return route.fulfill({ json: { data: {}, meta } });
      const unavailable = state.unavailable
        ? {
            ...meta,
            unavailable_reasons: { uv: 'retention_cleanup', ranking: 'retention_cleanup' },
          }
        : meta;
      const data =
        kind === 'overview'
          ? {
              ...overview,
              ...(state.unavailable ? { uv: null } : {}),
              ...(url.searchParams.get('site_id') === 'site_second_test' ? { pv: 7 } : {}),
            }
          : kind === 'visitors'
            ? {
                uv: 2549,
                new_visitors: 1233,
                returning_visitors: 1316,
                new_share: 1233 / 2549,
                returning_share: 1316 / 2549,
              }
            : kind === 'trend'
              ? {
                  metric: url.searchParams.get('metric'),
                  granularity: url.searchParams.get('granularity'),
                  points: [500, 740, null, 350, 1800, 2200, 1500, 3000].map((value, i) => ({
                    start: new Date(Date.UTC(2026, 10, 5, i)).toISOString(),
                    end: new Date(Date.UTC(2026, 10, 5, i + 1)).toISOString(),
                    value,
                    complete: true,
                    ...(value === null ? { reason: 'aggregation_pending' } : {}),
                  })),
                }
              : {
                  unit:
                    kind === 'sources' || (url.searchParams.get('mode') ?? 'view') !== 'view'
                      ? 'session'
                      : 'page_view',
                  total: state.unavailable ? null : 4000,
                  page: Number(url.searchParams.get('page') ?? 1),
                  page_size: Number(url.searchParams.get('page_size') ?? 20),
                  total_items: 42,
                  other_count: 1000,
                  items: state.unavailable
                    ? []
                    : kind === 'sources'
                      ? ['direct', 'organic', 'referral', 'campaign', 'unknown'].map(
                          (channel, i) => ({
                            channel,
                            referrer_host: i > 1 ? 'github.com' : '',
                            utm_source: i === 3 ? 'newsletter' : '',
                            utm_medium: '',
                            utm_campaign: '',
                            count: 1000 - i * 100,
                            share: (1000 - i * 100) / 4000,
                          }),
                        )
                      : [
                          '/',
                          '/guide',
                          '/guide/installation',
                          '/docs/' + 'very-long-path/'.repeat(12),
                        ].map((path, i) => ({
                          path,
                          count: 1000 - i * 100,
                          share: (1000 - i * 100) / 4000,
                        })),
                };
      return route.fulfill({ json: { data, meta: unavailable } });
    }
    return fail('NOT_FOUND', 404);
  });
  return state;
}
