import { useState } from 'react';
import { Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { request } from '../../api/client';
import type { Diagnostics, Session, Site } from '../../api/types';
import type { Navigate } from '../../navigation';
import { Empty, Failure, Loading } from '../../components/Feedback';
import { SiteForm } from './SiteForm';
import { RetentionSettings } from './RetentionSettings';
import { SiteActions } from './SiteActions';

export function SitesPage({
  sites,
  session,
  navigate,
}: {
  sites: Site[];
  session: Session;
  navigate: Navigate;
}) {
  const [create, setCreate] = useState(sites.length === 0);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">让数据各归其位</p>
          <h1>站点管理</h1>
        </div>
        <Button type="primary" onClick={() => setCreate(!create)}>
          {create ? '取消创建' : '新建站点'}
        </Button>
      </div>
      {create && (
        <section className="panel settings-section">
          <h2>创建站点</h2>
          <SiteForm
            session={session}
            onSaved={(site) =>
              navigate(`/sites/${site.site_id}/settings`, {
                site_id: site.site_id,
                start_date: null,
                end_date: null,
              })
            }
          />
        </section>
      )}
      {sites.length ? (
        <div className="site-grid">
          {sites.map((site) => (
            <section className="panel site-card" key={site.site_id}>
              <span className="eyebrow">{site.enabled ? '采集中' : '已暂停'}</span>
              <h2>{site.name}</h2>
              <p className="break-text">{site.primary_origin}</p>
              <p className="muted small">
                {site.timezone} · {site.maintenance_state === 'active' ? '正常' : '维护中'}
              </p>
              <Button
                onClick={() =>
                  navigate(`/sites/${site.site_id}/settings`, { site_id: site.site_id })
                }
              >
                站点设置与接入
              </Button>
            </section>
          ))}
        </div>
      ) : (
        !create && <Empty title="尚未创建站点">新建一个站点，获取采集代码。</Empty>
      )}
    </>
  );
}
function Integration({ site }: { site: Site }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const escape = (s: string) =>
    s
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  const snippet = `<script defer src="${escape(site.tracker_url)}" data-site-id="${escape(site.site_id)}" data-consent="required"></script>\n<!-- 仅在访客明确同意后调用 -->\n<script>\n  window.webpulseQueue = window.webpulseQueue || [];\n  // 在同意管理器的同意回调中执行：\n  // window.webpulseQueue.push(['consent', true]);\n  // 撤销时调用 window.webpulse.consent(false);\n</script>`;
  return (
    <section className="panel settings-section">
      <h2>接入采集</h2>
      <p className="muted">
        公开站点 ID：<code className="break-text">{site.site_id}</code>。它用于识别站点。
      </p>
      <pre className="sdk-code" tabIndex={0}>
        {snippet}
      </pre>
      <Button
        onClick={() => {
          void navigator.clipboard
            .writeText(snippet)
            .then(() => {
              setCopied(true);
              setCopyError(false);
            })
            .catch(() => setCopyError(true));
        }}
      >
        复制接入代码
      </Button>
      <span role="status" className="small">
        {copyError ? '复制失败，请选中代码手动复制。' : copied ? '已复制' : ''}
      </span>
      <p className="field-help">
        SDK 默认不采集。请将同意调用放入访客明确同意的回调中；撤销后停止发送。CSP 的 script-src 与
        connect-src 需允许 {new URL(site.tracker_url).origin}。手动模式需在同意完成后调用
        trackPageView。
      </p>
    </section>
  );
}
function SiteDiagnostics({ site, navigate }: { site: Site; navigate: Navigate }) {
  const query = useQuery({
    queryKey: ['diagnostics', site.site_id],
    queryFn: ({ signal }) =>
      request<{ data: Diagnostics }>(`/sites/${site.site_id}/diagnostics`, { signal }),
  });
  const data = query.data?.data;
  const date = (value: string | null) =>
    value
      ? new Date(value).toLocaleString('zh-CN', { timeZone: site.timezone, hour12: false })
      : '暂无记录';
  return (
    <section className="panel settings-section">
      <div className="section-heading">
        <h2>采集诊断</h2>
        <Button onClick={() => void query.refetch()} loading={query.isFetching}>
          刷新诊断
        </Button>
      </div>
      {query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : data ? (
        <>
          <dl className="diagnostic-list">
            <dt>最近成功采集</dt>
            <dd>
              {date(data.last_accepted_at)}（{site.timezone}）
            </dd>
            <dt>待聚合时间桶</dt>
            <dd>{data.pending_buckets}</dd>
            <dt>维护任务最近成功</dt>
            <dd>{date(data.worker?.last_succeeded_at ?? null)}</dd>
            <dt>最近拒绝原因计数</dt>
            <dd>{data.rejection_counts.available ? '已记录' : '暂不可用（尚未持久化）'}</dd>
          </dl>
          {!data.last_accepted_at && (
            <p className="field-help">
              尚无保留窗口内的采集记录。首次接入请检查同意回调、允许的 Origin 和 CSP。
            </p>
          )}
          {data.jobs.map((job) => (
            <Button key={job.job_id} onClick={() => navigate(`/jobs/${job.job_id}`)}>
              查看删除任务 · {job.status}
            </Button>
          ))}
        </>
      ) : (
        <Loading />
      )}
    </section>
  );
}
export function SiteSettingsPage({
  site,
  session,
  navigate,
}: {
  site: Site;
  session: Session;
  navigate: Navigate;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">配置、接入与数据边界</p>
          <h1>站点设置</h1>
        </div>
        <span className="muted">
          {site.name} · {site.enabled ? '采集中' : '已暂停'}
        </span>
      </div>
      <div className="settings-grid">
        <section className="panel settings-section">
          <h2>站点配置</h2>
          <SiteForm site={site} session={session} onSaved={() => {}} />
        </section>
        <div className="settings-stack">
          <Integration site={site} />
          <SiteDiagnostics site={site} navigate={navigate} />
          <RetentionSettings site={site} session={session} />
          <SiteActions site={site} session={session} navigate={navigate} />
        </div>
      </div>
    </>
  );
}
