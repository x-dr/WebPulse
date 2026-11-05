import { lazy, Suspense, useState } from 'react';
import { Button, Select } from 'antd';
import { useReport } from '../api/reports';
import type { Overview as OverviewData, Ranking, Trend, Visitors } from '../api/types';
import type { Navigate, Scope } from '../navigation';
import { Empty, Failure, Loading, reasonText } from '../components/Feedback';
import { MetricCards, ReportStatus, VisitorCards, trendMetrics } from '../components/ReportCards';
const TrendChart = lazy(() =>
  import('../components/TrendChart').then((module) => ({ default: module.TrendChart })),
);
import { RankingTable } from '../components/RankingTable';

export function TrendPanel({
  scope,
  visitorOnly = false,
}: {
  scope: Scope;
  visitorOnly?: boolean;
}) {
  const [metric, setMetric] = useState(visitorOnly ? 'uv' : 'pv');
  const [grain, setGrain] = useState(
    (Date.parse(scope.end) - Date.parse(scope.start)) / 86400000 <= 7 ? 'hour' : 'day',
  );
  const query = useReport<Trend>('trend', scope, { metric, granularity: grain });
  const days = (Date.parse(scope.end) - Date.parse(scope.start)) / 86400000;
  return (
    <section className="panel trend-panel" aria-labelledby="trend-title">
      <div className="panel-heading trend-heading">
        <div>
          <h2 id="trend-title">{visitorOnly ? '访客趋势' : '趋势分析'}</h2>
          <p>按时间观察变化，缺失数据保留断点。</p>
        </div>
        <div className="trend-controls">
          {!visitorOnly && (
            <Select
              aria-label="趋势指标"
              value={metric}
              options={trendMetrics}
              onChange={setMetric}
            />
          )}
          <Select
            aria-label="趋势粒度"
            value={grain}
            onChange={setGrain}
            options={[
              { value: 'minute', label: '按分钟', disabled: days > 1 },
              { value: 'hour', label: '按小时', disabled: days > 7 },
              { value: 'day', label: '按日' },
            ]}
          />
        </div>
      </div>
      {query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <Suspense fallback={<Loading />}>
          <TrendChart data={query.data.data} timezone={scope.site.timezone} />
        </Suspense>
      ) : (
        <Loading />
      )}
    </section>
  );
}
function TopRanking({
  scope,
  kind,
  title,
  description,
  navigate,
  mode,
}: {
  scope: Scope;
  kind: string;
  title: string;
  description: string;
  navigate: Navigate;
  mode?: string;
}) {
  const query = useReport<Ranking>(kind, scope, { page_size: '8', ...(mode ? { mode } : {}) });
  return (
    <section className="panel">
      <div className="panel-heading ranking-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <Button
          type="link"
          onClick={() =>
            navigate(kind === 'sources' ? '/sources' : `/pages?mode=${mode ?? 'view'}`)
          }
        >
          详情 →<span className="sr-only">{title}</span>
        </Button>
      </div>
      {query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : !query.data ? (
        <Loading />
      ) : query.data.data.total === null ? (
        <Empty title="排行暂不可用">
          {reasonText(query.data.meta.unavailable_reasons.ranking)}
        </Empty>
      ) : (
        <RankingTable data={query.data.data} sources={kind === 'sources'} compact />
      )}
    </section>
  );
}
export function OverviewPage({ scope, navigate }: { scope: Scope; navigate: Navigate }) {
  const overview = useReport<OverviewData>('overview', scope);
  const visitors = useReport<Visitors>('visitors', scope);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">每一次访问，都有迹可循</p>
          <h1>流量总览</h1>
        </div>
        <span className="muted">{scope.site.name} / 网站脉搏</span>
      </div>
      {overview.isError ? (
        <Failure error={overview.error} retry={() => void overview.refetch()} />
      ) : overview.data ? (
        <>
          <MetricCards report={overview.data} onRealtime={() => navigate('/realtime')} />
          <ReportStatus report={overview.data} />
          {overview.data.data.pv === 0 && (
            <Empty title="本期暂无流量">调整日期，或前往站点设置检查 SDK 接入。</Empty>
          )}
        </>
      ) : (
        <Loading />
      )}
      <div className="analysis-grid">
        <TrendPanel scope={scope} />
        {visitors.isError ? (
          <Failure error={visitors.error} retry={() => void visitors.refetch()} />
        ) : visitors.data ? (
          <VisitorCards report={visitors.data} />
        ) : (
          <Loading />
        )}
      </div>
      <div className="rankings-grid">
        <TopRanking
          scope={scope}
          kind="sources"
          title="来源"
          description="访客从哪里抵达 · 会话"
          navigate={navigate}
        />
        <TopRanking
          scope={scope}
          kind="pages"
          title="受访页面"
          description="最常被浏览的页面 · PV"
          navigate={navigate}
        />
        <TopRanking
          scope={scope}
          kind="pages"
          mode="entry"
          title="入口页面"
          description="会话的第一站 · 会话"
          navigate={navigate}
        />
      </div>
    </>
  );
}
