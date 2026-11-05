import type { Ranking, RankItem } from '../api/types';
import { Empty } from './Feedback';
import { number, percent } from './ReportCards';

export const channels: Record<string, string> = {
  direct: '直接访问',
  organic: '自然搜索',
  referral: '外部引荐',
  campaign: '推广活动',
  unknown: '未知来源',
};
export function sourceName(item: RankItem) {
  return item.referrer_host || channels[item.channel ?? 'unknown'] || '未知来源';
}
export function RankingTable({
  data,
  sources = false,
  compact = false,
  detail,
}: {
  data: Ranking;
  sources?: boolean;
  compact?: boolean;
  detail?: ((item: RankItem) => void) | undefined;
}) {
  if (!data.items.length) return <Empty />;
  return (
    <div className="table-wrap">
      <table className={compact ? 'compact-table' : ''}>
        <caption className="sr-only">
          {sources ? '来源' : '页面'}排行，单位{data.unit === 'page_view' ? 'PV' : '会话'}
        </caption>
        <thead>
          <tr>
            <th scope="col">{sources ? '来源' : '标准化路径'}</th>
            <th scope="col">{data.unit === 'page_view' ? 'PV' : '会话'}</th>
            <th scope="col" className="optional-column">
              占比
            </th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item, index) => (
            <tr
              key={JSON.stringify([
                item.path,
                item.channel,
                item.referrer_host,
                item.utm_source,
                item.utm_medium,
                item.utm_campaign,
              ])}
            >
              <th scope="row">
                <div className="rank-name">
                  <span className="rank-index">
                    {String((data.page - 1) * data.page_size + index + 1).padStart(2, '0')}
                  </span>
                  <div className="rank-content">
                    {detail ? (
                      <button className="text-button rank-path" onClick={() => detail(item)}>
                        {sources ? sourceName(item) : item.path}
                      </button>
                    ) : (
                      <span className="rank-path">{sources ? sourceName(item) : item.path}</span>
                    )}
                    {sources && (
                      <span className="muted small">
                        {channels[item.channel ?? 'unknown']}{' '}
                        {item.utm_source && ` · ${item.utm_source}`}
                      </span>
                    )}
                    <div className="rank-track">
                      <span style={{ width: `${item.share * 100}%` }} />
                    </div>
                  </div>
                </div>
              </th>
              <td className="rank-count">{number(item.count)}</td>
              <td className="optional-column muted">{percent(item.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
