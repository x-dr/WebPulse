import { useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Job, Session, Site } from '../../api/types';
import type { Navigate } from '../../navigation';
import { request } from '../../api/client';
import { Failure, Loading } from '../../components/Feedback';

function deletionKey(site: string) {
  const storageKey = `webpulse:deletion:${site}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
  } catch {
    /* Memory fallback below. */
  }
  const key = crypto.randomUUID();
  try {
    sessionStorage.setItem(storageKey, key);
  } catch {
    /* The component keeps this key across retries. */
  }
  return key;
}
export function SiteActions({
  site,
  session,
  navigate,
}: {
  site: Site;
  session: Session;
  navigate: Navigate;
}) {
  const client = useQueryClient();
  const [action, setAction] = useState<'pause' | 'delete' | null>(null);
  const [confirm, setConfirm] = useState('');
  const [key] = useState(() => deletionKey(site.site_id));
  const mutation = useMutation({
    mutationFn: async (): Promise<{ data: Job | Site }> =>
      action === 'delete'
        ? request<{ data: Job }>(`/sites/${site.site_id}`, {
            method: 'DELETE',
            csrf: session.csrf_token,
            key,
            body: { confirm_name: confirm },
          })
        : request<{ data: Site }>(`/sites/${site.site_id}`, {
            method: 'PATCH',
            csrf: session.csrf_token,
            body: { enabled: !site.enabled },
          }),
    onSuccess: async (result) => {
      setAction(null);
      await client.invalidateQueries({ queryKey: ['sites'] });
      await client.invalidateQueries({ queryKey: ['diagnostics', site.site_id] });
      if ('job_id' in result.data) navigate(`/jobs/${result.data.job_id}`);
    },
  });
  return (
    <section className="panel settings-section danger-section">
      <div className="panel-heading">
        <h2>采集与删除</h2>
        <p>暂停会排空在途采集；删除会禁用站点并建立持久化任务。</p>
      </div>
      <div className="action-row">
        <Button
          disabled={site.maintenance_state !== 'active'}
          onClick={() => {
            mutation.reset();
            setAction('pause');
          }}
        >
          {site.enabled ? '暂停采集' : '恢复采集'}
        </Button>
        <Button
          danger
          disabled={site.maintenance_state !== 'active'}
          onClick={() => {
            setConfirm('');
            mutation.reset();
            setAction('delete');
          }}
        >
          删除站点
        </Button>
      </div>
      <Modal
        open={Boolean(action)}
        title={action === 'delete' ? '删除站点及统计数据' : site.enabled ? '暂停采集' : '恢复采集'}
        okText={action === 'delete' ? '确认删除' : '确认'}
        cancelText="取消"
        okButtonProps={{
          danger: action === 'delete',
          disabled: action === 'delete' && confirm !== site.name,
        }}
        confirmLoading={mutation.isPending}
        cancelButtonProps={{ disabled: mutation.isPending }}
        closable={!mutation.isPending}
        keyboard={!mutation.isPending}
        mask={{ closable: false }}
        onCancel={() => {
          if (!mutation.isPending) setAction(null);
        }}
        onOk={() => mutation.mutate()}
      >
        {action === 'delete' ? (
          <>
            <p>
              将删除「{site.name}
              」的站点配置、采集事实、成员与汇总。此操作不能撤销。受理后可查看任务进度；网络中断后重试会复用同一请求。
            </p>
            <label htmlFor="delete-confirm">输入站点名称「{site.name}」确认</label>
            <Input
              id="delete-confirm"
              autoComplete="off"
              value={confirm}
              disabled={mutation.isPending}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </>
        ) : (
          <p>
            {site.enabled
              ? `暂停「${site.name}」后将拒绝新采集，历史数据继续保留。`
              : `恢复「${site.name}」的新访问采集。`}
          </p>
        )}
        {mutation.isError && <Failure error={mutation.error} />}
      </Modal>
    </section>
  );
}
export function JobPage({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ['job', id],
    queryFn: ({ signal }) => request<{ data: Job }>(`/jobs/${encodeURIComponent(id)}`, { signal }),
    refetchInterval: (q) =>
      ['completed', 'failed'].includes(q.state.data?.data.status ?? '') ? false : 5000,
  });
  const job = query.data?.data;
  const status: Record<string, string> = {
    queued: '等待处理',
    running: '处理中',
    completed: '已完成',
    failed: '处理失败',
  };
  return (
    <>
      <div className="page-heading">
        <h1>删除任务</h1>
      </div>
      {query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : job ? (
        <section className="panel settings-section">
          <h2>{status[job.status] ?? job.status}</h2>
          <dl className="diagnostic-list">
            <dt>任务编号</dt>
            <dd>{job.job_id}</dd>
            <dt>当前阶段</dt>
            <dd>{job.phase}</dd>
          </dl>
          {job.phase === 'journal' && (
            <p role="status">正在等待独立删除清单确认。部署管理员接入后才能继续删除。</p>
          )}
          {job.last_error_code && (
            <p role="alert">任务异常：{job.last_error_code}。请联系管理员处理后重试任务。</p>
          )}
          <Button onClick={() => void query.refetch()} loading={query.isFetching}>
            刷新任务状态
          </Button>
        </section>
      ) : (
        <Loading />
      )}
    </>
  );
}
