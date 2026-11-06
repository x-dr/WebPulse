import { useState } from 'react';
import { Button } from 'antd';
import { addDays, today, validRange, type Scope } from '../navigation';
import { WorkspaceIcon } from './WorkspaceIcon';

export function DateFilter({
  scope,
  apply,
  refresh,
  fetching,
}: {
  scope: Scope;
  apply: (start: string, end: string) => void;
  refresh: () => void;
  fetching: boolean;
}) {
  const [start, setStart] = useState(scope.start);
  const [end, setEnd] = useState(addDays(scope.end, -1));
  const [invalid, setInvalid] = useState(false);
  const current = today(scope.site.timezone);
  return (
    <div className="date-filter">
      <div className="date-filter-controls">
        <div className="date-presets" role="group" aria-label="快捷日期">
          {[
            { label: '今日', start: current, end: addDays(current, 1) },
            { label: '昨日', start: addDays(current, -1), end: current },
            { label: '近 7 日', start: addDays(current, -6), end: addDays(current, 1) },
            { label: '近 30 日', start: addDays(current, -29), end: addDays(current, 1) },
          ].map((preset) => (
            <button
              type="button"
              key={preset.label}
              aria-pressed={scope.start === preset.start && scope.end === preset.end}
              onClick={() => apply(preset.start, preset.end)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <form
          className="date-form"
          onSubmit={(event) => {
            event.preventDefault();
            const exclusiveEnd = end ? addDays(end, 1) : '';
            if (validRange(start, exclusiveEnd, scope.site.timezone)) {
              setInvalid(false);
              apply(start, exclusiveEnd);
            } else setInvalid(true);
          }}
        >
          <div className="date-inputs">
            <label className="sr-only" htmlFor="start-date">
              开始日期
            </label>
            <input
              id="start-date"
              type="date"
              required
              max={current}
              value={start}
              onChange={(event) => setStart(event.target.value)}
              aria-describedby="date-help"
              aria-invalid={invalid}
            />
            <span aria-hidden="true">—</span>
            <label className="sr-only" htmlFor="end-date">
              结束日期（含）
            </label>
            <input
              id="end-date"
              type="date"
              required
              max={current}
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              aria-describedby="date-help"
              aria-invalid={invalid}
            />
          </div>
          <Button htmlType="submit" className="apply-date">
            应用日期
          </Button>
        </form>
        <Button
          type="text"
          onClick={refresh}
          loading={fetching}
          icon={<WorkspaceIcon name="refresh" />}
        >
          刷新数据
        </Button>
      </div>
      <div className="date-filter-help">
        <p
          id="date-help"
          className={invalid ? 'field-help error-text' : 'field-help'}
          role={invalid ? 'alert' : undefined}
        >
          {invalid
            ? '日期范围无效，最多 365 个自然日，不能包含未来日期。'
            : `${scope.site.timezone} · 按站点自然日统计；结束日期包含当天。`}
        </p>
        {fetching && (
          <span className="refresh-status" role="status">
            更新中…
          </span>
        )}
      </div>
    </div>
  );
}
