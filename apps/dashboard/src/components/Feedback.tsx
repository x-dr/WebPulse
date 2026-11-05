import { Alert, Button, Skeleton } from 'antd';
import { errorText } from '../api/client';

export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      title="查询失败"
      description={errorText(error)}
      action={retry && <Button onClick={retry}>重试</Button>}
    />
  );
}
export function Loading() {
  return (
    <div className="loading-panel" role="status" aria-label="正在加载">
      <Skeleton active={false} />
      <span>正在加载…</span>
    </div>
  );
}
export function Empty({
  title = '本期暂无流量',
  children,
}: {
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{children ?? '请调整日期范围，或在站点设置中检查采集接入。'}</p>
    </div>
  );
}
const reasons: Record<string, string> = {
  before_site_created: '该日期早于站点接入时间，请缩小日期范围。',
  no_closed_sessions: '暂无已结束会话，跳出率与时长暂不可用。',
  zero_baseline: '上一周期为 0，无法计算相对变化。',
  identity_history_unavailable: '身份历史不足，无法精确区分新老访客。',
  identity_epoch_changed: '范围跨越身份密钥版本，无法精确去重。',
  identity_epoch_boundary: '范围跨越身份密钥版本，无法精确去重。',
  coverage_unknown: '覆盖状态未知，请查看站点诊断后重试。',
  historical_sessions_unavailable: '历史会话已不可用，请缩小日期范围。',
  partial_range_raw_unavailable: '部分日期的明细已过期，无法精确计算该区间。',
  aggregation_pending: '聚合处理中，请稍后刷新。',
  retention_cleanup: '所需数据已过期，扩大保留窗口不能恢复历史。',
  privacy_replay_unverifiable: '该区间因隐私恢复校验暂不可查询。',
};
export function reasonText(reason?: string) {
  if (!reason) return '数据暂不可用，请调整日期或查看站点诊断。';
  return (
    reasons[reason] ??
    (reason.includes('retention') || reason.includes('expired')
      ? '所需数据已过期，请缩小日期范围。'
      : `数据暂不可用（${reason}），请调整日期或查看站点诊断。`)
  );
}
