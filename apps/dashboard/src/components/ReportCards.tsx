import { Tooltip } from 'antd';
import type { ReportMetric } from '@webpulse/shared';
import type { Overview, Report, Visitors } from '../api/types';
import { reasonText } from './Feedback';
import { PulseMark, WorkspaceIcon } from './WorkspaceIcon';

export const number = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
export const percent = (value: number | null | undefined) =>
  typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—';
export const trendMetrics = [
  { value: 'ip', label: 'IP' },
  { value: 'pv', label: 'PV' },
  { value: 'uv', label: 'UV' },
  { value: 'sessions', label: '会话' },
  { value: 'new_visitors', label: '新访客' },
];
export function duration(value: number | null) {
  if (value === null) return '—';
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}
const metrics: { key: ReportMetric; label: string; hint: string }[] = [
  { key: 'pv', label: '浏览量 PV', hint: '范围内有效页面浏览次数，重试与互动不重复计数。' },
  { key: 'uv', label: '访客 UV', hint: '范围内浏览器身份精确去重；不承诺跨设备、跨域统一。' },
  { key: 'ip', label: '独立 IP', hint: '范围内站点化 IP HMAC 精确去重，不代表人数。' },
  { key: 'sessions', label: '会话', hint: '本期开始的会话，包含尚未结束的会话。' },
  {
    key: 'bounce_rate',
    label: '跳出率',
    hint: '本期开始且已结束的会话中，仅一次 PV 且无可信互动的比例。',
  },
  {
    key: 'avg_active_ms',
    label: '平均访问时长',
    hint: '仅已结束会话；前台可见区间并集的估计值，并非精确停留时长。',
  },
];
export function MetricCards({
  report,
  onRealtime,
}: {
  report: Report<Overview>;
  onRealtime?: () => void;
}) {
  return (
    <section className="metric-grid" aria-label="七项核心指标">
      <article className="metric-card active-card">
        <Tooltip
          trigger={['hover', 'focus']}
          title="截至本次查询，最近 15 分钟有有效活动的去重访客，不随日期范围改变。"
        >
          <button className="metric-label" type="button">
            <WorkspaceIcon name="realtime" />
            最近 15 分钟活跃访客
          </button>
        </Tooltip>
        <strong>{number(report.data.active_visitors_15m)}</strong>
        <PulseMark className="activity-pulse" />
        <span className="muted small">最近活动快照 · 独立于所选日期</span>
        {onRealtime && (
          <button className="realtime-link" type="button" onClick={onRealtime}>
            查看实时访问 →
          </button>
        )}
      </article>
      {metrics.map(({ key, label, hint }) => {
        const value = report.data[key];
        const change = report.data.comparison[key];
        const relative = change?.relative_change;
        return (
          <article className="metric-card" key={key}>
            <div className="metric-label-row">
              <span>{label}</span>
              <Tooltip title={hint} trigger={['hover', 'focus']}>
                <button className="metric-help" type="button" aria-label={`${label}统计口径`}>
                  <WorkspaceIcon name="info" />
                </button>
              </Tooltip>
            </div>
            <strong
              className={key === 'avg_active_ms' ? 'duration-value' : undefined}
              title={number(value)}
            >
              {key === 'bounce_rate'
                ? percent(value)
                : key === 'avg_active_ms'
                  ? duration(value)
                  : number(value)}
            </strong>
            {value === null ? (
              <span className="muted small">
                {reasonText(report.meta.unavailable_reasons[key])}
              </span>
            ) : (
              <span
                className="comparison"
                title={
                  change?.reason
                    ? reasonText(change.reason)
                    : '与上一等长周期比较；部分日截止同一墙钟时刻'
                }
              >
                较前一周期 ·{' '}
                {relative === null || relative === undefined
                  ? '—'
                  : `${relative >= 0 ? '↑' : '↓'} ${Math.abs(relative * 100).toFixed(1)}%`}
                {key === 'bounce_rate' && change?.percentage_point_change != null && (
                  <span className="small">
                    {' '}
                    / {change.percentage_point_change > 0 ? '+' : ''}
                    {change.percentage_point_change.toFixed(1)} 个百分点
                  </span>
                )}
              </span>
            )}
            {['bounce_rate', 'avg_active_ms'].includes(key) && (
              <span className="small muted">
                仅已结束会话{key === 'avg_active_ms' ? ' · 估计' : ''}
              </span>
            )}
          </article>
        );
      })}
    </section>
  );
}
export function VisitorCards({ report }: { report: Report<Visitors> }) {
  const hasShares =
    report.data.new_share !== null &&
    report.data.returning_share !== null &&
    report.data.uv !== null &&
    report.data.uv > 0;
  const newShare = Math.min(1, Math.max(0, report.data.new_share ?? 0));
  return (
    <section className="panel visitor-panel" aria-labelledby="visitors-title">
      <div className="panel-heading">
        <h2 id="visitors-title">新老访客</h2>
        <p>相对整个所选周期划分，不累加每日分类。</p>
      </div>
      <div className="visitor-content">
        <div
          className="visitor-donut"
          role="img"
          aria-label={`本期访客 ${number(report.data.uv)}，新访客占比 ${percent(report.data.new_share)}，老访客占比 ${percent(report.data.returning_share)}`}
        >
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle
              cx="60"
              cy="60"
              r="49"
              fill="none"
              stroke={hasShares ? '#35614c' : '#e4e8ed'}
              strokeWidth="15"
            />
            {hasShares && (
              <circle
                cx="60"
                cy="60"
                r="49"
                fill="none"
                stroke="#c77d58"
                strokeWidth="15"
                pathLength="100"
                strokeDasharray={`${newShare * 100} 100`}
                transform="rotate(-90 60 60)"
              />
            )}
          </svg>
          <div className="visitor-donut-label">
            <strong>{number(report.data.uv)}</strong>
            <span>本期访客</span>
          </div>
        </div>
        <div className="visitor-grid">
          {(
            [
              { name: '新访客', key: 'new_visitors', share: 'new_share' },
              { name: '老访客', key: 'returning_visitors', share: 'returning_share' },
            ] as const
          ).map(({ name, key, share }) => (
            <div key={key} className={`visitor-stat ${key}`}>
              <span className="visitor-name">
                <span className="visitor-dot" aria-hidden="true" />
                {name}
              </span>
              <strong>{number(report.data[key])}</strong>
              <span className="muted small">占比 {percent(report.data[share])}</span>
              {report.data[key] === null && (
                <p className="small muted">{reasonText(report.meta.unavailable_reasons[key])}</p>
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="panel-footnote">
        新访客 + 老访客 = 本期 UV {number(report.data.uv)}。身份以浏览器为单位。
      </p>
    </section>
  );
}
export function ReportStatus({ report }: { report: Report<unknown> }) {
  const finalized = report.meta.data_coverage.find(
    (c) => c.layer === 'day_aggregates',
  )?.finalized_through;
  return (
    <div
      className={`report-status${report.meta.is_provisional ? ' report-status--provisional' : ''}`}
      role="status"
    >
      <span>
        {report.meta.is_provisional ? '暂定数据 · 本期尚未完整结算' : '数据快照'} · 截至{' '}
        {new Date(report.meta.as_of).toLocaleString('zh-CN', {
          timeZone: report.meta.timezone,
          hour12: false,
        })}
        （{report.meta.timezone}）
        {report.meta.effective_start_utc &&
          report.meta.start_utc &&
          report.meta.effective_start_utc > report.meta.start_utc &&
          ` · 首日从站点接入时刻 ${new Date(report.meta.effective_start_utc).toLocaleTimeString('zh-CN', { timeZone: report.meta.timezone, hour12: false })} 起统计`}
      </span>
      <span>
        日汇总冻结至{' '}
        {finalized
          ? new Date(finalized).toLocaleDateString('zh-CN', { timeZone: report.meta.timezone })
          : '尚未冻结'}
        {report.meta.aggregation_lag_seconds !== undefined &&
          ` · 待聚合延迟 ${Math.round(report.meta.aggregation_lag_seconds)} 秒`}
      </span>
    </div>
  );
}
