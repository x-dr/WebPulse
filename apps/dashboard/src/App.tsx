import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, useIsFetching } from '@tanstack/react-query';
import { Alert, Button } from 'antd';
import { ApiError, request } from './api/client';
import type { Session, Site } from './api/types';
import { addDays, today, useNavigation, validRange } from './navigation';
import { Failure, Loading } from './components/Feedback';
import { Login } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { VisitorsPage } from './pages/Visitors';
import { RankingsPage } from './pages/Rankings';
import { SiteSettingsPage, SitesPage } from './pages/sites/Sites';
import { JobPage } from './pages/sites/SiteActions';
import { RealtimePage } from './pages/Realtime';
import { DateFilter } from './components/DateFilter';
import { WorkspaceLayout, workspaceTitle } from './components/WorkspaceLayout';

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
    const title = workspaceTitle(path);
    document.title = `${title} · WebPulse 网站脉搏`;
    document.querySelector<HTMLElement>('#main')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [path]);
  if (sessionQuery.isPending) return <Loading />;
  if (!session) {
    if (
      sessionQuery.isError &&
      !(sessionQuery.error instanceof ApiError && sessionQuery.error.status === 401)
    )
      return (
        <div className="standalone-error">
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
  const toolbar =
    isReport && scope ? (
      <DateFilter
        key={reportKey}
        scope={scope}
        apply={(start, end) =>
          navigate(path, { site_id: scope.site.site_id, start_date: start, end_date: end })
        }
        refresh={refresh}
        fetching={reportFetching > 0}
      />
    ) : undefined;
  return (
    <WorkspaceLayout
      session={session}
      site={site}
      sites={sites}
      sitesPending={sitesQuery.isPending}
      path={path}
      url={url}
      navigate={navigate}
      selectSite={(id) => {
        void client.cancelQueries({ queryKey: ['report'] });
        navigate(settingsId ? `/sites/${id}/settings` : path, { site_id: id });
      }}
      onLogout={() => logout.mutate()}
      loggingOut={logout.isPending}
    >
      {logout.isError && <Failure error={logout.error} />}

      {sitesQuery.isError ? (
        <Failure error={sitesQuery.error} retry={() => void sitesQuery.refetch()} />
      ) : sitesQuery.isPending ? (
        <Loading />
      ) : (
        <>
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
                <OverviewPage scope={scope} navigate={navigate} toolbar={toolbar} />
              ) : path === '/visitors' ? (
                <VisitorsPage scope={scope} toolbar={toolbar} />
              ) : (
                <RankingsPage
                  key={`${reportKey}:${path}`}
                  scope={scope}
                  url={url}
                  navigate={navigate}
                  sources={path === '/sources'}
                  toolbar={toolbar}
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
    </WorkspaceLayout>
  );
}
