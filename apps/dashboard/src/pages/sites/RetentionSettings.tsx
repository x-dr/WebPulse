import { useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Retention, RetentionPreview, Session, Site } from '../../api/types';
import { request } from '../../api/client';
import { Failure } from '../../components/Feedback';

export const layerNames: Record<string, string> = {
  raw_pv: '页面明细',
  sessions: '会话明细',
  hour_members: '小时去重成员',
  day_members: '每日去重成员',
  hour_aggregates: '小时汇总',
  day_aggregates: '日汇总',
};
export function RetentionSettings({ site, session }: { site: Site; session: Session }) {
  const client = useQueryClient();
  const [settings, setSettings] = useState<Retention>({
    raw_retention_days: site.raw_retention_days,
    member_retention_days: site.member_retention_days,
    aggregate_retention_days: site.aggregate_retention_days,
  });
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [confirm, setConfirm] = useState('');
  const [saved, setSaved] = useState(false);
  const read = useMutation({
    mutationFn: () =>
      request<{ data: RetentionPreview }>(
        `/sites/${site.site_id}/retention-preview?${new URLSearchParams(Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])))}`,
      ),
    onSuccess: ({ data }) => {
      setConfirm('');
      setPreview(data);
      save.reset();
    },
  });
  const save = useMutation({
    mutationFn: () =>
      request(`/sites/${site.site_id}/retention`, {
        method: 'PATCH',
        csrf: session.csrf_token,
        body: { ...preview!.settings, confirm_name: confirm },
      }),
    onSuccess: async () => {
      setPreview(null);
      setSaved(true);
      await client.invalidateQueries({ queryKey: ['sites'] });
      await client.invalidateQueries({ queryKey: ['report'] });
    },
  });
  return (
    <section className="panel settings-section">
      <div className="panel-heading">
        <h2>数据保留</h2>
        <p>缩短窗口会在安全冻结后清理数据；扩大窗口无法恢复已清理历史。</p>
      </div>
      <form
        className="settings-form"
        onChange={() => setSaved(false)}
        onSubmit={(e) => {
          e.preventDefault();
          read.mutate();
        }}
      >
        <fieldset disabled={read.isPending || site.maintenance_state !== 'active'}>
          <legend className="sr-only">保留天数</legend>
          {(
            [
              { key: 'raw_retention_days', label: '明细保留天数', min: 7, max: 30 },
              { key: 'member_retention_days', label: '精确去重成员保留天数', min: 30, max: 90 },
              { key: 'aggregate_retention_days', label: '汇总保留天数', min: 90, max: 365 },
            ] as const
          ).map(({ key, label, min, max }) => (
            <div key={key}>
              <label htmlFor={key}>
                {label}（{min}–{max}）
              </label>
              <Input
                id={key}
                type="number"
                min={min}
                max={max}
                required
                value={settings[key]}
                onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })}
              />
            </div>
          ))}
          <p className="field-help">明细 ≤ 去重成员 ≤ 汇总。先预览，再输入站点名确认。</p>
          <Button htmlType="submit" loading={read.isPending}>
            预览影响
          </Button>
        </fieldset>
        {read.isError && <Failure error={read.error} />}
        {saved && (
          <p role="status" className="success-text">
            保留策略已更新。
          </p>
        )}
      </form>
      <Modal
        open={Boolean(preview)}
        title="确认保留策略"
        okText="确认更新保留策略"
        cancelText="取消"
        confirmLoading={save.isPending}
        okButtonProps={{ disabled: confirm !== site.name }}
        cancelButtonProps={{ disabled: save.isPending }}
        closable={!save.isPending}
        keyboard={!save.isPending}
        mask={{ closable: false }}
        onCancel={() => {
          if (!save.isPending) setPreview(null);
        }}
        onOk={() => save.mutate()}
      >
        <p>
          站点：{site.name}
          。安全清理后以下时间之前的数据将不可用；历史去重、部分日统计和汇总查询能力会随相应层丢失。
        </p>
        <div className="table-wrap">
          <table>
            <caption>预览安全清理边界</caption>
            <thead>
              <tr>
                <th>数据层</th>
                <th>保留起点（UTC）</th>
              </tr>
            </thead>
            <tbody>
              {preview?.layers.map((layer) => (
                <tr key={layer.layer}>
                  <th scope="row">{layerNames[layer.layer] ?? layer.layer}</th>
                  <td>{layer.safe_target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <label htmlFor="retention-confirm">输入站点名称「{site.name}」确认</label>
        <Input
          id="retention-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={save.isPending}
          autoComplete="off"
        />
        {save.isError && <Failure error={save.error} />}
      </Modal>
    </section>
  );
}
