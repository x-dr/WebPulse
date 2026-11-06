import { useState } from 'react';
import { Pagination } from 'antd';
import { useReport } from '../api/reports';
import type { Visits } from '../api/types';
import type { Scope } from '../navigation';
import { Empty, Failure, Loading, reasonText } from '../components/Feedback';
import { channels } from '../components/RankingTable';
import { number } from '../components/ReportCards';

export function VisitRecords({ scope }: { scope: Scope }) {
  const [page, setPage] = useState(1);
  const query = useReport<Visits>('visits', scope, { page: String(page), page_size: '20' });
  const report = query.data;
  return (
    <section className="panel visit-records" aria-label="访问记录">
      <div className="panel-heading">
        <h2>访问记录</h2>
        <p>按访问时间倒序显示真实 IP、页面与来源。旧访问的 IP 显示为“未记录”。</p>
      </div>
      {query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : !report ? (
        <Loading />
      ) : report.data.total_items === null ? (
        <Empty title="访问记录暂不可用">{reasonText(report.meta.unavailable_reasons.visits)}</Empty>
      ) : (
        <>
          {!report.data.items.length ? (
            <Empty title={page === 1 ? '所选日期暂无访问记录' : '本页暂无访问记录，请返回上一页'} />
          ) : (
            <div className="table-wrap" role="region" aria-label="访问记录表格" tabIndex={0}>
              <table>
                <caption className="sr-only">访问记录，时间采用 {scope.site.timezone}</caption>
                <thead>
                  <tr>
                    <th scope="col">页面</th>
                    <th scope="col">真实 IP</th>
                    <th scope="col">来源</th>
                    <th scope="col">访问时间</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.items.map((visit) => (
                    <tr key={visit.event_id}>
                      <th scope="row">{visit.path}</th>
                      <td>
                        <span className="visit-ip">{visit.client_ip ?? '未记录'}</span>
                      </td>
                      <td>{channels[visit.channel] ?? '未知来源'}</td>
                      <td>
                        {new Date(visit.at).toLocaleString('zh-CN', {
                          timeZone: scope.site.timezone,
                          hour12: false,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="pagination">
            <span className="muted small">共 {number(report.data.total_items)} 条访问</span>
            <Pagination
              current={page}
              pageSize={20}
              total={report.data.total_items}
              showSizeChanger={false}
              responsive
              onChange={setPage}
            />
          </div>
        </>
      )}
    </section>
  );
}
