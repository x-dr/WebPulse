import { lazy, Suspense, useState } from 'react';
import { Alert, Button } from 'antd';
import type { Site, Trend } from '../api/types';
import { useRealtime } from '../api/realtime';
import { Loading } from '../components/Feedback';
import { number } from '../components/ReportCards';
const TrendChart = lazy(() =>
  import('../components/TrendChart').then((m) => ({ default: m.TrendChart })),
);
const labels = {
  connecting: '连接中',
  live: '实时连接正常',
  delayed: '数据可能延迟',
  paused: '页面隐藏，已暂停',
  unavailable: '站点已暂停或正在维护',
};
const channels: Record<string, string> = {
  direct: '直接访问',
  organic: '自然搜索',
  referral: '外部引荐',
  campaign: '推广活动',
  unknown: '未知',
};
export function RealtimePage({ site }: { site: Site }) {
  const [retry, setRetry] = useState(0);
  const { data, status } = useRealtime(site.site_id, retry);
  const time = (at: string) =>
    new Date(at).toLocaleTimeString('zh-CN', { timeZone: site.timezone, hour12: false });
  const trend: Trend | undefined = data && {
    metric: 'pv',
    granularity: 'minute',
    points: data.minutes.map((m) => ({
      start: m.start,
      end: new Date(Date.parse(m.start) + 60000).toISOString(),
      value: m.pv,
      complete: Date.parse(m.start) + 60000 <= Date.parse(data.as_of),
    })),
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LIVE PULSE</p>
          <h1>实时访问</h1>
          <p>滚动观察最近 15 分钟，不受日期筛选影响。</p>
        </div>
        <Button onClick={() => setRetry((n) => n + 1)}>重新连接</Button>
      </div>
      <p role="status" aria-label="实时连接状态" className="muted">
        {labels[status]} · {data ? `最后更新 ${time(data.as_of)}` : '等待完整快照'} ·{' '}
        {site.timezone}
      </p>
      {['delayed', 'unavailable'].includes(status) && (
        <Alert
          type="warning"
          title={labels[status]}
          description="连接恢复后会替换为最新完整快照。"
        />
      )}
      <div className="realtime-metrics">
        <section className="panel">
          <h2>15 分钟活跃访客</h2>
          <strong className="realtime-value">
            {data ? number(data.active_visitors_15m) : '—'}
          </strong>
          <p>有效浏览或前台心跳；同一访客只计一次。</p>
        </section>
        <section className="panel">
          <h2>最近一分钟 PV</h2>
          <strong className="realtime-value">{data ? number(data.pv_last_minute) : '—'}</strong>
          <p>最近 60 秒已持久化的页面浏览。</p>
        </section>
      </div>
      {!data ? (
        status === 'connecting' ? (
          <Loading />
        ) : (
          <p>暂无可展示的实时快照。</p>
        )
      ) : (
        <>
          <div className="realtime-grid">
            <section className="panel trend-panel">
              <div className="panel-heading">
                <h2>最近 15 分钟 PV</h2>
              </div>
              {trend && (
                <Suspense fallback={<Loading />}>
                  <TrendChart data={trend} timezone={site.timezone} />
                </Suspense>
              )}
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h2>活跃页面 Top 10</h2>
                <p>按访客最近一次前台活动页面计数。</p>
              </div>
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">活跃页面</caption>
                  <thead>
                    <tr>
                      <th scope="col">页面</th>
                      <th scope="col">访客</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.active_pages.map((p) => (
                      <tr key={p.path}>
                        <th scope="row" className="path-cell">
                          {p.path}
                        </th>
                        <td>{number(p.visitors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.active_pages.length && <p>最近 15 分钟暂无活跃页面。</p>}
            </section>
          </div>
          <section className="panel realtime-recent">
            <div className="panel-heading">
              <h2>最近页面</h2>
              <p>显示最近 20 次访问的页面、真实 IP、来源与时间。</p>
            </div>
            <div className="table-wrap" role="region" aria-label="最近页面表格" tabIndex={0}>
              <table>
                <caption className="sr-only">最近页面浏览</caption>
                <thead>
                  <tr>
                    <th scope="col">页面</th>
                    <th scope="col">真实 IP</th>
                    <th scope="col">来源</th>
                    <th scope="col">访问时间</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_pages.map((p, i) => (
                    <tr key={`${p.at}:${i}`}>
                      <th scope="row" className="path-cell">
                        {p.path}
                      </th>
                      <td>
                        <span className="visit-ip">{p.client_ip ?? '未记录'}</span>
                      </td>
                      <td>{channels[p.channel] ?? '未知'}</td>
                      <td>{time(p.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.recent_pages.length && <p>最近 15 分钟暂无页面浏览。</p>}
          </section>
        </>
      )}
    </>
  );
}
