import { useState } from 'react';
import { Button, Input } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { defaultRules } from '@webpulse/shared/browser';
import type { Session, Site } from '../../api/types';
import { request } from '../../api/client';
import { Failure } from '../../components/Feedback';

export function SiteForm({
  site,
  session,
  onSaved,
}: {
  site?: Site;
  session: Session;
  onSaved: (site: Site) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(site?.name ?? '');
  const [origin, setOrigin] = useState(site?.primary_origin ?? '');
  const [allowed, setAllowed] = useState(site?.allowed_origins.join('\n') ?? '');
  const [timezone, setTimezone] = useState(site?.timezone ?? 'Asia/Shanghai');
  const [rules, setRules] = useState(site?.rules ?? defaultRules);
  const [prefixes, setPrefixes] = useState(rules.excluded_prefixes.join('\n'));
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      request<{ data: Site }>(site ? `/sites/${site.site_id}` : '/sites', {
        method: site ? 'PATCH' : 'POST',
        csrf: session.csrf_token,
        body: {
          name: name.trim(),
          primary_origin: origin.trim(),
          allowed_origins: [
            ...new Set(
              (allowed || origin)
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ],
          ...(!site ? { timezone } : {}),
          rules: {
            ...rules,
            excluded_prefixes: prefixes
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        },
      }),
    onSuccess: async ({ data }) => {
      setSaved(true);
      await client.invalidateQueries({ queryKey: ['sites'] });
      onSaved(data);
    },
  });
  return (
    <form
      className="settings-form"
      aria-label={site ? '站点配置' : '创建站点'}
      onChange={() => setSaved(false)}
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      {mutation.isError && (
        <div id="site-form-error">
          <Failure error={mutation.error} />
        </div>
      )}
      <fieldset disabled={mutation.isPending || (site && site.maintenance_state !== 'active')}>
        <legend className="sr-only">基本资料与采集规则</legend>
        <label htmlFor="site-name">站点名称</label>
        <Input
          id="site-name"
          value={name}
          required
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          aria-describedby={mutation.isError ? 'site-form-error' : undefined}
        />
        <label htmlFor="site-origin">主 Origin</label>
        <Input
          id="site-origin"
          type="url"
          placeholder="https://example.com"
          required
          maxLength={300}
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          aria-describedby="origin-help"
        />
        <p id="origin-help" className="field-help">
          仅协议、域名及可选端口，不含路径或末尾斜杠。
        </p>
        <label htmlFor="allowed-origins">允许的 Origin（每行一个）</label>
        <Input.TextArea
          id="allowed-origins"
          rows={3}
          value={allowed}
          onChange={(e) => setAllowed(e.target.value)}
          aria-describedby="allowed-help"
        />
        <p id="allowed-help" className="field-help">
          最多 20 个，必须包含主 Origin。创建时留空则使用主 Origin。
        </p>
        <label htmlFor="site-timezone">站点时区</label>
        <Input
          id="site-timezone"
          value={timezone}
          disabled={Boolean(site)}
          required
          maxLength={80}
          onChange={(e) => setTimezone(e.target.value)}
          aria-describedby="timezone-help"
        />
        <p id="timezone-help" className="field-help">
          {site
            ? '当前在线设置不支持修改时区。请新建站点或由管理员安排离线重建。'
            : '例如 Asia/Shanghai、UTC、America/New_York。日期按此时区计算。'}
        </p>
        <label htmlFor="routing-mode">导航模式</label>
        <select
          id="routing-mode"
          value={rules.routing_mode}
          onChange={(e) =>
            setRules({ ...rules, routing_mode: e.target.value as typeof rules.routing_mode })
          }
        >
          <option value="history">History / 普通页面</option>
          <option value="hash">Hash 路由</option>
          <option value="manual">手动上报</option>
        </select>
        <label htmlFor="excluded-prefixes">排除路径前缀（每行一个）</label>
        <Input.TextArea
          id="excluded-prefixes"
          rows={3}
          value={prefixes}
          onChange={(e) => setPrefixes(e.target.value)}
        />
        <div className="checkbox-fields">
          {(
            [
              { key: 'redact_identifiers', label: '脱敏路径中的数字、邮箱及长标识' },
              { key: 'exclude_bots', label: '过滤已知机器人' },
              { key: 'allow_utm', label: '允许白名单 UTM 来源参数' },
            ] as const
          ).map(({ key, label }) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={rules[key]}
                onChange={(e) => setRules({ ...rules, [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
        <Button type="primary" htmlType="submit" loading={mutation.isPending}>
          {site ? '保存配置' : '创建站点'}
        </Button>
      </fieldset>
      {saved && (
        <p role="status" className="success-text">
          配置已保存。
        </p>
      )}
    </form>
  );
}
