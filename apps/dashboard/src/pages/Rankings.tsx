import { useState, type ReactNode } from 'react';
import { Button, Input, Pagination, Select } from 'antd';
import type { Navigate, Scope } from '../navigation';
import { useReport } from '../api/reports';
import type { RankItem, Ranking } from '../api/types';
import { Empty, Failure, Loading, reasonText } from '../components/Feedback';
import { channels, RankingTable } from '../components/RankingTable';
import { number, ReportStatus } from '../components/ReportCards';

export function RankingsPage({
  scope,
  url,
  navigate,
  sources = false,
  toolbar,
}: {
  scope: Scope;
  url: URL;
  navigate: Navigate;
  sources?: boolean;
  toolbar: ReactNode;
}) {
  const [search, setSearch] = useState(url.searchParams.get('search') ?? '');
  const mode = ['view', 'entry', 'exit'].includes(url.searchParams.get('mode') ?? '')
    ? url.searchParams.get('mode')!
    : 'view';
  const page = /^[1-9]\d{0,5}$/.test(url.searchParams.get('page') ?? '')
    ? Number(url.searchParams.get('page'))
    : 1;
  const params: Record<string, string> = {
    page: String(page),
    page_size: '20',
    sort: url.searchParams.get('sort') === 'name' ? 'name' : 'count',
    order: url.searchParams.get('order') === 'asc' ? 'asc' : 'desc',
  };
  const filters = sources
    ? ['channel', 'referrer_host', 'utm_source', 'utm_medium', 'utm_campaign']
    : ['search'];
  filters.forEach((key) => {
    const value = url.searchParams.get(key);
    if (value) params[key] = value;
  });
  if (!sources) params.mode = mode;
  const query = useReport<Ranking>(sources ? 'sources' : 'pages', scope, params);
  const update = (changes: Record<string, string | null>) => {
    const next = new URL(url);
    Object.entries({ page: null, ...changes }).forEach(([k, v]) =>
      v === null ? next.searchParams.delete(k) : next.searchParams.set(k, v),
    );
    navigate(next.pathname + next.search);
  };
  const detail = (item: RankItem) =>
    update(
      Object.fromEntries(
        ['channel', 'referrer_host', 'utm_source', 'utm_medium', 'utm_campaign'].map((k) => [
          k,
          (item[k as keyof RankItem] as string) || null,
        ]),
      ),
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{sources ? '理解每一次抵达' : '了解内容的吸引力'}</p>
          <h1>{sources ? '流量来源' : '页面分析'}</h1>
        </div>
      </div>
      <p className="page-description">
        {sources
          ? '以会话首条页面浏览锁定来源；内部跳转和后续 UTM 不会改写归因。'
          : '受访按 PV；入口按本期开始的会话；退出只计本期开始且已结束的会话。'}
      </p>
      {toolbar}
      <section className="panel">
        <div className="table-toolbar">
          {sources ? (
            <>
              <Select
                aria-label="来源渠道"
                value={params.channel ?? ''}
                options={[
                  { value: '', label: '全部渠道' },
                  ...Object.entries(channels).map(([value, label]) => ({ value, label })),
                ]}
                onChange={(v) => update({ channel: v || null })}
              />
              {filters.some((k) => k !== 'channel' && params[k]) && (
                <div className="source-detail">
                  来源详情：
                  {filters
                    .filter((k) => params[k])
                    .map((k) => `${k}=${params[k]}`)
                    .join(' / ')}
                  <Button onClick={() => update(Object.fromEntries(filters.map((k) => [k, null])))}>
                    清除筛选
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="mode-buttons" role="group" aria-label="页面类型">
                {[
                  ['view', '受访'],
                  ['entry', '入口'],
                  ['exit', '退出'],
                ].map(([value, label]) => (
                  <Button
                    key={value}
                    type={mode === value ? 'primary' : 'default'}
                    aria-pressed={mode === value}
                    onClick={() => update({ mode: value! })}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <form
                className="search-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  update({ search: search || null });
                }}
              >
                <Input
                  aria-label="搜索路径"
                  value={search}
                  maxLength={128}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索标准化路径"
                />
                <Button htmlType="submit">搜索</Button>
              </form>
            </>
          )}
          <Select
            aria-label="排行排序"
            value={`${params.sort}:${params.order}`}
            options={[
              { value: 'count:desc', label: '计数从高到低' },
              { value: 'count:asc', label: '计数从低到高' },
              { value: 'name:asc', label: '名称顺序' },
            ]}
            onChange={(value) => {
              const [sort, order] = value.split(':');
              update({ sort: sort!, order: order! });
            }}
          />
        </div>
        {query.isError ? (
          <Failure error={query.error} retry={() => void query.refetch()} />
        ) : !query.data ? (
          <Loading />
        ) : (
          <>
            {query.data.data.total === null ? (
              <Empty title="排行暂不可用">
                {reasonText(query.data.meta.unavailable_reasons.ranking)}
              </Empty>
            ) : (
              <>
                <RankingTable
                  data={query.data.data}
                  sources={sources}
                  detail={sources ? detail : undefined}
                />
                <div className="pagination">
                  <span className="muted small">
                    范围总计 {number(query.data.data.total)}{' '}
                    {query.data.data.unit === 'page_view' ? 'PV' : '会话'} · 本页外{' '}
                    {number(query.data.data.other_count)}
                  </span>
                  <Pagination
                    current={page}
                    pageSize={20}
                    total={query.data.data.total_items ?? 0}
                    showSizeChanger={false}
                    responsive
                    onChange={(p) => update({ page: String(p) })}
                  />
                </div>
              </>
            )}
            <ReportStatus report={query.data} />
          </>
        )}
      </section>
    </>
  );
}
