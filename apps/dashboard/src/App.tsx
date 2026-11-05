import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, useIsFetching } from '@tanstack/react-query';
import { Alert, Button, Select } from 'antd';
import { ApiError, request } from './api/client';
import type { Session, Site } from './api/types';
import { addDays, today, useNavigation, validRange, type Scope } from './navigation';
import { Failure, Loading } from './components/Feedback';
import { Login } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { VisitorsPage } from './pages/Visitors';
import { RankingsPage } from './pages/Rankings';
import { SiteSettingsPage, SitesPage } from './pages/sites/Sites';
import { JobPage } from './pages/sites/SiteActions';
import { RealtimePage } from './pages/Realtime';

const nav = [
  ['/overview', '总览'],
  ['/realtime', '实时'],
  ['/sources', '来源'],
  ['/pages', '页面'],
  ['/visitors', '访客'],
  ['/sites', '站点设置'],
] as const;

function DateFilter({
  scope,
  apply,
}: {
  scope: Scope;
  apply: (start: string, end: string) => void;
}) {
  const [start, setStart] = useState(scope.start);
  const [end, setEnd] = useState(addDays(scope.end, -1));
  const [invalid, setInvalid] = useState(false);
  const current = today(scope.site.timezone);
  return (
    <div className="date-filter">
      <div className="date-presets" role="group" aria-label="快捷日期">
        {[
          { label: '今日', start: current, end: addDays(current, 1) },
          { label: '昨日', start: addDays(current, -1), end: current },
          { label: '近 7 日', start: addDays(current, -6), end: addDays(current, 1) },
          { label: '近 30 日', start: addDays(current, -29), end: addDays(current, 1) },
        ].map((p) => (
          <Button
            key={p.label}
            type={scope.start === p.start && scope.end === p.end ? 'primary' : 'default'}
            aria-pressed={scope.start === p.start && scope.end === p.end}
            onClick={() => apply(p.start, p.end)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <form
        className="date-form"
        onSubmit={(e) => {
          e.preventDefault();
          const exclusiveEnd = end ? addDays(end, 1) : '';
          if (validRange(start, exclusiveEnd, scope.site.timezone)) {
            setInvalid(false);
            apply(start, exclusiveEnd);
          } else setInvalid(true);
        }}
      >
        <label className="sr-only" htmlFor="start-date">
          开始日期
        </label>
        <input
          id="start-date"
          type="date"
          required
          max={current}
          value={start}
          onChange={(e) => setStart(e.target.value)}
          aria-describedby="date-help"
        />
        <span aria-hidden="true">—</span>
        <label className="sr-only" htmlFor="end-date">
          结束日期（含）
        </label>
        <input
          id="end-date"
          type="date"
          required
          max={current}
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          aria-describedby="date-help"
        />
        <Button htmlType="submit">应用日期</Button>
      </form>
      <p
        id="date-help"
        className={invalid ? 'field-help error-text' : 'field-help'}
        role={invalid ? 'alert' : undefined}
      >
        {invalid
          ? '日期范围无效，最多 365 个自然日，不能包含未来日期。'
          : `按 ${scope.site.timezone} 自然日；界面结束日期包含当天。`}
      </p>
    </div>
  );
}

export function App() {
  const client = useQueryClient();
  const { url, navigate } = useNavigation();
  const [expired, setExpired] = useState(false);
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: async ({ signal }) => {
      const result = await request<{ data: Session }>('/auth/session', { signal });
      if (typeof result.data?.username !== 'string' || typeof result.data.csrf_token !== 'string')
        throw new ApiError(502, 'invalid_response');
      return result.data;
    },
    staleTime: 60_000,
  });
  const session = sessionQuery.data;
  const sitesQuery = useQuery({
    queryKey: ['sites'],
    enabled: Boolean(session),
    queryFn: async ({ signal }) => {
      const result = await request<{ data: Site[] }>('/sites', { signal });
      if (
        !Array.isArray(result.data) ||
        result.data.some(
          (s) =>
            typeof s.site_id !== 'string' ||
            typeof s.timezone !== 'string' ||
            typeof s.name !== 'string',
        )
      )
        throw new ApiError(502, 'invalid_response');
      return result.data;
    },
  });
  const reportFetching = useIsFetching({ queryKey: ['report'] });
  const logout = useMutation({
    mutationFn: () => request('/auth/logout', { method: 'POST', csrf: session!.csrf_token }),
    onSuccess: async () => {
      await client.cancelQueries();
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      client.setQueryData(['session'], null);
      setExpired(false);
    },
  });
  useEffect(() => {
    const unauthorized = () => {
      setExpired((previous) => previous || Boolean(client.getQueryData(['session'])));
      void client.cancelQueries();
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      client.setQueryData(['session'], null);
    };
    window.addEventListener('webpulse:unauthorized', unauthorized);
    return () => window.removeEventListener('webpulse:unauthorized', unauthorized);
  }, [client]);
  const sites = sitesQuery.data ?? [];
  const settingsId = /^\/sites\/([^/]+)\/settings$/.exec(url.pathname)?.[1];
  const requestedId = settingsId ?? url.searchParams.get('site_id');
  const site = sites.find((s) => s.site_id === requestedId) ?? (!settingsId ? sites[0] : undefined);
  const startParam = url.searchParams.get('start_date') ?? '';
  const endParam = url.searchParams.get('end_date') ?? '';
  const valid = site && validRange(startParam, endParam, site.timezone);
  const scope = site
    ? {
        site,
        start: valid ? startParam : today(site.timezone),
        end: valid ? endParam : addDays(today(site.timezone), 1),
      }
    : undefined;
  const reportKey = scope ? `${scope.site.site_id}:${scope.start}:${scope.end}` : '';
  const path = url.pathname === '/' ? '/overview' : url.pathname;
  const isReport = ['/overview', '/sources', '/pages', '/visitors'].includes(path);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['report'] });
  };
  useEffect(() => {
    const title = path.startsWith('/jobs/')
      ? '删除任务'
      : (nav.find(([p]) => path.startsWith(p))?.[1] ?? '工作台');
    document.title = `${title} · WebPulse 网站脉搏`;
    document.querySelector<HTMLElement>('#main')?.focus();
  }, [path]);
  if (sessionQuery.isPending) return <Loading />;
  if (!session) {
    if (
      sessionQuery.isError &&
      !(sessionQuery.error instanceof ApiError && sessionQuery.error.status === 401)
    )
      return (
        <div className="workspace">
          <Failure error={sessionQuery.error} retry={() => void sessionQuery.refetch()} />
        </div>
      );
    return (
      <>
        <a className="skip-link" href="#main">
          跳转到主要内容
        </a>
        <Login
          expired={expired}
          onLogin={(data) => {
            client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
            client.setQueryData(['session'], data);
            setExpired(false);
          }}
        />
      </>
    );
  }
  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        跳转到主要内容
      </a>
      <header className="header">
        <a
          className="brand"
          href="/overview"
          onClick={(e) => {
            e.preventDefault();
            navigate('/overview');
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            W<span>·</span>
          </span>
          <span>
            WebPulse <span className="brand-subtitle">网站脉搏</span>
          </span>
        </a>
        <div className="account">
          <span className="muted">{session.username}</span>
          <Button onClick={() => logout.mutate()} loading={logout.isPending}>
            退出登录
          </Button>
        </div>
      </header>
      <nav className="navigation" aria-label="主要导航">
        {nav.map(([href, label]) => {
          const target = href === '/sites' && site ? `/sites/${site.site_id}/settings` : href;
          return (
            <a
              key={href}
              href={target + url.search}
              aria-current={path.startsWith(href) ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(target);
              }}
            >
              {label}
            </a>
          );
        })}
        <span className="nav-note">自托管网站统计</span>
      </nav>
      {logout.isError && <Failure error={logout.error} />}
      <div className="global-filters">
        <div className="site-selector">
          <label htmlFor="site-selector">当前站点</label>
          <Select
            id="site-selector"
            aria-label="当前站点"
            value={site?.site_id}
            placeholder="选择站点"
            loading={sitesQuery.isPending}
            options={sites.map((s) => ({ value: s.site_id, label: s.name }))}
            onChange={(id) => {
              void client.cancelQueries({ queryKey: ['report'] });
              navigate(settingsId ? `/sites/${id}/settings` : path, { site_id: id! });
            }}
          />
          <span className="muted small">{site?.timezone ?? '尚无站点'}</span>
        </div>
        {isReport && scope && (
          <DateFilter
            key={reportKey}
            scope={scope}
            apply={(start, end) =>
              navigate(path, { site_id: site!.site_id, start_date: start, end_date: end })
            }
          />
        )}
      </div>
      <main id="main" tabIndex={-1}>
        {sitesQuery.isError ? (
          <Failure error={sitesQuery.error} retry={() => void sitesQuery.refetch()} />
        ) : sitesQuery.isPending ? (
          <Loading />
        ) : (
          <>
            {isReport && reportFetching > 0 && (
              <div className="refresh-status" role="status">
                更新中…
              </div>
            )}
            {isReport && scope && startParam && !valid && (
              <Alert type="warning" title="链接中的日期范围无效，已显示站点今日数据。" />
            )}
            {path.startsWith('/jobs/') ? (
              <JobPage key={path} id={path.slice(6)} />
            ) : path === '/sites' || (!site && !settingsId) ? (
              <SitesPage session={session} sites={sites} navigate={navigate} />
            ) : settingsId && site ? (
              <SiteSettingsPage
                key={site.site_id}
                site={site}
                session={session}
                navigate={navigate}
              />
            ) : path === '/realtime' && site ? (
              <RealtimePage key={site.site_id} site={site} />
            ) : isReport && scope ? (
              <div key={reportKey}>
                {path === '/overview' ? (
                  <OverviewPage scope={scope} navigate={navigate} />
                ) : path === '/visitors' ? (
                  <VisitorsPage scope={scope} />
                ) : (
                  <RankingsPage
                    key={`${reportKey}:${path}`}
                    scope={scope}
                    url={url}
                    navigate={navigate}
                    sources={path === '/sources'}
                  />
                )}
              </div>
            ) : (
              <section className="panel settings-section">
                <h1>页面不存在</h1>
                <Button onClick={() => navigate('/sites')}>返回站点管理</Button>
              </section>
            )}
          </>
        )}
      </main>
      <footer>
        <a
          href="/sites"
          onClick={(e) => {
            e.preventDefault();
            navigate('/sites');
          }}
        >
          管理站点
        </a>
        <span>WebPulse · 数据自持，指标透明。</span>
        {isReport && (
          <Button onClick={refresh} loading={reportFetching > 0}>
            刷新数据
          </Button>
        )}
      </footer>
    </div>
  );
}
